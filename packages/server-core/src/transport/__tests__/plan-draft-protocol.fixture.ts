import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const profile = process.env.CRAFT_CONFIG_DIR
if (!profile?.includes('stair-plan-protocol-profile-')) throw new Error('Disposable profile required')
const { CONFIG_DIR, getSessionDraft, setSessionDraftContent } = await import('@craft-agent/shared/config')
if (CONFIG_DIR !== profile) throw new Error('Profile imported before isolation')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { loadSession, saveSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { RPC_CHANNELS, PROTOCOL_VERSION } = await import('@craft-agent/shared/protocol')
const { SessionManager, createManagedSession } = await import('../../sessions/SessionManager')
const { registerSessionsHandlers } = await import('../../handlers/rpc/sessions')
const { registerSettingsHandlers } = await import('../../handlers/rpc/settings')
const { WsRpcServer } = await import('../server')
const { WsRpcClient } = await import('../client')

const fixtures: any[] = []
async function setup(id: string) {
  const sandbox = mkdtempSync(join(tmpdir(), 'stair-plan-protocol-workspace-'))
  const workspace = createWorkspaceAtPath(sandbox, 'Plan protocol compatibility tests')
  const sm: any = new SessionManager()
  const managed = createManagedSession({ id, name: 'Existing Chat', projectId: workspace.defaultProjectId }, { ...workspace, rootPath: sandbox }, { messagesLoaded: true })
  sm.sessions.set(id, managed)
  sm.decisionFeatureActive = () => false
  // Keep the durable approval queued so no provider process can be started.
  sm.processNextQueuedMessage = () => {}
  await saveSession({ id, name: 'Existing Chat', workspaceRootPath: sandbox, projectId: managed.projectId, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as never)
  const server = new WsRpcServer({ host: '127.0.0.1', port: 0 })
  const calls: string[] = []
  const handle = server.handle.bind(server)
  server.handle = (channel, handler) => handle(channel, (ctx, ...args) => {
    calls.push(channel)
    return handler(ctx, ...args)
  })
  const deps = { sessionManager: sm, platform: { logger: { info() {}, warn() {}, error() {} } } }
  registerSessionsHandlers(server, deps as never)
  registerSettingsHandlers(server, deps as never)
  sm.setEventSink(server.push.bind(server))
  await server.listen()
  const f = { id, sandbox, workspace, sm, managed, server, calls, sockets: [] as WebSocket[], clients: [] as InstanceType<typeof WsRpcClient>[] }
  fixtures.push(f)
  return f
}
afterAll(async () => {
  for (const f of fixtures) {
    for (const client of f.clients) client.destroy()
    for (const socket of f.sockets) socket.terminate()
    f.server.close()
  }
  await sessionPersistenceQueue.flushAll()
  for (const f of fixtures) rmSync(f.sandbox, { recursive: true, force: true })
})

test('an old clear-before-prepare client cannot reach either preparation or a blind draft write', async () => {
  const f = await setup('old-plan-protocol')
  const draft = 'Preserve the draft from an incompatible renderer'
  setSessionDraftContent(f.id, { text: draft })
  const socket = new WebSocket(`ws://127.0.0.1:${f.server.port}`)
  f.sockets.push(socket)
  const envelopes: any[] = []
  const closed = new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Legacy handshake was not rejected')), 2_000)
    socket.on('message', raw => envelopes.push(JSON.parse(raw.toString())))
    socket.on('close', code => { clearTimeout(deadline); resolve(code) })
    socket.on('error', error => { clearTimeout(deadline); reject(error) })
    socket.on('open', () => {
      // Pipeline the dangerous old RPCs after its real version-1 handshake.
      // Neither can run even if they were already buffered on the connection.
      socket.send(JSON.stringify({ id: 'legacy-handshake', type: 'handshake', protocolVersion: '1.0', workspaceId: f.workspace.id }))
      socket.send(JSON.stringify({ id: 'legacy-clear', type: 'request', channel: RPC_CHANNELS.drafts.SET_CONTENT, args: [f.id, { text: '' }] }))
      socket.send(JSON.stringify({ id: 'legacy-prepare', type: 'request', channel: RPC_CHANNELS.sessions.COMMAND, args: [f.id, { type: 'setPendingPlanExecution', planPath: '/plan.md', draftInputSnapshot: draft }] }))
    })
  })
  expect(await closed).toBe(4004)
  expect(envelopes.some(message => message.type === 'handshake_ack')).toBe(false)
  expect(envelopes.find(message => message.type === 'error')?.error?.code).toBe('PROTOCOL_VERSION_UNSUPPORTED')
  expect(f.server.getConnectedClientCount()).toBe(0)
  expect(f.calls).toEqual([])
  expect(f.sm.getPendingPlanExecution(f.id)).toBeNull()
  expect(getSessionDraft(f.id)?.text).toBe(draft)
  expect(loadSession(f.sandbox, f.id)?.pendingPlanExecution).toBeUndefined()
}, 10_000)

test('a current client completes identified consumption, compaction and durable dispatch over real WS RPC', async () => {
  const f = await setup('current-plan-protocol')
  const client = new WsRpcClient(`ws://127.0.0.1:${f.server.port}`, { workspaceId: f.workspace.id, autoReconnect: false, requestTimeout: 2_000 })
  f.clients.push(client)
  client.connect()
  const text = 'Additional instructions survive the version-2 acceptance'
  const writerId = crypto.randomUUID()
  const write = await client.invoke(RPC_CHANNELS.drafts.SET_CONTENT, f.id, { text }, {
    id: crypto.randomUUID(), clientId: writerId, sequence: 1, baseRevision: 0, base: { text: '' },
  })
  expect(client.isConnected).toBe(true)
  expect(PROTOCOL_VERSION.split('.')[0]).toBe('2')
  const approvalText = `Approved plan.\n\n${text}`
  const pending = await client.invoke(RPC_CHANNELS.sessions.COMMAND, f.id, {
    type: 'setPendingPlanExecution', planPath: '/plan.md', draftInputSnapshot: text, approvalText,
  })
  expect(pending.executionId).toBeTruthy()
  const consumed = await client.invoke(RPC_CHANNELS.sessions.COMMAND, f.id, {
    type: 'consumePendingPlanDraft', executionId: pending.executionId,
    local: { content: { text }, mutation: { id: crypto.randomUUID(), clientId: writerId, sequence: 2, baseRevision: write.revision, base: { text } } },
  })
  expect(consumed.receipt.text).toBe(true)
  expect(getSessionDraft(f.id)?.text ?? '').toBe('')
  const agent = {
    getModel: () => 'isolated-test-model', setAllSources() {}, getSessionId: () => undefined, isCompactionInFlight: () => false,
    chat: async function* () {
      yield { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' }
      yield { type: 'complete' }
    },
  }
  f.sm.getOrCreateAgent = async () => { f.managed.agent = agent as never; return agent }
  await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, f.id, '/compact', undefined, undefined, { planExecutionId: pending.executionId })
  for (let n = 0; n < 200 && (f.managed.isProcessing || f.sm.getPendingPlanExecution(f.id)?.awaitingCompaction); n++) await Bun.sleep(5)
  expect(f.managed.isProcessing).toBe(false)
  expect(f.sm.getPendingPlanExecution(f.id)?.awaitingCompaction).toBe(false)
  const dispatched = await client.invoke(RPC_CHANNELS.sessions.COMMAND, f.id, { type: 'dispatchPendingPlanExecution', executionId: pending.executionId })
  expect(dispatched).toEqual({ ok: true })
  await sessionPersistenceQueue.flushAll()
  const stored = loadSession(f.sandbox, f.id)!
  expect(stored.pendingPlanExecution?.executionDispatched).toBe(true)
  const approval = stored.messages.find(message => message.id === stored.pendingPlanExecution?.approvalMessageId)
  expect(approval?.content).toBe(approvalText)
  expect(approval?.isQueued).toBe(true)
  expect(f.managed.messageQueue).toHaveLength(1)
  expect(f.managed.messageQueue[0].messageId).toBe(approval?.id)
  expect(f.managed.messageQueue[0].message).toBe(approvalText)
  expect(f.calls).toContain(RPC_CHANNELS.drafts.SET_CONTENT)
  expect(f.calls).toContain(RPC_CHANNELS.sessions.COMMAND)
  expect(f.calls).toContain(RPC_CHANNELS.sessions.SEND_MESSAGE)
}, 10_000)
