import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import { readFile } from 'node:fs/promises'
import type { HandlerDeps } from '../handler-deps'
import { isSupportedTextbookFilename, MAX_TEXTBOOK_BYTES, parseTextbook } from '../../learning/import-textbook'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.LIST_ASSETS,
  RPC_CHANNELS.projects.UPLOAD_ASSET,
  RPC_CHANNELS.projects.IMPORT_TEXTBOOK,
  RPC_CHANNELS.projects.PARSE_TEXTBOOK_ASSET,
  RPC_CHANNELS.projects.LIST_EPUB_HIGHLIGHTS,
  RPC_CHANNELS.projects.SAVE_EPUB_HIGHLIGHT,
  RPC_CHANNELS.projects.DELETE_EPUB_HIGHLIGHT,
  RPC_CHANNELS.projects.EXPORT_EPUB_HIGHLIGHTS,
  RPC_CHANNELS.projects.DELETE_ASSET,
] as const

export function registerProjectsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

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

  // List assets in a project
  server.handle(RPC_CHANNELS.projects.LIST_ASSETS, async (_ctx, workspaceId: string, projectSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    const { listProjectAssets } = await import('@craft-agent/shared/projects')
    return listProjectAssets(workspace.rootPath, projectSlug)
  })

  // Upload an asset (base64 / text / sourcePath)
  server.handle(RPC_CHANNELS.projects.UPLOAD_ASSET, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    input: import('@craft-agent/shared/projects').UploadProjectAssetInput,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { uploadProjectAsset } = await import('@craft-agent/shared/projects')
    const asset = uploadProjectAsset(workspace.rootPath, projectSlug, input)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Uploaded asset ${asset.filename} to project ${projectSlug}`)
    return asset
  })

  // Validate and parse a supported textbook before persisting the original file.
  // Keeping this atomic prevents corrupt uploads from appearing as usable books.
  server.handle(RPC_CHANNELS.projects.IMPORT_TEXTBOOK, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    input: { filename: string; base64: string },
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (!input?.filename || !isSupportedTextbookFilename(input.filename)) {
      throw new Error('Unsupported textbook format. Choose a Markdown or EPUB file.')
    }
    if (typeof input.base64 !== 'string') throw new Error('Textbook data is missing')
    if (input.base64.length > Math.ceil(MAX_TEXTBOOK_BYTES / 3) * 4 + 4) {
      throw new Error('The textbook file exceeds the 25 MB limit')
    }

    const bytes = Buffer.from(input.base64, 'base64')
    const textbook = parseTextbook(bytes, input.filename)
    const { uploadProjectAsset } = await import('@craft-agent/shared/projects')
    const asset = uploadProjectAsset(workspace.rootPath, projectSlug, input)
    textbook.sourceFilename = asset.filename
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Imported ${textbook.format} textbook ${asset.filename} into project ${projectSlug}`)
    return { asset, textbook }
  })

  // Re-parse a persisted textbook on demand after navigating back to the project.
  server.handle(RPC_CHANNELS.projects.PARSE_TEXTBOOK_ASSET, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    filename: string,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (!isSupportedTextbookFilename(filename)) {
      throw new Error('Unsupported textbook format. Choose a Markdown or EPUB file.')
    }
    const { listProjectAssets } = await import('@craft-agent/shared/projects')
    const asset = listProjectAssets(workspace.rootPath, projectSlug).find((candidate) => candidate.filename === filename)
    if (!asset) throw new Error(`Textbook not found: ${filename}`)
    const bytes = await readFile(asset.absolutePath)
    return parseTextbook(bytes, asset.filename)
  })

  server.handle(RPC_CHANNELS.projects.LIST_EPUB_HIGHLIGHTS, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    sourceFilename: string,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { listProjectEpubHighlights } = await import('@craft-agent/shared/projects')
    return listProjectEpubHighlights(workspace.rootPath, projectSlug, sourceFilename)
  })

  server.handle(RPC_CHANNELS.projects.SAVE_EPUB_HIGHLIGHT, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    input: import('@craft-agent/shared/learning').EpubHighlightInput,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (!input?.sourceFilename || typeof input.sourceFilename !== 'string') {
      throw new Error('Highlight sourceFilename is required')
    }
    const { listProjectAssets, saveProjectEpubHighlight } = await import('@craft-agent/shared/projects')
    const assetExists = listProjectAssets(workspace.rootPath, projectSlug)
      .some((asset) => asset.filename === input.sourceFilename && /\.epub$/i.test(asset.filename))
    if (!assetExists) throw new Error(`EPUB asset not found: ${input.sourceFilename}`)
    return saveProjectEpubHighlight(workspace.rootPath, projectSlug, input)
  })

  server.handle(RPC_CHANNELS.projects.DELETE_EPUB_HIGHLIGHT, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    sourceFilename: string,
    cfiRange: string,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deleteProjectEpubHighlight } = await import('@craft-agent/shared/projects')
    deleteProjectEpubHighlight(workspace.rootPath, projectSlug, sourceFilename, cfiRange)
  })

  server.handle(RPC_CHANNELS.projects.EXPORT_EPUB_HIGHLIGHTS, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    sourceFilename: string,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { exportProjectEpubHighlights } = await import('@craft-agent/shared/projects')
    return exportProjectEpubHighlights(workspace.rootPath, projectSlug, sourceFilename)
  })

  // Delete an asset by filename
  server.handle(RPC_CHANNELS.projects.DELETE_ASSET, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    filename: string,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const {
      deleteProjectAsset,
      deleteProjectEpubHighlightsForSource,
      sanitizeAssetFilename,
    } = await import('@craft-agent/shared/projects')
    const safeFilename = sanitizeAssetFilename(filename)
    deleteProjectAsset(workspace.rootPath, projectSlug, safeFilename)
    if (/\.epub$/i.test(safeFilename)) {
      deleteProjectEpubHighlightsForSource(workspace.rootPath, projectSlug, safeFilename)
    }
    await broadcastChanged(workspaceId, workspace.rootPath)
  })
}
