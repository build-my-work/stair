import {
  findElements,
  fakeNodeWeakMap,
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
import type { SourceFingerprint } from '@craft-agent/core'
import type {
  DrawnixBoardUpdateCapabilityRequest,
  DrawnixMindmapNode,
  DrawnixMindmapOperation,
  DrawnixMindmapSnapshot,
} from '@craft-agent/server-core/transport'
import type {
  SaveDrawnixProjectFileResponse,
} from '@craft-agent/shared/protocol'
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

type DrawnixSaveApi = (request: {
  projectId: string
  relativePath: string
  expectedFingerprint: SourceFingerprint
  content: string
}) => Promise<SaveDrawnixProjectFileResponse>

function mindmapError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export function parseNativeDrawnixDocument(
  content: string,
): NativeDrawnixDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw mindmapError(
      'MINDMAP_INVALID_DOCUMENT',
      'The Project File is not valid Drawnix JSON.',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw mindmapError(
      'MINDMAP_INVALID_DOCUMENT',
      'The Project File is not a native Drawnix document.',
    )
  }

  const value = parsed as Partial<NativeDrawnixDocument>
  let viewportZoom: unknown
  if (
    value.viewport
    && typeof value.viewport === 'object'
    && !Array.isArray(value.viewport)
  ) {
    viewportZoom = (value.viewport as { zoom?: unknown }).zoom
  }
  if (
    value.type !== 'drawnix'
    || typeof value.version !== 'number'
    || value.source !== 'web'
    || !Array.isArray(value.elements)
    || typeof viewportZoom !== 'number'
    || !Number.isFinite(viewportZoom)
    || viewportZoom <= 0
  ) {
    throw mindmapError(
      'MINDMAP_INVALID_DOCUMENT',
      'The Project File is not a native Drawnix document.',
    )
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

function toOutlineNode(element: MindElement): DrawnixMindmapNode {
  return {
    id: element.id,
    topic: Node.string(element.data.topic),
    children: element.children
      .filter(child => MindElement.isMindElement(null, child))
      .map(toOutlineNode),
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
    roots: board.children
      .filter(PlaitMind.isMind)
      .map(element => toOutlineNode(element)),
  }
}

function requireMindElement(
  board: PlaitBoard,
  id: string,
): MindElement {
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
    const id = operation.type === 'insert_child'
      ? operation.parentId
      : operation.nodeId
    const element = requireMindElement(board, id)
    if (
      operation.type === 'insert_sibling'
      && PlaitMind.isMind(element)
    ) {
      throw mindmapError(
        'MINDMAP_INVALID_OPERATION',
        'A root mind-map node cannot have a sibling.',
      )
    }
    if (!operation.topic.trim()) {
      throw mindmapError(
        'MINDMAP_INVALID_OPERATION',
        'Mind-map topics cannot be empty.',
      )
    }
  }
}

export async function applyMindmapOperations(
  board: PlaitBoard,
  operations: DrawnixMindmapOperation[],
): Promise<void> {
  if (operations.length < 1 || operations.length > 50) {
    throw mindmapError(
      'MINDMAP_INVALID_OPERATION',
      'Provide between 1 and 50 mind-map operations.',
    )
  }

  const populate = operations.find(
    operation => operation.type === 'populate_empty',
  )
  if (populate) {
    if (operations.length !== 1 || board.children.length !== 0) {
      throw mindmapError(
        'MINDMAP_NOT_EMPTY',
        'populate_empty can only be used by itself on a completely empty board.',
      )
    }
    const markdown = populate.markdown
    if (!markdown.trim()) {
      throw mindmapError(
        'MINDMAP_INVALID_OPERATION',
        'Markdown used to populate a mind map cannot be empty.',
      )
    }
    const markdownLines = markdown.trim().split(/\r?\n/)
    const hasHeading = markdownLines.some(
      line => /^\s{0,3}#{1,6}\s+\S/.test(line),
    )
    if (!hasHeading) {
      const firstContent = markdownLines[0].trim()
      const rootTopic = firstContent.match(
        /^(?:[-+*]|\d+[.)])\s+(.+)$/,
      )?.[1]?.trim() ?? firstContent
      if (
        !rootTopic
        || rootTopic.startsWith('```')
        || rootTopic.startsWith('~~~')
        || rootTopic.startsWith('>')
      ) {
        throw mindmapError(
          'MINDMAP_INVALID_OPERATION',
          'Markdown must begin with a root topic or heading.',
        )
      }
      markdownLines[0] = `# ${rootTopic}`
    }

    let mind: MindElement
    try {
      mind = parseMarkdownToDrawnix(markdownLines.join('\n'))
    } catch {
      throw mindmapError(
        'MINDMAP_INVALID_OPERATION',
        'Drawnix could not parse the Markdown hierarchy.',
      )
    }
    mind.points = [[100, 100]]
    PlaitHistoryBoard.withNewBatch(board, () => {
      MindTransforms.insertMind(board as PlaitMindBoard, mind)
    })
    return
  }

  validateIncrementalOperations(board, operations)
  PlaitHistoryBoard.withNewBatch(board, () => {
    for (const operation of operations) {
      if (operation.type === 'populate_empty') continue
      // Earlier transforms in this batch can replace ancestor object
      // identities. Refresh Plait's path maps before resolving the next node.
      fakeNodeWeakMap(board)
      if (operation.type === 'set_topic') {
        const element = requireMindElement(board, operation.nodeId)
        MindTransforms.setTopic(
          board as PlaitMindBoard,
          element,
          buildText(operation.topic) as SlateElement,
        )
        continue
      }

      const targetId = operation.type === 'insert_child'
        ? operation.parentId
        : operation.nodeId
      const target = requireMindElement(board, targetId)
      const path = operation.type === 'insert_child'
        ? findNewChildNodePath(board, target)
        : findNewSiblingNodePath(board, target)
      MindTransforms.insertNodes(
        board,
        [createMindElement(operation.topic, {})],
        path,
      )
      const inserted = PlaitNode.get(board, path)
      if (!MindElement.isMindElement(board, inserted)) {
        throw mindmapError(
          'MINDMAP_UPDATE_FAILED',
          'Drawnix did not insert the requested mind-map node.',
        )
      }
    }
  })
}

export class DrawnixDocumentController
implements OpenDrawnixBoardController {
  private changeSeq = 0
  private dirty = false
  private pendingChange: Promise<void> | null = null
  private savePromise: Promise<void> | null = null
  private saveError: Error | null = null

  constructor(
    private readonly board: PlaitBoard,
    private readonly projectId: string,
    private readonly relativePath: string,
    private sourceFingerprint: SourceFingerprint,
    private readonly save: DrawnixSaveApi,
    private readonly onStateChange: (state: DrawnixDocumentState) => void,
  ) {}

  notifyBoardChanged(): void {
    if (this.pendingChange) return
    this.pendingChange = Promise.resolve().then(() => {
      this.pendingChange = null
      this.changeSeq += 1
      this.dirty = true
      this.startSave()
    })
  }

  private startSave(): void {
    if (this.savePromise || this.saveError || !this.dirty) return
    this.savePromise = this.runSaveLoop()
      .catch(error => {
        this.saveError = error instanceof Error ? error : new Error(String(error))
        this.dirty = true
        this.onStateChange({ saving: false, error: this.saveError })
      })
      .finally(() => {
        this.savePromise = null
        if (this.dirty && !this.saveError) this.startSave()
      })
  }

  private async runSaveLoop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false
      this.onStateChange({ saving: true, error: null })
      const response = await this.save({
        projectId: this.projectId,
        relativePath: this.relativePath,
        expectedFingerprint: this.sourceFingerprint,
        content: serializeNativeDrawnixBoard(this.board),
      })
      this.sourceFingerprint = response.sourceFingerprint
    }
    this.onStateChange({ saving: false, error: null })
  }

  async flush(): Promise<void> {
    while (this.pendingChange || this.savePromise || (this.dirty && !this.saveError)) {
      if (this.pendingChange) await this.pendingChange
      this.startSave()
      if (this.savePromise) await this.savePromise
    }
    if (this.saveError) throw this.saveError
  }

  async read(): Promise<DrawnixMindmapSnapshot> {
    if (this.pendingChange) await this.pendingChange
    return snapshotDrawnixBoard(
      this.board,
      this.relativePath,
      this.changeSeq,
    )
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

    await applyMindmapOperations(this.board, request.operations)
    this.notifyBoardChanged()
    await this.flush()
    return snapshotDrawnixBoard(
      this.board,
      this.relativePath,
      this.changeSeq,
    )
  }
}
