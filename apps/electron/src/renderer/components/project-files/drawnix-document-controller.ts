import {
  fakeNodeWeakMap,
  findElements,
  PlaitHistoryBoard,
  PlaitNode,
  type PlaitBoard,
  type PlaitElement,
  type PlaitTheme,
  type Viewport,
} from '@plait/core'
import { buildText } from '@plait/common'
import {
  createMindElement,
  findNewChildNodePath,
  findNewSiblingNodePath,
  MindElement,
  MindTransforms,
  PlaitMind,
  type PlaitMindBoard,
} from '@plait/mind'
import { Node, type Element as SlateElement } from 'slate'
import { parseMarkdownToDrawnix } from '@plait-board/markdown-to-drawnix'
import type {
  ProjectFileFingerprint,
  SaveDrawnixProjectFileRequest,
  SaveDrawnixProjectFileResponse,
} from '@craft-agent/shared/project-files'
import type {
  DrawnixBoardUpdateCapabilityRequest,
  DrawnixMindmapNode,
  DrawnixMindmapOperation,
  DrawnixMindmapSnapshot,
} from '@craft-agent/server-core/transport'
import type { OpenDrawnixBoardController } from './drawnix-board-registry'

export interface NativeDrawnixDocument {
  type: 'drawnix'
  version: number
  source: 'web'
  elements: PlaitElement[]
  viewport: Viewport
  theme?: PlaitTheme
}

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

export function parseNativeDrawnixDocument(content: string): NativeDrawnixDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw mindmapError('MINDMAP_INVALID_DOCUMENT', 'The Project File is not valid Drawnix JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw mindmapError('MINDMAP_INVALID_DOCUMENT', 'The Project File is not a native Drawnix document.')
  }

  const value = parsed as Partial<NativeDrawnixDocument>
  const zoom = value.viewport && typeof value.viewport === 'object'
    ? (value.viewport as { zoom?: unknown }).zoom
    : undefined
  if (
    value.type !== 'drawnix'
    || typeof value.version !== 'number'
    || value.source !== 'web'
    || !Array.isArray(value.elements)
    || typeof zoom !== 'number'
    || !Number.isFinite(zoom)
    || zoom <= 0
  ) {
    throw mindmapError('MINDMAP_INVALID_DOCUMENT', 'The Project File is not a native Drawnix document.')
  }
  return value as NativeDrawnixDocument
}

export function serializeNativeDrawnixBoard(board: PlaitBoard): string {
  return JSON.stringify({
    type: 'drawnix',
    version: 1,
    source: 'web',
    elements: board.children,
    viewport: board.viewport,
    theme: board.theme,
  }, null, 2)
}

export function mindElementToOutlineNode(element: MindElement): DrawnixMindmapNode {
  return {
    id: element.id,
    topic: Node.string(element.data.topic),
    children: element.children
      .filter(child => MindElement.isMindElement(null, child))
      .map(mindElementToOutlineNode),
  }
}

export function snapshotDrawnixBoard(
  board: PlaitBoard,
  relativePath: string,
  changeSeq: number,
): DrawnixMindmapSnapshot {
  return {
    relativePath,
    changeSeq,
    roots: board.children.filter(PlaitMind.isMind).map(mindElementToOutlineNode),
  }
}

function requireMindElement(board: PlaitBoard, id: string): MindElement {
  const element = findElements(board, {
    match: candidate => candidate.id === id,
    recursion: () => true,
    isReverse: false,
  })[0]
  if (!element || !MindElement.isMindElement(board, element)) {
    throw mindmapError(
      'MINDMAP_NODE_NOT_FOUND',
      `Mind-map node ${id} is not present on the open board.`,
    )
  }
  return element
}

function validateIncrementalOperations(
  board: PlaitBoard,
  operations: DrawnixMindmapOperation[],
): void {
  for (const operation of operations) {
    if (operation.type === 'populate_empty') continue
    const id = operation.type === 'insert_child' ? operation.parentId : operation.nodeId
    const element = requireMindElement(board, id)
    if (operation.type === 'insert_sibling' && PlaitMind.isMind(element)) {
      throw mindmapError('MINDMAP_INVALID_OPERATION', 'A root mind-map node cannot have a sibling.')
    }
    if (!operation.topic.trim()) {
      throw mindmapError('MINDMAP_INVALID_OPERATION', 'Mind-map topics cannot be empty.')
    }
  }
}

export function applyMindmapOperations(
  board: PlaitBoard,
  operations: DrawnixMindmapOperation[],
): void {
  if (operations.length < 1 || operations.length > 50) {
    throw mindmapError('MINDMAP_INVALID_OPERATION', 'Provide between 1 and 50 mind-map operations.')
  }

  let mutate: () => void
  const populate = operations.find(operation => operation.type === 'populate_empty')
  if (populate) {
    if (operations.length !== 1 || board.children.length !== 0) {
      throw mindmapError(
        'MINDMAP_NOT_EMPTY',
        'populate_empty can only be used by itself on a completely empty board.',
      )
    }
    if (!populate.markdown.trim()) {
      throw mindmapError('MINDMAP_INVALID_OPERATION', 'Markdown used to populate a mind map cannot be empty.')
    }
    const lines = populate.markdown.trim().split(/\r?\n/)
    if (!lines.some(line => /^\s{0,3}#{1,6}\s+\S/.test(line))) {
      const first = lines[0]!.trim()
      const rootTopic = first.match(/^(?:[-+*]|\d+[.)])\s+(.+)$/)?.[1]?.trim() ?? first
      if (!rootTopic || rootTopic.startsWith('```') || rootTopic.startsWith('~~~') || rootTopic.startsWith('>')) {
        throw mindmapError('MINDMAP_INVALID_OPERATION', 'Markdown must begin with a root topic or heading.')
      }
      lines[0] = `# ${rootTopic}`
    }

    let mind: MindElement
    try {
      mind = parseMarkdownToDrawnix(lines.join('\n'))
    } catch {
      throw mindmapError('MINDMAP_INVALID_OPERATION', 'Drawnix could not parse the Markdown hierarchy.')
    }
    mind.points = [[100, 100]]
    mutate = () => {
      MindTransforms.insertMind(board as PlaitMindBoard, mind)
    }
  } else {
    validateIncrementalOperations(board, operations)
    mutate = () => {
      for (const operation of operations) {
        if (operation.type === 'populate_empty') continue
        fakeNodeWeakMap(board)
        if (operation.type === 'set_topic') {
          MindTransforms.setTopic(
            board as PlaitMindBoard,
            requireMindElement(board, operation.nodeId),
            buildText(operation.topic) as SlateElement,
          )
          continue
        }

        const target = requireMindElement(
          board,
          operation.type === 'insert_child' ? operation.parentId : operation.nodeId,
        )
        const path = operation.type === 'insert_child'
          ? findNewChildNodePath(board, target)
          : findNewSiblingNodePath(board, target)
        MindTransforms.insertNodes(board, [createMindElement(operation.topic, {})], path)
        if (!MindElement.isMindElement(board, PlaitNode.get(board, path))) {
          throw mindmapError('MINDMAP_UPDATE_FAILED', 'Drawnix did not insert the requested mind-map node.')
        }
      }
    }
  }

  const undoCount = board.history.undos.length
  const previousRedos = [...board.history.redos]
  let mutationFailed = false
  let mutationError: unknown
  PlaitHistoryBoard.withNewBatch(board, () => {
    try {
      mutate()
    } catch (error) {
      mutationFailed = true
      mutationError = error
    }
  })
  if (!mutationFailed) return

  while (board.history.undos.length > undoCount) board.undo()
  board.history.redos = previousRedos
  throw mutationError
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
    private readonly board: PlaitBoard,
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
      content: serializeNativeDrawnixBoard(this.board),
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
    return snapshotDrawnixBoard(this.board, this.relativePath, this.changeSeq)
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

    applyMindmapOperations(this.board, request.operations)
    this.notifyBoardChanged()
    await this.flush()
    return snapshotDrawnixBoard(this.board, this.relativePath, this.changeSeq)
  }
}
