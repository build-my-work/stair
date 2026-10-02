import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentEvent, Reference, StoredAttachment } from '@craft-agent/core/types'
import type { AgentBackend, BackendConfig } from '@craft-agent/shared/agent/backend'
import type { FileAttachment } from '@craft-agent/shared/utils/files'
import type { StoredSession } from '@craft-agent/shared/sessions'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import type { HandlerDeps } from '../handlers/handler-deps'
import type { RpcServer } from '../transport'

// Resolve config only inside this child, after the profile is seeded.
const configDir = mkdtempSync(join(tmpdir(), 'runtime-turn-ownership-profile-'))
process.env.CRAFT_CONFIG_DIR = configDir
copyFileSync(
  resolve(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'),
  join(configDir, 'config-defaults.json'),
)
const connection = {
  slug: 'owned-runtime',
  name: 'Owned runtime',
  providerType: 'pi_compat',
  authType: 'api_key_with_endpoint',
  baseUrl: 'https://runtime-ownership.invalid',
  piAuthProvider: 'openai',
  customEndpoint: { api: 'openai-completions' },
  defaultModel: 'model-old',
  models: [
    { id: 'model-old', name: 'Old', contextWindow: 64_000, supportsImages: false },
    { id: 'model-new', name: 'New', contextWindow: 128_000, supportsImages: true },
  ],
  createdAt: 1,
} as const

// Seal model classification only; the host still establishes deferred titles.
mock.module(join(import.meta.dir, '../decisions/smart-titles.ts'), () => ({
  isSmallTalk: async (message: string) => message === 'hi',
  titleNoLongerFits: async () => false,
  TITLE_DRIFT_RECENT_MESSAGES: 3,
}))
const { SessionManager, createManagedSession, setSessionPlatform } = await import('./SessionManager.ts')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSessionStrict, loadSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { addWorkspace, updateLlmConnection, setSessionDraft, CONFIG_DIR } = await import('@craft-agent/shared/config')
const { registerFilesHandlers } = await import('../handlers/rpc/files.ts')
const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
const { resolveBackendContext } = await import('@craft-agent/shared/agent/backend')
const { buildBackendRuntimeSignature, buildRestartRequiredSignature } = await import('./runtime-config.ts')
const { PiAgent } = await import('@craft-agent/shared/agent/pi-agent')
const { getSessionScopedToolCallbacks } = await import('@craft-agent/shared/agent/session-scoped-tools')
if (CONFIG_DIR !== configDir) throw new Error('Runtime ownership fixture needs an isolated config cache')
setSessionPlatform({
  appRootPath: resolve(import.meta.dir, '../../../..'),
  resourcesPath: configDir,
  isPackaged: false,
  appVersion: 'test',
  imageProcessor: {
    getMetadata: async () => null,
    process: async () => { throw new Error('Native image boundary forbidden in this fixture') },
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  isDebugMode: false,
})

type ManagedSession = ReturnType<typeof createManagedSession>
type DecisionResult = { thinkingOverride: null; suggestionHint: null }
interface RuntimeHarness {
  sessions: Map<string, ManagedSession>
  decisionFeatureActive(): boolean
  startPreTurnDecisions(): Promise<DecisionResult> | null
  getOrCreateAgent(managed: ManagedSession): Promise<AgentBackend>
  generateTitle(managed: ManagedSession, message: string): Promise<void>
  disposeManagedAgentRuntime(managed: ManagedSession, reason: string): Promise<void>
}
const fixtures: Array<{ root: string; sm: InstanceType<typeof SessionManager>; managed: ManagedSession }> = []
afterAll(async () => {
  for (const fixture of fixtures) {
    await (fixture.sm as unknown as RuntimeHarness).disposeManagedAgentRuntime(fixture.managed, 'fixture cleanup')
  }
  await sessionPersistenceQueue.flushAll()
  for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})
beforeEach(() => {
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    defaultLlmConnection: connection.slug,
    llmConnections: [connection],
  }))
})

test('idle Pi refresh applies the new model and capability without replacing its runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-idle-workspace-'))
  const workspace = { ...createWorkspaceAtPath(root, 'Runtime idle'), rootPath: root }
  const sm = new SessionManager()
  const harness = sm as unknown as RuntimeHarness
  const managed = createManagedSession(
    { id: 'idle-runtime', projectId: workspace.defaultProjectId, llmConnection: connection.slug },
    workspace,
    { messagesLoaded: true },
  )
  harness.sessions.set(managed.id, managed)
  const context = resolveBackendContext({ sessionConnectionSlug: connection.slug })
  managed.backendRuntimeSignature = buildBackendRuntimeSignature(context)
  managed.backendRestartSignature = buildRestartRequiredSignature(context)
  const agent = new PiAgent({
    provider: 'pi', providerType: connection.providerType, authType: 'api_key',
    model: context.resolvedModel, workspace,
    session: { id: managed.id, workspaceRootPath: root, projectId: managed.projectId, createdAt: 1, lastUsedAt: 1 }, isHeadless: true,
    runtime: { baseUrl: connection.baseUrl, piAuthProvider: connection.piAuthProvider, customEndpoint: connection.customEndpoint },
  })
  managed.agent = agent
  fixtures.push({ root, sm, managed })
  expect(updateLlmConnection(connection.slug, { defaultModel: 'model-new' })).toBe(true)
  await sm.refreshConnectionRuntime(connection.slug)
  expect(managed.agent).toBe(agent)
  expect(agent.getModel()).toBe('model-new')
  expect(managed.backendRuntimeSignature).toBe(buildBackendRuntimeSignature(resolveBackendContext({ sessionConnectionSlug: connection.slug })))
  const config = Object.getOwnPropertyDescriptor(agent, 'config')!.value as BackendConfig
  expect(config.runtime?.customModels).toContainEqual({ id: 'model-new', contextWindow: 128_000, supportsImages: true })
})

test('SAVE during pre-turn decisions waits for the next turn before recreating its captured Pi agent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-owned-workspace-'))
  const workspace = { ...createWorkspaceAtPath(root, 'Runtime owner'), rootPath: root }
  const sm = new SessionManager()
  const harness = sm as unknown as RuntimeHarness
  const managed = createManagedSession(
    { id: 'owned-runtime', name: 'Existing chat', projectId: workspace.defaultProjectId, llmConnection: connection.slug },
    workspace,
    { messagesLoaded: true },
  )
  harness.sessions.set(managed.id, managed)
  fixtures.push({ root, sm, managed })
  sm.setEventSink(() => {})
  harness.decisionFeatureActive = () => false
  await saveSessionStrict({
    id: managed.id, name: 'Existing chat', workspaceRootPath: root, projectId: managed.projectId,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  const context = resolveBackendContext({ sessionConnectionSlug: connection.slug })
  managed.backendRuntimeSignature = buildBackendRuntimeSignature(context)
  managed.backendRestartSignature = buildRestartRequiredSignature(context)
  const agent = new PiAgent({
    provider: 'pi', providerType: connection.providerType, authType: 'api_key',
    model: context.resolvedModel, workspace,
    session: { id: managed.id, workspaceRootPath: root, projectId: managed.projectId, createdAt: 1, lastUsedAt: 1 }, isHeadless: true,
    runtime: { baseUrl: connection.baseUrl, piAuthProvider: connection.piAuthProvider, customEndpoint: connection.customEndpoint },
  })
  managed.agent = agent
  let disposed = false
  const originalDispose = agent.disposeForRestart.bind(agent)
  agent.disposeForRestart = async () => { await originalDispose(); disposed = true }
  const entered = Promise.withResolvers<void>()
  const decision = Promise.withResolvers<DecisionResult>()
  harness.startPreTurnDecisions = () => decision.promise
  const actualGet = harness.getOrCreateAgent.bind(sm)
  const turns: Array<{ agent: AgentBackend; disposed: boolean; model: string; provider: string | undefined; hostOwnsAgent: boolean }> = []
  harness.getOrCreateAgent = async (session) => {
    const selected = await actualGet(session)
    // Keep the real factory/BaseAgent preflight. Only model execution is sealed.
    Object.defineProperty(selected, 'chatImpl', { configurable: true, value: async function* (): AsyncGenerator<AgentEvent> {
      const config = Object.getOwnPropertyDescriptor(selected, 'config')!.value as BackendConfig
      const provider = config.runtime?.piAuthProvider
      turns.push({ agent: selected, disposed: selected === agent && disposed, model: selected.getModel(), provider: typeof provider === 'string' ? provider : undefined, hostOwnsAgent: managed.agent === selected })
      yield { type: 'complete' }
    } })
    entered.resolve()
    return selected
  }
  const sending = sm.sendMessage(managed.id, 'Explain these changes')
  await entered.promise
  expect(managed.isProcessing).toBe(true)
  expect(agent.isProcessing()).toBe(false)
  expect(updateLlmConnection(connection.slug, { piAuthProvider: 'anthropic', customEndpoint: { api: 'anthropic-messages' }, defaultModel: 'model-new' })).toBe(true)
  await sm.refreshConnectionRuntime(connection.slug)
  expect(disposed).toBe(false)
  expect(managed.agent).toBe(agent)
  expect(agent.getModel()).toBe('model-old')
  decision.resolve({ thinkingOverride: null, suggestionHint: null })
  await sending
  expect(turns).toHaveLength(1)
  expect(turns[0]).toMatchObject({ agent, disposed: false, model: 'model-old', provider: 'openai', hostOwnsAgent: true })

  harness.startPreTurnDecisions = () => null
  await sm.sendMessage(managed.id, 'Continue using the saved connection')
  expect(disposed).toBe(true)
  expect(turns).toHaveLength(2)
  expect(turns[1]).toMatchObject({ disposed: false, model: 'model-new', provider: 'anthropic', hostOwnsAgent: true })
  expect(turns[1]!.agent).not.toBe(agent)
  expect(getSessionScopedToolCallbacks(managed.id)).toBeDefined()
  await sm.flushSession(managed.id)
}, 10_000)

async function coldLegacyFixture(path: 'getSession' | 'flagSession') {
  const root = mkdtempSync(join(tmpdir(), 'runtime-cold-legacy-workspace-'))
  const workspace = { ...createWorkspaceAtPath(root, 'Legacy FIFO'), rootPath: root }
  const id = `cold-legacy-${path}-${fixtures.length}`
  const bId = `${id}-approval`
  const cId = `${id}-following`
  const bReference: Reference = {
    version: 1, kind: 'web-selection', projectId: workspace.defaultProjectId,
    url: 'https://runtime-fifo.invalid/legacy-b', title: 'Approved source', quote: 'B-QUOTE',
    locator: { type: 'web-text-quote', exact: 'B-QUOTE' },
  }
  const cReference: Reference = {
    ...bReference, url: 'https://runtime-fifo.invalid/legacy-c', quote: 'C-QUOTE',
    locator: { type: 'web-text-quote', exact: 'C-QUOTE' },
  }
  const stored: StoredAttachment = {
    id: `${id}-notes`, type: 'text', name: 'notes.txt', mimeType: 'text/plain', size: 12,
    storedPath: join(root, 'sessions', id, 'attachments', `${id}-notes_notes.txt`),
  }
  mkdirSync(join(root, 'sessions', id, 'attachments'), { recursive: true })
  writeFileSync(stored.storedPath, 'queued notes')
  await saveSessionStrict({
    id, name: 'Existing chat', workspaceRootPath: root, projectId: workspace.defaultProjectId,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  // Preserve the real durable consumption proof paired with this old header.
  const preparation = new SessionManager()
  const preparing = createManagedSession({ id, name: 'Existing chat', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
  ;(preparation as unknown as RuntimeHarness).sessions.set(id, preparing)
  const prepared = await preparation.setPendingPlanExecution(id, '/accepted.md', 'B context', [bReference], 'B-OLDER-APPROVAL')
  if (!prepared.executionId) throw new Error('Prepared legacy fixture needs an execution identity')
  setSessionDraft(id, { text: 'B context', references: [bReference] })
  expect((await preparation.consumePendingPlanDraft(id, prepared.executionId))?.receipt.text).toBe(true)
  // Compatibility image generated by real HEAD 0757: compact -> dispatch B ->
  // stall before its first event -> queue C -> crash. That producer cleared
  // B.isQueued at replay start while its durable delivery record still survived.
  // Seed the documented old disk shape, never a modern in-memory queue state.
  await saveSessionStrict({
    id, name: 'Existing chat', workspaceRootPath: root, projectId: workspace.defaultProjectId,
    createdAt: 1, lastUsedAt: 1, llmConnection: connection.slug,
    messages: [
      { id: bId, type: 'user', content: 'B-OLDER-APPROVAL', timestamp: 2, isQueued: false, references: [bReference] },
      { id: cId, type: 'user', content: 'C-LATER', timestamp: 3, isQueued: true, references: [cReference], attachments: [stored] },
    ],
    pendingPlanExecution: {
      planPath: '/accepted.md', draftInputSnapshot: 'B context', draftReferencesSnapshot: [bReference],
      approvalMessage: 'B-OLDER-APPROVAL', referencesValidated: true,
      awaitingCompaction: false, executionDispatched: true,
      executionId: prepared.executionId, restoreId: prepared.restoreId, approvalMessageId: bId,
      compactionTurn: { generation: 1, stopEpoch: 0 },
    },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  const sm = new SessionManager()
  const harness = sm as unknown as RuntimeHarness
  const managed = createManagedSession(
    { id, name: 'Existing chat', projectId: workspace.defaultProjectId, llmConnection: connection.slug },
    workspace,
    { messagesLoaded: false },
  )
  harness.sessions.set(id, managed)
  harness.decisionFeatureActive = () => false
  managed.triggeredBy = { event: 'isolated-review' }
  const events: SessionEvent[] = []
  sm.setEventSink((_channel, _target, event) => events.push(structuredClone(event)))
  fixtures.push({ root, sm, managed })
  return { root, sm, managed, harness, bId, cId, bReference, cReference, stored, events }
}

test.each(['getSession', 'flagSession'] as const)('%s cold recovery runs the older delivered-plan bubble before following input', async (path) => {
  const f = await coldLegacyFixture(path)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: Array<{ text: string; ids: string[]; attachments?: FileAttachment[]; storedAttachments?: StoredAttachment[] }> = []
  const agent = {
    getModel: () => 'model-old', setAllSources: () => {}, getSessionId: () => undefined,
    forceAbort: () => {}, redirect: () => false, dispose: () => {},
    chat: async function* (text: string, attachments?: FileAttachment[]): AsyncGenerator<AgentEvent> {
      calls.push({ text, attachments, ids: [...(f.managed.lastSentMessageIds ?? [])], storedAttachments: f.managed.lastSentStoredAttachments })
      if (text.startsWith('B-OLDER-APPROVAL')) { entered.resolve(); await release.promise }
      yield { type: 'input_accepted' }
      yield { type: 'complete' }
    },
  } as unknown as AgentBackend
  f.managed.agent = agent
  f.harness.getOrCreateAgent = async () => agent
  let dId: string | undefined
  try {
    if (path === 'getSession') await f.sm.getSession(f.managed.id)
    else await f.sm.flagSession(f.managed.id)
    await entered.promise
    expect(calls.map(call => call.text.split('\n')[0])).toEqual(['B-OLDER-APPROVAL'])
    expect(f.managed.isProcessing).toBe(true)
    expect(f.managed.pendingPlanExecution?.approvalMessageId).toBe(f.bId)
    expect(f.managed.pendingQueueReplay?.entries.map(entry => entry.messageId)).toEqual([f.bId])
    expect(f.managed.messageQueue.map(entry => entry.messageId)).toEqual([f.cId])
    expect(f.managed.messageQueue[0]?.storedAttachments).toEqual([f.stored])
    expect(f.managed.messageQueue[0]?.options?.references).toEqual([f.cReference])
    const dReference: Reference = {
      ...f.cReference, url: 'https://runtime-fifo.invalid/legacy-d', quote: 'D-QUOTE',
      locator: { type: 'web-text-quote', exact: 'D-QUOTE' },
    }
    await f.sm.sendMessage(f.managed.id, 'D-NEWEST', undefined, undefined, { references: [dReference] },
      undefined, undefined, id => { dId = id })
    if (!dId) throw new Error('Following input must receive its durable public ACK')
    expect(f.managed.messageQueue.map(entry => entry.messageId)).toEqual([f.cId, dId])
    release.resolve()
    for (let i = 0; i < 400 && (calls.length < 3 || f.managed.isProcessing || f.managed.pendingQueueReplay || f.managed.messageQueue.length); i++) await Bun.sleep(1)
    expect(calls.map(call => call.text.split('\n')[0])).toEqual(['B-OLDER-APPROVAL', 'C-LATER', 'D-NEWEST'])
    expect(calls.map(call => call.ids)).toEqual([[f.bId], [f.cId], [dId]])
    expect(calls[0]!.text).toContain('B-QUOTE')
    expect(calls[1]!.text).toContain('C-QUOTE')
    expect(calls[1]!.storedAttachments).toEqual([f.stored])
    expect(calls[1]!.attachments).toMatchObject([{ type: 'text', name: f.stored.name, text: 'queued notes', storedPath: f.stored.storedPath }])
    expect(calls[2]!.text).toContain('D-QUOTE')
    expect(f.managed.isProcessing).toBe(false)
    expect(f.managed.pendingQueueReplay).toBeUndefined()
    expect(f.managed.pendingPlanExecution).toBeUndefined()
    expect(f.managed.messageQueue).toHaveLength(0)
    await f.sm.flushSession(f.managed.id)
    const durable = loadSession(f.root, f.managed.id)!
    expect(durable.pendingPlanExecution).toBeUndefined()
    expect(durable.messages.filter(message => message.id === f.bId)).toHaveLength(1)
    expect(durable.messages.filter(message => message.id === f.cId)).toHaveLength(1)
    const b = durable.messages.find(message => message.id === f.bId)!
    const c = durable.messages.find(message => message.id === f.cId)!
    expect(b.references).toEqual([f.bReference])
    expect(c.references).toEqual([f.cReference])
    expect(c.attachments).toEqual([f.stored])
    expect(b.isQueued).toBe(false)
    expect(c.isQueued).toBe(false)
    if (path === 'flagSession') expect(durable.isFlagged).toBe(true)
  } finally {
    release.resolve()
    await f.sm.cancelProcessing(f.managed.id)
  }
}, 10_000)

test.each(['getSession', 'flagSession'] as const)('%s cold recovery Stop before replay keeps the approval non-executable and restores following payload', async (path) => {
  const f = await coldLegacyFixture(path)
  const calls: string[] = []
  const agent = {
    getModel: () => 'model-old', setAllSources: () => {}, getSessionId: () => undefined,
    forceAbort: () => {}, redirect: () => false, dispose: () => {},
    chat: async function* (text: string): AsyncGenerator<AgentEvent> {
      calls.push(text)
      yield { type: 'input_accepted' }
      yield { type: 'complete' }
    },
  } as unknown as AgentBackend
  f.managed.agent = agent
  f.harness.getOrCreateAgent = async () => agent
  const loading = path === 'getSession' ? f.sm.getSession(f.managed.id) : f.sm.flagSession(f.managed.id)
  // Both entry points hydrate synchronously before yielding; Stop owns the
  // queued payloads before any setImmediate may begin their provider turn.
  const stopping = f.sm.cancelProcessing(f.managed.id)
  await Promise.all([loading, stopping])
  for (let i = 0; i < 15; i++) await Bun.sleep(1)
  expect(calls).toHaveLength(0)
  expect(f.managed.pendingPlanExecution?.failed).toBe(true)
  expect(f.managed.messageQueue).toHaveLength(0)
  expect(f.managed.pendingQueueReplay).toBeUndefined()
  const restored = f.events.find(event => event.type === 'interrupted' && event.queuedMessageIds?.includes(f.cId))
  if (!restored || restored.type !== 'interrupted') throw new Error('Stop must expose durable recovery for the following input')
  expect(restored.queuedMessages).toEqual(['C-LATER'])
  expect(restored.queuedMessageIds).toEqual([f.cId])
  expect(restored.queuedReferences).toEqual([f.cReference])
  expect(restored.queuedAttachments).toEqual([f.stored])
  expect(restored.queuedRestoreId).toBeDefined()
  const outbox = f.events.find(event => event.type === 'compaction_failed')
  if (!outbox || outbox.type !== 'compaction_failed') throw new Error('Stopped approval must restore through its own plan outbox')
  expect(outbox.text).toBe('B context')
  expect(outbox.references).toEqual([f.bReference])
  await f.sm.flushSession(f.managed.id)
  const durable = loadSession(f.root, f.managed.id)!
  expect(durable.pendingPlanExecution?.failed).toBe(true)
  expect(durable.messages.filter(message => message.id === f.bId)).toHaveLength(1)
  expect(durable.messages.filter(message => message.id === f.cId)).toHaveLength(1)
  expect(durable.messages.find(message => message.id === f.bId)?.queuedRestoreId).toBeUndefined()
  const c = durable.messages.find(message => message.id === f.cId)!
  expect(c.queuedRestoreId).toBe(restored.queuedRestoreId)
  expect(c.isQueued).toBe(true)
  expect(c.references).toEqual([f.cReference])
  expect(c.attachments).toEqual([f.stored])
}, 10_000)

test('deferred-title IO keeps an earlier accepted input ahead of later queued references', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-fifo-workspace-'))
  const workspace = { ...createWorkspaceAtPath(root, 'Runtime FIFO'), rootPath: root }
  const sm = new SessionManager()
  const harness = sm as unknown as RuntimeHarness
  const managed = createManagedSession(
    { id: 'title-fifo-runtime', projectId: workspace.defaultProjectId, llmConnection: connection.slug },
    workspace,
    { messagesLoaded: true },
  )
  harness.sessions.set(managed.id, managed)
  harness.decisionFeatureActive = () => false
  // Immediate title persistence stays real; provider-backed title generation is sealed.
  harness.generateTitle = async () => {}
  fixtures.push({ root, sm, managed })
  const calls: Array<{ text: string; attachments?: FileAttachment[]; ids: string[] }> = []
  const bEntered = Promise.withResolvers<void>()
  const bRelease = Promise.withResolvers<void>()
  const agent = {
    getModel: () => 'model-old', setAllSources: () => {}, getSessionId: () => undefined,
    forceAbort: () => {}, redirect: () => false, dispose: () => {},
    chat: async function* (text: string, attachments?: FileAttachment[]): AsyncGenerator<AgentEvent> {
      calls.push({ text, attachments, ids: [...(managed.lastSentMessageIds ?? [])] })
      yield { type: 'input_accepted' }
      if (text === 'B-LATER') { bEntered.resolve(); await bRelease.promise }
      yield { type: 'complete' }
    },
  } as unknown as AgentBackend
  managed.agent = agent
  harness.getOrCreateAgent = async () => agent
  const acks: Record<string, string> = {}
  sm.setEventSink(() => {})
  await saveSessionStrict({
    id: managed.id, projectId: managed.projectId, workspaceRootPath: root,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  await sm.sendMessage(managed.id, 'hi')
  for (let i = 0; i < 100 && !managed.titleDeferred; i++) await Bun.sleep(1)
  expect(managed.titleDeferred).toBe(true)
  expect(managed.name).toBe('hi')
  expect(managed.autoTitle).toBe('hi')

  const aInitialEntered = Promise.withResolvers<void>()
  const aInitialRelease = Promise.withResolvers<void>()
  const aTitleEntered = Promise.withResolvers<void>()
  const aTitleRelease = Promise.withResolvers<void>()
  const writes = sessionPersistenceQueue as unknown as {
    performWrite(sessionId: string, entry: { data: StoredSession; timer: ReturnType<typeof setTimeout> }): Promise<void>
  }
  const realWrite = writes.performWrite.bind(sessionPersistenceQueue)
  let initialGated = false
  let titleGated = false
  writes.performWrite = async (sessionId, entry) => {
    if (sessionId === managed.id && !initialGated && entry.data.messages.some(message => message.content === 'A-EARLIER')) {
      initialGated = true
      aInitialEntered.resolve()
      await aInitialRelease.promise
    }
    if (sessionId === managed.id && !titleGated && entry.data.name === 'A-EARLIER') {
      titleGated = true
      aTitleEntered.resolve()
      await aTitleRelease.promise
    }
    await realWrite(sessionId, entry)
  }
  const reference: Reference = {
    version: 1, kind: 'web-selection', projectId: managed.projectId,
    url: 'https://runtime-fifo.invalid/a', title: 'A source', quote: 'A-QUOTE',
    locator: { type: 'web-text-quote', exact: 'A-QUOTE' },
  }
  const stored: StoredAttachment = {
    id: 'a-notes', type: 'text', name: 'a.txt', mimeType: 'text/plain', size: 1,
    storedPath: join(root, 'a.txt'),
  }
  const attachment: FileAttachment = {
    type: 'text', path: stored.storedPath, name: stored.name, mimeType: stored.mimeType,
    size: stored.size, text: 'A attachment',
  }
  const cReference: Reference = {
    ...reference, url: 'https://runtime-fifo.invalid/c', quote: 'C-QUOTE',
    locator: { type: 'web-text-quote', exact: 'C-QUOTE' },
  }
  let sendingA: Promise<void> | undefined
  let sendingB: Promise<void> | undefined
  let sendingC: Promise<void> | undefined
  try {
    sendingA = sm.sendMessage(managed.id, 'A-EARLIER', [attachment], [stored], { references: [reference] },
      undefined, undefined, id => { acks.A = id })
    await aInitialEntered.promise
    sendingB = sm.sendMessage(managed.id, 'B-LATER', undefined, undefined, undefined,
      undefined, undefined, id => { acks.B = id })
    // Later input cannot pass earlier admission while its initial/title write waits.
    await Bun.sleep(10)
    expect(managed.messages.some(message => message.content === 'B-LATER')).toBe(false)
    aInitialRelease.resolve()
    await aTitleEntered.promise
    sendingC = sm.sendMessage(managed.id, 'C-LATEST', undefined, undefined, { references: [cReference] },
      undefined, undefined, id => { acks.C = id })
    expect(managed.messages.some(message => message.content === 'C-LATEST')).toBe(false)
    aTitleRelease.resolve()
    await bEntered.promise
    await sendingA
    bRelease.resolve()
    await Promise.all([sendingB, sendingC])
    for (let i = 0; i < 250 && (calls.length < 4 || managed.isProcessing || managed.pendingQueueReplay || managed.messageQueue.length); i++) await Bun.sleep(1)
    expect(managed.isProcessing).toBe(false)
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.pendingQueueReplay).toBeUndefined()
    await sm.flushSession(managed.id)
    const durable = loadSession(root, managed.id)!
    const aBubble = durable.messages.find(message => message.id === acks.A)!
    const cBubble = durable.messages.find(message => message.id === acks.C)!
    expect(aBubble.references).toEqual([reference])
    expect(aBubble.attachments).toEqual([stored])
    expect(cBubble.references).toEqual([cReference])
    expect(aBubble.isQueued).toBe(false)
    expect(cBubble.isQueued).toBe(false)
    expect(durable.messages.filter(message => message.id === acks.A)).toHaveLength(1)
    expect(durable.messages.filter(message => message.id === acks.C)).toHaveLength(1)
    expect(calls.find(call => call.text.includes('A-EARLIER'))?.attachments).toEqual([attachment])
    expect(calls.find(call => call.text.includes('A-EARLIER'))?.ids).toEqual([acks.A])
    expect(calls.find(call => call.text.includes('C-LATEST'))?.ids).toEqual([acks.C])
    // Assert order after verifying all payloads and identities survive replay.
    expect(calls.map(call => call.text.split('\n')[0])).toEqual(['hi', 'A-EARLIER', 'B-LATER', 'C-LATEST'])
  } finally {
    aInitialRelease.resolve()
    aTitleRelease.resolve()
    bRelease.resolve()
    writes.performWrite = realWrite
    await Promise.allSettled([sendingA, sendingB, sendingC].filter((sending): sending is Promise<void> => !!sending))
    await sm.cancelProcessing(managed.id)
  }
}, 10_000)


test('STORE_ATTACHMENT and a real warm queue preserve image, extensionless PDF and Office data after cold replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-cold-media-workspace-'))
  const registered = addWorkspace({ rootPath: root, name: 'Cold media' })
  const workspace = { ...createWorkspaceAtPath(root, 'Cold media'), id: registered.id, rootPath: root }
  const id = 'cold-media'
  const storeHandlers = new Map<string, (context: { workspaceId: string }, sessionId: string, file: FileAttachment) => Promise<StoredAttachment>>()
  // Register production handlers; seal only unavailable preview/image services.
  registerFilesHandlers({
    handle(channel: string, handler: unknown) {
      storeHandlers.set(channel, handler as (context: { workspaceId: string }, sessionId: string, file: FileAttachment) => Promise<StoredAttachment>)
    },
  } as unknown as RpcServer, {
    platform: {
      logger: { info() {}, debug() {}, warn() {}, error() {} },
      imageProcessor: {
        getMetadata: async () => { throw new Error("Cannot find module 'sharp'") },
        process: async () => { throw new Error("Cannot find module 'sharp'") },
      },
    },
  } as unknown as HandlerDeps)
  // MIME-derived inputs from FreeFormInput support a PDF named `report`.
  // Keep the actual producer's persisted type, rather than infer from its name.
  const media: Array<{ type: FileAttachment['type']; name: string; mimeType: string; base64: string }> = [
    { type: 'image', name: 'picture.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' },
    { type: 'pdf', name: 'report', mimeType: 'application/pdf', base64: 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyA+PgplbmRvYmoKJSVFT0YK' },
    { type: 'office', name: 'brief.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', base64: 'UEsDBBQAAAAIANasQV3mdcR+0gAAAIsBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QvVLDMAzHX8XnlasVGBh6SToAKzD0BXSOkvjw11luad++Sls6cIVR+n/8ZLebQ/BqT4Vdip1+NI3e9O32mImVKJE7Pdea1wBsZwrIJmWKooypBKwylgky2i+cCJ6a5hlsipViXdWlQ/ftK42481W9HWR9oRTyrNXLxbiwOo05e2exig77OPyirK4EI8mzh2eX+UEMGu4SFuVvwDX3Ic8ubiD1iaW+YxAXfKcywJDsLkjS/F9z5840js7SLb+05ZIsMbs4BW9uSkAXf+6H83f3J1BLAwQUAAAACADWrEFdXzOVUpUAAAAHAQAACwAAAF9yZWxzLy5yZWxzjc87DsIwDAbgq0Q+QJ0yMKCmXVi6Ii4QJW5T0TzkhNftycBAEQOjf//6LHfDw6/iRpyXGBS0jYSh70606lKD7JaURW2ErMCVkg6I2TjyOjcxUaibKbLXpY48Y9LmomfCnZR75E8DtqYYrQIebQvi/Ez0jx2naTF0jObqKZQfJ74aVdY8U1Fwj2zRvuOmsoB9h5sX+xdQSwMEFAAAAAgA1qxBXQWQ2rGKAAAAvAAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOSw6DMAxEr4JyAEy76ALxOULPQBMDkYgdOabQ2zehi27eyHqakbvxDFv1RkmeqTe3ujHj0B2tY7sHJK2yptQevVlVYwuQ7IphSjVHpOxmljBpPmWBg8VFYYspeVrCBvemeUCYPJky+WL3KRkLpECH5zx7i5Xl6NHlIMVTOyiqUC7Gi786/F8bvlBLAQIUAxQAAAAIANasQV3mdcR+0gAAAIsBAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgA1qxBXV8zlVKVAAAABwEAAAsAAAAAAAAAAAAAAIABAwEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgA1qxBXQWQ2rGKAAAAvAAAABEAAAAAAAAAAAAAAIABwQEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAHoCAAAAAA==' },
  ]
  const attachments: FileAttachment[] = []
  const storedAttachments: StoredAttachment[] = []
  for (const file of media) {
    const original: FileAttachment = { ...file, path: file.name, size: Buffer.from(file.base64, 'base64').length }
    const store = storeHandlers.get(RPC_CHANNELS.file.STORE_ATTACHMENT)
    if (!store) throw new Error('Production attachment handler was not registered')
    const stored = await store({ workspaceId: registered.id }, id, original)
    storedAttachments.push(stored)
    attachments.push({ ...original, storedPath: stored.storedPath, markdownPath: stored.markdownPath })
  }
  const officeMarkdown = storedAttachments[2]?.markdownPath
  if (!officeMarkdown) throw new Error('Real Office conversion must produce its copied Markdown')
  expect(readFileSync(officeMarkdown, 'utf8')).toContain('Office copied context')
  const sm = new SessionManager()
  const harness = sm as unknown as RuntimeHarness
  const managed = createManagedSession(
    { id, name: 'Existing chat', projectId: workspace.defaultProjectId, llmConnection: connection.slug, model: 'model-new' }, workspace, { messagesLoaded: true },
  )
  harness.sessions.set(id, managed)
  harness.decisionFeatureActive = () => false
  managed.triggeredBy = { event: 'isolated-review' }
  sm.setEventSink(() => {})
  fixtures.push({ root, sm, managed })
  await saveSessionStrict({
    id, name: 'Existing chat', projectId: managed.projectId, workspaceRootPath: root,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const warmAgent = {
    getModel: () => 'model-new', setAllSources: () => {}, getSessionId: () => undefined,
    forceAbort: () => release.resolve(), redirect: () => false, dispose: () => release.resolve(),
    chat: async function* (): AsyncGenerator<AgentEvent> { entered.resolve(); await release.promise; yield { type: 'complete' } },
  } as unknown as AgentBackend
  managed.agent = warmAgent
  harness.getOrCreateAgent = async () => warmAgent
  const running = sm.sendMessage(id, 'RUNNING-PREDECESSOR')
  await entered.promise
  let queuedId: string | undefined
  await sm.sendMessage(id, 'C-COPIED-MEDIA', attachments, storedAttachments, undefined, undefined, undefined, mid => { queuedId = mid })
  if (!queuedId) throw new Error('The actual public queue must durably ACK the media input')
  await sm.flushSession(id)
  expect(loadSession(root, id)?.messages.find(message => message.id === queuedId)?.isQueued).toBe(true)
  // The old process is dead after its real public queue write. It cannot drain
  // the cold image or rewrite queued flags when its sealed iterator returns.
  harness.sessions.delete(id)
  release.resolve()
  await running
  const cold = new SessionManager()
  const coldHarness = cold as unknown as RuntimeHarness
  const restored = createManagedSession(
    { id, name: 'Existing chat', projectId: managed.projectId, llmConnection: connection.slug, model: 'model-new' }, workspace, { messagesLoaded: false },
  )
  coldHarness.sessions.set(id, restored)
  coldHarness.decisionFeatureActive = () => false
  restored.triggeredBy = { event: 'isolated-review' }
  cold.setEventSink(() => {})
  fixtures.push({ root, sm: cold, managed: restored })
  const calls: Array<{ text: string; attachments?: FileAttachment[]; ids: string[] }> = []
  const coldAgent = {
    getModel: () => 'model-new', setAllSources: () => {}, getSessionId: () => undefined,
    forceAbort: () => {}, redirect: () => false, dispose: () => {},
    chat: async function* (text: string, files?: FileAttachment[]): AsyncGenerator<AgentEvent> {
      calls.push({ text, attachments: files, ids: [...(restored.lastSentMessageIds ?? [])] })
      yield { type: 'input_accepted' }
      yield { type: 'complete' }
    },
  } as unknown as AgentBackend
  restored.agent = coldAgent
  coldHarness.getOrCreateAgent = async () => coldAgent
  await cold.getSession(id)
  for (let i = 0; i < 400 && (calls.length < 1 || restored.isProcessing || restored.pendingQueueReplay || restored.messageQueue.length); i++) await Bun.sleep(1)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.text).toBe('C-COPIED-MEDIA')
  expect(calls[0]?.ids).toEqual([queuedId])
  expect(calls[0]?.attachments).toHaveLength(3)
  for (let i = 0; i < media.length; i++) {
    expect(calls[0]?.attachments?.[i]).toMatchObject({ ...media[i], storedPath: storedAttachments[i]!.storedPath })
  }
  expect(calls[0]?.attachments?.[1]?.text).toBeUndefined()
  expect(calls[0]?.attachments?.[2]?.markdownPath).toBe(officeMarkdown)
  expect(restored.isProcessing).toBe(false)
  expect(restored.pendingQueueReplay).toBeUndefined()
  expect(restored.messageQueue).toHaveLength(0)
  await cold.flushSession(id)
  const durable = loadSession(root, id)!
  expect(durable.messages.filter(message => message.id === queuedId)).toHaveLength(1)
  expect(durable.messages.find(message => message.id === queuedId)?.attachments).toEqual(storedAttachments)
  expect(durable.messages.find(message => message.id === queuedId)?.isQueued).toBe(false)
}, 10_000)

test.each(['missing', 'other-session', 'symlink'] as const)('cold %s attachment is rejected without blocking the following public input', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-cold-attachment-reject-'))
  const workspace = { ...createWorkspaceAtPath(root, 'Cold attachment rejection'), rootPath: root }
  const id = `cold-${kind}`
  const attachmentsDir = join(root, 'sessions', id, 'attachments')
  const foreignDir = join(root, 'sessions', 'foreign', 'attachments')
  mkdirSync(attachmentsDir, { recursive: true })
  mkdirSync(foreignDir, { recursive: true })
  const foreign = join(foreignDir, 'secret.txt')
  writeFileSync(foreign, 'FOREIGN BYTES MUST NOT REACH MODEL')
  let storedPath = join(attachmentsDir, 'missing.txt')
  if (kind === 'other-session') storedPath = foreign
  if (kind === 'symlink') { storedPath = join(attachmentsDir, 'link.txt'); symlinkSync(foreign, storedPath) }
  const stored: StoredAttachment = { id: 'copied-file', type: 'text', name: 'notes.txt', mimeType: 'text/plain', size: 36, storedPath }
  // A real durable queued bubble may outlive its copied file, or disk metadata
  // may point elsewhere. Only the session-local copied bytes may be replayed.
  await saveSessionStrict({
    id, name: 'Existing chat', projectId: workspace.defaultProjectId, workspaceRootPath: root,
    createdAt: 1, lastUsedAt: 1,
    messages: [{ id: 'C-cold', type: 'user', content: 'C-COLD-FILE', timestamp: 1, isQueued: true, attachments: [stored] }],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  const sm = new SessionManager()
  const harness = sm as unknown as RuntimeHarness
  const managed = createManagedSession(
    { id, name: 'Existing chat', projectId: workspace.defaultProjectId, llmConnection: connection.slug }, workspace, { messagesLoaded: false },
  )
  harness.sessions.set(id, managed)
  harness.decisionFeatureActive = () => false
  managed.triggeredBy = { event: 'isolated-review' }
  fixtures.push({ root, sm, managed })
  const calls: Array<{ text: string; attachments?: FileAttachment[]; ids: string[] }> = []
  const events: SessionEvent[] = []
  const agent = {
    getModel: () => 'model-old', setAllSources: () => {}, getSessionId: () => undefined,
    forceAbort: () => {}, redirect: () => false, dispose: () => {},
    chat: async function* (text: string, attachments?: FileAttachment[]): AsyncGenerator<AgentEvent> {
      calls.push({ text, attachments, ids: [...(managed.lastSentMessageIds ?? [])] })
      yield { type: 'input_accepted' }
      yield { type: 'complete' }
    },
  } as unknown as AgentBackend
  managed.agent = agent
  harness.getOrCreateAgent = async () => agent
  sm.setEventSink((_channel, _target, event) => events.push(structuredClone(event)))
  const loading = sm.getSession(id)
  let followingId: string | undefined
  const sending = sm.sendMessage(id, 'D-FOLLOWING', undefined, undefined, undefined, undefined, undefined, mid => { followingId = mid })
  await Promise.all([loading, sending])
  if (!followingId) throw new Error('Following public input must be durably ACKed')
  for (let i = 0; i < 400 && (calls.length < 1 || managed.isProcessing || managed.pendingQueueReplay || managed.messageQueue.length); i++) await Bun.sleep(1)
  expect(calls.map(call => call.text)).toEqual(['D-FOLLOWING'])
  expect(calls[0]?.ids).toEqual([followingId])
  expect(calls[0]?.attachments).toBeUndefined()
  expect(events.some(event => event.type === 'typed_error' && event.error.code === 'queued_message_replay_failed')).toBe(true)
  expect(managed.isProcessing).toBe(false)
  expect(managed.pendingQueueReplay).toBeUndefined()
  expect(managed.messageQueue).toHaveLength(0)
  await sm.flushSession(id)
  const durable = loadSession(root, id)!
  expect(durable.messages.filter(message => message.id === 'C-cold')).toHaveLength(1)
  expect(durable.messages.find(message => message.id === 'C-cold')?.attachments).toEqual([stored])
  expect(durable.messages.find(message => message.id === 'C-cold')?.isQueued).toBe(false)
  expect(durable.messages.filter(message => message.id === followingId)).toHaveLength(1)
}, 10_000)
