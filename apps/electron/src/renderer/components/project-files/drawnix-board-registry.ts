import type {
  DrawnixBoardCapabilityRequest,
  DrawnixBoardCapabilityResponse,
  DrawnixMindmapSnapshot,
} from '@craft-agent/server-core/transport'
import { isCanonicalProjectRelativePath } from '@craft-agent/core'
import { registerOpenProjectFileDocument } from './project-file-document-registry'

export interface OpenDrawnixBoardController {
  read(): Promise<DrawnixMindmapSnapshot>
  update(
    request: Extract<DrawnixBoardCapabilityRequest, { action: 'update' }>,
  ): Promise<DrawnixMindmapSnapshot>
  flush(): Promise<void>
}

const openBoards = new Map<string, OpenDrawnixBoardController>()

function boardKey(projectId: string, relativePath: string): string {
  return `${projectId}\0${relativePath}`
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export function registerOpenDrawnixBoard(
  projectId: string,
  relativePath: string,
  controller: OpenDrawnixBoardController,
): () => void {
  const key = boardKey(projectId, relativePath)
  const existing = openBoards.get(key)
  if (existing && existing !== controller) {
    throw codedError(
      'MINDMAP_ALREADY_OPEN',
      `${relativePath} already has a visible Drawnix board.`,
    )
  }
  if (existing === controller) return () => {}
  const unregisterDocument = registerOpenProjectFileDocument(
    projectId,
    relativePath,
    controller,
  )
  openBoards.set(key, controller)
  return () => {
    if (openBoards.get(key) === controller) openBoards.delete(key)
    unregisterDocument()
  }
}

export async function handleDrawnixBoardCapability(
  request: DrawnixBoardCapabilityRequest,
): Promise<DrawnixBoardCapabilityResponse> {
  try {
    if (
      request.v !== 1
      || !isCanonicalProjectRelativePath(request.relativePath)
      || !request.relativePath.toLowerCase().endsWith('.drawnix')
    ) {
      throw codedError(
        'MINDMAP_INVALID_REQUEST',
        'A canonical .drawnix Project File path is required.',
      )
    }
    const controller = openBoards.get(
      boardKey(request.projectId, request.relativePath),
    )
    if (!controller) {
      throw codedError(
        'MINDMAP_NOT_OPEN',
        `Open ${request.relativePath} in Project Files before asking the Agent to read or modify it.`,
      )
    }
    const snapshot = request.action === 'read'
      ? await controller.read()
      : await controller.update(request)
    return { ok: true, snapshot }
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : 'MINDMAP_BOARD_ERROR'
    return {
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

export async function flushOpenDrawnixBoards(): Promise<void> {
  await Promise.all(Array.from(openBoards.values(), board => board.flush()))
}

export async function flushOpenDrawnixBoard(
  projectId: string,
  relativePath: string,
): Promise<void> {
  await openBoards.get(boardKey(projectId, relativePath))?.flush()
}
