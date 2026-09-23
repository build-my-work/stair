import { parseMarkdownToDrawnix } from '@plait-board/markdown-to-drawnix'
import type { MindElement } from '@plait/mind'
import {
  isCanonicalProjectRelativePath,
  type CreateProjectEntryRequest,
  type ProjectDirectoryEntriesRequest,
  type ProjectDirectoryEntriesResult,
  type ProjectDirectoryEntry,
  type ProjectFileRequest,
  type ProjectFileTextResponse,
  type SaveDrawnixProjectFileRequest,
  type SaveDrawnixProjectFileResponse,
} from '@craft-agent/shared/project-files'
import type {
  DrawnixBoardCreateCapabilityRequest,
  DrawnixBoardCapabilityResponse,
} from '@craft-agent/server-core/transport'
import { mindElementToOutlineNode } from './drawnix-document-controller'

interface DrawnixMindmapCreateApi {
  listProjectDirectoryEntries(
    request: ProjectDirectoryEntriesRequest,
  ): Promise<ProjectDirectoryEntriesResult>
  createProjectDirectory(request: CreateProjectEntryRequest): Promise<ProjectDirectoryEntry>
  createDrawnixProjectFile(request: CreateProjectEntryRequest): Promise<ProjectDirectoryEntry>
  readProjectTextFile(request: ProjectFileRequest): Promise<ProjectFileTextResponse>
  saveDrawnixProjectFile(
    request: SaveDrawnixProjectFileRequest,
  ): Promise<SaveDrawnixProjectFileResponse>
}

interface DrawnixMindmapCreateContext {
  api: DrawnixMindmapCreateApi
  activeProjectId: () => string | null
  openProjectFile: (input: {
    projectId: string
    relativePath: string
  }) => Promise<boolean>
}

function errorResponse(code: string, message: string): DrawnixBoardCapabilityResponse {
  return { ok: false, error: { code, message } }
}

export async function createDrawnixMindmap(
  request: DrawnixBoardCreateCapabilityRequest,
  context: DrawnixMindmapCreateContext,
): Promise<DrawnixBoardCapabilityResponse> {
  if (
    request.v !== 1
    || !isCanonicalProjectRelativePath(request.relativePath)
    || !request.relativePath.toLowerCase().endsWith('.drawnix')
    || typeof request.markdown !== 'string'
    || !request.markdown.trim()
  ) {
    return errorResponse(
      'MINDMAP_INVALID_REQUEST',
      'A confirmed Project-relative .drawnix path and non-empty Markdown are required.',
    )
  }
  if (context.activeProjectId() !== request.projectId) {
    return errorResponse(
      'MINDMAP_PROJECT_NOT_ACTIVE',
      'Open the Session Project in Stair before creating its Drawnix mind map.',
    )
  }

  const lines = request.markdown.trim().split(/\r?\n/)
  if (!lines.some(line => /^\s{0,3}#{1,6}\s+\S/.test(line))) {
    const first = lines[0]!.trim()
    const rootTopic = first.match(/^(?:[-+*]|\d+[.)])\s+(.+)$/)?.[1]?.trim() ?? first
    if (!rootTopic || rootTopic.startsWith('```') || rootTopic.startsWith('~~~') || rootTopic.startsWith('>')) {
      return errorResponse('MINDMAP_INVALID_OPERATION', 'Markdown must begin with a root topic or heading.')
    }
    lines[0] = `# ${rootTopic}`
  }

  let mind: MindElement
  try {
    mind = parseMarkdownToDrawnix(lines.join('\n'))
  } catch {
    return errorResponse('MINDMAP_INVALID_OPERATION', 'Drawnix could not parse the Markdown hierarchy.')
  }
  mind.points = [[100, 100]]

  const pathSegments = request.relativePath.split('/')
  const name = pathSegments.pop()!
  const parentRelativePath = pathSegments.join('/')
  const content = JSON.stringify({
    type: 'drawnix',
    version: 1,
    source: 'web',
    elements: [mind],
    viewport: { zoom: 1 },
    theme: { themeColorMode: 'default' },
  }, null, 2)

  try {
    let currentParent = ''
    for (const directoryName of pathSegments) {
      const listing = await context.api.listProjectDirectoryEntries({
        projectId: request.projectId,
        ...(currentParent ? { relativePath: currentParent } : {}),
      })
      const existing = listing.entries.find(entry => entry.name === directoryName)
      if (existing?.type === 'file') {
        throw Object.assign(
          new Error(`${existing.relativePath} is not a directory.`),
          { code: 'PROJECT_FILE_ALREADY_EXISTS' },
        )
      }
      if (!existing) {
        try {
          await context.api.createProjectDirectory({
            projectId: request.projectId,
            ...(currentParent ? { parentRelativePath: currentParent } : {}),
            name: directoryName,
          })
        } catch (error) {
          const code = typeof (error as { code?: unknown })?.code === 'string'
            ? (error as { code: string }).code
            : undefined
          if (code !== 'PROJECT_FILE_ALREADY_EXISTS') throw error
          const retried = await context.api.listProjectDirectoryEntries({
            projectId: request.projectId,
            ...(currentParent ? { relativePath: currentParent } : {}),
          })
          if (!retried.entries.some(entry => (
            entry.name === directoryName && entry.type === 'directory'
          ))) throw error
        }
      }
      currentParent = currentParent ? `${currentParent}/${directoryName}` : directoryName
    }
    await context.api.createDrawnixProjectFile({
      projectId: request.projectId,
      ...(parentRelativePath ? { parentRelativePath } : {}),
      name,
    })
    const created = await context.api.readProjectTextFile({
      projectId: request.projectId,
      relativePath: request.relativePath,
    })
    await context.api.saveDrawnixProjectFile({
      projectId: request.projectId,
      relativePath: request.relativePath,
      expectedFingerprint: created.sourceFingerprint,
      content,
    })
    if (!await context.openProjectFile({
      projectId: request.projectId,
      relativePath: request.relativePath,
    })) {
      return errorResponse(
        'MINDMAP_CREATED_NOT_OPENED',
        `Created ${request.relativePath}, but Stair could not open its Drawnix canvas. Do not retry creation.`,
      )
    }
    return {
      ok: true,
      snapshot: {
        relativePath: request.relativePath,
        changeSeq: 0,
        roots: [mindElementToOutlineNode(mind)],
      },
    }
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : 'MINDMAP_CREATE_FAILED'
    return errorResponse(
      code,
      error instanceof Error ? error.message : String(error),
    )
  }
}
