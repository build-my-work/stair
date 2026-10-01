import { afterAll, expect, spyOn, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StoredSession } from '../../../shared/src/sessions/types.ts'
import type { AgentEvent, Reference, StoredAttachment } from '../../../core/src/types/index.ts'
import type { SessionEvent } from '../../../shared/src/protocol/dto.ts'
import type { FileAttachment } from '../../../shared/src/utils/files.ts'

if (process.env.CRAFT_PENDING_PLAN_METADATA_TEST_CHILD !== '1') {
  throw new Error('pending-plan metadata fixture requires its isolated test entry')
}
const profile = mkdtempSync(join(tmpdir(), 'stair-plan-metadata-profile-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(
  join(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'),
  join(profile, 'config-defaults.json'),
)
const { CONFIG_DIR } = await import('../../../shared/src/config/paths.ts')
if (CONFIG_DIR !== profile) throw new Error('pending-plan metadata fixture requires an isolated config module cache')
const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { createWorkspaceAtPath } = await import('../../../shared/src/workspaces/storage.ts')
const { createProject } = await import('../../../shared/src/projects/index.ts')
const projectFiles = await import('../handlers/rpc/project-files.ts')
const { saveSessionStrict, loadSession, sessionPersistenceQueue, getSessionFilePath } = await import('../../../shared/src/sessions/index.ts')
const { setSessionDraft, getSessionDraft, getPlanDraftConsumption } = await import('../../../shared/src/config/storage.ts')

type Managed = ReturnType<typeof createManagedSession>
type PendingWrite = { data: StoredSession; timer: ReturnType<typeof setTimeout> }
type QueueWriteHarness = { performWrite(sessionId: string, entry: PendingWrite): Promise<void> }
const workspaces: string[] = []
afterAll(async () => {
  // Cold reconciliation uses captured setImmediate callbacks. Let them settle
  // before disposing their isolated directories.
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  await sessionPersistenceQueue.flushAll()
  for (const root of workspaces) rmSync(root, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
})

async function setup(persistInitialSession = true) {
  const root = mkdtempSync(join(tmpdir(), 'stair-plan-metadata-workspace-'))
  workspaces.push(root)
  const workspace = createWorkspaceAtPath(root, 'Pending-plan metadata review')
  const id = `metadata-${randomUUID()}`
  const sm = new SessionManager()
  const managed = createManagedSession({ id, name: 'Review', projectId: workspace.defaultProjectId }, { ...workspace, rootPath: root }, { messagesLoaded: true })
  ;(sm as unknown as { sessions: Map<string, Managed> }).sessions.set(id, managed)
  ;(sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}
  sm.setEventSink(() => {})
  if (persistInitialSession) {
    await saveSessionStrict({
      id, name: 'Review', projectId: managed.projectId, workspaceRootPath: root,
      createdAt: 1, lastUsedAt: 1, messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as StoredSession)
  }
  return { sm, managed, root, workspace }
}

async function readyConsumedPlan(f: Awaited<ReturnType<typeof setup>>, text: string) {
  const prepared = await f.sm.setPendingPlanExecution(f.managed.id, '/accepted.md', text)
  setSessionDraft(f.managed.id, { text })
  expect((await f.sm.consumePendingPlanDraft(f.managed.id, prepared.executionId!))?.receipt.text).toBe(true)
  const turn = { generation: f.managed.processingGeneration, stopEpoch: f.managed.stopEpoch ?? 0 }
  f.managed.pendingPlanExecution!.compactionTurn = turn
  const before = loadSession(f.root, f.managed.id)!
  before.pendingPlanExecution = f.managed.pendingPlanExecution
  await saveSessionStrict(before)
  expect(await f.sm.markCompactionComplete(f.managed.id, prepared.executionId, turn)).toBe(true)
  return prepared
}

/** Pause only IO scheduling; the real queue serialization and writes still run. */
async function withConcurrentFlag<T>(
  sm: InstanceType<typeof SessionManager>,
  sessionId: string,
  matches: (entry: PendingWrite) => boolean,
  transition: () => Promise<T>,
): Promise<T> {
  const queue = sessionPersistenceQueue as unknown as QueueWriteHarness
  const original = queue.performWrite
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let gated = false
  queue.performWrite = async function (id, entry) {
    if (id === sessionId && matches(entry) && !gated) {
      gated = true
      entered.resolve()
      await release.promise
    }
    return original.call(this, id, entry)
  }
  try {
    const transitioning = transition()
    await Promise.race([
      entered.promise,
      transitioning.then(() => { throw new Error('Transition completed without the expected IO boundary') }),
    ])
    // This is the real public command, with its normal enqueue + flush.
    const flagging = sm.flagSession(sessionId)
    release.resolve()
    const [result] = await Promise.all([transitioning, flagging])
    return result
  } finally {
    release.resolve()
    queue.performWrite = original
    await sessionPersistenceQueue.flush(sessionId)
  }
}

test('a concurrent flag cannot erase a prepared record or lose its consumed draft on reboot', async () => {
  const f = await setup()
  const text = 'CRASH-RECOVERABLE-PREPARE-DRAFT'
  setSessionDraft(f.managed.id, { text })
  const prepared = await withConcurrentFlag(f.sm, f.managed.id,
    entry => entry.data.pendingPlanExecution?.planPath === '/accepted.md',
    () => f.sm.setPendingPlanExecution(f.managed.id, '/accepted.md', text),
  )
  const stored = loadSession(f.root, f.managed.id)!
  const consumed = await f.sm.consumePendingPlanDraft(f.managed.id, prepared.executionId!)
  const cold = new SessionManager()
  const restored = createManagedSession({ id: f.managed.id, name: 'Review', projectId: f.managed.projectId }, { ...f.workspace, rootPath: f.root }, { messagesLoaded: false })
  ;(cold as unknown as { sessions: Map<string, Managed> }).sessions.set(restored.id, restored)
  ;(cold as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}
  await (cold as unknown as { ensureMessagesLoaded(managed: Managed): Promise<void> }).ensureMessagesLoaded(restored)
  const recovery = cold.getPendingPlanExecution(restored.id)

  expect(stored.isFlagged).toBe(true)
  expect(stored.pendingPlanExecution?.executionId).toBe(prepared.executionId)
  expect(consumed?.receipt.text).toBe(true)
  expect(getSessionDraft(restored.id)).toBeNull()
  expect(recovery?.executionId).toBe(prepared.executionId)
  expect(recovery?.draftInputSnapshot).toBe(text)
  await cold.restorePendingPlanDraft(restored.id, prepared.executionId!, recovery!.restoreId!)
  await cold.clearPendingPlanExecution(restored.id, prepared.executionId)
  expect(getSessionDraft(restored.id)?.text).toBe(text)
  expect(cold.getPendingPlanExecution(restored.id)).toBeNull()
}, 5_000)

test('prepare retries a failed first session write after filesystem recovery', async () => {
  const f = await setup(false)
  const text = 'RECOVERABLE-FIRST-WRITE-DRAFT'
  setSessionDraft(f.managed.id, { text })
  const blocker = `${getSessionFilePath(f.root, f.managed.id)}.tmp`
  mkdirSync(blocker, { recursive: true })
  try {
    // The real public metadata command enqueues and flushes the initial live
    // image. Its ordinary flush logs the write failure; strict callers must
    // still observe the sticky error after that queue entry was consumed.
    await f.sm.flagSession(f.managed.id)
    expect(loadSession(f.root, f.managed.id)).toBeNull()
    await expect(sessionPersistenceQueue.flush(f.managed.id, { strict: true })).rejects.toThrow()
  } finally {
    rmSync(blocker, { recursive: true, force: true })
  }
  const prepared = await f.sm.setPendingPlanExecution(f.managed.id, '/accepted.md', text)
  const stored = loadSession(f.root, f.managed.id)!
  expect(stored.isFlagged).toBe(true)
  expect(stored.pendingPlanExecution?.executionId).toBe(prepared.executionId)
  expect((await f.sm.consumePendingPlanDraft(f.managed.id, prepared.executionId!))?.receipt.text).toBe(true)
  expect(getSessionDraft(f.managed.id)).toBeNull()

  const cold = new SessionManager()
  const restored = createManagedSession({ id: f.managed.id, name: 'Review', projectId: f.managed.projectId }, { ...f.workspace, rootPath: f.root }, { messagesLoaded: false })
  ;(cold as unknown as { sessions: Map<string, Managed> }).sessions.set(restored.id, restored)
  ;(cold as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}
  await (cold as unknown as { ensureMessagesLoaded(managed: Managed): Promise<void> }).ensureMessagesLoaded(restored)
  const recovery = cold.getPendingPlanExecution(restored.id)
  expect(recovery?.executionId).toBe(prepared.executionId)
  expect(recovery?.draftInputSnapshot).toBe(text)
  await cold.restorePendingPlanDraft(restored.id, prepared.executionId!, recovery!.restoreId!)
  await cold.clearPendingPlanExecution(restored.id, prepared.executionId)
  expect(getSessionDraft(restored.id)?.text).toBe(text)
  expect(cold.getPendingPlanExecution(restored.id)).toBeNull()
}, 5_000)

test('prepare rejects a missing session without an initial write instead of creating a ghost', async () => {
  const f = await setup(false)
  setSessionDraft(f.managed.id, { text: 'UNCONSUMED-GHOST-DRAFT' })
  await expect(f.sm.setPendingPlanExecution(f.managed.id, '/accepted.md', 'UNCONSUMED-GHOST-DRAFT'))
    .rejects.toThrow('PENDING_PLAN_SESSION_MISSING')
  expect(loadSession(f.root, f.managed.id)).toBeNull()
  expect(f.managed.pendingPlanExecution).toBeUndefined()
  expect(getSessionDraft(f.managed.id)?.text).toBe('UNCONSUMED-GHOST-DRAFT')
}, 5_000)

test('Stop during an accepted approval startup prevents cold-restart execution', async () => {
  const f = await setup()
  // Restore the actual prototype queue replay for this end-to-end delivery
  // case; the metadata-only cases intentionally leave queued messages inert.
  Reflect.deleteProperty(f.sm, 'processNextQueuedMessage')
  ;(f.sm as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
  const text = 'STOPPED-BEFORE-BACKEND-HANDOFF'
  const prepared = await readyConsumedPlan(f, text)

  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const chats: string[] = []
  const agent = {
    getModel: () => 'claude-sonnet-4-6',
    setAllSources: () => {},
    getSessionId: () => undefined,
    forceAbort: () => {},
    chat: async function* (message: string): AsyncGenerator<AgentEvent> {
      chats.push(message)
      yield { type: 'complete' }
    },
  }
  ;(f.sm as unknown as { getOrCreateAgent: () => Promise<typeof agent> }).getOrCreateAgent = async () => {
    entered.resolve()
    await release.promise
    return agent
  }
  try {
    expect(await f.sm.dispatchPendingPlanExecution(f.managed.id, prepared.executionId)).toEqual({ ok: true })
    await entered.promise
    await f.sm.cancelProcessing(f.managed.id)
  } finally {
    release.resolve()
  }
  for (let i = 0; f.managed.isProcessing && i < 100; i++) await Bun.sleep(1)
  expect(f.managed.isProcessing).toBe(false)
  await f.sm.flushSession(f.managed.id)
  expect(chats).toHaveLength(0)

  const cold = new SessionManager()
  const restored = createManagedSession({ id: f.managed.id, name: 'Review', projectId: f.managed.projectId }, { ...f.workspace, rootPath: f.root }, { messagesLoaded: false })
  ;(cold as unknown as { sessions: Map<string, Managed> }).sessions.set(restored.id, restored)
  ;(cold as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
  cold.setEventSink(() => {})
  const coldChats: string[] = []
  ;(cold as unknown as { getOrCreateAgent: () => Promise<typeof agent> }).getOrCreateAgent = async () => ({
    ...agent,
    chat: async function* (message: string): AsyncGenerator<AgentEvent> {
      coldChats.push(message)
      yield { type: 'complete' }
    },
  })
  await (cold as unknown as { ensureMessagesLoaded(managed: Managed): Promise<void> }).ensureMessagesLoaded(restored)
  // Drain the real recovery callbacks and queue replay rather than stubbing
  // sendMessage, so a stale delivery tracker can reach the offline backend.
  for (let i = 0; i < 25; i++) {
    await new Promise(resolve => setImmediate(resolve))
    await Bun.sleep(1)
  }
  await cold.flushSession(restored.id)
  expect(coldChats).toHaveLength(0)
  expect(restored.messageQueue).toHaveLength(0)
  expect(cold.getPendingPlanExecution(restored.id)?.failed).toBe(true)
  expect(cold.getPendingPlanExecution(restored.id)?.draftInputSnapshot).toBe(text)
}, 5_000)

test('a concurrent flag cannot undo a successful compaction readiness transition', async () => {
  const f = await setup()
  const prepared = await f.sm.setPendingPlanExecution(f.managed.id, '/accepted.md', 'draft')
  const turn = { generation: f.managed.processingGeneration, stopEpoch: f.managed.stopEpoch ?? 0 }
  f.managed.pendingPlanExecution!.compactionTurn = turn
  const before = loadSession(f.root, f.managed.id)!
  before.pendingPlanExecution = f.managed.pendingPlanExecution
  await saveSessionStrict(before)
  const marked = await withConcurrentFlag(f.sm, f.managed.id,
    entry => entry.data.pendingPlanExecution?.awaitingCompaction === false,
    () => f.sm.markCompactionComplete(f.managed.id, prepared.executionId, turn),
  )
  const stored = loadSession(f.root, f.managed.id)!
  expect(marked).toBe(true)
  expect(f.managed.pendingPlanExecution?.awaitingCompaction).toBe(false)
  expect(stored.isFlagged).toBe(true)
  expect(stored.pendingPlanExecution?.awaitingCompaction).toBe(false)
}, 5_000)

test('a concurrent flag cannot resurrect a successfully cleared record', async () => {
  const f = await setup()
  const prepared = await f.sm.setPendingPlanExecution(f.managed.id, '/accepted.md', 'draft')
  await withConcurrentFlag(f.sm, f.managed.id,
    entry => entry.data.pendingPlanExecution === undefined,
    () => f.sm.clearPendingPlanExecution(f.managed.id, prepared.executionId),
  )
  const stored = loadSession(f.root, f.managed.id)!
  expect(f.managed.pendingPlanExecution).toBeUndefined()
  expect(stored.isFlagged).toBe(true)
  expect(stored.pendingPlanExecution).toBeUndefined()
}, 5_000)

test('a failed prepare rolls back its record and permits retry after filesystem recovery', async () => {
  const f = await setup()
  const first = await f.sm.setPendingPlanExecution(f.managed.id, '/first.md', 'FIRST')
  setSessionDraft(f.managed.id, { text: 'UNCONSUMED-REPLACEMENT' })
  const blocker = `${getSessionFilePath(f.root, f.managed.id)}.tmp`
  mkdirSync(blocker)
  try {
    await expect(f.sm.setPendingPlanExecution(f.managed.id, '/failed.md', 'UNCONSUMED-REPLACEMENT'))
      .rejects.toThrow()
    expect(f.managed.pendingPlanExecution?.executionId).toBe(first.executionId)
    expect(loadSession(f.root, f.managed.id)?.pendingPlanExecution?.executionId).toBe(first.executionId)
    expect(getSessionDraft(f.managed.id)?.text).toBe('UNCONSUMED-REPLACEMENT')
  } finally {
    rmSync(blocker, { recursive: true, force: true })
  }
  const retry = await f.sm.setPendingPlanExecution(f.managed.id, '/retry.md', 'UNCONSUMED-REPLACEMENT')
  expect(retry.executionId).not.toBe(first.executionId)
  expect(f.managed.pendingPlanExecution?.executionId).toBe(retry.executionId)
  expect(loadSession(f.root, f.managed.id)?.pendingPlanExecution?.executionId).toBe(retry.executionId)
  expect(getSessionDraft(f.managed.id)?.text).toBe('UNCONSUMED-REPLACEMENT')
}, 5_000)

test('a failed dispatch removes its approval from a concurrent metadata successor and cold recovery', async () => {
  const f = await setup()
  const prepared = await f.sm.setPendingPlanExecution(f.managed.id, '/accepted.md', 'READY-DRAFT')
  const turn = { generation: f.managed.processingGeneration, stopEpoch: f.managed.stopEpoch ?? 0 }
  f.managed.pendingPlanExecution!.compactionTurn = turn
  const before = loadSession(f.root, f.managed.id)!
  before.pendingPlanExecution = f.managed.pendingPlanExecution
  await saveSessionStrict(before)
  expect(await f.sm.markCompactionComplete(f.managed.id, prepared.executionId, turn)).toBe(true)

  const queue = sessionPersistenceQueue as unknown as QueueWriteHarness
  const original = queue.performWrite
  const handoffEntered = Promise.withResolvers<void>()
  const handoffRelease = Promise.withResolvers<void>()
  const metadataEntered = Promise.withResolvers<void>()
  const metadataRelease = Promise.withResolvers<void>()
  let handoffGated = false
  let metadataGated = false
  queue.performWrite = async function (id, entry) {
    if (id === f.managed.id && !handoffGated && entry.data.pendingPlanExecution?.executionDispatched) {
      handoffGated = true
      handoffEntered.resolve()
      await handoffRelease.promise
    } else if (id === f.managed.id && handoffGated && !metadataGated && entry.data.isFlagged) {
      metadataGated = true
      metadataEntered.resolve()
      await metadataRelease.promise
    }
    return original.call(this, id, entry)
  }
  const blocker = `${getSessionFilePath(f.root, f.managed.id)}.tmp`
  try {
    const dispatching = f.sm.dispatchPendingPlanExecution(f.managed.id, prepared.executionId)
    await handoffEntered.promise
    // Its snapshot includes the approval message, which must not survive a
    // failed durable handoff even though the original live bubble is removed.
    const flagging = f.sm.flagSession(f.managed.id)
    mkdirSync(blocker)
    handoffRelease.resolve()
    await metadataEntered.promise
    // Repair and release independently of the RPC response: a correct
    // rollback waits for its correction behind this metadata write.
    rmSync(blocker, { recursive: true })
    metadataRelease.resolve()
    const [result] = await Promise.all([dispatching, flagging])
    const stored = loadSession(f.root, f.managed.id)!
    const cold = new SessionManager()
    const restored = createManagedSession({ id: f.managed.id, name: 'Review', projectId: f.managed.projectId }, { ...f.workspace, rootPath: f.root }, { messagesLoaded: false })
    ;(cold as unknown as { sessions: Map<string, Managed> }).sessions.set(restored.id, restored)
    ;(cold as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}
    await (cold as unknown as { ensureMessagesLoaded(managed: Managed): Promise<void> }).ensureMessagesLoaded(restored)

    expect(result).toEqual({ ok: false, reason: 'persist-failed' })
    expect(f.managed.messages.filter(message => message.role === 'user')).toHaveLength(0)
    expect(f.managed.messageQueue).toHaveLength(0)
    expect(stored.isFlagged).toBe(true)
    expect(stored.pendingPlanExecution?.executionDispatched).toBe(false)
    expect(stored.pendingPlanExecution?.approvalMessageId).toBeUndefined()
    expect(stored.messages.filter(message => message.type === 'user')).toHaveLength(0)
    expect(restored.messageQueue).toHaveLength(0)
  } finally {
    rmSync(blocker, { recursive: true, force: true })
    handoffRelease.resolve()
    metadataRelease.resolve()
    queue.performWrite = original
    await sessionPersistenceQueue.flushAll()
  }
}, 5_000)

test.each([
  ['Stop before the manual-success write finishes cancels the same compaction', true],
  ['Stop after an idle completed manual compact preserves the ready plan', false],
] as const)('%s', async (_name, pauseReadiness) => {
  const f = await setup()
  const text = 'CONSUMED-BEFORE-COMPACT'
  const prepared = await f.sm.setPendingPlanExecution(f.managed.id, '/accepted.md', text)
  setSessionDraft(f.managed.id, { text })
  expect((await f.sm.consumePendingPlanDraft(f.managed.id, prepared.executionId!))?.receipt.text).toBe(true)
  let aborted = false
  let rendererSawComplete = false
  const agent = {
    getModel: () => 'claude-sonnet-4-6',
    setAllSources: () => {},
    getSessionId: () => undefined,
    isCompactionInFlight: () => true,
    forceAbort: () => { aborted = true },
    takePendingSteers: () => [],
    chat: async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' }
      if (!aborted) yield { type: 'complete' }
    },
  }
  f.managed.agent = agent as never
  ;(f.sm as unknown as { getOrCreateAgent: () => Promise<typeof agent> }).getOrCreateAgent = async () => agent
  ;(f.sm as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
  f.sm.setEventSink((_channel, _target, event) => {
    if (event?.statusType === 'compaction_complete') rendererSawComplete = true
  })
  const queue = sessionPersistenceQueue as unknown as QueueWriteHarness
  const original = queue.performWrite
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let gated = false
  if (pauseReadiness) {
    queue.performWrite = async function (id, entry) {
      if (id === f.managed.id && !gated && entry.data.pendingPlanExecution?.awaitingCompaction === false) {
        gated = true
        entered.resolve()
        await release.promise
      }
      return original.call(this, id, entry)
    }
  }
  try {
    const sending = f.sm.sendMessage(f.managed.id, '/compact', undefined, undefined, { planExecutionId: prepared.executionId })
    if (pauseReadiness) {
      await entered.promise
      // Success has reached the host, but it is neither durably ready nor
      // visible as complete in the renderer when the actual Stop arrives.
      expect(loadSession(f.root, f.managed.id)?.pendingPlanExecution?.awaitingCompaction).toBe(true)
      expect(f.managed.isProcessing).toBe(true)
      expect(rendererSawComplete).toBe(false)
      const stopping = f.sm.cancelProcessing(f.managed.id)
      release.resolve()
      await Promise.all([sending, stopping])
      await f.sm.flushSession(f.managed.id)
      expect(f.sm.getPendingPlanExecution(f.managed.id)?.failed).toBe(true)
      expect(await f.sm.dispatchPendingPlanExecution(f.managed.id, prepared.executionId))
        .toEqual({ ok: false, reason: 'failed' })
    } else {
      await sending
      expect(f.managed.isProcessing).toBe(false)
      expect(f.sm.getPendingPlanExecution(f.managed.id)?.awaitingCompaction).toBe(false)
      await f.sm.cancelProcessing(f.managed.id)
      expect(await f.sm.dispatchPendingPlanExecution(f.managed.id, prepared.executionId)).toEqual({ ok: true })
    }
  } finally {
    release.resolve()
    queue.performWrite = original
    await sessionPersistenceQueue.flushAll()
  }
}, 5_000)

test.each([false, true])('Stop during the approval handoff write blocks live and cold queued replay (write failure=%s)', async (failApprovalWrite) => {
  const f = await setup()
  Reflect.deleteProperty(f.sm, 'processNextQueuedMessage')
  ;(f.sm as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
  const prepared = await readyConsumedPlan(f, 'QUEUED-WRITE-STOP-DRAFT')
  const chats: string[] = []
  const agent = {
    getModel: () => 'claude-sonnet-4-6', setAllSources: () => {}, getSessionId: () => undefined, forceAbort: () => {},
    chat: async function* (message: string): AsyncGenerator<AgentEvent> {
      chats.push(message)
      yield { type: 'complete' }
    },
  }
  ;(f.sm as unknown as { getOrCreateAgent: () => Promise<typeof agent> }).getOrCreateAgent = async () => agent
  const queue = sessionPersistenceQueue as unknown as QueueWriteHarness
  const original = queue.performWrite
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const blocker = `${getSessionFilePath(f.root, f.managed.id)}.tmp`
  let gated = false
  let observedWriteFailure = false
  queue.performWrite = async function (id, entry) {
    let approvalWrite = false
    if (id === f.managed.id && !gated && entry.data.pendingPlanExecution?.executionDispatched) {
      gated = true
      approvalWrite = true
      entered.resolve()
      await release.promise
    }
    try {
      return await original.call(this, id, entry)
    } catch (error) {
      if (approvalWrite && failApprovalWrite) {
        observedWriteFailure = true
        // Repair only after the real approval write failed, so the queued
        // rollback and Stop outbox can subsequently reach durable storage.
        rmSync(blocker, { recursive: true, force: true })
      }
      throw error
    }
  }
  try {
    const dispatching = f.sm.dispatchPendingPlanExecution(f.managed.id, prepared.executionId)
    await entered.promise
    expect(f.managed.isProcessing).toBe(false)
    expect(f.managed.messageQueue).toHaveLength(1)
    const stopping = f.sm.cancelProcessing(f.managed.id)
    // Stop must close admission immediately, before waiting for dispatch's
    // lifecycle lock and its real strict IO operation.
    expect(f.managed.stopEpoch).toBeGreaterThan(0)
    if (failApprovalWrite) mkdirSync(blocker)
    release.resolve()
    expect((await Promise.all([dispatching, stopping]))[0]).toEqual({ ok: false, reason: failApprovalWrite ? 'persist-failed' : 'stale' })
    expect(observedWriteFailure).toBe(failApprovalWrite)
    for (let i = 0; i < 25; i++) {
      await new Promise(resolve => setImmediate(resolve))
      await Bun.sleep(1)
    }
    await f.sm.flushSession(f.managed.id)
    expect(chats).toHaveLength(0)
    expect(f.sm.getPendingPlanExecution(f.managed.id)?.failed).toBe(true)
    expect(getPlanDraftConsumption(f.managed.id, prepared.executionId!)?.text).toBe(true)

    const cold = new SessionManager()
    const restored = createManagedSession({ id: f.managed.id, name: 'Review', projectId: f.managed.projectId }, { ...f.workspace, rootPath: f.root }, { messagesLoaded: false })
    ;(cold as unknown as { sessions: Map<string, Managed> }).sessions.set(restored.id, restored)
    ;(cold as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
    ;(cold as unknown as { getOrCreateAgent: () => Promise<typeof agent> }).getOrCreateAgent = async () => agent
    cold.setEventSink(() => {})
    await (cold as unknown as { ensureMessagesLoaded(managed: Managed): Promise<void> }).ensureMessagesLoaded(restored)
    for (let i = 0; i < 25; i++) {
      await new Promise(resolve => setImmediate(resolve))
      await Bun.sleep(1)
    }
    expect(chats).toHaveLength(0)
    expect(restored.messageQueue).toHaveLength(0)
    expect(cold.getPendingPlanExecution(restored.id)?.failed).toBe(true)
    await cold.restorePendingPlanDraft(restored.id, prepared.executionId!, prepared.restoreId!)
    await cold.clearPendingPlanExecution(restored.id, prepared.executionId)
    expect(getSessionDraft(restored.id)?.text).toBe('QUEUED-WRITE-STOP-DRAFT')
    expect(cold.getPendingPlanExecution(restored.id)).toBeNull()
  } finally {
    rmSync(blocker, { recursive: true, force: true })
    release.resolve()
    queue.performWrite = original
    await sessionPersistenceQueue.flushAll()
  }
}, 5_000)

test.each(['status', 'complete'] as const)('a late first %s after forceAbort preserves the failed outbox and consumption receipt', async (firstEvent) => {
  const f = await setup()
  Reflect.deleteProperty(f.sm, 'processNextQueuedMessage')
  ;(f.sm as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
  const text = 'STOPPED-FIRST-EVENT-DRAFT'
  const prepared = await readyConsumedPlan(f, text)
  const receipt = getPlanDraftConsumption(f.managed.id, prepared.executionId!)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const agent = {
    getModel: () => 'claude-sonnet-4-6', setAllSources: () => {}, getSessionId: () => undefined,
    forceAbort: () => { release.resolve() },
    chat: async function* (): AsyncGenerator<AgentEvent> {
      entered.resolve()
      await release.promise
      // Claude's UserStop path emits Interrupted then complete even before
      // assistant content. Neither is a successful approval handoff.
      if (firstEvent === 'status') yield { type: 'status', message: 'Interrupted' }
      yield { type: 'complete' }
    },
  }
  f.managed.agent = agent as never
  ;(f.sm as unknown as { getOrCreateAgent: () => Promise<typeof agent> }).getOrCreateAgent = async () => agent
  try {
    expect(await f.sm.dispatchPendingPlanExecution(f.managed.id, prepared.executionId)).toEqual({ ok: true })
    await entered.promise
    await f.sm.cancelProcessing(f.managed.id)
  } finally {
    release.resolve()
  }
  for (let i = 0; f.managed.isProcessing && i < 100; i++) await Bun.sleep(1)
  expect(f.managed.isProcessing).toBe(false)
  await f.sm.flushSession(f.managed.id)
  const pending = f.sm.getPendingPlanExecution(f.managed.id)
  expect(pending?.failed).toBe(true)
  expect(pending?.draftInputSnapshot).toBe(text)
  expect(loadSession(f.root, f.managed.id)?.pendingPlanExecution?.failed).toBe(true)
  expect(getPlanDraftConsumption(f.managed.id, prepared.executionId!)).toEqual(receipt)
  expect(getSessionDraft(f.managed.id)).toBeNull()
  await f.sm.restorePendingPlanDraft(f.managed.id, prepared.executionId!, prepared.restoreId!)
  await f.sm.clearPendingPlanExecution(f.managed.id, prepared.executionId)
  expect(getSessionDraft(f.managed.id)?.text).toBe(text)
  expect(f.sm.getPendingPlanExecution(f.managed.id)).toBeNull()
}, 5_000)

test.each([
  ['scheduled plain', false, false, false],
  ['scheduled merged', true, false, false],
  ['startup merged', true, true, false],
  ['late complete during cancellation write', true, true, true],
] as const)('Stop during %s approval replay preserves following input', async (_stage, mergedFollowing, startupGate, lateCompleteDuringWrite) => {
  const f = await setup()
  ;(f.sm as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
  const prepared = await readyConsumedPlan(f, 'UNSTARTED-APPROVAL-DRAFT')
  const chats: string[] = []
  const startupEntered = Promise.withResolvers<void>()
  const startupRelease = Promise.withResolvers<void>()
  const backendEntered = Promise.withResolvers<void>()
  const backendRelease = Promise.withResolvers<void>()
  const agent = {
    getModel: () => 'claude-sonnet-4-6', setAllSources: () => {}, getSessionId: () => undefined,
    forceAbort: () => { if (lateCompleteDuringWrite) backendRelease.resolve() },
    chat: async function* (message: string): AsyncGenerator<AgentEvent> {
      chats.push(message)
      if (lateCompleteDuringWrite && chats.length === 1) {
        backendEntered.resolve()
        await backendRelease.promise
      }
      yield { type: 'complete' }
    },
  }
  ;(f.sm as unknown as { getOrCreateAgent: () => Promise<typeof agent> }).getOrCreateAgent = async () => {
    if (startupGate && !lateCompleteDuringWrite) {
      startupEntered.resolve()
      await startupRelease.promise
    }
    return agent
  }
  if (lateCompleteDuringWrite) f.managed.agent = agent as never
  const events: SessionEvent[] = []
  f.sm.setEventSink((_channel, _target, event) => events.push(event))
  // Keep only the already-durable approval in the queue until the fixture
  // seeds the result of a plain-text continuation decision.
  expect(await f.sm.dispatchPendingPlanExecution(f.managed.id, prepared.executionId)).toEqual({ ok: true })
  const approval = f.managed.messageQueue[0]!
  const followingId = `following-${randomUUID()}`
  let semanticId = `semantic-${randomUUID()}`
  const following = 'FOLLOWING-TEXT-CORRECTION'
  const semantic = 'FOLLOWING-REFERENCE-ATTACHMENT'
  const reference: Reference = { version: 1, kind: 'web-selection', projectId: f.managed.projectId,
    url: 'https://example.test', title: 'Queued source', quote: 'QUEUED-QUOTE',
    locator: { type: 'web-text-quote', exact: 'QUEUED-QUOTE' } }
  const attachment: StoredAttachment = { id: 'queued-notes', type: 'text', name: 'notes.txt',
    mimeType: 'text/plain', size: 12, storedPath: join(f.root, 'notes.txt') }
  const input: FileAttachment = { type: 'text', path: attachment.storedPath, name: attachment.name,
    mimeType: attachment.mimeType, size: attachment.size, text: 'queued notes' }
  if (mergedFollowing) {
    f.managed.messages.push({ id: followingId, role: 'user', content: following, timestamp: Date.now(), isQueued: true })
    f.managed.messageQueue.push({ message: following, messageId: followingId, mergeWith: approval })
    if (!lateCompleteDuringWrite) {
      f.managed.messages.push({ id: semanticId, role: 'user', content: semantic, timestamp: Date.now(), isQueued: true,
        references: [reference], attachments: [attachment] })
      f.managed.messageQueue.push({ message: semantic, messageId: semanticId, storedAttachments: [attachment], options: { references: [reference] } })
    }
    // Persist the legitimate semantic queue payload. It cannot merge with
    // text-only steers, so it remains behind the approval+correction pair.
    await f.sm.flagSession(f.managed.id)
  }
  Reflect.deleteProperty(f.sm, 'processNextQueuedMessage')
  ;(f.sm as unknown as { processNextQueuedMessage: (id: string) => void }).processNextQueuedMessage(f.managed.id)
  if (startupGate) await (lateCompleteDuringWrite ? backendEntered.promise : startupEntered.promise)
  if (lateCompleteDuringWrite) {
    // Exercise the actual busy-send admission while the accepted approval's
    // first backend event is still pending, including all semantic payload.
    await f.sm.sendMessage(f.managed.id, semantic, [input], [attachment], { references: [reference] })
    expect(f.managed.messageQueue).toHaveLength(1)
    semanticId = f.managed.messageQueue[0]!.messageId!
    expect(f.sm.getPendingPlanExecution(f.managed.id)?.executionDispatched).toBe(true)
  }
  expect(f.managed.isProcessing).toBe(startupGate)
  // Scheduling and startup do not deliver the input. The reservation keeps
  // the queued bubble recoverable until the producer acknowledges acceptance.
  expect(f.managed.messages.find(message => message.id === approval.messageId)?.isQueued).toBe(true)
  const queue = sessionPersistenceQueue as unknown as QueueWriteHarness
  const original = queue.performWrite
  const cancellationEntered = Promise.withResolvers<void>()
  const cancellationRelease = Promise.withResolvers<void>()
  let gatedCancellation = false
  if (lateCompleteDuringWrite) {
    queue.performWrite = async function (id, entry) {
      if (id === f.managed.id && !gatedCancellation && entry.data.pendingPlanExecution?.failed) {
        gatedCancellation = true
        cancellationEntered.resolve()
        await cancellationRelease.promise
      }
      return original.call(this, id, entry)
    }
  }
  // A late first complete must remain serialized with Stop's durable outbox
  // cancellation, so it cannot deliver following input while IO is paused.
  try {
    const stopping = f.sm.cancelProcessing(f.managed.id)
    if (lateCompleteDuringWrite) {
      await cancellationEntered.promise
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setImmediate(resolve))
        await Bun.sleep(1)
      }
      expect(chats).toHaveLength(1)
      cancellationRelease.resolve()
    }
    await stopping
  } finally {
    cancellationRelease.resolve()
    startupRelease.resolve()
    backendRelease.resolve()
    queue.performWrite = original
  }
  for (let i = 0; i < 25; i++) {
    await new Promise(resolve => setImmediate(resolve))
    await Bun.sleep(1)
  }
  await f.sm.flushSession(f.managed.id)
  expect(chats).toHaveLength(lateCompleteDuringWrite ? 1 : 0)
  expect(f.managed.messageQueue).toHaveLength(0)
  expect(f.managed.pendingQueueReplay).toBeUndefined()
  expect(f.sm.getPendingPlanExecution(f.managed.id)?.failed).toBe(true)
  expect(getPlanDraftConsumption(f.managed.id, prepared.executionId!)?.text).toBe(true)
  if (mergedFollowing) {
    const interrupted = events.find(event => event.type === 'interrupted')
    expect(interrupted?.queuedMessages).toEqual([following, semantic])
    expect(interrupted?.queuedReferences).toEqual([reference])
    expect(interrupted?.queuedAttachments).toEqual([attachment])
    expect(interrupted?.queuedMessageIds).toEqual([followingId, semanticId])
    expect(interrupted?.queuedRestoreId).toBeString()
    const stored = loadSession(f.root, f.managed.id)!
    const correction = stored.messages.find(message => message.id === followingId)
    const queuedSemantic = stored.messages.find(message => message.id === semanticId)
    expect(correction?.queuedRestoreId).toBe(interrupted!.queuedRestoreId)
    expect(queuedSemantic?.queuedRestoreId).toBe(interrupted!.queuedRestoreId)
    expect(queuedSemantic?.references).toEqual([reference])
    expect(queuedSemantic?.attachments).toEqual([attachment])
    // Restore and ACK only the user's following inputs; the generated
    // approval is recovered through its authoritative plan receipt instead.
    const draftAttachment = { path: attachment.storedPath, name: attachment.name }
    setSessionDraft(f.managed.id, { text: `${following}\n\n${semantic}`, references: [reference], attachments: [draftAttachment] })
    await f.sm.acknowledgeQueuedInputRestore(f.managed.id, interrupted!.queuedRestoreId!, [followingId, semanticId])
    expect(f.managed.messages.some(message => [followingId, semanticId].includes(message.id))).toBe(false)
    expect(getSessionDraft(f.managed.id)?.text).toBe(`${following}\n\n${semantic}`)
    expect(getSessionDraft(f.managed.id)?.references).toEqual([reference])
    expect(getSessionDraft(f.managed.id)?.attachments).toEqual([draftAttachment])
  }
}, 5_000)

test('a duplicate dispatch late validation failure cannot revoke an accepted approval or block following input', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stair-plan-dispatch-workspace-')))
  workspaces.push(root)
  const workspace = { ...createWorkspaceAtPath(root, 'Concurrent plan dispatch'), rootPath: root }
  const project = createProject(root, { name: 'File validation project', workingDirectory: root })
  const sm = new SessionManager()
  const managed = createManagedSession({ id: `dispatch-${randomUUID()}`, name: 'Review', projectId: project.id }, workspace, { messagesLoaded: true })
  ;(sm as unknown as { sessions: Map<string, Managed> }).sessions.set(managed.id, managed)
  ;(sm as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
  managed.triggeredBy = { event: 'isolated-review' }
  await saveSessionStrict({
    id: managed.id, name: 'Review', projectId: project.id, workspaceRootPath: root,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  const lateValidation = Promise.withResolvers<void>()
  const validationEntered = Promise.withResolvers<void>()
  const approvalEntered = Promise.withResolvers<void>()
  const approvalRelease = Promise.withResolvers<void>()
  const events: SessionEvent[] = []
  const calls: string[] = []
  sm.setEventSink((_channel, _target, event) => {
    events.push(structuredClone(event))
    if (event.type === 'user_message' && event.status === 'processing'
      && managed.pendingPlanExecution?.approvalMessageId === event.message.id) {
      // The real queue has reserved the accepted approval, but its scheduled
      // callback has not admitted the model turn yet. Release only the older
      // RPC's actual, already-read file validation result at this boundary.
      lateValidation.resolve()
    }
  })
  const agent = {
    getModel: () => 'claude-sonnet-4-6', setAllSources: () => {}, getSessionId: () => undefined,
    forceAbort: () => { approvalRelease.resolve() }, redirect: () => false,
    chat: async function* (message: string): AsyncGenerator<AgentEvent> {
      calls.push(message)
      if (calls.length === 1) {
        yield { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' }
      } else {
        if (calls.length === 2) {
          approvalEntered.resolve()
          await approvalRelease.promise
        }
        yield { type: 'input_accepted' }
      }
      yield { type: 'complete' }
    },
  }
  managed.agent = agent as never
  ;(sm as unknown as { getOrCreateAgent: () => Promise<typeof agent> }).getOrCreateAgent = async () => agent
  const filePath = join(root, 'source.txt')
  const quote = 'ORIGINAL-ACCEPTED-SOURCE'
  writeFileSync(filePath, quote)
  const source = await projectFiles.readProjectTextFileWithinRoot(root, { projectId: project.id, relativePath: 'source.txt' })
  const reference: Reference = {
    version: 1, kind: 'project-file', projectId: project.id, relativePath: 'source.txt',
    sourceFingerprint: source.sourceFingerprint, fileName: 'source.txt', quote,
    locator: { type: 'text-quote', exact: quote, start: 0, end: quote.length },
  }
  const text = 'ORIGINAL-PLAN-DRAFT'
  setSessionDraft(managed.id, { text, references: [reference] })
  const prepared = await sm.setPendingPlanExecution(managed.id, '/accepted.md', text, [reference])
  expect((await sm.consumePendingPlanDraft(managed.id, prepared.executionId!))?.receipt.text).toBe(true)
  // Use the public compact send and its real event correlation instead of
  // manufacturing a ready or failed managed-session record.
  await sm.sendMessage(managed.id, '/compact', undefined, undefined, { planExecutionId: prepared.executionId! })
  for (let i = 0; managed.isProcessing && i < 100; i++) await Bun.sleep(1)
  expect(managed.isProcessing).toBe(false)
  expect(managed.pendingPlanExecution?.awaitingCompaction).toBe(false)
  const originalRead = projectFiles.readProjectTextFileWithinRoot
  let gateOnce = true
  const pauseRead = spyOn(projectFiles, 'readProjectTextFileWithinRoot').mockImplementation(async (...args) => {
    const result = await originalRead(...args)
    if (gateOnce) {
      gateOnce = false
      validationEntered.resolve()
      await lateValidation.promise
    }
    return result
  })
  let olderDispatch: ReturnType<typeof sm.dispatchPendingPlanExecution> | undefined
  try {
    // Both requests use real source bytes. The first read is stale by the
    // time its RPC resumes; the second request validates the restored file.
    writeFileSync(filePath, 'INTERMEDIATE-FILE-EDIT')
    olderDispatch = sm.dispatchPendingPlanExecution(managed.id, prepared.executionId)
    await validationEntered.promise
    writeFileSync(filePath, quote)
    expect(await sm.dispatchPendingPlanExecution(managed.id, prepared.executionId)).toEqual({ ok: true })
    expect(await olderDispatch).toEqual({ ok: false, reason: 'invalid-references' })
    expect(managed.pendingPlanExecution?.failed).not.toBe(true)
    expect(managed.pendingPlanExecution?.executionDispatched).toBe(true)
    expect(events.some(event => event.type === 'compaction_failed')).toBe(false)
    expect(getSessionDraft(managed.id)).toBeNull()
    await approvalEntered.promise
    const approvalId = managed.pendingPlanExecution!.approvalMessageId!
    expect(managed.pendingQueueReplay?.entries[0]?.messageId).toBe(approvalId)
    // Neither a recovery call nor an early scoped ACK can consume this
    // still-active approval owner's draft or record.
    await expect(sm.restorePendingPlanDraft(managed.id, prepared.executionId!, prepared.restoreId!))
      .rejects.toThrow('PENDING_PLAN_STALE')
    await sm.clearPendingPlanExecution(managed.id, prepared.executionId)
    expect(sm.getPendingPlanExecution(managed.id)?.executionId).toBe(prepared.executionId)
    expect(getSessionDraft(managed.id)).toBeNull()
    await sm.sendMessage(managed.id, 'FOLLOWING-ORDINARY-INPUT')
    expect(managed.messageQueue).toHaveLength(1)
    expect(calls).toHaveLength(2)
    approvalRelease.resolve()
    for (let i = 0; (calls.length < 3 || managed.isProcessing) && i < 100; i++) await Bun.sleep(1)
    await sm.flushSession(managed.id)
    expect(calls).toHaveLength(3)
    expect(calls.filter(message => message.includes(text))).toHaveLength(1)
    expect(calls[1]).toContain(quote)
    expect(calls[2]).toContain('FOLLOWING-ORDINARY-INPUT')
    expect(managed.messages.filter(message => message.id === approvalId)).toHaveLength(1)
    expect(managed.pendingQueueReplay).toBeUndefined()
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.isProcessing).toBe(false)
    expect(sm.getPendingPlanExecution(managed.id)).toBeNull()
    expect(getSessionDraft(managed.id)).toBeNull()
    expect(loadSession(root, managed.id)?.messages.filter(message => message.type === 'user').every(message => !message.isQueued)).toBe(true)
  } finally {
    lateValidation.resolve()
    approvalRelease.resolve()
    if (olderDispatch) await olderDispatch.catch(() => {})
    pauseRead.mockRestore()
  }
}, 10_000)

test('successful approval input acceptance releases its replay owner and delivers the next full queued message', async () => {
  const f = await setup()
  Reflect.deleteProperty(f.sm, 'processNextQueuedMessage')
  ;(f.sm as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
  const prepared = await readyConsumedPlan(f, 'SUCCESSFUL-APPROVAL-DRAFT')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: { message: string; attachments?: FileAttachment[] }[] = []
  const events: SessionEvent[] = []
  f.sm.setEventSink((_channel, _target, event) => events.push(structuredClone(event)))
  const agent = {
    getModel: () => 'claude-sonnet-4-6', setAllSources: () => {}, getSessionId: () => undefined, forceAbort: () => {},
    chat: async function* (message: string, attachments?: FileAttachment[]): AsyncGenerator<AgentEvent> {
      calls.push({ message, attachments })
      if (calls.length === 1) {
        entered.resolve()
        await release.promise
      }
      yield { type: 'input_accepted' }
      yield { type: 'complete' }
    },
  }
  f.managed.agent = agent as never
  ;(f.sm as unknown as { getOrCreateAgent: () => Promise<typeof agent> }).getOrCreateAgent = async () => agent
  const reference: Reference = { version: 1, kind: 'web-selection', projectId: f.managed.projectId,
    url: 'https://example.test', title: 'Queued source', quote: 'QUEUED-QUOTE',
    locator: { type: 'web-text-quote', exact: 'QUEUED-QUOTE' } }
  const attachment: StoredAttachment = { id: 'next-attachment', type: 'text', name: 'notes.txt',
    mimeType: 'text/plain', size: 12, storedPath: join(f.root, 'notes.txt') }
  const input: FileAttachment = { type: 'text', path: attachment.storedPath, name: attachment.name,
    mimeType: attachment.mimeType, size: attachment.size, text: 'queued notes' }
  try {
    expect(await f.sm.dispatchPendingPlanExecution(f.managed.id, prepared.executionId)).toEqual({ ok: true })
    await entered.promise
    expect(f.managed.pendingQueueReplay?.entries).toHaveLength(1)
    await f.sm.sendMessage(f.managed.id, 'NEXT-USER-INPUT', [input], [attachment], { references: [reference] })
    expect(f.managed.messageQueue).toHaveLength(1)
    expect(calls).toHaveLength(1)
  } finally {
    release.resolve()
  }
  for (let i = 0; (calls.length < 2 || f.managed.isProcessing) && i < 100; i++) await Bun.sleep(1)
  await f.sm.flushSession(f.managed.id)
  expect(calls).toHaveLength(2)
  expect(calls[0]?.message).toContain('SUCCESSFUL-APPROVAL-DRAFT')
  expect(calls[1]?.message).toContain('NEXT-USER-INPUT')
  expect(calls[1]?.message).toContain('QUEUED-QUOTE')
  expect(calls[1]?.attachments).toEqual([input])
  const users = f.managed.messages.filter(message => message.role === 'user')
  expect(users).toHaveLength(2)
  expect(users[1]?.references).toEqual([reference])
  expect(users[1]?.attachments).toEqual([attachment])
  expect(users.every(message => !message.isQueued)).toBe(true)
  for (const user of users) {
    const delivered = events.findLast(event => event.type === 'user_message' && event.message.id === user.id && event.status === 'processing')
    if (delivered?.type !== 'user_message') throw new Error(`Missing processing event for ${user.id}`)
    expect(delivered.message.isQueued).toBe(false)
  }
  expect(f.managed.isProcessing).toBe(false)
  expect(f.managed.messageQueue).toHaveLength(0)
  expect(f.managed.pendingQueueReplay).toBeUndefined()
  expect(f.sm.getPendingPlanExecution(f.managed.id)).toBeNull()
}, 5_000)
