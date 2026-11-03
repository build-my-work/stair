import type { DrawnixEditor } from '@ttsworld/drawnix/editor'
import type {
  ProjectFileFingerprint,
  SaveDrawnixProjectFileRequest,
  SaveDrawnixProjectFileResponse,
} from '@craft-agent/shared/project-files'
import type {
  DrawnixBoardUpdateCapabilityRequest,
  DrawnixMindmapSnapshot,
} from '@craft-agent/server-core/transport'
import type { OpenDrawnixBoardController } from './drawnix-board-registry'

export interface DrawnixDocumentState {
  saving: boolean
  error: Error | null
}

type DrawnixSaveApi = (
  request: SaveDrawnixProjectFileRequest,
) => Promise<SaveDrawnixProjectFileResponse>

function mindmapError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export class DrawnixDocumentController implements OpenDrawnixBoardController {
  // A fresh 52-bit epoch survives renderer restarts without reusing old read
  // tokens, while leaving room for safe-integer increments on the live board.
  private changeSeq = Number.parseInt(crypto.randomUUID().replaceAll('-', '').slice(-13), 16)
  private dirty = false
  private pendingChange: Promise<void> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private savePromise: Promise<void> | null = null
  private saveError: Error | null = null

  constructor(
    private readonly editor: DrawnixEditor,
    private readonly projectId: string,
    private readonly relativePath: string,
    private sourceFingerprint: ProjectFileFingerprint,
    private readonly save: DrawnixSaveApi,
    private readonly onStateChange: (state: DrawnixDocumentState) => void,
    private readonly debounceMs = 800,
  ) {}

  notifyBoardChanged(): void {
    if (this.pendingChange) return
    this.pendingChange = Promise.resolve().then(() => {
      this.pendingChange = null
      this.changeSeq += 1
      this.dirty = true
      this.scheduleSave()
    })
  }

  notifyPresentationChanged(): void {
    this.dirty = true
    this.scheduleSave()
  }

  retry(): void {
    if (!this.saveError) return
    this.saveError = null
    this.onStateChange({ saving: false, error: null })
    this.startSave()
  }

  private clearSaveTimer(): void {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
  }

  private scheduleSave(): void {
    if (this.saveError || !this.dirty) return
    this.clearSaveTimer()
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.startSave()
    }, this.debounceMs)
  }

  private startSave(): void {
    if (this.savePromise || this.saveError || !this.dirty) return
    this.clearSaveTimer()
    this.savePromise = this.runSave()
      .catch(error => {
        this.saveError = error instanceof Error ? error : new Error(String(error))
        this.dirty = true
        this.onStateChange({ saving: false, error: this.saveError })
      })
      .finally(() => {
        this.savePromise = null
        if (this.dirty && !this.saveError) this.scheduleSave()
      })
  }

  private async runSave(): Promise<void> {
    this.dirty = false
    this.onStateChange({ saving: true, error: null })
    const response = await this.save({
      projectId: this.projectId,
      relativePath: this.relativePath,
      expectedFingerprint: this.sourceFingerprint,
      content: this.editor.serialize(),
    })
    this.sourceFingerprint = response.sourceFingerprint
    this.onStateChange({ saving: false, error: null })
  }

  async flush(): Promise<void> {
    while (this.pendingChange || this.savePromise || this.dirty) {
      if (this.pendingChange) await this.pendingChange
      this.clearSaveTimer()
      this.startSave()
      if (this.savePromise) await this.savePromise
      if (this.saveError) throw this.saveError
    }
  }

  async read(): Promise<DrawnixMindmapSnapshot> {
    if (this.pendingChange) await this.pendingChange
    return {
      relativePath: this.relativePath,
      changeSeq: this.changeSeq,
      roots: this.editor.readMindmap(),
    }
  }

  async update(
    request: DrawnixBoardUpdateCapabilityRequest,
  ): Promise<DrawnixMindmapSnapshot> {
    if (this.pendingChange) await this.pendingChange
    if (this.saveError) throw this.saveError
    if (request.expectedChangeSeq !== this.changeSeq) {
      throw mindmapError(
        'MINDMAP_BOARD_CHANGED',
        'The open mind map changed after the Agent read it. Read the board again before updating.',
      )
    }

    this.editor.updateMindmap(request.operations)
    this.notifyBoardChanged()
    await this.flush()
    return this.read()
  }
}
