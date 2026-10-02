import type {
  DrawnixBoardCapabilityRequest,
  DrawnixBoardCapabilityResponse,
  DrawnixBoardDiscoveryRequest,
  DrawnixBoardDiscoveryResponse,
  DrawnixMindmapSnapshot,
} from '@craft-agent/server-core/transport'
import { isCanonicalProjectRelativePath } from '@craft-agent/shared/project-files'
import type { OpenProjectFileDocument } from './project-file-document-registry'

export interface OpenDrawnixBoardController extends OpenProjectFileDocument {
  read(): Promise<DrawnixMindmapSnapshot>
  update(
    request: Extract<DrawnixBoardCapabilityRequest, { action: 'update' }>,
  ): Promise<DrawnixMindmapSnapshot>
}

const openBoards = new Map<string, Set<OpenDrawnixBoardController>>()

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
  const controllers = openBoards.get(key) ?? new Set()
  controllers.add(controller)
  openBoards.set(key, controllers)
  return () => {
    const current = openBoards.get(key)
    if (!current) return
    current.delete(controller)
    if (current.size === 0) openBoards.delete(key)
  }
}

export function discoverDrawnixBoards(
  request: DrawnixBoardDiscoveryRequest,
  activeProjectId: string | null,
): DrawnixBoardDiscoveryResponse {
  if (
    request.v !== 1
    || typeof request.projectId !== 'string'
    || request.projectId.length === 0
    || request.projectId !== request.projectId.trim()
    || request.projectId.includes('\0')
    || !isCanonicalProjectRelativePath(request.relativePath)
    || !request.relativePath.toLowerCase().endsWith('.drawnix')
  ) {
    return {
      ok: false,
      error: {
        code: 'MINDMAP_INVALID_REQUEST',
        message: 'A Project id and canonical .drawnix Project File path are required.',
      },
    }
  }
  return {
    ok: true,
    boardCount: openBoards.get(boardKey(request.projectId, request.relativePath))?.size ?? 0,
    canCreate: activeProjectId === request.projectId,
  }
}

export async function handleDrawnixBoardCapability(
  request: DrawnixBoardCapabilityRequest,
): Promise<DrawnixBoardCapabilityResponse> {
  try {
    if (
      request.v !== 1
      || !['read', 'update', 'create'].includes(request.action)
      || typeof request.projectId !== 'string'
      || request.projectId.length === 0
      || request.projectId !== request.projectId.trim()
      || request.projectId.includes('\0')
      || !isCanonicalProjectRelativePath(request.relativePath)
      || !request.relativePath.toLowerCase().endsWith('.drawnix')
    ) {
      throw codedError(
        'MINDMAP_INVALID_REQUEST',
        'A Project id and canonical .drawnix Project File path are required.',
      )
    }
    if (request.action === 'create') {
      throw codedError(
        'MINDMAP_CREATE_UNAVAILABLE',
        'Creating a Drawnix mind map requires the Project File capability bridge.',
      )
    }
    const controllers = openBoards.get(boardKey(request.projectId, request.relativePath))
    if (!controllers?.size) {
      throw codedError(
        'MINDMAP_NOT_OPEN',
        `Open ${request.relativePath} in Project Files before asking the Agent to read or modify it.`,
      )
    }
    if (controllers.size !== 1) {
      throw codedError(
        'MINDMAP_AMBIGUOUS_BOARD',
        `Close duplicate views of ${request.relativePath} before asking the Agent to read or modify it.`,
      )
    }
    const controller = controllers.values().next().value!
    const snapshot = request.action === 'read'
      ? await controller.read()
      : await controller.update(request)
    return { ok: true, snapshot }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'MINDMAP_BOARD_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
