import { afterAll, expect, mock, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = new URL('../../../..', import.meta.url).pathname
const profile = mkdtempSync(join(tmpdir(), 'stair-auth-continuation-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(join(repo, 'apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
const backend = await import('@craft-agent/shared/agent/backend')
const resolveBackendContext = backend.resolveBackendContext
const credentials = await import('@craft-agent/shared/credentials')
const originalCredentialManager = credentials.getCredentialManager
let credentialStore: { set: (...args: unknown[]) => Promise<void> } | undefined
mock.module('@craft-agent/shared/credentials', () => ({ ...credentials,
  getCredentialManager: () => credentialStore ?? originalCredentialManager(),
}))
let constructedAgent: any
mock.module('@craft-agent/shared/agent/backend', () => ({ ...backend,
  createBackendFromResolvedContext: () => {
    if (!constructedAgent) throw new Error('No controlled backend configured')
    return constructedAgent
  },
  resolveBackendContext: (...args: Parameters<typeof backend.resolveBackendContext>) => {
    const context = resolveBackendContext(...args)
    return { ...context, capabilities: { ...context.capabilities, needsHttpPoolServer: false } }
  },
}))
const { SessionManager, createManagedSession, setSessionPlatform } = await import('./SessionManager.ts')
setSessionPlatform({ appRootPath: repo, resourcesPath: profile, isPackaged: false, appVersion: 'test', isDebugMode: false,
  imageProcessor: { getMetadata: async () => null, process: async () => { throw new Error('Native image access forbidden') } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
})
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { loadSession, saveSession, sessionPersistenceQueue, getSessionAttachmentsPath } = await import('@craft-agent/shared/sessions')
const { storedToMessage } = await import('@craft-agent/core/types')
const workspacePath = join(profile, 'workspace')
mkdirSync(workspacePath)
const workspace = { ...createWorkspaceAtPath(workspacePath, 'Auth fixture'), rootPath: workspacePath }
const projectId = workspace.defaultProjectId!
afterAll(async () => { await sessionPersistenceQueue.flushAll(); rmSync(profile, { recursive: true, force: true }) })

async function fixture(id: string) {
  const request = { type: 'oauth' as const, requestId: `auth-${id}`, sessionId: id, sourceSlug: 'source-a', sourceName: 'Source A' }
  const references = [{ version: 1 as const, kind: 'web-selection' as const, projectId, url: 'https://example.test/auth',
    title: 'Auth source', quote: 'AUTH-REFERENCE', locator: { type: 'web-text-quote' as const, exact: 'AUTH-REFERENCE' } }]
  const dir = getSessionAttachmentsPath(workspacePath, id)
  mkdirSync(dir, { recursive: true })
  const storedPath = join(dir, 'marker.txt')
  writeFileSync(storedPath, 'AUTH-ATTACHMENT')
  const attachments = [{ id: 'attachment', name: 'marker.txt', type: 'text' as const, mimeType: 'text/plain', size: 15, storedPath }]
  const input = { text: 'AUTH-ORIGINAL-BODY', references, attachments }
  const record = { version: 1 as const, request, projectId, originMessageIds: ['original'], input,
    continuationMessageId: 'auth-continuation', phase: 'waiting' as const }
  await saveSession({ id, name: 'Auth fixture', projectId, sdkSessionId: 'persisted-sdk', workspaceRootPath: workspacePath,
    createdAt: 1, lastUsedAt: 1, pendingAuthContinuation: record,
    messages: [{ id: 'original', type: 'user', content: input.text, timestamp: 1, references, attachments },
      { id: 'auth-card', type: 'auth-request', content: 'Sign in', timestamp: 2,
        authRequestId: request.requestId, authRequestType: request.type, authSourceSlug: request.sourceSlug, authStatus: 'pending' }],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
  const manager = new SessionManager()
  const saved = loadSession(workspacePath, id)!
  const managed = createManagedSession({ ...saved, messages: undefined }, workspace, { messagesLoaded: false })
  ;(manager as any).sessions.set(id, managed)
  ;(manager as any).decisionFeatureActive = () => false
  const events: any[] = []
  manager.setEventSink((_channel, _destination, event) => { events.push(event) })
  const calls: Array<{ text: string; attachments: any[] }> = []
  const agent = { getModel: () => 'offline', setAllSources() {}, setSourceServers: async () => {},
    getSessionId: () => 'persisted-sdk', getSummarizeCallback: () => undefined, isCompactionInFlight: () => false, forceAbort() {},
    chat: (text: string, files: any[]) => (async function* () {
      calls.push({ text, attachments: files })
      yield { type: 'input_accepted' }
      yield { type: 'complete' }
    })(),
  }
  ;(manager as any).getOrCreateAgent = async () => { managed.agent = agent as any; return agent }
  const prepare = () => manager.prepareAuthRequest(id, request.requestId, workspace.id, request.sourceSlug)
  const complete = (token?: string) => manager.completeAuthRequest(id, {
    requestId: request.requestId, sourceSlug: request.sourceSlug, success: true,
  }, token)
  return { manager, managed, request, record, calls, events, agent, prepare, complete }
}

async function settle(f: Awaited<ReturnType<typeof fixture>>) {
  for (let i = 0; (f.managed.isProcessing || f.managed.pendingAuthDispatch) && i < 200; i++) await Bun.sleep(2)
  await f.manager.flushSession(f.managed.id)
}

test('a restarted explicit card restores full input to the actual backend once and persists its receipt', async () => {
  const f = await fixture('restart')
  expect(f.managed.pendingAuthRequest).toBeUndefined()
  expect(await f.manager.completeAuthRequestsForSource(workspace.id, 'source-a', {})).toEqual([])
  const token = await f.prepare()
  await Promise.all([f.complete(token), f.complete(token)])
  await settle(f)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.text).toContain('AUTH-ORIGINAL-BODY')
  expect(f.calls[0]!.text).toContain('AUTH-REFERENCE')
  expect(f.calls[0]!.attachments[0].text).toBe('AUTH-ATTACHMENT')
  const saved = loadSession(workspacePath, f.managed.id)!
  expect(saved.pendingAuthContinuation?.phase).toBe('delivered')
  const messages = saved.messages.map(storedToMessage)
  expect(messages.filter(message => message.role === 'user' && !message.hidden)).toHaveLength(1)
  expect(messages.find(message => message.id === 'auth-continuation')?.pendingDelivery).toBeUndefined()
  const cold = createManagedSession({ ...saved, messages: undefined }, workspace)
  ;(f.manager as any).sessions.set(cold.id, cold)
  await expect(f.prepare()).rejects.toThrow('AUTH_REQUEST_CANCELLED')
  await f.complete(token)
  expect(f.calls).toHaveLength(1)
})

test('warm SDK continuation is a result notice, not a second original request', async () => {
  const f = await fixture('warm')
  await (f.manager as any).ensureMessagesLoaded(f.managed)
  f.managed.pendingAuthRequest = f.request
  f.managed.pendingAuthRequestId = f.request.requestId
  f.managed.pendingAuthOwner = { generation: 0, stopEpoch: 0, token: 'warm-owner' }
  await f.complete('warm-owner')
  await settle(f)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.text).not.toContain('AUTH-ORIGINAL-BODY')
  expect(f.calls[0]!.text).toContain('Authentication completed')
})

test('Stop during durable prepare fences its delayed result and survives a restart', async () => {
  const f = await fixture('stop-prepare')
  const flush = (f.manager as any).flushSessionStrict.bind(f.manager)
  let release!: () => void
  let arrived!: () => void
  const started = new Promise<void>(resolve => { arrived = resolve })
  let first = true
  ;(f.manager as any).flushSessionStrict = async (id: string) => {
    if (first) { first = false; arrived(); await new Promise<void>(resolve => { release = resolve }) }
    return flush(id)
  }
  const preparing = f.prepare()
  const rejection = preparing.catch(error => error)
  await started
  await f.manager.cancelProcessing(f.managed.id)
  release()
  expect((await rejection).message).toContain('AUTH_REQUEST_CANCELLED')
  await f.complete()
  expect(f.calls).toHaveLength(0)
  expect(loadSession(workspacePath, f.managed.id)?.pendingAuthContinuation?.phase).toBe('cancelled')
})

test('new user input invalidates auth ownership before a late completion', async () => {
  const f = await fixture('new-input')
  const token = await f.prepare()
  await f.manager.sendMessage(f.managed.id, 'NEWER-USER-INPUT')
  await f.complete(token)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.text).toContain('NEWER-USER-INPUT')
  expect(f.managed.pendingAuthContinuation?.phase).toBe('cancelled')
})

test('cancelling an already admitted auth continuation during backend setup prevents delivery', async () => {
  const f = await fixture('auth-cancel-setup')
  const token = await f.prepare()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const send = f.manager.sendMessage.bind(f.manager)
  let oldRun: Promise<void> | undefined
  f.manager.sendMessage = (...args: Parameters<typeof send>) => { oldRun = send(...args); return oldRun }
  ;(f.manager as any).getOrCreateAgent = async () => { started.resolve(); await release.promise; f.managed.agent = f.agent as any; return f.agent }
  await f.complete(token)
  await started.promise
  await f.manager.completeAuthRequest(f.managed.id, { requestId: f.request.requestId, sourceSlug: 'source-a',
    success: false, cancelled: true }, token)
  expect(f.managed.pendingAuthDispatch).toBeUndefined()
  // The same cleanup used by Stop's timeout permits a successor even if the old
  // backend setup promise has not returned yet.
  await (f.manager as any).onProcessingStopped(f.managed.id, 'timeout', f.managed.processingGeneration)
  const next = { ...f.record, request: { ...f.request, requestId: 'next-auth' }, phase: 'waiting' as const }
  f.managed.pendingAuthContinuation = next
  f.managed.messages.push({ id: 'next-card', role: 'auth-request', content: 'Sign in again', timestamp: 4,
    authRequestId: 'next-auth', authRequestType: 'oauth', authSourceSlug: 'source-a', authStatus: 'pending' })
  const nextToken = await f.manager.prepareAuthRequest(f.managed.id, 'next-auth', workspace.id, 'source-a')
  release.resolve()
  await oldRun
  await settle(f)
  expect(f.calls).toHaveLength(0)
  expect(f.managed.pendingAuthOwner?.token).toBe(nextToken)
  expect(loadSession(workspacePath, f.managed.id)?.pendingAuthContinuation?.request.requestId).toBe('next-auth')
})

test('client disconnect during auth preparation revokes only runtime ownership and permits explicit retry', async () => {
  const f = await fixture('disconnect-prepare')
  const flush = (f.manager as any).flushSessionStrict.bind(f.manager)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let held = false
  ;(f.manager as any).flushSessionStrict = async (id: string) => {
    if (!held) { held = true; started.resolve(); await release.promise }
    await flush(id)
  }
  const preparing = f.manager.prepareAuthRequest(f.managed.id, f.request.requestId, workspace.id, 'source-a', 'disconnected-client')
  const outcome = preparing.catch(error => error)
  await started.promise
  const oldToken = f.managed.pendingAuthOwner!.token
  f.manager.onClientDisconnected('disconnected-client')
  release.resolve()
  expect((await outcome).message).toContain('AUTH_REQUEST_CANCELLED')
  await f.complete(oldToken)
  expect(f.calls).toHaveLength(0)
  expect(f.managed.pendingAuthOwner).toBeUndefined()
  await f.manager.flushSession(f.managed.id)
  expect(loadSession(workspacePath, f.managed.id)?.pendingAuthContinuation?.phase).toBe('waiting')
  const nextToken = await f.manager.prepareAuthRequest(f.managed.id, f.request.requestId, workspace.id, 'source-a', 'reconnected-client')
  expect(nextToken).not.toBe(oldToken)
  await f.complete(nextToken)
  await settle(f)
  expect(f.calls).toHaveLength(1)
})

test('client disconnect while the auth lifecycle lock waits cannot establish a late owner', async () => {
  const f = await fixture('disconnect-lock')
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = (f.manager as any).withSessionLifecycleLock(f.managed.id, async () => { started.resolve(); await release.promise })
  await started.promise
  const preparing = f.manager.prepareAuthRequest(f.managed.id, f.request.requestId, workspace.id, 'source-a', 'disconnected-client')
  const outcome = preparing.catch(error => error)
  f.manager.onClientDisconnected('disconnected-client')
  release.resolve()
  await held
  expect((await outcome).message).toContain('AUTH_REQUEST_CANCELLED')
  expect(f.managed.pendingAuthOwner).toBeUndefined()
  expect(f.managed.pendingAuthContinuation?.phase).toBe('waiting')
})

test('idempotent original retries and rejected payloads cannot cancel a pending auth card', async () => {
  const f = await fixture('auth-send-retry')
  const token = await f.prepare()
  const original = f.managed.messages.find(message => message.id === 'original')!
  original.clientMessageId = 'original-client-id'
  await f.manager.sendMessage(f.managed.id, original.content, undefined, original.attachments,
    { references: original.references, optimisticMessageId: original.clientMessageId })
  expect(f.calls).toHaveLength(0)
  expect(f.managed.pendingAuthOwner?.token).toBe(token)
  expect(f.managed.pendingAuthContinuation?.phase).toBe('waiting')
  await expect(f.manager.sendMessage(f.managed.id, 'CONFLICTING-CONTENT', undefined, undefined,
    { optimisticMessageId: original.clientMessageId })).rejects.toThrow('INPUT_ID_CONFLICT')
  await expect(f.manager.sendMessage(f.managed.id, 'INVALID-REFERENCE', undefined, undefined,
    { references: [{ ...f.record.input.references[0]!, projectId: 'wrong-project' }] })).rejects.toThrow()
  expect(f.managed.pendingAuthOwner?.token).toBe(token)
  expect(f.managed.messages.find(message => message.id === 'auth-card')?.authStatus).toBe('pending')
})

test('a successful retry replaces a failed ready notice while keeping the continuation id', async () => {
  const f = await fixture('auth-result-retry')
  const token = await f.prepare()
  const chat = f.agent.chat
  f.agent.chat = () => (async function* () { yield { type: 'complete' } })()
  await f.manager.completeAuthRequest(f.managed.id, { requestId: f.request.requestId, sourceSlug: 'source-a',
    success: false, error: 'FIRST-FAILED-EXCHANGE' }, token)
  await settle(f)
  expect(f.managed.messages.find(message => message.id === 'auth-continuation')?.content).toContain('FIRST-FAILED-EXCHANGE')
  f.agent.chat = chat
  const retryToken = await f.prepare()
  await f.complete(retryToken)
  await settle(f)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.text).toContain('Authentication completed')
  expect(f.calls[0]!.text).not.toContain('FIRST-FAILED-EXCHANGE')
  expect(f.managed.messages.filter(message => message.id === 'auth-continuation')).toHaveLength(1)
})

test('failed auth result persistence reports failure, leaves the card recoverable and sends nothing', async () => {
  const f = await fixture('failed-write')
  const token = await f.prepare()
  const flush = (f.manager as any).flushSessionStrict.bind(f.manager)
  ;(f.manager as any).flushSessionStrict = async () => { throw new Error('Injected disk failure') }
  await expect(f.complete(token)).rejects.toThrow('Injected disk failure')
  expect(f.calls).toHaveLength(0)
  expect(f.managed.pendingAuthContinuation?.phase).toBe('waiting')
  expect(f.managed.messages.find(message => message.id === 'auth-card')?.authStatus).toBe('pending')
  expect(f.events.some(event => event.type === 'auth_completed')).toBe(false)
  ;(f.manager as any).flushSessionStrict = flush
  await f.complete(token)
  await settle(f)
  expect(f.calls).toHaveLength(1)
})

test('a stale owner, changed Project, and legacy cards without an origin cannot resume', async () => {
  const f = await fixture('scope')
  const token = await f.prepare()
  await f.complete('older-owner')
  expect(f.calls).toHaveLength(0)
  await expect(f.manager.prepareAuthRequest(f.managed.id, f.request.requestId, 'other-workspace', 'source-a')).rejects.toThrow('SCOPE_MISMATCH')
  f.managed.projectId = 'other-project'
  await expect(f.prepare()).rejects.toThrow('AUTH_REQUEST_CANCELLED')
  await f.complete(token)
  expect(f.calls).toHaveLength(0)
  f.managed.projectId = projectId
  f.managed.pendingAuthContinuation = undefined
  await expect(f.prepare()).rejects.toThrow('AUTH_CONTINUATION_UNAVAILABLE')
  expect(f.managed.messages.find(message => message.id === 'auth-card')?.authStatus).toBe('pending')
})

test('a restarted credential card explicitly acquires ownership before cancellation', async () => {
  const f = await fixture('credential-cancel')
  const record = f.managed.pendingAuthContinuation!
  record.request = { ...record.request, type: 'credential', mode: 'bearer' }
  expect(await f.manager.respondToCredential(f.managed.id, f.request.requestId, { type: 'credential', cancelled: true }, 'credential-client')).toBe(true)
  expect(f.managed.pendingAuthOwner).toBeUndefined()
  expect(f.calls).toHaveLength(0)
  expect(loadSession(workspacePath, f.managed.id)?.pendingAuthContinuation?.phase).toBe('cancelled')
})

test('credential RPC disconnect during storage leaves a pending historical card without a late continuation', async () => {
  const f = await fixture('credential-disconnect')
  f.managed.pendingAuthContinuation!.request = { ...f.request, type: 'credential', mode: 'bearer' }
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const written: unknown[][] = []
  credentialStore = { set: async (...args: unknown[]) => { written.push(args); started.resolve(); await release.promise } }
  const { registerSessionsHandlers } = await import('../handlers/rpc/sessions.ts')
  const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
  const handlers = new Map<string, (...args: any[]) => any>()
  registerSessionsHandlers({ handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } as any,
    { sessionManager: f.manager, platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } } } as any)
  const submitting = handlers.get(RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL)!({ clientId: 'credential-client', workspaceId: workspace.id },
    f.managed.id, f.request.requestId, { type: 'credential', value: 'CONTROLLED-NONSECRET', cancelled: false })
  await started.promise
  f.manager.onClientDisconnected('credential-client')
  release.resolve()
  expect(await submitting).toBe(true)
  credentialStore = undefined
  await f.manager.flushSession(f.managed.id)
  expect(written).toHaveLength(1)
  expect(f.calls).toHaveLength(0)
  expect(f.managed.pendingAuthOwner).toBeUndefined()
  expect(loadSession(workspacePath, f.managed.id)?.pendingAuthContinuation?.phase).toBe('waiting')
  expect(f.managed.messages.find(message => message.id === 'auth-card')?.authStatus).toBe('pending')
})

test('an unconfirmed auth continuation survives restart without automatic replay and reuses its identity', async () => {
  const f = await fixture('ready-restart')
  await (f.manager as any).ensureMessagesLoaded(f.managed)
  f.managed.pendingAuthRequest = f.request
  f.managed.pendingAuthRequestId = f.request.requestId
  f.managed.pendingAuthOwner = { generation: 0, stopEpoch: 0, token: 'warm-owner' }
  const chat = f.agent.chat
  f.agent.chat = () => (async function* () { yield { type: 'complete' } })()
  await f.complete('warm-owner')
  await settle(f)
  const warmRow = f.managed.messages.find(message => message.id === 'auth-continuation')!
  expect(warmRow.pendingDelivery).toBe(true)
  expect(warmRow.content).not.toContain('AUTH-ORIGINAL-BODY')
  expect(warmRow.references).toBeUndefined()
  f.agent.chat = chat
  const saved = loadSession(workspacePath, f.managed.id)!
  const cold = createManagedSession({ ...saved, messages: undefined }, workspace, { messagesLoaded: false })
  ;(f.manager as any).sessions.set(cold.id, cold)
  ;(f.manager as any).getOrCreateAgent = async () => { cold.agent = f.agent as any; return f.agent }
  await (f.manager as any).ensureMessagesLoaded(cold)
  await Bun.sleep(10)
  expect(f.calls).toHaveLength(0)
  expect(cold.messageQueue).toHaveLength(0)
  expect(cold.messages.find(message => message.id === 'auth-card')?.authStatus).toBe('pending')
  const token = await f.prepare()
  await f.complete(token)
  for (let i = 0; cold.isProcessing && i < 200; i++) await Bun.sleep(2)
  await f.manager.flushSession(cold.id)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.text).toContain('AUTH-ORIGINAL-BODY')
  expect(f.calls[0]!.text).toContain('AUTH-REFERENCE')
  expect(f.calls[0]!.attachments[0]?.text).toBe('AUTH-ATTACHMENT')
  expect(cold.messages.filter(message => message.id === 'auth-continuation')).toHaveLength(1)
  expect(loadSession(workspacePath, cold.id)?.pendingAuthContinuation?.phase).toBe('delivered')
})

test('a failed receipt write keeps live delivery retired and retries the same durable image', async () => {
  const f = await fixture('receipt-write')
  const token = await f.prepare()
  const flush = (f.manager as any).flushSessionStrict.bind(f.manager)
  let failedReceipt = false
  ;(f.manager as any).flushSessionStrict = async (id: string) => {
    if (!failedReceipt && f.managed.pendingAuthContinuation?.phase === 'delivered') {
      failedReceipt = true
      const row = f.managed.messages.find(message => message.id === 'auth-continuation')
      expect(row?.pendingDelivery).toBeUndefined()
      throw new Error('Injected receipt write failure')
    }
    await flush(id)
  }
  await f.complete(token)
  await settle(f)
  await f.complete(token)
  expect(failedReceipt).toBe(true)
  expect(f.calls).toHaveLength(1)
  expect(f.managed.pendingAuthOwner).toBeUndefined()
  expect(loadSession(workspacePath, f.managed.id)?.pendingAuthContinuation?.phase).toBe('delivered')
})

test('Stop during new setup cannot reuse the previous backend receipt', async () => {
  const f = await fixture('stop-setup')
  const setup = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let receipts = 0
  const agent = Object.assign(f.agent, { stopTurn: () => false,
    settleStoppedTurnInput: async () => { receipts++; return true } })
  f.managed.agent = agent as any
  f.managed.foregroundInputOwner = { agent: agent as any, generation: 0 }
  ;(f.manager as any).getOrCreateAgent = async () => { setup.resolve(); await release.promise; return agent }
  const sending = f.manager.sendMessage(f.managed.id, 'NEW-UNDELIVERED-BODY')
  await setup.promise
  await f.manager.cancelProcessing(f.managed.id)
  release.resolve()
  await sending
  expect(receipts).toBe(0)
  expect(f.calls).toHaveLength(0)
  expect(f.events.some(event => event.type === 'interrupted' && event.queuedMessages?.includes('NEW-UNDELIVERED-BODY'))).toBe(true)
  const input = f.managed.messages.find(message => message.content === 'NEW-UNDELIVERED-BODY')
  expect(input?.queuedRestoreId).toBeDefined()
})

for (const delivered of [true, false]) {
  test(`Stop waits for the matching late receipt before ${delivered ? 'retiring' : 'restoring'} input`, async () => {
    const f = await fixture(`stop-receipt-${delivered}`)
    const started = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    const receipt = Promise.withResolvers<boolean>()
    const agent = Object.assign(f.agent, {
      chat: () => (async function* () { started.resolve(); await stopped.promise; yield { type: 'complete' } })(),
      stopTurn: () => { stopped.resolve(); return true },
      settleStoppedTurnInput: () => receipt.promise,
    })
    ;(f.manager as any).getOrCreateAgent = async () => { f.managed.agent = agent as any; return agent }
    const sending = f.manager.sendMessage(f.managed.id, 'STOP-CORRELATED-BODY')
    await started.promise
    const cancelling = f.manager.cancelProcessing(f.managed.id)
    await Bun.sleep(10)
    expect(f.events.some(event => event.type === 'interrupted')).toBe(false)
    expect(f.managed.isProcessing).toBe(true)
    receipt.resolve(delivered)
    await Promise.all([sending, cancelling])
    const row = f.managed.messages.find(message => message.content === 'STOP-CORRELATED-BODY')
    expect(row?.pendingDelivery).toBeUndefined()
    expect(!!row?.queuedRestoreId).toBe(!delivered)
    expect(f.events.some(event => event.type === 'interrupted' && event.queuedMessages?.includes('STOP-CORRELATED-BODY'))).toBe(!delivered)
    await f.manager.flushSession(f.managed.id)
    expect(!!loadSession(workspacePath, f.managed.id)?.messages.find(message => message.id === row?.id)?.queuedRestoreId).toBe(!delivered)
  })
}

test('a late delivered plan approval stays retired even if Stop cannot persist the first receipt', async () => {
  const f = await fixture('stop-plan-write')
  const started = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  const receipt = Promise.withResolvers<boolean>()
  const agent = Object.assign(f.agent, {
    chat: () => (async function* () { started.resolve(); await stopped.promise; yield { type: 'complete' } })(),
    stopTurn: () => { stopped.resolve(); return true },
    settleStoppedTurnInput: () => receipt.promise,
  })
  ;(f.manager as any).getOrCreateAgent = async () => { f.managed.agent = agent as any; return agent }
  const sending = f.manager.sendMessage(f.managed.id, 'PLAN-APPROVAL')
  await started.promise
  const approvalId = f.managed.lastSentMessageIds![0]!
  f.managed.pendingPlanExecution = { planPath: '/plan.md', executionId: 'accepted-execution', approvalMessageId: approvalId,
    executionDispatched: true, awaitingCompaction: false, draftInputSnapshot: 'PLAN-EXTRA-CONTEXT' }
  ;(f.manager as any).persistSession(f.managed)
  await f.manager.flushSession(f.managed.id)
  const flush = (f.manager as any).flushSessionStrict.bind(f.manager)
  let failed = false
  ;(f.manager as any).flushSessionStrict = async (id: string) => {
    if (!failed && !f.managed.pendingPlanExecution) { failed = true; throw new Error('Injected Stop receipt failure') }
    await flush(id)
  }
  const cancelling = f.manager.cancelProcessing(f.managed.id)
  receipt.resolve(true)
  await Promise.all([sending, cancelling])
  await f.manager.flushSession(f.managed.id)
  expect(failed).toBe(true)
  expect(f.managed.pendingPlanExecution).toBeUndefined()
  expect(f.managed.messages.find(message => message.id === approvalId)?.queuedRestoreId).toBeUndefined()
  expect(f.events.some(event => event.type === 'interrupted' && event.queuedMessages?.length)).toBe(false)
  expect(loadSession(workspacePath, f.managed.id)?.pendingPlanExecution).toBeUndefined()
  expect(loadSession(workspacePath, f.managed.id)?.messages.find(message => message.id === approvalId)?.pendingDelivery).toBeUndefined()
})

test('the actual auth callback snapshots input durably and rejects stopped or replaced backend callbacks', async () => {
  const f = await fixture('auth-callback')
  await (f.manager as any).ensureMessagesLoaded(f.managed)
  f.managed.pendingAuthContinuation = undefined
  constructedAgent = Object.assign(f.agent, { postInit: async () => ({}), setPermissionMode() {}, interruptForHandoff() {} })
  const agent = await (SessionManager.prototype as any).getOrCreateAgent.call(f.manager, f.managed)
  f.managed.isProcessing = true
  f.managed.processingGeneration = 1
  f.managed.lastSentMessage = f.record.input.text
  f.managed.lastSentMessageIds = ['original']
  f.managed.lastSentStoredAttachments = f.record.input.attachments
  f.managed.lastSentOptions = { references: f.record.input.references, skillSlugs: ['selected-skill'], thinkingLevel: 'high' }
  f.managed.foregroundInputOwner = { agent, generation: 1 }
  f.managed.pendingAuthDispatch = Promise.resolve()
  const request = { ...f.request, requestId: 'fresh-auth-card' }
  agent.onAuthRequest(request)
  expect(f.managed.pendingAuthDispatch).toBeUndefined()
  await f.manager.flushSession(f.managed.id)
  await Bun.sleep(1)
  const saved = loadSession(workspacePath, f.managed.id)!
  expect(saved.pendingAuthContinuation?.input).toMatchObject({ ...f.record.input, skillSlugs: ['selected-skill'], thinkingLevel: 'high' })
  expect(f.events.some(event => event.type === 'auth_request' && event.request.requestId === request.requestId)).toBe(true)
  await f.manager.cancelProcessing(f.managed.id)
  agent.onAuthRequest({ ...request, requestId: 'late-stopped-card' })
  expect(loadSession(workspacePath, f.managed.id)?.pendingAuthContinuation?.phase).toBe('cancelled')
  expect(f.managed.messages.some(message => message.authRequestId === 'late-stopped-card')).toBe(false)
  f.managed.isProcessing = true
  f.managed.agent = { ...agent } as any
  f.managed.foregroundInputOwner = { agent: f.managed.agent!, generation: 1 }
  agent.onAuthRequest({ ...request, requestId: 'late-replaced-card' })
  expect(f.managed.messages.some(message => message.authRequestId === 'late-replaced-card')).toBe(false)
  f.managed.isProcessing = false
  await f.managed.mcpPool?.disconnectAll()
  constructedAgent = undefined
})
