import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.LIST_ASSETS,
  RPC_CHANNELS.projects.UPLOAD_ASSET,
  RPC_CHANNELS.projects.DELETE_ASSET,
] as const

export function registerProjectsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspaceProjects } = await import('@craft-agent/shared/projects')
    const projects = loadWorkspaceProjects(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.projects.CHANGED, { to: 'workspace', workspaceId }, workspaceId, projects)
  }

  async function withExistingProjectMutation<T>(
    workspaceRootPath: string,
    projectSlug: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const { loadProject, withProjectMutationLock } = await import('@craft-agent/shared/projects')
    const project = loadProject(workspaceRootPath, projectSlug)
    if (!project) throw new Error(`Project not found: ${projectSlug}`)
    return withProjectMutationLock(workspaceRootPath, project.config.id, async () => {
      const current = loadProject(workspaceRootPath, projectSlug)
      if (!current || current.config.id !== project.config.id) {
        throw new Error(`Project not found: ${projectSlug}`)
      }
      return operation()
    })
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
    const updated = await withExistingProjectMutation(
      workspace.rootPath,
      projectSlug,
      () => updateProject(workspace.rootPath, projectSlug, patch),
    )
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Delete an empty, non-default Project. Session ownership is immutable.
  server.handle(RPC_CHANNELS.projects.DELETE, async (_ctx, workspaceId: string, projectSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const { deleteProject } = await import('@craft-agent/shared/projects')
    let deletingProjectId: string | null = null
    let touchedPages = 0
    let deleted = false
    try {
      deleted = await deleteProject(
        workspace.rootPath,
        projectSlug,
        async project => {
          deletingProjectId = project.id
          // Pages may reference the Project without belonging to it; unbind them
          // instead of leaving dangling links. Sessions keep immutable Project
          // ownership — deleteProject enforces PROJECT_NOT_EMPTY.
          const { unbindProjectFromPages } = await import('@craft-agent/shared/pages')
          touchedPages = unbindProjectFromPages(workspace.rootPath, project.id)
          await deps.sessionManager.beginBrowserProjectDeletion(workspaceId, project.id)
        },
      )
    } catch (error) {
      if (deletingProjectId) {
        await deps.sessionManager.finishBrowserProjectDeletion(
          workspaceId,
          deletingProjectId,
          false,
        ).catch(releaseError => log.error(
          `PROJECTS_DELETE: failed to release Browser deletion gate for ${deletingProjectId}`,
          releaseError,
        ))
      }
      throw error
    }
    if (!deleted) {
      log.warn(`PROJECTS_DELETE: project ${projectSlug} not found`)
      return
    }
    if (deletingProjectId) {
      await deps.sessionManager.finishBrowserProjectDeletion(
        workspaceId,
        deletingProjectId,
        true,
      ).catch(error => log.warn(
        `PROJECTS_DELETE: failed to finalize Browser deletion gate for ${deletingProjectId}`,
        error,
      ))
    }
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted empty project ${projectSlug} (unbound ${touchedPages} pages)`)
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
    const asset = await withExistingProjectMutation(
      workspace.rootPath,
      projectSlug,
      () => uploadProjectAsset(workspace.rootPath, projectSlug, input),
    )
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Uploaded asset ${asset.filename} to project ${projectSlug}`)
    return asset
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
    const { deleteProjectAsset } = await import('@craft-agent/shared/projects')
    await withExistingProjectMutation(
      workspace.rootPath,
      projectSlug,
      () => deleteProjectAsset(workspace.rootPath, projectSlug, filename),
    )
    await broadcastChanged(workspaceId, workspace.rootPath)
  })
}
