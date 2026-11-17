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

/** Matches Drawnix `waitForPendingCardImages`: idle queue vs bound elapsed. */
export type DrawnixImageWaitResult = 'idle' | 'timeout'

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
  /** Shared in-flight flush so concurrent callers join one run instead of double-writing. */
  private flushPromise: Promise<DrawnixImageWaitResult> | null = null
  /** Last content written (or the open baseline). Used after image wait when onValueChange is gone. */
  private lastSavedContent: string

  constructor(
    private readonly editor: DrawnixEditor,
    private readonly projectId: string,
    private readonly relativePath: string,
    private sourceFingerprint: ProjectFileFingerprint,
    private readonly save: DrawnixSaveApi,
    private readonly onStateChange: (state: DrawnixDocumentState) => void,
    private readonly debounceMs = 800,
  ) {
    this.lastSavedContent = editor.serialize()
  }

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
    const content = this.editor.serialize()
    const response = await this.save({
      projectId: this.projectId,
      relativePath: this.relativePath,
      expectedFingerprint: this.sourceFingerprint,
      content,
    })
    this.lastSavedContent = content
    this.sourceFingerprint = response.sourceFingerprint
    this.onStateChange({ saving: false, error: null })
  }

  /**
   * Waits for in-flight card images (bounded), then saves. Re-serializes after
   * the wait so a batch that committed without `onValueChange` (panel/board
   * teardown) is still written. Returns the image-wait result so callers can
   * warn on `'timeout'` after saving whatever already landed.
   *
   * Concurrent callers share one in-flight flush so overlapping close/switch
   * paths cannot each mark dirty and rewrite the same snapshot.
   */
  async flush(timeoutMs?: number): Promise<DrawnixImageWaitResult> {
    if (this.flushPromise) return this.flushPromise
    this.flushPromise = this.runFlush(timeoutMs).finally(() => {
      this.flushPromise = null
    })
    return this.flushPromise
  }

  private async runFlush(timeoutMs?: number): Promise<DrawnixImageWaitResult> {
    // Card images commit asynchronously; onValueChange (and dirty) only fire
    // once a batch lands. Wait (bounded inside the editor) so close/switch/Cmd+S
    // persist an image the user already added.
    const imageWait = await this.editor.waitForPendingCardImages(timeoutMs)

    while (true) {
      if (this.pendingChange) await this.pendingChange
      // Wait for any in-flight autosave/flush write before comparing — otherwise
      // lastSavedContent is stale and we double-write the same snapshot.
      if (this.savePromise) await this.savePromise

      if (this.editor.serialize() === this.lastSavedContent) {
        // Stale dirty from a concurrent waiter, or a redundant write that failed
        // after the latest content was already persisted.
        this.dirty = false
        if (this.saveError) {
          this.saveError = null
          this.onStateChange({ saving: false, error: null })
        }
        break
      }

      // After unmount, onValueChange may be detached: compare serialize() to the
      // last saved baseline instead of relying only on dirty.
      this.dirty = true
      if (this.saveError) throw this.saveError
      this.clearSaveTimer()
      this.startSave()
      if (this.savePromise) await this.savePromise

      if (this.saveError) {
        // Redundant failure: latest board content already matches lastSavedContent
        // (another write won). Do not veto close/switch.
        if (this.editor.serialize() === this.lastSavedContent) {
          this.saveError = null
          this.dirty = false
          this.onStateChange({ saving: false, error: null })
          break
        }
        throw this.saveError
      }
    }

    return imageWait === 'timeout' ? 'timeout' : 'idle'
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
