import type { SourceFingerprint } from '@craft-agent/core'
import type {
  SaveProjectTextFileRequest,
  SaveProjectTextFileResponse,
} from '@craft-agent/shared/protocol'
import type { OpenProjectFileDocument } from './project-file-document-registry'

export type ProjectTextDocumentStatus =
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'error'
  | 'conflict'

export interface ProjectTextDocumentState {
  status: ProjectTextDocumentStatus
  error: Error | null
}

type ProjectTextSaveApi = (
  request: SaveProjectTextFileRequest,
) => Promise<SaveProjectTextFileResponse>

export class ProjectTextDocumentController implements OpenProjectFileDocument {
  private persistedContent: string
  private currentContent: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private savePromise: Promise<void> | null = null
  private saveAgain = false
  private saveError: Error | null = null
  private disposed = false

  constructor(
    private readonly projectId: string,
    private readonly relativePath: string,
    content: string,
    private sourceFingerprint: SourceFingerprint,
    private readonly save: ProjectTextSaveApi,
    private readonly onStateChange: (state: ProjectTextDocumentState) => void,
    private readonly reloadFromDisk: () => void,
    private readonly debounceMs = 800,
  ) {
    this.persistedContent = content
    this.currentContent = content
  }

  get content(): string {
    return this.currentContent
  }

  updateContent(content: string): void {
    this.currentContent = content
    if (content === this.persistedContent && !this.savePromise) {
      this.clearSaveTimer()
      this.emit({ status: 'clean', error: null })
      return
    }
    if (this.saveError) return
    if (!this.savePromise) this.emit({ status: 'dirty', error: null })
    this.scheduleSave()
  }

  retry(): void {
    if (!this.saveError) return
    this.saveError = null
    if (this.currentContent === this.persistedContent) {
      this.emit({ status: 'clean', error: null })
      return
    }
    this.emit({ status: 'dirty', error: null })
    this.clearSaveTimer()
    this.startSave()
  }

  private emit(state: ProjectTextDocumentState): void {
    if (!this.disposed) this.onStateChange(state)
  }

  private clearSaveTimer(): void {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
  }

  private scheduleSave(): void {
    this.clearSaveTimer()
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.startSave()
    }, this.debounceMs)
  }

  private startSave(): void {
    if (this.saveError || this.currentContent === this.persistedContent) return
    if (this.savePromise) {
      this.saveAgain = true
      return
    }

    const content = this.currentContent
    const expectedFingerprint = this.sourceFingerprint
    this.emit({ status: 'saving', error: null })
    this.savePromise = this.save({
      projectId: this.projectId,
      relativePath: this.relativePath,
      expectedFingerprint,
      content,
    })
      .then(response => {
        this.sourceFingerprint = response.sourceFingerprint
        this.persistedContent = content
        if (this.currentContent === this.persistedContent) {
          this.clearSaveTimer()
          this.emit({ status: 'saved', error: null })
        } else {
          this.emit({ status: 'dirty', error: null })
        }
      })
      .catch(error => {
        const saveError = error instanceof Error
          ? error
          : new Error(String(error))
        this.saveError = saveError
        const errorCode = (saveError as Error & { code?: string }).code
        const conflict = saveError.message.startsWith('PROJECT_FILE_CHANGED:')
          || errorCode === 'PROJECT_FILE_CHANGED'
        this.emit({
          status: conflict ? 'conflict' : 'error',
          error: saveError,
        })
      })
      .finally(() => {
        this.savePromise = null
        const shouldSaveAgain =
          this.saveAgain
          && !this.saveError
          && this.currentContent !== this.persistedContent
        this.saveAgain = false
        if (shouldSaveAgain) this.startSave()
      })
  }

  async flush(): Promise<void> {
    this.clearSaveTimer()
    while (true) {
      if (this.savePromise) await this.savePromise
      if (this.saveError) throw this.saveError
      if (this.currentContent === this.persistedContent) return
      this.startSave()
    }
  }

  onExternalChange(): void {
    if (
      this.saveTimer
      || this.savePromise
      || this.saveError
      || this.currentContent !== this.persistedContent
    ) {
      return
    }
    this.reloadFromDisk()
  }

  dispose(): void {
    this.disposed = true
    this.clearSaveTimer()
  }
}
