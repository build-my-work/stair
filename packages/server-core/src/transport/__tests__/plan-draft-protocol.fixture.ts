import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
async function setup(id: string, holdContentMutationId?: string) {
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
  const contentWriteCommitted = Promise.withResolvers<void>()
  const releaseContentReply = Promise.withResolvers<void>()
  const handle = server.handle.bind(server)
  server.handle = (channel, handler) => handle(channel, async (ctx, ...args) => {
    calls.push(channel)
    const result = await handler(ctx, ...args)
    if (holdContentMutationId && channel === RPC_CHANNELS.drafts.SET_CONTENT
      && args[2]?.id === holdContentMutationId) {
      contentWriteCommitted.resolve()
      await releaseContentReply.promise
    }
    return result
  })
  const deps = { sessionManager: sm, platform: { logger: { info() {}, warn() {}, error() {} } } }
  registerSessionsHandlers(server, deps as never)
  registerSettingsHandlers(server, deps as never)
  sm.setEventSink(server.push.bind(server))
  await server.listen()
  const f = { id, sandbox, workspace, sm, managed, server, calls, contentWriteCommitted, releaseContentReply,
    sockets: [] as WebSocket[], clients: [] as InstanceType<typeof WsRpcClient>[] }
  fixtures.push(f)
  return f
}
afterAll(async () => {
  for (const f of fixtures) {
    f.releaseContentReply.resolve()
    for (const client of f.clients) client.destroy()
    for (const socket of f.sockets) socket.terminate()
    f.server.close()
  }
  await sessionPersistenceQueue.flushAll()
  for (const f of fixtures) rmSync(f.sandbox, { recursive: true, force: true })
})

test.each(['1.0', '2.0'])('an incompatible version-%s client cannot reach a pipelined draft or plan write', async legacyVersion => {
  const f = await setup(`old-plan-protocol-${legacyVersion}`)
  const draft = 'Preserve the draft from an incompatible renderer'
  setSessionDraftContent(f.id, { text: draft })
  const draftBefore = readFileSync(join(profile, 'drafts.json'), 'utf8')
  const sessionBefore = readFileSync(join(f.sandbox, 'sessions', f.id, 'session.jsonl'), 'utf8')
  const socket = new WebSocket(`ws://127.0.0.1:${f.server.port}`)
  f.sockets.push(socket)
  const envelopes: any[] = []
  const closed = new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Legacy handshake was not rejected')), 2_000)
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      envelopes.push(message)
      // An accidentally admitted peer should fail this test immediately,
      // after the pipelined write has actually reached the handler.
      if (message.type === 'response' && message.id === 'legacy-restore') socket.close()
    })
    socket.on('close', code => { clearTimeout(deadline); resolve(code) })
    socket.on('error', error => { clearTimeout(deadline); reject(error) })
    socket.on('open', () => {
      // Pipeline the dangerous old RPCs after its incompatible handshake.
      // Neither can run even if they were already buffered on the connection.
      socket.send(JSON.stringify({ id: 'legacy-handshake', type: 'handshake', protocolVersion: legacyVersion, workspaceId: f.workspace.id }))
      socket.send(JSON.stringify({ id: 'legacy-restore', type: 'request', channel: RPC_CHANNELS.drafts.RESTORE_INPUT,
        args: [f.id, { restoreId: 'input-incompatible-peer', draft: { text: 'MUST-NOT-BE-WRITTEN' } }] }))
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
  expect(readFileSync(join(profile, 'drafts.json'), 'utf8')).toBe(draftBefore)
  expect(readFileSync(join(f.sandbox, 'sessions', f.id, 'session.jsonl'), 'utf8')).toBe(sessionBefore)
}, 10_000)

test('a current client cannot send draft writes to a version-2 host', async () => {
  const childProfile = join(profile, 'version-2-host')
  mkdirSync(childProfile)
  copyFileSync(join(profile, 'config-defaults.json'), join(childProfile, 'config-defaults.json'))
  const ready = Promise.withResolvers<{ port: number; workspaceId: string; sessionId: string }>()
  const snapshot = Promise.withResolvers<{ calls: string[]; draftUnchanged: boolean; sessionUnchanged: boolean }>()
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'plan-draft-protocol-v2-host.fixture.ts')], {
    env: { ...process.env, CRAFT_CONFIG_DIR: childProfile }, stdout: 'pipe', stderr: 'pipe',
    ipc(message) {
      if (message.type === 'ready') ready.resolve(message)
      if (message.type === 'snapshot') snapshot.resolve(message)
    },
  })
  const exited = child.exited.then(async code => {
    if (code !== 0) throw new Error(`Version 2 peer exited (${code}): ${await new Response(child.stderr).text()}`)
    throw new Error('Version 2 peer exited before inspection')
  })
  void exited.catch(() => {})
  let client: InstanceType<typeof WsRpcClient> | undefined
  let socket: WebSocket | undefined
  try {
    const peer = await Promise.race([ready.promise, exited])
    const url = `ws://127.0.0.1:${peer.port}`
    const envelopes: any[] = []
    socket = new WebSocket(url)
    const closed = new Promise<number>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Current handshake was not rejected by version 2 host')), 2_000)
      socket!.on('message', raw => {
        const message = JSON.parse(raw.toString())
        envelopes.push(message)
        if (message.type === 'response' && message.id === 'current-restore') socket!.close()
      })
      socket!.on('close', code => { clearTimeout(deadline); resolve(code) })
      socket!.on('error', error => { clearTimeout(deadline); reject(error) })
      socket!.on('open', () => {
        socket!.send(JSON.stringify({ id: 'current-handshake', type: 'handshake', protocolVersion: PROTOCOL_VERSION, workspaceId: peer.workspaceId }))
        socket!.send(JSON.stringify({ id: 'current-restore', type: 'request', channel: RPC_CHANNELS.drafts.RESTORE_INPUT,
          args: [peer.sessionId, { restoreId: 'input-new-peer', draft: { text: 'MUST-NOT-BE-WRITTEN' } }] }))
      })
    })
    const closeCode = await closed
    // The production client also queues its RPC behind handshake acceptance;
    // a protocol error must reject it without ever releasing that request.
    client = new WsRpcClient(url, { workspaceId: peer.workspaceId, autoReconnect: false, requestTimeout: 2_000 })
    client.connect()
    const outcome = await client.invoke(RPC_CHANNELS.drafts.RESTORE_INPUT, peer.sessionId, {
      restoreId: 'input-client-new-peer', draft: { text: 'MUST-NOT-BE-WRITTEN' },
    }).then(() => ({ accepted: true as const }), error => ({ accepted: false as const, error }))
    child.send('inspect')
    const disk = await Promise.race([snapshot.promise, exited])
    expect(disk.calls).toEqual([])
    expect(disk.draftUnchanged).toBe(true)
    expect(disk.sessionUnchanged).toBe(true)
    expect(closeCode).toBe(4004)
    expect(envelopes.some(message => message.type === 'handshake_ack')).toBe(false)
    expect(envelopes.find(message => message.type === 'error')?.error?.code).toBe('PROTOCOL_VERSION_UNSUPPORTED')
    expect(outcome.accepted).toBe(false)
    if (outcome.accepted) throw new Error('Current client reached the incompatible host')
    expect(outcome.error.code).toBe('PROTOCOL_VERSION_UNSUPPORTED')
  } finally {
    client?.destroy()
    socket?.terminate()
    child.kill()
    await child.exited
    rmSync(childProfile, { recursive: true, force: true })
  }
}, 10_000)

test('minor protocol revisions remain compatible within the current major', async () => {
  const f = await setup('same-major-minor-revision')
  setSessionDraftContent(f.id, { text: 'READ-ONLY-MINOR-COMPATIBILITY' })
  const socket = new WebSocket(`ws://127.0.0.1:${f.server.port}`)
  f.sockets.push(socket)
  const envelopes: any[] = []
  const reply = new Promise<any>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Same-major peer was not admitted')), 2_000)
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      envelopes.push(message)
      if (message.id === 'minor-read' && message.type === 'response') { clearTimeout(deadline); resolve(message) }
      if (message.type === 'error') { clearTimeout(deadline); reject(new Error(message.error?.message)) }
    })
    socket.on('error', error => { clearTimeout(deadline); reject(error) })
    socket.on('open', () => {
      socket.send(JSON.stringify({ id: 'minor-handshake', type: 'handshake', protocolVersion: `${PROTOCOL_VERSION.split('.')[0]}.99`, workspaceId: f.workspace.id }))
      socket.send(JSON.stringify({ id: 'minor-read', type: 'request', channel: RPC_CHANNELS.drafts.GET, args: [f.id] }))
    })
  })
  expect((await reply).result?.text).toBe('READ-ONLY-MINOR-COMPATIBILITY')
  expect(envelopes.find(message => message.type === 'handshake_ack')?.protocolVersion).toBe(PROTOCOL_VERSION)
  expect(f.calls).toEqual([RPC_CHANNELS.drafts.GET])
}, 10_000)

test.each(['committed', 'not-committed', 'remote-before-commit', 'remote-after-commit', 'remote-without-commit'] as const)(
  'causal draft consumption survives %s over real RPC without losing another writer', async outcome => {
    const id = `causal-${outcome}`
    const pendingId = `pending-${id}`
    const f = await setup(id, pendingId)
    const writerId = `writer-${id}`
    const base = { text: 'ORIGINAL A', attachments: [{ path: join(f.sandbox, 'a.txt'), name: 'a.txt' }] }
    const submitted = { text: 'SUBMITTED B', attachments: [{ path: join(f.sandbox, 'b.txt'), name: 'b.txt' }] }
    const remote = { text: 'OTHER WINDOW C', attachments: [{ path: join(f.sandbox, 'c.txt'), name: 'c.txt' }] }
    const original = new WsRpcClient(`ws://127.0.0.1:${f.server.port}`, {
      workspaceId: f.workspace.id, autoReconnect: false, requestTimeout: 100,
    })
    const observer = new WsRpcClient(`ws://127.0.0.1:${f.server.port}`, {
      workspaceId: f.workspace.id, autoReconnect: false, requestTimeout: 2_000,
    })
    f.clients.push(original, observer)
    original.connect()
    observer.connect()
    const seeded = await original.invoke(RPC_CHANNELS.drafts.SET_CONTENT, f.id, base, {
      id: `seed-${id}`, clientId: 'seed-writer', sequence: 1, baseRevision: 0, base: { text: '' },
    })
    const pendingMutation = { id: pendingId, clientId: writerId, sequence: 1, baseRevision: seeded.revision, base }
    const local = { content: { text: '' }, mutation: {
      id: `consume-${id}`, clientId: writerId, sequence: 2, baseRevision: seeded.revision, base,
      pendingWrite: { content: submitted, mutation: pendingMutation },
    } }
    const hasRemote = outcome.startsWith('remote-')
    const commits = outcome === 'committed' || outcome === 'remote-before-commit' || outcome === 'remote-after-commit'
    if (outcome === 'remote-before-commit' || outcome === 'remote-without-commit') {
      await observer.invoke(RPC_CHANNELS.drafts.SET_CONTENT, f.id, remote, {
        id: `remote-${id}`, clientId: 'remote-writer', sequence: 1, baseRevision: seeded.revision, base,
      })
    }
    if (commits) {
      const lostReply = original.invoke(RPC_CHANNELS.drafts.SET_CONTENT, f.id, submitted, pendingMutation).catch(error => error)
      await f.contentWriteCommitted.promise
      // The production handler committed, but its reply misses the actual
      // client timeout. Consumption later replays the journal's exact nested
      // predecessor proof through a different live client connection.
      const lostResponse = await lostReply
      expect(lostResponse).toBeInstanceOf(Error)
      expect(lostResponse.message).toContain(`Request timeout: ${RPC_CHANNELS.drafts.SET_CONTENT}`)
      f.releaseContentReply.resolve()
    } else {
      original.destroy() // Unknown send outcome whose predecessor never reached the host.
    }
    if (outcome === 'remote-after-commit') {
      const state = await observer.invoke(RPC_CHANNELS.drafts.GET_ALL)
      await observer.invoke(RPC_CHANNELS.drafts.SET_CONTENT, f.id, remote, {
        id: `remote-${id}`, clientId: 'remote-writer', sequence: 1,
        baseRevision: state.revisions[f.id], base: state.drafts[f.id],
      })
    }
    if (outcome === 'committed') {
      const beforeInvalid = readFileSync(join(profile, 'drafts.json'), 'utf8')
      await expect(observer.invoke(RPC_CHANNELS.drafts.RESTORE_INPUT, f.id, {
        restoreId: `consume-${id}`, draft: { text: '' }, local: {
          ...local, mutation: { ...local.mutation, pendingWrite: { ...local.mutation.pendingWrite, content: { text: 'ALTERED PROOF' } } },
        },
      })).rejects.toThrow('DRAFT_REQUEST_CONFLICT')
      expect(readFileSync(join(profile, 'drafts.json'), 'utf8')).toBe(beforeInvalid)
    }
    const request = { restoreId: `consume-${id}`, draft: { text: '' }, local }
    const result = await observer.invoke(RPC_CHANNELS.drafts.RESTORE_INPUT, f.id, request)
    expect(result.committed).toBe(true)
    expect(result.localApplied).toBe(true)
    expect({ text: result.draft?.text ?? '', attachments: result.draft?.attachments ?? [] })
      .toEqual(hasRemote ? remote : { text: '', attachments: [] })
    expect({ text: getSessionDraft(f.id)?.text ?? '', attachments: getSessionDraft(f.id)?.attachments ?? [] })
      .toEqual(hasRemote ? remote : { text: '', attachments: [] })
    const beforeReplay = readFileSync(join(profile, 'drafts.json'), 'utf8')
    const duplicate = await observer.invoke(RPC_CHANNELS.drafts.RESTORE_INPUT, f.id, request)
    expect(duplicate.localApplied).toBe(false)
    expect(duplicate.draft).toEqual(result.draft)
    expect(readFileSync(join(profile, 'drafts.json'), 'utf8')).toBe(beforeReplay)
  }, 10_000,
)

test('a current client completes identified consumption, compaction and durable dispatch over real WS RPC', async () => {
  const f = await setup('current-plan-protocol')
  const client = new WsRpcClient(`ws://127.0.0.1:${f.server.port}`, { workspaceId: f.workspace.id, autoReconnect: false, requestTimeout: 2_000 })
  f.clients.push(client)
  client.connect()
  const text = 'Additional instructions survive the version-3 acceptance'
  const writerId = crypto.randomUUID()
  const write = await client.invoke(RPC_CHANNELS.drafts.SET_CONTENT, f.id, { text }, {
    id: crypto.randomUUID(), clientId: writerId, sequence: 1, baseRevision: 0, base: { text: '' },
  })
  expect(client.isConnected).toBe(true)
  expect(PROTOCOL_VERSION.split('.')[0]).toBe('3')
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
