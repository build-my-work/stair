import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadProjectById } from '@craft-agent/shared/projects'
import { projectNotionService } from '../../notion/service'
import type { RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [RPC_CHANNELS.notion.CHILDREN] as const

export function registerNotionHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.notion.CHILDREN, async (context, request: { projectId: string; pageId?: string }) => {
    const workspaceId = context.workspaceId ?? (context.webContentsId == null ? null : deps.windowManager?.getWorkspaceForWindow(context.webContentsId))
    const workspace = workspaceId ? getWorkspaceByNameOrId(workspaceId) : null
    if (!workspace || !request || typeof request.projectId !== 'string') throw new Error('NOTION_NO_PROJECT')
    const project = loadProjectById(workspace.rootPath, request.projectId)
    if (!project?.config.notion) throw new Error('NOTION_NOT_CONFIGURED')
    const service = await projectNotionService(workspace.rootPath, project.config.notion)
    return service.children(request.pageId)
  })
}
