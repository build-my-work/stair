import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'

const workspace = { id: 'workspace-test', rootPath: '/workspace-test' }
const context = { clientId: 'test', workspaceId: workspace.id, webContentsId: null }
const source = {
  id: 'notion-test', slug: 'notion', name: 'Notion', provider: 'notion',
  type: 'api' as const, enabled: true,
  api: { baseUrl: 'https://api.notion.com', authType: 'bearer' as const },
}
const createSource = mock(async (..._args: unknown[]) => source)
const saveCredential = mock(async (..._args: unknown[]) => {})
const deleteCredential = mock(async (..._args: unknown[]) => true)
const deleteSource = mock((..._args: unknown[]) => {})
const markAuthenticated = mock((..._args: unknown[]) => true)
const request = mock(async (..._args: unknown[]) => Response.json({ object: 'user' }))

mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: (id: string) => id === workspace.id ? workspace : null,
}))
mock.module('@craft-agent/shared/sources', () => ({
  createSource, deleteSource, markSourceAuthenticated: markAuthenticated,
  loadWorkspaceSources: () => [],
  loadSource: () => ({ config: source, workspaceId: workspace.id, workspaceRootPath: workspace.rootPath }),
  getSourceCredentialManager: () => ({ save: saveCredential, delete: deleteCredential }),
}))

const { registerSourcesHandlers } = await import('./sources')
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe('Notion Source preset connection', () => {
  beforeEach(() => {
    for (const fn of [createSource, saveCredential, deleteCredential, deleteSource, markAuthenticated, request]) fn.mockClear()
    saveCredential.mockImplementation(async () => {})
    request.mockImplementation(async () => Response.json({ object: 'user' }))
    globalThis.fetch = Object.assign(request, { preconnect() {} }) as typeof fetch
  })

  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle: (channel, handler) => { handlers.set(channel, handler) },
    push() {},
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  }
  registerSourcesHandlers(server, {
    platform: { logger: { info() {}, error() {} } },
  } as unknown as HandlerDeps)

  it('validates the token against Notion before creating a fixed API Source and saving to the vault', async () => {
    const connect = handlers.get('sources:connectNotion')
    expect(connect).toBeDefined()
    const result = await connect!(context, workspace.id, '  fixture-token  ')
    expect(result).toEqual(source)
    expect(request).toHaveBeenCalledWith('https://api.notion.com/v1/users/me', expect.objectContaining({
      method: 'GET', redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer fixture-token', 'Notion-Version': '2026-03-11' }),
    }))
    expect(createSource).toHaveBeenCalledWith(workspace.rootPath, expect.objectContaining({
      name: 'Notion', provider: 'notion', type: 'api',
      api: expect.objectContaining({
        baseUrl: 'https://api.notion.com', authType: 'bearer',
        defaultHeaders: { 'Notion-Version': '2026-03-11' },
        testEndpoint: { method: 'GET', path: '/v1/users/me' },
      }),
    }))
    expect(JSON.stringify(createSource.mock.calls)).not.toContain('fixture-token')
    expect(saveCredential).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: workspace.id }), { value: 'fixture-token' })
    expect(markAuthenticated).toHaveBeenCalledWith(workspace.rootPath, source.slug)
  })

  it('does not create a Source or save a credential for a rejected token', async () => {
    request.mockImplementation(async () => Response.json({ message: 'fixture-private-response' }, { status: 401 }))
    const connect = handlers.get('sources:connectNotion')!
    expect(connect).toBeDefined()
    await expect(connect(context, workspace.id, 'fixture-token')).rejects.toThrow('NOTION_AUTH_FAILED')
    expect(createSource).not.toHaveBeenCalled()
    expect(saveCredential).not.toHaveBeenCalled()
  })

  it('redacts transport errors and creates no Source when Notion is unavailable', async () => {
    request.mockImplementation(async () => { throw new Error('fixture-private-transport-error') })
    const connect = handlers.get('sources:connectNotion')!
    expect(connect).toBeDefined()
    await expect(connect(context, workspace.id, 'fixture-token')).rejects.toThrow('NOTION_UNAVAILABLE')
    expect(createSource).not.toHaveBeenCalled()
  })

  it('rejects an empty token or missing workspace without making a request', async () => {
    const connect = handlers.get('sources:connectNotion')!
    expect(connect).toBeDefined()
    await expect(connect(context, workspace.id, '  ')).rejects.toThrow('NOTION_TOKEN_REQUIRED')
    await expect(connect(context, 'missing', 'fixture-token')).rejects.toThrow('Workspace not found')
    expect(request).not.toHaveBeenCalled()
  })

  it('removes the newly created Source and credential when vault persistence fails', async () => {
    saveCredential.mockImplementation(async () => { throw new Error('vault unavailable') })
    const connect = handlers.get('sources:connectNotion')!
    expect(connect).toBeDefined()
    await expect(connect(context, workspace.id, 'fixture-token')).rejects.toThrow('NOTION_SAVE_FAILED')
    expect(deleteCredential).toHaveBeenCalled()
    expect(deleteSource).toHaveBeenCalledWith(workspace.rootPath, source.slug)
    expect(markAuthenticated).not.toHaveBeenCalled()
  })
})
