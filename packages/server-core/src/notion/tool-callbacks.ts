import type { NotionHostRequest, NotionHostState, NotionToolCallbacks, NotionReadInput, NotionWriteInput } from '@craft-agent/session-tools-core/notion'
import { loadProjectById } from '@craft-agent/shared/projects'
import { notionPageId } from '@craft-agent/shared/notion'
import type { RpcServer } from '../transport'
import { CLIENT_NOTION_INVOKE } from '../transport'
import { projectNotionService } from './service'

type Session = { projectId?: string; workspace: { id: string; rootPath: string } }

/** The Agent never supplies a workspace, Project, host window, token or arbitrary write target. */
export class ProjectNotionTools implements NotionToolCallbacks {
  private target: { clientId: string; pageId: string; revision: string; binding: string } | null = null
  constructor(private readonly getServer: () => RpcServer | null, private readonly getSession: () => Session | undefined) {}

  private context() {
    const session = this.getSession()
    if (!session?.projectId) throw new Error('NOTION_NO_PROJECT')
    const project = loadProjectById(session.workspace.rootPath, session.projectId)
    if (!project?.config.notion) throw new Error('NOTION_NOT_CONFIGURED: Configure Notion in Project Settings first.')
    return { session, binding: project.config.notion, fingerprint: JSON.stringify(project.config.notion) }
  }

  private async host(action: 'current' | 'open', pageId?: string, pinnedClient?: string): Promise<{ clientId: string; state: NotionHostState }> {
    const { session } = this.context()
    const server = this.getServer()
    if (!server) throw new Error('NOTION_NO_DESKTOP: Open the Project in Stair.')
    const base = { workspaceId: session.workspace.id, projectId: session.projectId! }
    let clientId = pinnedClient
    if (!clientId) {
      const clients = server.findClientsWithCapability(CLIENT_NOTION_INVOKE, { workspaceId: session.workspace.id })
      const responses = await Promise.all(clients.map(async id => ({ id, state: await server.invokeClient(id, CLIENT_NOTION_INVOKE, { ...base, action: 'discover' } satisfies NotionHostRequest) as NotionHostState })))
      const candidates = responses.filter(result => action === 'open' ? result.state.canOpen : result.state.hasPanel)
      if (candidates.length !== 1) throw new Error(candidates.length ? 'NOTION_AMBIGUOUS_HOST: Keep this Project’s Notion panel in one Stair window.' : 'NOTION_NOT_OPEN: Open this Project in Stair, then open the target page.')
      clientId = candidates[0]!.id
    }
    if (!server.hasClientCapability(clientId, CLIENT_NOTION_INVOKE)) throw new Error('NOTION_HOST_CHANGED: Open or read the page again.')
    const request: NotionHostRequest = action === 'open' ? { ...base, action, pageId: pageId! } : { ...base, action }
    const state = await server.invokeClient(clientId, CLIENT_NOTION_INVOKE, request) as NotionHostState
    if (this.getServer() !== server || this.getSession() !== session) throw new Error('NOTION_HOST_CHANGED')
    return { clientId, state }
  }

  async open(rawPageId: string): Promise<unknown> {
    const { session, binding, fingerprint } = this.context()
    const pageId = notionPageId(rawPageId)
    const service = await projectNotionService(session.workspace.rootPath, binding)
    await service.assertWithinRoot(pageId)
    const host = await this.host('open', pageId)
    if (host.state.pageId !== pageId || !host.state.revision) throw new Error('NOTION_PAGE_NOT_READY: Wait for the full page to load and finish signing in before writing.')
    this.target = { clientId: host.clientId, pageId, revision: host.state.revision, binding: fingerprint }
    return { pageId, opened: true }
  }

  async read(input: NotionReadInput): Promise<unknown> {
    const { session, binding, fingerprint } = this.context()
    const service = await projectNotionService(session.workspace.rootPath, binding)
    if (input.children) return service.children(input.pageId)
    let host: { clientId: string; state: NotionHostState } | null = null
    try { host = await this.host('current') }
    catch (error) { if (!input.pageId) throw error }
    const pageId = input.pageId ? notionPageId(input.pageId) : host?.state.pageId
    if (!pageId) throw new Error('NOTION_NOT_OPEN: Open the target page in Stair first.')
    const doc = await service.read(pageId)
    this.target = null
    if (host?.state.pageId === pageId && host.state.revision) {
      this.target = { clientId: host.clientId, pageId, revision: host.state.revision, binding: fingerprint }
    }
    return { ...doc, current: host?.state.pageId === pageId }
  }

  async write(input: NotionWriteInput): Promise<unknown> {
    const { session, binding, fingerprint } = this.context()
    const target = this.target
    if (!target || target.pageId !== notionPageId(input.expectedPageId) || target.binding !== fingerprint) throw new Error('NOTION_TARGET_CHANGED: Read or open the current page before writing.')
    const service = await projectNotionService(session.workspace.rootPath, binding)
    try {
      return await service.write(input, async () => {
        if (this.context().fingerprint !== target.binding) throw new Error('NOTION_BINDING_CHANGED: Read the page again.')
        const host = await this.host('current', undefined, target.clientId)
        if (host.state.pageId !== target.pageId || host.state.revision !== target.revision) throw new Error('NOTION_PAGE_CHANGED: The page has switched. Read or open the intended page again.')
      })
    } catch (error) {
      if (String(error).includes('NOTION_WRITE_UNKNOWN') && this.target === target) this.target = null
      throw error
    }
  }
}
