import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { isSupportedTextbookFilename, MAX_TEXTBOOK_BYTES, parseTextbook } from '../../learning/import-textbook'
import {
  fingerprintWorkingFile,
  listSafeWorkingDirectoryEntries,
  readSafeWorkingDirectoryBinary,
  readSafeWorkingDirectoryDataUrl,
  readSafeWorkingDirectoryText,
  resolveSafeWorkingDirectoryPath,
} from '../../working-directory/files'
import {
  assertRequestingWorkspace,
  resolveSessionProject,
  resolveSessionProjectWorkingDirectory,
} from '../../working-directory/session-project'
import { resolveArtifactSourceSessionId } from '../../sessions/project-artifact-capability'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.LIST_WORKING_DIRECTORY_ENTRIES,
  RPC_CHANNELS.projects.READ_WORKING_DIRECTORY_TEXT,
  RPC_CHANNELS.projects.READ_WORKING_DIRECTORY_BINARY,
  RPC_CHANNELS.projects.READ_WORKING_DIRECTORY_DATA_URL,
  RPC_CHANNELS.projects.OPEN_WORKING_DIRECTORY_FILE,
  RPC_CHANNELS.projects.PARSE_WORKING_DIRECTORY_TEXTBOOK,
  RPC_CHANNELS.projects.LIST_ARTIFACTS,
  RPC_CHANNELS.projects.GET_ARTIFACT,
  RPC_CHANNELS.projects.SAVE_ARTIFACT,
  RPC_CHANNELS.projects.DELETE_ARTIFACT,
  RPC_CHANNELS.projects.LIST_WORKING_FILE_EPUB_HIGHLIGHTS,
  RPC_CHANNELS.projects.SAVE_WORKING_FILE_EPUB_HIGHLIGHT,
  RPC_CHANNELS.projects.DELETE_WORKING_FILE_EPUB_HIGHLIGHT,
  RPC_CHANNELS.projects.EXPORT_WORKING_FILE_EPUB_HIGHLIGHTS,
] as const

export function registerProjectsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  async function resolveWorkingDirectory(ctxWorkspaceId: string | null, sessionId: string) {
    const resolved = await resolveSessionProjectWorkingDirectory(deps.sessionManager, sessionId)
    assertRequestingWorkspace(ctxWorkspaceId, resolved.workspaceId)
    return resolved
  }

  async function resolveProject(ctxWorkspaceId: string | null, sessionId: string) {
    const resolved = await resolveSessionProject(deps.sessionManager, sessionId)
    assertRequestingWorkspace(ctxWorkspaceId, resolved.workspaceId)
    return resolved
  }

  async function resolveWorkingEpub(ctxWorkspaceId: string | null, sessionId: string, sourcePath: string) {
    const project = await resolveWorkingDirectory(ctxWorkspaceId, sessionId)
    if (!isSupportedTextbookFilename(sourcePath) || !/\.epub$/i.test(sourcePath)) {
      throw new Error('Working file must be an EPUB')
    }
    const bytes = await readSafeWorkingDirectoryBinary(
      project.workingDirectory,
      sourcePath,
      MAX_TEXTBOOK_BYTES,
    )
    return {
      ...project,
      sourcePath: (await resolveSafeWorkingDirectoryPath(
        project.workingDirectory,
        sourcePath,
        'file',
      )).relativePath,
      sourceFingerprint: fingerprintWorkingFile(bytes),
      bytes,
    }
  }

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspaceProjects } = await import('@craft-agent/shared/projects')
    const projects = loadWorkspaceProjects(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.projects.CHANGED, { to: 'workspace', workspaceId }, workspaceId, projects)
  }

  // List all projects for a workspace
  server.handle(RPC_CHANNELS.projects.GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`PROJECTS_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    const { loadWorkspaceProjects } = await import('@craft-agent/shared/projects')
    return loadWorkspaceProjects(workspace.rootPath)
  })

  // Get one project (by id or slug)
  server.handle(RPC_CHANNELS.projects.GET_ONE, async (_ctx, workspaceId: string, projectIdOrSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { loadProject, loadProjectById } = await import('@craft-agent/shared/projects')
    return loadProject(workspace.rootPath, projectIdOrSlug)
      ?? loadProjectById(workspace.rootPath, projectIdOrSlug)
  })

  // Create a new project
  server.handle(RPC_CHANNELS.projects.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/projects').CreateProjectInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { createProject } = await import('@craft-agent/shared/projects')
    const project = createProject(workspace.rootPath, {
      name: input.name?.trim() || 'New Project',
      description: input.description,
      workingDirectory: input.workingDirectory,
      details: input.details,
      colorTheme: input.colorTheme,
    })
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Created project: ${project.slug}`)
    return project
  })

  // Update project (partial patch). Slug stays stable.
  server.handle(RPC_CHANNELS.projects.UPDATE, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    patch: Partial<Omit<import('@craft-agent/shared/projects').ProjectConfig, 'id' | 'slug' | 'createdAt'>>,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateProject } = await import('@craft-agent/shared/projects')
    const updated = updateProject(workspace.rootPath, projectSlug, patch)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Delete a project; unbinds projectId from any sessions that referenced it.
  server.handle(RPC_CHANNELS.projects.DELETE, async (_ctx, workspaceId: string, projectSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const { loadProject, deleteProject } = await import('@craft-agent/shared/projects')
    const project = loadProject(workspace.rootPath, projectSlug)
    if (!project) {
      log.warn(`PROJECTS_DELETE: project ${projectSlug} not found`)
      return
    }

    const { unbindProjectFromSessions } = await import('@craft-agent/shared/sessions')
    const touched = await unbindProjectFromSessions(workspace.rootPath, project.config.id)
    deleteProject(workspace.rootPath, projectSlug)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted project ${projectSlug} (unbound ${touched} sessions)`)
  })

  server.handle(RPC_CHANNELS.projects.LIST_WORKING_DIRECTORY_ENTRIES, async (
    ctx,
    sessionId: string,
    relativeDirectory?: string,
  ) => {
    const project = await resolveWorkingDirectory(ctx.workspaceId, sessionId)
    return listSafeWorkingDirectoryEntries(project.workingDirectory, relativeDirectory)
  })

  server.handle(RPC_CHANNELS.projects.READ_WORKING_DIRECTORY_TEXT, async (
    ctx,
    sessionId: string,
    relativePath: string,
  ) => {
    const project = await resolveWorkingDirectory(ctx.workspaceId, sessionId)
    return readSafeWorkingDirectoryText(project.workingDirectory, relativePath)
  })

  server.handle(RPC_CHANNELS.projects.READ_WORKING_DIRECTORY_BINARY, async (
    ctx,
    sessionId: string,
    relativePath: string,
  ) => {
    const project = await resolveWorkingDirectory(ctx.workspaceId, sessionId)
    return readSafeWorkingDirectoryBinary(project.workingDirectory, relativePath)
  })

  server.handle(RPC_CHANNELS.projects.READ_WORKING_DIRECTORY_DATA_URL, async (
    ctx,
    sessionId: string,
    relativePath: string,
  ) => {
    const project = await resolveWorkingDirectory(ctx.workspaceId, sessionId)
    return readSafeWorkingDirectoryDataUrl(project.workingDirectory, relativePath)
  })

  server.handle(RPC_CHANNELS.projects.OPEN_WORKING_DIRECTORY_FILE, async (
    ctx,
    sessionId: string,
    relativePath: string,
  ) => {
    const project = await resolveWorkingDirectory(ctx.workspaceId, sessionId)
    const file = await resolveSafeWorkingDirectoryPath(project.workingDirectory, relativePath, 'file')
    if (!deps.platform.openPath) throw new Error('Opening files is unavailable on this host')
    await deps.platform.openPath(file.realPath)
  })

  server.handle(RPC_CHANNELS.projects.PARSE_WORKING_DIRECTORY_TEXTBOOK, async (
    ctx,
    sessionId: string,
    sourcePath: string,
  ): Promise<import('@craft-agent/shared/protocol').WorkingDirectoryTextbookResult> => {
    const project = await resolveWorkingDirectory(ctx.workspaceId, sessionId)
    if (!isSupportedTextbookFilename(sourcePath)) {
      throw new Error('Unsupported textbook format. Choose a Markdown or EPUB file.')
    }
    const bytes = await readSafeWorkingDirectoryBinary(
      project.workingDirectory,
      sourcePath,
      MAX_TEXTBOOK_BYTES,
    )
    const file = await resolveSafeWorkingDirectoryPath(project.workingDirectory, sourcePath, 'file')
    return {
      textbook: parseTextbook(bytes, file.relativePath),
      projectId: project.projectId,
      sourcePath: file.relativePath,
      sourceFingerprint: fingerprintWorkingFile(bytes),
    }
  })

  server.handle(RPC_CHANNELS.projects.LIST_ARTIFACTS, async (ctx, sessionId: string) => {
    const project = await resolveProject(ctx.workspaceId, sessionId)
    const { listProjectArtifacts } = await import('@craft-agent/shared/projects')
    return listProjectArtifacts(project.workspaceRootPath, project.projectSlug)
  })

  server.handle(RPC_CHANNELS.projects.GET_ARTIFACT, async (
    ctx,
    sessionId: string,
    artifactId: string,
  ) => {
    const project = await resolveProject(ctx.workspaceId, sessionId)
    const { getProjectArtifact } = await import('@craft-agent/shared/projects')
    return getProjectArtifact(project.workspaceRootPath, project.projectSlug, artifactId)
  })

  server.handle(RPC_CHANNELS.projects.SAVE_ARTIFACT, async (
    ctx,
    sessionId: string,
    input: Omit<import('@craft-agent/shared/projects').SaveProjectArtifactInput, 'sourceSessionId'>,
  ) => {
    const project = await resolveProject(ctx.workspaceId, sessionId)
    const { getProjectArtifact, saveProjectArtifact } = await import('@craft-agent/shared/projects')
    const existing = input.id
      ? getProjectArtifact(project.workspaceRootPath, project.projectSlug, input.id)
      : null
    return saveProjectArtifact(project.workspaceRootPath, project.projectSlug, {
      ...input,
      sourceSessionId: resolveArtifactSourceSessionId(existing?.sourceSessionId, sessionId),
      references: (input.references ?? []).map(reference => ({
        ...reference,
        projectId: project.projectId,
      })),
    })
  })

  server.handle(RPC_CHANNELS.projects.DELETE_ARTIFACT, async (
    ctx,
    sessionId: string,
    artifactId: string,
  ) => {
    const project = await resolveProject(ctx.workspaceId, sessionId)
    const { deleteProjectArtifact } = await import('@craft-agent/shared/projects')
    deleteProjectArtifact(project.workspaceRootPath, project.projectSlug, artifactId)
  })

  server.handle(RPC_CHANNELS.projects.LIST_WORKING_FILE_EPUB_HIGHLIGHTS, async (
    ctx,
    sessionId: string,
    sourcePath: string,
  ) => {
    const source = await resolveWorkingEpub(ctx.workspaceId, sessionId, sourcePath)
    const { listProjectWorkingFileEpubHighlights } = await import('@craft-agent/shared/projects')
    return listProjectWorkingFileEpubHighlights(
      source.workspaceRootPath,
      source.projectSlug,
      source.sourcePath,
      source.sourceFingerprint,
    )
  })

  server.handle(RPC_CHANNELS.projects.SAVE_WORKING_FILE_EPUB_HIGHLIGHT, async (
    ctx,
    sessionId: string,
    input: Omit<import('@craft-agent/shared/learning').WorkingFileEpubHighlightInput, 'sourceFingerprint'>,
  ) => {
    const source = await resolveWorkingEpub(ctx.workspaceId, sessionId, input?.sourcePath)
    const { saveProjectWorkingFileEpubHighlight } = await import('@craft-agent/shared/projects')
    return saveProjectWorkingFileEpubHighlight(
      source.workspaceRootPath,
      source.projectSlug,
      { ...input, sourcePath: source.sourcePath, sourceFingerprint: source.sourceFingerprint },
    )
  })

  server.handle(RPC_CHANNELS.projects.DELETE_WORKING_FILE_EPUB_HIGHLIGHT, async (
    ctx,
    sessionId: string,
    sourcePath: string,
    cfiRange: string,
  ) => {
    const source = await resolveWorkingEpub(ctx.workspaceId, sessionId, sourcePath)
    const { deleteProjectWorkingFileEpubHighlight } = await import('@craft-agent/shared/projects')
    deleteProjectWorkingFileEpubHighlight(
      source.workspaceRootPath,
      source.projectSlug,
      source.sourcePath,
      source.sourceFingerprint,
      cfiRange,
    )
  })

  server.handle(RPC_CHANNELS.projects.EXPORT_WORKING_FILE_EPUB_HIGHLIGHTS, async (
    ctx,
    sessionId: string,
    sourcePath: string,
  ) => {
    const source = await resolveWorkingEpub(ctx.workspaceId, sessionId, sourcePath)
    const { exportProjectWorkingFileEpubHighlights } = await import('@craft-agent/shared/projects')
    return exportProjectWorkingFileEpubHighlights(
      source.workspaceRootPath,
      source.projectSlug,
      source.sourcePath,
      source.sourceFingerprint,
    )
  })

  // Delete an asset by filename
}
