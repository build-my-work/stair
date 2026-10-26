import { afterAll, afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandlerDeps } from '../handler-deps.ts'
import type { HandlerFn, RpcServer } from '../../transport/index.ts'

const profile = mkdtempSync(join(tmpdir(), 'stair-oauth-client-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(join(import.meta.dir, '../../../../../apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
writeFileSync(join(profile, 'config.json'), JSON.stringify({ workspaces: [], activeWorkspaceId: null, activeSessionId: null }))
const { addWorkspace } = await import('@craft-agent/shared/config')
const { getSourceCredentialManager } = await import('@craft-agent/shared/sources')
const { OAuthFlowStore } = await import('@craft-agent/shared/auth')
const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
const { registerOAuthHandlers } = await import('./oauth.ts')
const { cleanupRpcClientResources } = await import('./index.ts')
const workspacePath = join(profile, 'workspace')
mkdirSync(workspacePath)
const workspace = addWorkspace({ name: 'OAuth fixture', rootPath: workspacePath })
const sourcePath = join(workspacePath, 'sources/source')
mkdirSync(sourcePath, { recursive: true })
writeFileSync(join(sourcePath, 'config.json'), JSON.stringify({ id: 'fixture-source', slug: 'source', name: 'Source',
  type: 'mcp', enabled: true, mcp: { transport: 'http', url: 'https://example.test', authType: 'oauth' } }))
const credentials = getSourceCredentialManager()
const originalPrepare = credentials.prepareOAuth
const originalExchange = credentials.exchangeAndStore
const stores: InstanceType<typeof OAuthFlowStore>[] = []
const clients: string[] = []
afterEach(() => {
  while (clients.length) cleanupRpcClientResources(clients.pop()!)
  while (stores.length) stores.pop()!.dispose()
  credentials.prepareOAuth = originalPrepare
  credentials.exchangeAndStore = originalExchange
})
afterAll(() => rmSync(profile, { recursive: true, force: true }))

function harness() {
  const clientId = `client-${crypto.randomUUID()}`
  clients.push(clientId)
  const flowStore = new OAuthFlowStore()
  stores.push(flowStore)
  const handlers = new Map<string, HandlerFn>()
  const released: string[] = []
  const preparedClients: (string | undefined)[] = []
  let currentOwner: string | undefined
  let ownerCount = 0
  let prepareCount = 0
  let resumed = 0
  let terminal = 0
  const sessionManager = {
    prepareAuthRequest: async (_session: string, _request: string, _workspace: string, _source: string, caller?: string) => {
      preparedClients.push(caller)
      return currentOwner = `owner-${++ownerCount}`
    },
    isAuthRequestCurrent: (_session: string, _request: string, token: string) => token === currentOwner,
    releaseAuthRequestOwner: async (_session: string, _request: string, token: string) => {
      released.push(token)
      if (currentOwner === token) currentOwner = undefined
    },
    completeAuthRequestsForSource: async () => { resumed++; return ['session'] },
    completeAuthRequest: async () => { terminal++ },
  }
  credentials.prepareOAuth = async () => ({ authUrl: 'https://example.test/authorize', state: `state-${++prepareCount}`,
    codeVerifier: 'verifier', tokenEndpoint: 'https://example.test/token', clientId: 'provider-client',
    redirectUri: 'http://localhost/callback', provider: 'google' })
  credentials.exchangeAndStore = async () => ({ success: true })
  const server = { handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler), push() {} } as unknown as RpcServer
  registerOAuthHandlers(server, { sessionManager, oauthFlowStore: flowStore,
    platform: { logger: { info() {}, warn() {}, error() {} } } } as unknown as HandlerDeps)
  const context = { clientId, workspaceId: workspace.id, webContentsId: null }
  const start = (bound = true, restart = false) => handlers.get(RPC_CHANNELS.oauth.START)!(context, {
    sourceSlug: 'source', ...(bound ? { sessionId: 'session', authRequestId: 'request' } : {}), joinLive: true, restart,
  }) as Promise<any>
  const complete = (flow: any) => handlers.get(RPC_CHANNELS.oauth.COMPLETE)!(context, {
    flowId: flow.flowId, state: flow.state, code: 'code',
  }) as Promise<any>
  return { clientId, flowStore, sessionManager, released, preparedClients, start, complete,
    currentOwner: () => currentOwner, resumed: () => resumed, terminal: () => terminal, prepareCount: () => prepareCount }
}

test('disconnect during card preparation prevents flow publication and releases the exact returned owner', async () => {
  const f = harness()
  const gate = Promise.withResolvers<string>()
  f.sessionManager.prepareAuthRequest = async () => gate.promise
  f.sessionManager.isAuthRequestCurrent = () => true
  const starting = f.start()
  const failure = starting.catch(error => error)
  cleanupRpcClientResources(f.clientId)
  gate.resolve('delayed-owner')
  expect((await failure).message).toContain('DISCONNECTED')
  expect(f.prepareCount()).toBe(0)
  expect(f.released).toEqual(['delayed-owner'])
  expect(f.flowStore.getLiveForSource(workspace.id, 'source')).toBeNull()
  expect(f.terminal()).toBe(0)
})

test('disconnect during banner provider preparation also prevents flow publication', async () => {
  const f = harness()
  const prepare = credentials.prepareOAuth
  const gate = Promise.withResolvers<void>()
  credentials.prepareOAuth = async (...args) => { await gate.promise; return prepare(...args) }
  const starting = f.start(false)
  const failure = starting.catch(error => error)
  cleanupRpcClientResources(f.clientId)
  gate.resolve()
  expect((await failure).message).toContain('DISCONNECTED')
  expect(f.flowStore.getLiveForSource(workspace.id, 'source')).toBeNull()
})

test('disconnect during token exchange revokes the flow without completing or cancelling its durable card', async () => {
  const f = harness()
  const started = await f.start()
  expect(f.preparedClients).toEqual([f.clientId])
  const gate = Promise.withResolvers<{ success: boolean }>()
  credentials.exchangeAndStore = async () => gate.promise
  const completing = f.complete(started)
  cleanupRpcClientResources(f.clientId)
  expect(f.flowStore.getByState(started.state)).toBeNull()
  expect(f.released).toEqual(['owner-1'])
  gate.resolve({ success: true })
  expect((await completing).success).toBe(false)
  expect(f.resumed()).toBe(0)
  expect(f.terminal()).toBe(0)
  const retried = await f.start()
  expect(retried.state).not.toBe(started.state)
  expect(f.currentOwner()).toBe('owner-2')
})

test('late preparation after reconnect cannot publish a flow or release the successor owner', async () => {
  const f = harness()
  const prepare = credentials.prepareOAuth
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  credentials.prepareOAuth = async (...args) => { entered.resolve(); await gate.promise; return prepare(...args) }
  const oldStart = f.start()
  const oldFailure = oldStart.catch(error => error)
  await entered.promise
  cleanupRpcClientResources(f.clientId)
  credentials.prepareOAuth = prepare
  // A new explicit action may replace the old discovery wait without inheriting its scope.
  const newFlow = await f.start(true, true)
  gate.resolve()
  expect((await oldFailure).message).toContain('DISCONNECTED')
  expect(f.currentOwner()).toBe('owner-2')
  expect(f.flowStore.getByState(newFlow.state)?.authOwnerToken).toBe('owner-2')
  expect(f.released.every(token => token === 'owner-1')).toBe(true)
})
