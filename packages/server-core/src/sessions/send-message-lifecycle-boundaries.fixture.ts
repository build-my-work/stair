import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, Reference, StoredAttachment } from '../../../core/src/types/index.ts'
import type { SessionEvent } from '../../../shared/src/protocol/dto.ts'
import type { FileAttachment } from '../../../shared/src/utils/files.ts'
import type { StoredSession } from '../../../shared/src/sessions/types.ts'

if (process.env.CRAFT_SEND_LIFECYCLE_TEST_CHILD !== '1') {
  throw new Error('send lifecycle fixture requires its isolated test entry')
}
const profile = mkdtempSync(join(tmpdir(), 'stair-send-lifecycle-profile-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(
  join(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'),
  join(profile, 'config-defaults.json'),
)
const { CONFIG_DIR } = await import('../../../shared/src/config/paths.ts')
if (CONFIG_DIR !== profile) throw new Error('send lifecycle fixture requires an isolated config module cache')
const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { createWorkspaceAtPath } = await import('../../../shared/src/workspaces/storage.ts')
const { saveSessionStrict, loadSession, sessionPersistenceQueue, getSessionFilePath } = await import('../../../shared/src/sessions/index.ts')
const { setSessionDraft, getPlanDraftConsumption } = await import('../../../shared/src/config/storage.ts')

type Managed = ReturnType<typeof createManagedSession>
type QueueWriteHarness = {
  performWrite(sessionId: string, entry: { data: StoredSession; timer: ReturnType<typeof setTimeout> }): Promise<void>
}
type Internals = {
  sessions: Map<string, Managed>
  decisionFeatureActive: () => boolean
  getOrCreateAgent: () => Promise<ReturnType<typeof agentStub>>
  getBrowserPaneManagerForSession: () => {
    clearVisualsForSession: () => Promise<void>
    unbindAllForSession: () => void
  }
  isSessionBeingViewed: () => boolean
  startPreTurnDecisions: () => Promise<never>
}
const workspaces: string[] = []
afterAll(async () => {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  await sessionPersistenceQueue.flushAll()
  for (const root of workspaces) rmSync(root, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
})

async function tick() {
  await new Promise(resolve => setImmediate(resolve))
  await Bun.sleep(1)
}

function agentStub(chat: (text: string, attachments?: FileAttachment[]) => AsyncGenerator<AgentEvent>) {
  return {
    getModel: () => 'no-model', setAllSources: () => {}, getSessionId: () => undefined,
    forceAbort: () => {}, redirect: () => false, chat,
  }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'stair-send-lifecycle-workspace-'))
  workspaces.push(root)
  const workspace = { ...createWorkspaceAtPath(root, 'Send lifecycle review'), rootPath: root }
  const id = `send-lifecycle-${randomUUID()}`
  const sm = new SessionManager()
  const managed = createManagedSession({ id, name: 'Existing chat', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
  const internals = sm as unknown as Internals
  internals.sessions.set(id, managed)
  internals.decisionFeatureActive = () => false
  // A final assistant reply must not start a model-backed title refresh.
  managed.triggeredBy = { event: 'isolated-review' }
  sm.setEventSink(() => {})
  await saveSessionStrict({
    id, name: 'Existing chat', projectId: managed.projectId, workspaceRootPath: root,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  return { sm, managed, root, workspace, internals }
}

test.each(['Stop', 'iterator error'] as const)('%s settles unfinished tools on the host and disk without touching a newer turn', async (ending) => {
  const f = await setup()
  const events: SessionEvent[] = []
  let releaseStopped!: () => void
  let releaseNewer!: () => void
  const stopped = new Promise<void>(resolve => { releaseStopped = resolve })
  const newer = new Promise<void>(resolve => { releaseNewer = resolve })
  let stopping: Promise<void> | undefined
  let calls = 0
  const agent = agentStub(async function* () {
    calls++
    yield { type: 'input_accepted' }
    const toolUseId = calls === 1 ? 'stopped-tool' : 'newer-tool'
    yield { type: 'tool_start', toolName: 'Bash', toolUseId, input: { command: 'synthetic tool' } }
    if (calls === 1) {
      await stopped
      throw ending === 'Stop' ? new DOMException('Stopped', 'AbortError') : new Error('Synthetic iterator failure')
    }
    await newer
    yield { type: 'tool_result', toolName: 'Bash', toolUseId, result: 'NEWER-RESULT', isError: false }
    yield { type: 'complete' }
  })
  agent.forceAbort = releaseStopped
  f.managed.agent = agent as never
  f.internals.getOrCreateAgent = async () => agent
  f.sm.setEventSink((_channel, _target, event) => {
    events.push(structuredClone(event))
    if (event.type === 'tool_start' && event.toolUseId === 'stopped-tool') {
      if (ending === 'Stop') stopping = f.sm.cancelProcessing(f.managed.id)
      else releaseStopped()
    }
  })
  const first = f.sm.sendMessage(f.managed.id, 'STOPPED-INPUT')
  try {
    await first
    await stopping
    for (let i = 0; i < 10; i++) await tick()
    await f.sm.flushSession(f.managed.id)
    const result = ending === 'Stop' ? 'Interrupted' : 'Error occurred'
    const closed = f.managed.messages.find(message => message.toolUseId === 'stopped-tool')!
    expect(closed.toolStatus).toBe('error')
    expect(closed.toolResult).toBe(result)
    expect(closed.isError).toBe(true)
    expect(loadSession(f.root, f.managed.id)?.messages.find(message => message.toolUseId === 'stopped-tool')).toMatchObject({
      toolStatus: 'error', toolResult: result, isError: true,
    })
    expect(events.filter(event => event.type === 'tool_result' && event.toolUseId === 'stopped-tool')).toHaveLength(1)
    const stoppedGeneration = f.managed.processingGeneration
    const next = f.sm.sendMessage(f.managed.id, 'NEWER-INPUT')
    try {
      for (let i = 0; i < 50 && !f.managed.messages.some(message => message.toolUseId === 'newer-tool'); i++) await tick()
      const current = f.managed.messages.find(message => message.toolUseId === 'newer-tool')!
      expect(current.toolStatus).toBe('executing')
      await (f.sm as unknown as { onProcessingStopped(id: string, reason: 'interrupted', generation: number): Promise<void> })
        .onProcessingStopped(f.managed.id, 'interrupted', stoppedGeneration)
      expect(current.toolStatus).toBe('executing')
      expect(current.toolResult).toBeUndefined()
    } finally { releaseNewer(); await next }
    for (let i = 0; i < 10; i++) await tick()
    await f.sm.flushSession(f.managed.id)
    expect(f.managed.messages.find(message => message.toolUseId === 'newer-tool')).toMatchObject({
      toolStatus: 'completed', toolResult: 'NEWER-RESULT', isError: false,
    })
    expect(loadSession(f.root, f.managed.id)?.messages.find(message => message.toolUseId === 'newer-tool')?.toolStatus).toBe('completed')
    expect(f.managed.isProcessing).toBe(false)
  } finally { releaseStopped(); releaseNewer(); await first }
}, 5_000)

test.each(['agent construction', 'source setup'] as const)('%s failure settles processing before a new warm send', async (stage) => {
  const f = await setup()
  let fail = true
  const calls: string[] = []
  const agent = agentStub(async function* (text) { calls.push(text); yield { type: 'input_accepted' }; yield { type: 'complete' } })
  agent.setAllSources = () => { if (stage === 'source setup' && fail) throw new Error('isolated setup failure') }
  f.internals.getOrCreateAgent = async () => { if (stage === 'agent construction' && fail) throw new Error('isolated setup failure'); return agent }
  const acks: string[] = []
  let error: unknown
  try { await f.sm.sendMessage(f.managed.id, 'INITIAL-INPUT', undefined, undefined, undefined, undefined, undefined, id => acks.push(id)) }
  catch (caught) { error = caught }
  fail = false
  try {
    await f.sm.sendMessage(f.managed.id, 'WARM-NEXT-INPUT')
    for (let i = 0; i < 15; i++) await tick()
    await f.sm.flushSession(f.managed.id)
    expect(String(error)).toContain('isolated setup failure')
    expect(acks).toHaveLength(1)
    expect(calls).toEqual(['WARM-NEXT-INPUT'])
    expect(f.managed.isProcessing).toBe(false)
    expect(f.managed.messageQueue).toHaveLength(0)
    expect(loadSession(f.root, f.managed.id)?.messages.filter(message => message.type === 'user').map(message => message.content)).toEqual(['INITIAL-INPUT', 'WARM-NEXT-INPUT'])
  } finally { await f.sm.cancelProcessing(f.managed.id) }
}, 5_000)

test('startup rejection drains already accepted following references and attachments', async () => {
  const f = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let startups = 0
  const calls: { text: string; attachments?: FileAttachment[] }[] = []
  const agent = agentStub(async function* (text, attachments) { calls.push({ text, attachments }); yield { type: 'input_accepted' }; yield { type: 'complete' } })
  f.internals.getOrCreateAgent = async () => {
    if (++startups === 1) { entered.resolve(); await release.promise; throw new Error('isolated setup failure') }
    return agent
  }
  const reference: Reference = { version: 1, kind: 'web-selection', projectId: f.managed.projectId,
    url: 'https://example.test', title: 'Following source', quote: 'FOLLOWING-QUOTE',
    locator: { type: 'web-text-quote', exact: 'FOLLOWING-QUOTE' } }
  const stored: StoredAttachment = { id: 'notes', type: 'text', name: 'notes.txt', mimeType: 'text/plain', size: 12, storedPath: join(f.root, 'notes.txt') }
  const attachment: FileAttachment = { type: 'text', path: stored.storedPath, name: stored.name, mimeType: stored.mimeType, size: stored.size, text: 'queued notes' }
  const first = f.sm.sendMessage(f.managed.id, 'INITIAL-INPUT').catch(error => error)
  await entered.promise
  await f.sm.sendMessage(f.managed.id, 'QUEUED-FOLLOWING-INPUT', [attachment], [stored], { references: [reference] })
  release.resolve()
  await first
  try {
    for (let i = 0; i < 25; i++) await tick()
    await f.sm.flushSession(f.managed.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toContain('QUEUED-FOLLOWING-INPUT')
    expect(calls[0]?.text).toContain('FOLLOWING-QUOTE')
    expect(calls[0]?.attachments).toEqual([attachment])
    expect(f.managed.messageQueue).toHaveLength(0)
    const following = loadSession(f.root, f.managed.id)?.messages.find(message => message.content === 'QUEUED-FOLLOWING-INPUT')
    expect(following?.references).toEqual([reference])
    expect(following?.attachments).toEqual([stored])
  } finally { release.resolve(); await f.sm.cancelProcessing(f.managed.id) }
}, 5_000)

test.each(['first visual clear', 'final visual clear', 'read persistence', 'mini status persistence'] as const)('old completion after %s cannot complete or unbind a newer turn', async (stage) => {
  const f = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const newerEntered = Promise.withResolvers<void>()
  const releaseNewer = Promise.withResolvers<void>()
  const events: { event: SessionEvent; generation: number; processing: boolean }[] = []
  const conductorWhileActive: unknown[] = []
  let clears = 0
  let unbindsWhileActive = 0
  f.internals.getBrowserPaneManagerForSession = () => ({
    clearVisualsForSession: async () => {
      clears++
      if ((stage === 'first visual clear' && clears === 1) || (stage === 'final visual clear' && clears === 2)) {
        entered.resolve()
        await release.promise
      }
    },
    unbindAllForSession: () => { if (f.managed.isProcessing) unbindsWhileActive++ },
  })
  if (stage === 'read persistence') {
    f.internals.isSessionBeingViewed = () => true
    const original = f.sm.markSessionRead.bind(f.sm)
    f.sm.markSessionRead = async id => { await original(id); entered.resolve(); await release.promise }
  }
  if (stage === 'mini status persistence') {
    f.managed.systemPromptPreset = 'mini'
    const original = f.sm.setSessionStatus.bind(f.sm)
    f.sm.setSessionStatus = async (id, status) => { await original(id, status); entered.resolve(); await release.promise }
  }
  const agent = agentStub(async function* (text) {
    yield { type: 'input_accepted' }
    if (text === 'NEWER-ACTIVE-TURN') { newerEntered.resolve(); await releaseNewer.promise }
    yield { type: 'text_complete', text: `${text} reply` }
    yield { type: 'complete' }
  })
  f.internals.getOrCreateAgent = async () => agent
  f.sm.setEventSink((_channel, _target, event) => events.push({ event: structuredClone(event), generation: f.managed.processingGeneration, processing: f.managed.isProcessing }))
  f.sm.onSessionComplete(event => { if (f.managed.isProcessing) conductorWhileActive.push(event) })
  const older = f.sm.sendMessage(f.managed.id, 'OLDER-COMPLETED-TURN')
  await entered.promise
  const newer = f.sm.sendMessage(f.managed.id, 'NEWER-ACTIVE-TURN')
  await newerEntered.promise
  release.resolve()
  try {
    for (let i = 0; i < 15; i++) await tick()
    expect(f.managed.isProcessing).toBe(true)
    expect(events.filter(entry => entry.event.type === 'complete' && entry.processing)).toHaveLength(0)
    expect(unbindsWhileActive).toBe(0)
    expect(conductorWhileActive).toHaveLength(0)
  } finally {
    release.resolve()
    releaseNewer.resolve()
    await Promise.all([older, newer])
    for (let i = 0; i < 5; i++) await tick()
  }
}, 5_000)

test.each(['complete', 'empty iterator', 'pre-turn rejection'] as const)('%s still allows the next ordinary warm send', async (exit) => {
  const f = await setup()
  const calls: string[] = []
  const agent = agentStub(async function* (text) {
    calls.push(text)
    // The first empty iterator deliberately has no producer acknowledgement.
    // The following warm send is an ordinary successfully admitted turn.
    if (exit !== 'empty iterator' || calls.length > 1) {
      yield { type: 'input_accepted' }
      yield { type: 'complete' }
    }
  })
  f.internals.getOrCreateAgent = async () => agent
  if (exit === 'pre-turn rejection') {
    f.internals.startPreTurnDecisions = () => Promise.reject(new Error('isolated decision failure'))
  }
  await f.sm.sendMessage(f.managed.id, 'FIRST-INPUT')
  expect(f.managed.isProcessing).toBe(false)
  if (exit === 'pre-turn rejection') Reflect.deleteProperty(f.sm, 'startPreTurnDecisions')
  await f.sm.sendMessage(f.managed.id, 'SECOND-INPUT')
  for (let i = 0; i < 5; i++) await tick()
  expect(calls).toEqual(exit === 'pre-turn rejection' ? ['SECOND-INPUT'] : ['FIRST-INPUT', 'SECOND-INPUT'])
  expect(f.managed.isProcessing).toBe(false)
  expect(f.managed.messageQueue).toHaveLength(0)
}, 5_000)

test('cold hydration keeps approval and a new semantic input in separate FIFO turns', async () => {
  const f = await setup()
  const originalReference: Reference = { version: 1, kind: 'web-selection', projectId: f.managed.projectId,
    url: 'https://example.test/original', title: 'Approved source', quote: 'ORIGINAL-QUOTE',
    locator: { type: 'web-text-quote', exact: 'ORIGINAL-QUOTE' } }
  const text = 'ORIGINAL-ACCEPTED-CONTEXT'
  const prepared = await f.sm.setPendingPlanExecution(f.managed.id, '/accepted.md', text, [originalReference])
  setSessionDraft(f.managed.id, { text, references: [originalReference] })
  expect((await f.sm.consumePendingPlanDraft(f.managed.id, prepared.executionId!))?.receipt.text).toBe(true)
  const turn = { generation: f.managed.processingGeneration, stopEpoch: f.managed.stopEpoch ?? 0 }
  f.managed.pendingPlanExecution!.compactionTurn = turn
  const before = loadSession(f.root, f.managed.id)!
  before.pendingPlanExecution = f.managed.pendingPlanExecution
  await saveSessionStrict(before)
  expect(await f.sm.markCompactionComplete(f.managed.id, prepared.executionId, turn)).toBe(true)
  // Simulate process exit after durable acceptance but before queue replay.
  ;(f.sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}
  expect(await f.sm.dispatchPendingPlanExecution(f.managed.id, prepared.executionId)).toEqual({ ok: true })
  await f.sm.flushSession(f.managed.id)
  const approvalId = f.managed.pendingPlanExecution!.approvalMessageId!

  const cold = new SessionManager()
  const restored = createManagedSession({ id: f.managed.id, name: 'Existing chat', projectId: f.managed.projectId }, f.workspace, { messagesLoaded: false })
  const internals = cold as unknown as Internals
  internals.sessions.set(restored.id, restored)
  internals.decisionFeatureActive = () => false
  restored.triggeredBy = { event: 'isolated-review' }
  const events: SessionEvent[] = []
  cold.setEventSink((_channel, _target, event) => events.push(structuredClone(event)))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: { text: string; attachments?: FileAttachment[] }[] = []
  const agent = agentStub(async function* (message, attachments) {
    calls.push({ text: message, attachments })
    const first = calls.length === 1
    if (first) { entered.resolve(); await release.promise }
    yield { type: 'input_accepted' }
    yield { type: 'text_complete', text: first ? 'APPROVAL-RESULT' : 'NEW-INPUT-RESULT' }
    yield { type: 'complete' }
  })
  restored.agent = agent as never
  internals.getOrCreateAgent = async () => agent
  const reference: Reference = { version: 1, kind: 'web-selection', projectId: restored.projectId,
    url: 'https://example.test/new', title: 'New source', quote: 'NEW-QUOTE',
    locator: { type: 'web-text-quote', exact: 'NEW-QUOTE' } }
  const stored: StoredAttachment = { id: 'cold-notes', type: 'text', name: 'notes.txt', mimeType: 'text/plain', size: 12, storedPath: join(f.root, 'notes.txt') }
  const attachment: FileAttachment = { type: 'text', path: stored.storedPath, name: stored.name, mimeType: stored.mimeType, size: stored.size, text: 'cold notes' }
  const acks: string[] = []
  const incoming = cold.sendMessage(restored.id, 'NEW-COLD-USER-INPUT', [attachment], [stored], { references: [reference] }, undefined, undefined, id => acks.push(id))
  await entered.promise
  try {
    for (let i = 0; i < 20; i++) await tick()
    // The original iterator still owns the turn. Holding it open exposes an
    // admission race that checking only the eventual call order would miss.
    expect(calls).toHaveLength(1)
    expect(restored.isProcessing).toBe(true)
    expect(restored.messageQueue).toHaveLength(1)
    expect(restored.messageQueue[0]?.messageId).toBe(acks[0])
  } finally { release.resolve(); await incoming }
  for (let i = 0; i < 25; i++) await tick()
  await cold.flushSession(restored.id)
  expect(calls).toHaveLength(2)
  expect(calls[0]?.text).toContain('ORIGINAL-ACCEPTED-CONTEXT')
  expect(calls[0]?.text).toContain('ORIGINAL-QUOTE')
  expect(calls[1]?.text).toContain('NEW-COLD-USER-INPUT')
  expect(calls[1]?.text).toContain('NEW-QUOTE')
  expect(calls[1]?.attachments).toEqual([attachment])
  expect(acks).toHaveLength(1)
  expect(restored.messageQueue).toHaveLength(0)
  expect(restored.isProcessing).toBe(false)
  const durable = loadSession(f.root, restored.id)!
  expect(durable.messages.filter(message => message.id === approvalId)).toHaveLength(1)
  expect(durable.messages.find(message => message.id === approvalId)?.references).toEqual([originalReference])
  const newInput = durable.messages.filter(message => message.id === acks[0])
  expect(newInput).toHaveLength(1)
  expect(newInput[0]?.references).toEqual([reference])
  expect(newInput[0]?.attachments).toEqual([stored])
  expect(durable.messages.some(message => message.type === 'assistant' && message.content === 'APPROVAL-RESULT')).toBe(true)
  for (const messageId of [approvalId, acks[0]!]) {
    const delivered = events.findLast(event => event.type === 'user_message' && event.message.id === messageId && event.status === 'processing')
    if (delivered?.type !== 'user_message') throw new Error(`Missing processing event for ${messageId}`)
    expect(delivered.message.isQueued).toBe(false)
  }
}, 5_000)

test('a new send racing public delete cannot ACK or recreate the removed session', async () => {
  const f = await setup()
  const calls: string[] = []
  const acks: string[] = []
  const agent = agentStub(async function* (text) { calls.push(text); yield { type: 'input_accepted' }; yield { type: 'complete' } })
  f.internals.getOrCreateAgent = async () => agent
  // Both real commands share their normal lifecycle lock. No scheduling seam
  // is needed to reproduce deletion between hydration and message creation.
  const sending = f.sm.sendMessage(f.managed.id, 'INPUT-RACING-DELETE', undefined, undefined, undefined, undefined, undefined, id => acks.push(id)).catch(error => error)
  await Promise.all([sending, f.sm.deleteSession(f.managed.id)])
  await sessionPersistenceQueue.flushAll()
  expect(f.internals.sessions.has(f.managed.id)).toBe(false)
  expect(calls).toHaveLength(0)
  expect(acks).toHaveLength(0)
  expect(loadSession(f.root, f.managed.id)).toBeNull()
}, 5_000)

test('a send accepted before public delete keeps its single ACK and is then removed', async () => {
  const f = await setup()
  const calls: string[] = []
  const acks: string[] = []
  const agent = agentStub(async function* (text) { calls.push(text); yield { type: 'input_accepted' }; yield { type: 'complete' } })
  f.internals.getOrCreateAgent = async () => agent
  await f.sm.sendMessage(f.managed.id, 'ACCEPTED-BEFORE-DELETE', undefined, undefined, undefined, undefined, undefined, id => acks.push(id))
  for (let i = 0; i < 5; i++) await tick()
  await f.sm.deleteSession(f.managed.id)
  await sessionPersistenceQueue.flushAll()
  expect(acks).toHaveLength(1)
  expect(calls).toEqual(['ACCEPTED-BEFORE-DELETE'])
  expect(f.internals.sessions.has(f.managed.id)).toBe(false)
  expect(loadSession(f.root, f.managed.id)).toBeNull()
}, 5_000)

test('strict cleanup failure after input acceptance does not close the producing approval iterator', async () => {
  const f = await setup()
  const prepared = await f.sm.setPendingPlanExecution(f.managed.id, '/accepted.md', 'ACCEPTED-CONTEXT')
  setSessionDraft(f.managed.id, { text: 'ACCEPTED-CONTEXT' })
  expect((await f.sm.consumePendingPlanDraft(f.managed.id, prepared.executionId!))?.receipt.text).toBe(true)
  const turn = { generation: f.managed.processingGeneration, stopEpoch: f.managed.stopEpoch ?? 0 }
  f.managed.pendingPlanExecution!.compactionTurn = turn
  const before = loadSession(f.root, f.managed.id)!
  before.pendingPlanExecution = f.managed.pendingPlanExecution
  await saveSessionStrict(before)
  expect(await f.sm.markCompactionComplete(f.managed.id, prepared.executionId, turn)).toBe(true)
  let continued = false
  let closed = false
  const agent = agentStub(async function* () {
    try {
      yield { type: 'input_accepted' }
      continued = true
      yield { type: 'text_complete', text: 'GENUINE-FIRST-ANSWER' }
      yield { type: 'complete' }
    } finally { closed = true }
  })
  f.internals.getOrCreateAgent = async () => agent
  const queue = sessionPersistenceQueue as unknown as QueueWriteHarness
  const original = queue.performWrite
  const blocker = `${getSessionFilePath(f.root, f.managed.id)}.tmp`
  let injected = false
  queue.performWrite = async function (id, entry) {
    if (id === f.managed.id && !injected && !entry.data.pendingPlanExecution && entry.data.messages.length > 0) {
      // Fail the actual atomic write, then repair so its correction and a
      // later successful tracker cleanup can really reach the filesystem.
      injected = true
      mkdirSync(blocker)
      try { return await original.call(this, id, entry) }
      finally { rmSync(blocker, { recursive: true, force: true }) }
    }
    return original.call(this, id, entry)
  }
  try {
    expect(await f.sm.dispatchPendingPlanExecution(f.managed.id, prepared.executionId)).toEqual({ ok: true })
    for (let i = 0; i < 40; i++) await tick()
    await f.sm.flagSession(f.managed.id)
    await f.sm.flushSession(f.managed.id)
    expect(injected).toBe(true)
    expect(continued).toBe(true)
    expect(closed).toBe(true)
    expect(f.managed.messages.some(message => message.role === 'assistant' && message.content === 'GENUINE-FIRST-ANSWER')).toBe(true)
    expect(f.sm.getPendingPlanExecution(f.managed.id)).toBeNull()
    expect(loadSession(f.root, f.managed.id)?.pendingPlanExecution).toBeUndefined()
    expect(getPlanDraftConsumption(f.managed.id, prepared.executionId!)).toBeNull()
  } finally {
    queue.performWrite = original
    rmSync(blocker, { recursive: true, force: true })
    await sessionPersistenceQueue.flush(f.managed.id)
  }
}, 5_000)

test('public delete fences a write captured before the send ACK', async () => {
  const f = await setup()
  const calls: string[] = []
  const acks: string[] = []
  const agent = agentStub(async function* (text) { calls.push(text); yield { type: 'input_accepted' }; yield { type: 'complete' } })
  f.internals.getOrCreateAgent = async () => agent
  const queue = sessionPersistenceQueue as unknown as QueueWriteHarness
  const original = queue.performWrite
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let gated = false
  queue.performWrite = async function (id, entry) {
    if (id === f.managed.id && !gated && entry.data.messages.some(message => message.content === 'INFLIGHT-INPUT')) {
      gated = true
      entered.resolve()
      await release.promise
    }
    return original.call(this, id, entry)
  }
  const sending = f.sm.sendMessage(f.managed.id, 'INFLIGHT-INPUT', undefined, undefined, undefined, undefined, undefined, id => acks.push(id)).catch(error => error)
  await entered.promise
  const deleting = f.sm.deleteSession(f.managed.id)
  try {
    // A correct delete may wait for the in-flight writer. Release the IO
    // independently, rather than requiring delete to return first.
    for (let i = 0; i < 5; i++) await tick()
    release.resolve()
    await Promise.all([sending, deleting])
    await sessionPersistenceQueue.flush(f.managed.id)
    expect(gated).toBe(true)
    expect(f.internals.sessions.has(f.managed.id)).toBe(false)
    expect(calls).toHaveLength(0)
    expect(acks).toHaveLength(0)
    expect(loadSession(f.root, f.managed.id)).toBeNull()
  } finally {
    release.resolve()
    await Promise.all([sending, deleting])
    queue.performWrite = original
    await sessionPersistenceQueue.flush(f.managed.id)
  }
}, 5_000)

test('Stop during completed-turn visual cleanup restores queued following input instead of replaying it', async () => {
  const f = await setup()
  const firstEntered = Promise.withResolvers<void>()
  const firstRelease = Promise.withResolvers<void>()
  const cleanupEntered = Promise.withResolvers<void>()
  const cleanupRelease = Promise.withResolvers<void>()
  let gated = false
  const calls: string[] = []
  const events: SessionEvent[] = []
  const reference: Reference = { version: 1, kind: 'web-selection', projectId: f.managed.projectId,
    url: 'https://example.test/following', title: 'Queued source', quote: 'QUEUED-AFTER-CLEANUP-QUOTE',
    locator: { type: 'web-text-quote', exact: 'QUEUED-AFTER-CLEANUP-QUOTE' } }
  const stored: StoredAttachment = { id: 'cleanup-notes', type: 'text', name: 'notes.txt', mimeType: 'text/plain', size: 12, storedPath: join(f.root, 'notes.txt') }
  const attachment: FileAttachment = { type: 'text', path: stored.storedPath, name: stored.name, mimeType: stored.mimeType, size: stored.size, text: 'cleanup queued notes' }
  const agent = agentStub(async function* (text) {
    calls.push(text)
    yield { type: 'input_accepted' }
    if (calls.length === 1) { firstEntered.resolve(); await firstRelease.promise }
    yield { type: 'text_complete', text: `${text} result` }
    yield { type: 'complete' }
  })
  f.managed.agent = agent as never
  f.internals.getOrCreateAgent = async () => agent
  f.internals.getBrowserPaneManagerForSession = () => ({
    clearVisualsForSession: async () => { if (!gated) { gated = true; cleanupEntered.resolve(); await cleanupRelease.promise } },
    unbindAllForSession: () => {},
  })
  f.sm.setEventSink((_channel, _target, event) => events.push(structuredClone(event)))
  const first = f.sm.sendMessage(f.managed.id, 'FIRST-INPUT')
  await firstEntered.promise
  await f.sm.sendMessage(f.managed.id, 'FOLLOWING-QUEUED-INPUT', [attachment], [stored], { references: [reference] })
  const queuedId = f.managed.messageQueue[0]!.messageId!
  firstRelease.resolve()
  await cleanupEntered.promise
  expect(f.managed.isProcessing).toBe(false)
  expect(f.managed.messageQueue).toHaveLength(1)
  expect(f.managed.pendingQueueReplay).toBeUndefined()
  expect(events.filter(event => event.type === 'complete')).toHaveLength(0)
  await f.sm.cancelProcessing(f.managed.id)
  cleanupRelease.resolve()
  try {
    await first
    for (let i = 0; i < 20; i++) await tick()
    await f.sm.flushSession(f.managed.id)
    const interrupted = events.find(event => event.type === 'interrupted')
    expect(calls).toEqual(['FIRST-INPUT'])
    expect(interrupted?.queuedMessages).toEqual(['FOLLOWING-QUEUED-INPUT'])
    expect(interrupted?.queuedMessageIds).toEqual([queuedId])
    expect(interrupted?.queuedReferences).toEqual([reference])
    expect(interrupted?.queuedAttachments).toEqual([stored])
    expect(interrupted?.queuedRestoreId).toBeString()
    expect(loadSession(f.root, f.managed.id)?.messages.find(message => message.id === queuedId)?.queuedRestoreId).toBe(interrupted!.queuedRestoreId)
    expect(f.managed.messageQueue).toHaveLength(0)
  } finally { firstRelease.resolve(); cleanupRelease.resolve(); await first; await f.sm.cancelProcessing(f.managed.id) }
}, 5_000)

test('Stop during ordinary scheduled replay restores its references and attachments before admission', async () => {
  const f = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: string[] = []
  const events: SessionEvent[] = []
  let stopping: Promise<void> | undefined
  const reference: Reference = { version: 1, kind: 'web-selection', projectId: f.managed.projectId,
    url: 'https://example.test', title: 'Queued source', quote: 'QUEUED-QUOTE',
    locator: { type: 'web-text-quote', exact: 'QUEUED-QUOTE' } }
  const stored: StoredAttachment = { id: 'queued-notes', type: 'text', name: 'notes.txt', mimeType: 'text/plain', size: 12, storedPath: join(f.root, 'notes.txt') }
  const attachment: FileAttachment = { type: 'text', path: stored.storedPath, name: stored.name, mimeType: stored.mimeType, size: stored.size, text: 'queued notes' }
  const agent = agentStub(async function* (text) {
    calls.push(text)
    yield { type: 'input_accepted' }
    if (calls.length === 1) { entered.resolve(); await release.promise }
    yield { type: 'complete' }
  })
  f.managed.agent = agent as never
  f.internals.getOrCreateAgent = async () => agent
  f.sm.setEventSink((_channel, _target, event) => {
    events.push(structuredClone(event))
    if (event.type === 'user_message' && event.status === 'processing' && event.message.content === 'ORDINARY-QUEUED-INPUT') {
      // Pin the actual queue-pop -> setImmediate admission boundary. The
      // public cancel command can also arrive through RPC in this window.
      stopping = f.sm.cancelProcessing(f.managed.id)
    }
  })
  const first = f.sm.sendMessage(f.managed.id, 'FIRST-INPUT')
  await entered.promise
  await f.sm.sendMessage(f.managed.id, 'ORDINARY-QUEUED-INPUT', [attachment], [stored], { references: [reference] })
  const messageId = f.managed.messageQueue[0]!.messageId!
  release.resolve()
  await first
  for (let i = 0; i < 30; i++) await tick()
  await stopping
  await f.sm.flushSession(f.managed.id)
  expect(stopping).toBeDefined()
  expect(calls).toEqual(['FIRST-INPUT'])
  expect(f.managed.messageQueue).toHaveLength(0)
  const interrupted = events.find(event => event.type === 'interrupted')
  expect(interrupted?.queuedMessages).toEqual(['ORDINARY-QUEUED-INPUT'])
  expect(interrupted?.queuedReferences).toEqual([reference])
  expect(interrupted?.queuedAttachments).toEqual([stored])
  expect(interrupted?.queuedMessageIds).toEqual([messageId])
  expect(interrupted?.queuedRestoreId).toBeString()
  expect(loadSession(f.root, f.managed.id)?.messages.find(message => message.id === messageId)?.queuedRestoreId).toBe(interrupted!.queuedRestoreId)
}, 5_000)

test.each(['missing bubble', 'invalid persisted reference'] as const)('scheduled replay with %s reports once and delivers complete following input', async (fault) => {
  const f = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: { text: string; attachments?: FileAttachment[] }[] = []
  const replayErrors: SessionEvent[] = []
  let injected = false
  let cleanup: Promise<void> | undefined
  const reference: Reference = { version: 1, kind: 'web-selection', projectId: f.managed.projectId,
    url: 'https://example.test/following', title: 'Following source', quote: 'FOLLOWING-QUOTE',
    locator: { type: 'web-text-quote', exact: 'FOLLOWING-QUOTE' } }
  const stored: StoredAttachment = { id: 'following-notes', type: 'text', name: 'notes.txt', mimeType: 'text/plain', size: 12, storedPath: join(f.root, 'notes.txt') }
  const attachment: FileAttachment = { type: 'text', path: stored.storedPath, name: stored.name, mimeType: stored.mimeType, size: stored.size, text: 'following notes' }
  const agent = agentStub(async function* (text, attachments) {
    calls.push({ text, attachments })
    yield { type: 'input_accepted' }
    if (calls.length === 1) { entered.resolve(); await release.promise }
    yield { type: 'complete' }
  })
  f.managed.agent = agent as never
  f.internals.getOrCreateAgent = async () => agent
  f.sm.setEventSink((_channel, _target, event) => {
    if (!injected && event.type === 'user_message' && event.status === 'processing' && event.message.content === 'REJECTED-QUEUED-INPUT') {
      injected = true
      // Preserve the real scheduled queue entry and exercise its actual
      // admission failure against a missing or invalid durable bubble.
      if (fault === 'missing bubble') {
        f.managed.messages = f.managed.messages.filter(message => message.id !== event.message.id)
      } else {
        const queued = f.managed.messages.find(message => message.id === event.message.id)!
        queued.references = [{ ...reference, projectId: 'another-project' }]
      }
    }
    if (event.type === 'typed_error' && event.error.code === 'queued_message_replay_failed') {
      replayErrors.push(structuredClone(event))
      // Bound a broken auto-replay loop without changing the rejection or
      // pretending another automatic attempt is an explicit user retry.
      if (replayErrors.length === 3) {
        Reflect.set(f.sm, 'processNextQueuedMessage', () => {})
        cleanup = f.sm.cancelProcessing(f.managed.id)
      }
    }
  })
  const first = f.sm.sendMessage(f.managed.id, 'FIRST-INPUT')
  await entered.promise
  await f.sm.sendMessage(f.managed.id, 'REJECTED-QUEUED-INPUT', undefined, undefined, { references: [reference] })
  const rejectedId = f.managed.messageQueue[0]!.messageId!
  await f.sm.sendMessage(f.managed.id, 'FOLLOWING-QUEUED-INPUT', [attachment], [stored], { references: [reference] })
  const followingId = f.managed.messageQueue[1]!.messageId!
  release.resolve()
  try {
    await first
    for (let i = 0; i < 30; i++) await tick()
    await cleanup
    await f.sm.flushSession(f.managed.id)
    expect(injected).toBe(true)
    expect(replayErrors).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.text).toBe('FIRST-INPUT')
    expect(calls[1]?.text).toContain('FOLLOWING-QUEUED-INPUT')
    expect(calls[1]?.text).toContain('FOLLOWING-QUOTE')
    expect(calls[1]?.attachments).toEqual([attachment])
    expect(f.managed.isProcessing).toBe(false)
    expect(f.managed.messageQueue).toHaveLength(0)
    const durable = loadSession(f.root, f.managed.id)!
    const following = durable.messages.filter(message => message.id === followingId)
    expect(following).toHaveLength(1)
    expect(following[0]?.references).toEqual([reference])
    expect(following[0]?.attachments).toEqual([stored])
    expect(following[0]?.isQueued).toBe(false)
    if (fault === 'invalid persisted reference') expect(durable.messages.find(message => message.id === rejectedId)?.isQueued).toBe(false)
  } finally {
    release.resolve(); await first
    await cleanup
    await f.sm.cancelProcessing(f.managed.id)
  }
}, 5_000)

test('a delayed generic replay startup rejection warns without interrupting a newer active turn', async () => {
  const f = await setup()
  const firstEntered = Promise.withResolvers<void>()
  const firstRelease = Promise.withResolvers<void>()
  const cleanupEntered = Promise.withResolvers<void>()
  const cleanupRelease = Promise.withResolvers<void>()
  const newerEntered = Promise.withResolvers<void>()
  const newerRelease = Promise.withResolvers<void>()
  const newerDeltaSent = Promise.withResolvers<void>()
  let gatedCleanup = false
  let starts = 0
  let activeUnbinds = 0
  const calls: string[] = []
  const events: { event: SessionEvent; generation: number; processing: boolean }[] = []
  const agent = agentStub(async function* (text) {
    calls.push(text)
    yield { type: 'input_accepted' }
    if (text === 'FIRST-INPUT') { firstEntered.resolve(); await firstRelease.promise }
    if (text === 'NEWER-INPUT') {
      yield { type: 'text_delta', text: 'NEWER-PARTIAL' }
      newerEntered.resolve()
      await newerRelease.promise
    }
    yield { type: 'text_complete', text: `${text} result` }
    yield { type: 'complete' }
  })
  f.internals.getOrCreateAgent = async () => {
    if (++starts === 2) throw new Error('isolated queued setup failure')
    return agent
  }
  f.internals.getBrowserPaneManagerForSession = () => ({
    clearVisualsForSession: async () => {
      if (!gatedCleanup && f.managed.processingGeneration === 2) {
        gatedCleanup = true
        cleanupEntered.resolve()
        await cleanupRelease.promise
      }
    },
    unbindAllForSession: () => { if (f.managed.isProcessing) activeUnbinds++ },
  })
  f.sm.setEventSink((_channel, _target, event) => {
    events.push({ event: structuredClone(event), generation: f.managed.processingGeneration, processing: f.managed.isProcessing })
    if (event.type === 'text_delta' && event.delta === 'NEWER-PARTIAL') newerDeltaSent.resolve()
  })
  const reference: Reference = { version: 1, kind: 'web-selection', projectId: f.managed.projectId,
    url: 'https://example.test/queued', title: 'Failed queued source', quote: 'FAILED-QUEUED-QUOTE',
    locator: { type: 'web-text-quote', exact: 'FAILED-QUEUED-QUOTE' } }
  const stored: StoredAttachment = { id: 'failed-queued-notes', type: 'text', name: 'notes.txt', mimeType: 'text/plain', size: 12, storedPath: join(f.root, 'notes.txt') }
  const attachment: FileAttachment = { type: 'text', path: stored.storedPath, name: stored.name, mimeType: stored.mimeType, size: stored.size, text: 'queued notes' }
  const first = f.sm.sendMessage(f.managed.id, 'FIRST-INPUT')
  await firstEntered.promise
  await f.sm.sendMessage(f.managed.id, 'QUEUED-INPUT', [attachment], [stored], { references: [reference] })
  const queuedId = f.managed.messageQueue[0]!.messageId!
  firstRelease.resolve()
  await first
  await cleanupEntered.promise
  const newer = f.sm.sendMessage(f.managed.id, 'NEWER-INPUT')
  await newerEntered.promise
  // Wait for the real batched IPC delta, so the warning arrives while the
  // renderer already owns the newer turn's unfinished response.
  await newerDeltaSent.promise
  try {
    expect(f.managed.processingGeneration).toBe(3)
    cleanupRelease.resolve()
    for (let i = 0; i < 15; i++) await tick()
    expect(events.filter(({ event }) => event.type === 'typed_error' || event.type === 'error')).toHaveLength(0)
    expect(events.filter(({ event, processing }) => event.type === 'complete' && processing)).toHaveLength(0)
    expect(activeUnbinds).toBe(0)
    expect(f.managed.isProcessing).toBe(true)
    expect(calls).toEqual(['FIRST-INPUT', 'NEWER-INPUT'])
    expect(events.some(({ event }) => event.type === 'text_delta' && event.delta === 'NEWER-PARTIAL')).toBe(true)
    const warnings = events.filter(({ event }) => event.type === 'info' && event.level === 'warning')
    expect(warnings).toHaveLength(1)
    const warning = warnings[0]!
    expect(warning.processing).toBe(true)
    expect(warning.generation).toBe(3)
    if (warning.event.type !== 'info') throw new Error('Expected an informational queue failure warning')
    expect(warning.event.message).toContain('QUEUED-INPUT')
    // A historical warning must remain after reload, without pretending the
    // input reached the model or offering Retry for the newer last message.
    await f.sm.flushSession(f.managed.id)
    const durable = loadSession(f.root, f.managed.id)!
    const failedInput = durable.messages.find(message => message.id === queuedId)!
    expect(failedInput.content).toBe('QUEUED-INPUT')
    expect(failedInput.references).toEqual([reference])
    expect(failedInput.attachments).toEqual([stored])
    // The failed startup never accepted this input. It remains in the durable
    // restore outbox, while the live execution queue stays empty below.
    expect(failedInput.isQueued).toBe(true)
    expect(failedInput.queuedRestoreId).toBe(`input-${queuedId}`)
    expect(failedInput.pendingDelivery).toBeUndefined()
    const restores = events.filter(({ event }) => event.type === 'interrupted' && event.queuedMessageIds?.includes(queuedId))
    expect(restores).toHaveLength(1)
    expect(restores[0]?.generation).toBe(2)
    expect(restores[0]?.event).toMatchObject({
      type: 'interrupted',
      queuedMessages: ['QUEUED-INPUT'],
      queuedMessageIds: [queuedId],
      queuedReferences: [reference],
      queuedAttachments: [stored],
      queuedRestoreId: `input-${queuedId}`,
    })
    expect(durable.messages.filter(message => message.type === 'user' && message.content === 'QUEUED-INPUT')).toHaveLength(1)
    const durableWarnings = durable.messages.filter(message => message.type === 'info' && message.infoLevel === 'warning')
    expect(durableWarnings).toHaveLength(1)
    expect(durableWarnings[0]?.content).toBe(warning.event.message)
    expect(durableWarnings[0]?.timestamp).toBe(warning.event.timestamp)
    expect(f.managed.messageQueue).toHaveLength(0)
    expect(f.managed.pendingQueueReplay).toBeUndefined()
  } finally {
    firstRelease.resolve(); cleanupRelease.resolve(); newerRelease.resolve()
    await Promise.all([first, newer])
    for (let i = 0; i < 5; i++) await tick()
  }
  await f.sm.flushSession(f.managed.id)
  expect(loadSession(f.root, f.managed.id)?.messages.some(message => message.type === 'assistant' && message.content === 'NEWER-INPUT result')).toBe(true)
  expect(f.managed.isProcessing).toBe(false)
}, 5_000)

test('Stop before an auth-retry callback preserves the stopped input and permits a new warm send', async () => {
  const f = await setup()
  const calls: string[] = []
  let stopping: Promise<void> | undefined
  let initialMessageId: string | undefined
  const agent = agentStub(async function* (text) {
    calls.push(text)
    yield { type: 'input_accepted' }
    if (calls.length === 1) yield { type: 'error', message: 'Authentication token is expired' }
    yield { type: 'complete' }
  })
  f.managed.agent = agent as never
  f.internals.getOrCreateAgent = async () => agent
  f.sm.setEventSink((_channel, _target, event) => {
    if (event.type === 'info' && event.message === 'Token expired, refreshing session…') {
      initialMessageId = f.managed.lastSentMessageIds?.[0]
      // The real info callback is emitted before setImmediate is scheduled.
      // Stop must invalidate that old retry before it mutates any history.
      stopping = f.sm.cancelProcessing(f.managed.id)
    }
  })
  await f.sm.sendMessage(f.managed.id, 'AUTH-INPUT-BEFORE-STOP')
  await stopping
  for (let i = 0; i < 30; i++) await tick()
  await f.sm.flushSession(f.managed.id)
  expect(stopping).toBeDefined()
  expect(calls).toEqual(['AUTH-INPUT-BEFORE-STOP'])
  expect(f.managed.messages.find(message => message.id === initialMessageId)?.content).toBe('AUTH-INPUT-BEFORE-STOP')
  expect(f.managed.isProcessing).toBe(false)
  expect(f.managed.authRetryInProgress).toBe(false)
  await f.sm.sendMessage(f.managed.id, 'NEW-WARM-INPUT-AFTER-STOP')
  for (let i = 0; i < 5; i++) await tick()
  expect(calls).toEqual(['AUTH-INPUT-BEFORE-STOP', 'NEW-WARM-INPUT-AFTER-STOP'])
  expect(f.managed.isProcessing).toBe(false)
}, 5_000)

test('an owned auth retry succeeds once with the accepted references and attachments', async () => {
  const f = await setup()
  const calls: { text: string; attachments?: FileAttachment[] }[] = []
  const events: SessionEvent[] = []
  const acks: string[] = []
  const reference: Reference = { version: 1, kind: 'web-selection', projectId: f.managed.projectId,
    url: 'https://example.test/auth', title: 'Accepted source', quote: 'ACCEPTED-AUTH-QUOTE',
    locator: { type: 'web-text-quote', exact: 'ACCEPTED-AUTH-QUOTE' } }
  const stored: StoredAttachment = { id: 'auth-notes', type: 'text', name: 'notes.txt', mimeType: 'text/plain', size: 12, storedPath: join(f.root, 'notes.txt') }
  const attachment: FileAttachment = { type: 'text', path: stored.storedPath, name: stored.name, mimeType: stored.mimeType, size: stored.size, text: 'auth notes' }
  const agent = agentStub(async function* (text, attachments) {
    calls.push({ text, attachments })
    yield { type: 'input_accepted' }
    if (calls.length === 1) {
      yield { type: 'typed_error', error: { code: 'invalid_api_key', title: 'Expired credentials', message: 'Token expired', actions: [], canRetry: true } }
    } else {
      yield { type: 'text_complete', text: 'AUTH-RETRY-RESULT' }
    }
    yield { type: 'complete' }
  })
  f.managed.agent = agent as never
  f.internals.getOrCreateAgent = async () => { f.managed.agent = agent as never; return agent }
  f.sm.setEventSink((_channel, _target, event) => events.push(structuredClone(event)))
  await f.sm.sendMessage(f.managed.id, 'OWNED-AUTH-INPUT', [attachment], [stored], { references: [reference] }, undefined, undefined, id => acks.push(id))
  for (let i = 0; i < 30; i++) await tick()
  await f.sm.flushSession(f.managed.id)
  expect(calls).toHaveLength(2)
  expect(calls[0]?.text).toBe(calls[1]?.text)
  expect(calls[1]?.text).toContain('OWNED-AUTH-INPUT')
  expect(calls[1]?.text).toContain('ACCEPTED-AUTH-QUOTE')
  expect(calls[0]?.attachments).toEqual([attachment])
  expect(calls[1]?.attachments).toEqual([attachment])
  const durable = loadSession(f.root, f.managed.id)!
  const users = durable.messages.filter(message => message.type === 'user')
  expect(users).toHaveLength(1)
  expect(acks).toHaveLength(1)
  expect(users[0]?.id).toBe(acks[0])
  expect(users[0]?.content).toBe('OWNED-AUTH-INPUT')
  expect(users[0]?.references).toEqual([reference])
  expect(users[0]?.attachments).toEqual([stored])
  expect(durable.messages.some(message => message.type === 'assistant' && message.content === 'AUTH-RETRY-RESULT')).toBe(true)
  expect(events.filter(event => event.type === 'typed_error' || event.type === 'error')).toHaveLength(0)
  expect(f.managed.authRetryInProgress).toBe(false)
  expect(f.managed.isProcessing).toBe(false)
  expect(f.managed.messageQueue).toHaveLength(0)
}, 5_000)
