import { expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Disposable config root so drafts/workspaces never touch the user profile.
const configRoot = mkdtempSync(join(tmpdir(), 'stair-pending-plan-profile-'))
process.env.CRAFT_CONFIG_DIR = configRoot
const bundledDefaults = join(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json')
if (existsSync(bundledDefaults)) {
  copyFileSync(bundledDefaults, join(configRoot, 'config-defaults.json'))
}

const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const {
  saveSession,
  loadSession,
  getPendingPlanExecution,
  sessionPersistenceQueue,
} = await import('@craft-agent/shared/sessions')
const { getSessionDraft, setSessionDraft } = await import('@craft-agent/shared/config')

// Regression tests for the pending-plan defects confirmed in the 2026-10
// review round (stair-reader-rebase-review pending-plan-repro.ts) and the
// Codex early-review invariants: the read-check-await-save claim is not
// atomic across concurrent windows; identity-scoped claim/clear/authorization
// (no-ID legacy commands cannot affect identified records); fresh reference
// validation at prepare; failed compactions keep the consumed snapshot as a
// durable non-executable restore outbox until the scoped recovery ACK; late
// completions can never re-authorize a failed operation.

type Managed = ReturnType<typeof createManagedSession>
type Sm = InstanceType<typeof SessionManager>

/** Stamp the pending record's compaction correlation the way the production
 * `/compact` send does (sendMessage records {generation, stopEpoch} on the
 * record and persists it before the turn starts). */
async function stampCompactionCorrelation(managed: Managed, sandbox: string) {
  const correlation = { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
  managed.pendingPlanExecution!.compactionTurn = correlation
  const stored = loadSession(sandbox, managed.id)
  if (stored) {
    stored.pendingPlanExecution = managed.pendingPlanExecution as never
    await saveSession(stored)
  }
}

function buildRef(projectId: string) {
  return {
    version: 1,
    kind: 'web-selection',
    projectId,
    url: 'https://example.test',
    title: 'Selected source',
    quote: 'REF-review-token',
    locator: { type: 'web-text-quote', exact: 'REF-review-token' },
  } as const
}

async function buildSession(id: string) {
  const sandbox = mkdtempSync(join(tmpdir(), 'stair-pending-plan-'))
  const workspace = createWorkspaceAtPath(sandbox, 'Pending plan repro')
  const sm = new SessionManager()
  const managed = createManagedSession(
    { id, projectId: workspace.defaultProjectId },
    { ...workspace, rootPath: sandbox },
    { messagesLoaded: true },
  )
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  await saveSession({
    id,
    workspaceRootPath: sandbox,
    projectId: workspace.defaultProjectId,
    createdAt: 1,
    lastUsedAt: 1,
    messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  } as never)
  return { sandbox, sm, managed }
}

const processEvent = (sm: Sm, managed: Managed, event: unknown) =>
  (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, event)

async function prepareReadyRecord(id: string, withReference = false) {
  const { sandbox, sm, managed } = await buildSession(id)
  await sm.setPendingPlanExecution(managed.id, '/review-plan.md', 'MSG-review-token', withReference ? [buildRef(managed.projectId)] : [])
  await stampCompactionCorrelation(managed, sandbox)
  return { sandbox, sm, managed } as const
}

test('concurrent claims accept exactly one; no-identity claim cannot touch an identified record', async () => {
  const { sandbox, sm, managed } = await prepareReadyRecord('claim-race', true)
  const executionId = sm.getPendingPlanExecution(managed.id)?.executionId
  expect(executionId).toBeDefined()
  expect(await sm.markCompactionComplete(managed.id, executionId)).toBe(true)
  // The LEGACY claim path can never consume a modern identified record —
  // identified records dispatch server-side only (durable handoff or nothing).
  expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(false)
  // The durable dispatch commits atomically for exactly one of two windows.
  const dispatches = await Promise.all([
    sm.dispatchPendingPlanExecution(managed.id, executionId),
    sm.dispatchPendingPlanExecution(managed.id, executionId),
  ])
  expect(dispatches.filter(result => result.ok)).toHaveLength(1)
  expect(dispatches.filter(result => !result.ok && result.reason === 'already-dispatched')).toHaveLength(1)

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('readiness requires the observed record identity and the originating turn', async () => {
  const { sandbox, sm, managed } = await prepareReadyRecord('readiness-context')
  const executionId = managed.pendingPlanExecution?.executionId
  // No identity (legacy RPC shape): never readies an identified record.
  expect(await sm.markCompactionComplete(managed.id)).toBe(false)
  // Wrong identity: never readies.
  expect(await sm.markCompactionComplete(managed.id, 'wrong-id')).toBe(false)
  expect(getPendingPlanExecution(sandbox, managed.id)?.awaitingCompaction).toBe(true)
  // A foreign turn emits the completion: the record's own correlation (stamped
  // at the /compact send) does not match the live turn, so it never readies.
  managed.processingGeneration += 5
  expect(await sm.markCompactionComplete(managed.id, executionId)).toBe(false)
  managed.processingGeneration -= 5
  // The record's own compaction turn readies it.
  expect(await sm.markCompactionComplete(managed.id, executionId)).toBe(true)

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('prepare rejects missing sessions and never manufactures a memory-only record', async () => {
  const { sandbox, sm, managed } = await buildSession('prepare-missing')
  const sm2 = new SessionManager()
  await expect(sm2.setPendingPlanExecution(managed.id, '/p.md', 'MSG')).rejects.toThrow('PENDING_PLAN_SESSION_MISSING')
  // Managed session exists but no stored session file: still rejected.
  rmSync(join(sandbox, 'sessions', managed.id), { recursive: true, force: true })
  await expect(sm.setPendingPlanExecution(managed.id, '/p.md', 'MSG')).rejects.toThrow()
  expect(managed.pendingPlanExecution).toBeUndefined()
  expect(sm.getPendingPlanExecution(managed.id)).toBeNull()

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('prepare validates references with full send strictness (no forged quotes)', async () => {
  const { sandbox, sm, managed } = await buildSession('prepare-validation')
  // A chat-message quote whose source session does not exist in the SM: a
  // first-class send would reject it, so prepare must too — a forged quote
  // cannot bypass sendMessage validation via prepare+dispatch.
  const forged = {
    version: 1,
    kind: 'chat-message',
    projectId: managed.projectId,
    sessionId: 'nonexistent-chat',
    messageId: 'ghost-message',
    role: 'assistant',
    quote: 'forged',
    locator: { type: 'text-quote', exact: 'forged', start: 0, end: 6 },
  } as const
  await expect(sm.setPendingPlanExecution(managed.id, '/p.md', 'MSG', [forged]))
    .rejects.toThrow('MESSAGE_REFERENCE_SOURCE_INVALID')
  // Cross-Project quotes are rejected by the Project boundary.
  await expect(sm.setPendingPlanExecution(managed.id, '/p.md', 'MSG', [{ ...buildRef('other-project') }]))
    .rejects.toThrow('MESSAGE_REFERENCE_PROJECT_MISMATCH')
  expect(managed.pendingPlanExecution).toBeUndefined()

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('server-owned dispatch: concurrent dispatches durably accept exactly one, identity-scoped', async () => {
  const { sandbox, sm, managed } = await prepareReadyRecord('dispatch-race', true)
  await sm.markCompactionComplete(managed.id, managed.pendingPlanExecution?.executionId)
  const executionId = sm.getPendingPlanExecution(managed.id)?.executionId

  const sends: string[] = []
  sm.sendMessage = (async (_id: string, message: string) => { sends.push(message) }) as never
  const results = await Promise.all([
    sm.dispatchPendingPlanExecution(managed.id, executionId),
    sm.dispatchPendingPlanExecution(managed.id, executionId),
  ])
  // Give the queued replay its setImmediate tick.
  await new Promise(r => setTimeout(r, 50))

  expect(results.filter(result => result.ok)).toHaveLength(1)
  expect(results.filter(result => !result.ok && result.reason === 'already-dispatched')).toHaveLength(1)
  // Identity scoping: no-identity and stale-identity commands are rejected.
  expect(await sm.dispatchPendingPlanExecution(managed.id)).toMatchObject({ ok: false, reason: 'stale' })
  expect(await sm.dispatchPendingPlanExecution(managed.id, 'not-the-record')).toMatchObject({ ok: false, reason: 'stale' })

  // The durable acceptance persisted the approval user message together with
  // the dispatched flag and its stable approvalMessageId.
  const stored = loadSession(sandbox, managed.id)
  const record = stored?.pendingPlanExecution
  expect(record?.executionDispatched).toBe(true)
  expect(record?.approvalMessageId).toBeDefined()
  const approval = stored?.messages.find(m => m.id === record?.approvalMessageId)
  expect((approval as { type?: string } | undefined)?.type).toBe('user')
  expect((approval as { references?: unknown[] } | undefined)?.references?.length).toBe(1)
  // Exactly one replay send was kicked off.
  expect(sends).toHaveLength(1)
  expect(sends[0]).toContain('Plan approved, please execute.')

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('dispatch rejects busy and not-ready records without touching them', async () => {
  const { sandbox, sm, managed } = await prepareReadyRecord('dispatch-guards')
  // No compaction correlation yet: never dispatchable.
  const beforeReady = await sm.dispatchPendingPlanExecution(managed.id, managed.pendingPlanExecution?.executionId)
  expect(beforeReady).toEqual({ ok: false, reason: 'not-ready' })

  await stampCompactionCorrelation(managed, sandbox)
  await sm.markCompactionComplete(managed.id, managed.pendingPlanExecution?.executionId)
  managed.isProcessing = true
  const busy = await sm.dispatchPendingPlanExecution(managed.id, managed.pendingPlanExecution?.executionId)
  expect(busy).toEqual({ ok: false, reason: 'busy' })
  expect(loadSession(sandbox, managed.id)?.pendingPlanExecution?.executionDispatched).not.toBe(true)

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('a stale or no-identity clear cannot delete a replaced identified record', async () => {
  const { sandbox, sm, managed } = await buildSession('stale-clear')
  await sm.setPendingPlanExecution(managed.id, '/plan-a.md', 'A', [buildRef(managed.projectId)])
  const firstExecutionId = managed.pendingPlanExecution?.executionId
  expect(firstExecutionId).toBeDefined()

  // A second Accept & Compact replaces the record with a new identity.
  await sm.setPendingPlanExecution(managed.id, '/plan-b.md', 'B', [buildRef(managed.projectId)])
  expect(managed.pendingPlanExecution?.planPath).toBe('/plan-b.md')
  // Stale identity: no-op — and crucially the LIVE record survives too.
  await sm.clearPendingPlanExecution(managed.id, firstExecutionId)
  expect(managed.pendingPlanExecution?.planPath).toBe('/plan-b.md')
  // No-identity (legacy) clear of an identified record: no-op.
  await sm.clearPendingPlanExecution(managed.id)
  expect(managed.pendingPlanExecution?.planPath).toBe('/plan-b.md')
  expect(getPendingPlanExecution(sandbox, managed.id)?.planPath).toBe('/plan-b.md')

  // The scoped clear with the CURRENT identity works.
  await sm.clearPendingPlanExecution(managed.id, managed.pendingPlanExecution?.executionId)
  expect(managed.pendingPlanExecution).toBeUndefined()
  expect(getPendingPlanExecution(sandbox, managed.id)).toBeNull()

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('a late manual compaction completion cannot ready a newer record', async () => {
  const { sandbox, sm, managed } = await prepareReadyRecord('stale-complete')
  // The correlated turn ended and another turn started: a late completion
  // from the old compaction must not authorize the plan.
  managed.processingGeneration += 1
  await processEvent(sm, managed, {
    type: 'info',
    message: 'Compacted Conversation',
    compactionTrigger: 'manual',
  })
  expect(getPendingPlanExecution(sandbox, managed.id)?.awaitingCompaction).toBe(true)

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('an automatic compaction failure never touches the pending record', async () => {
  const { sandbox, sm, managed } = await prepareReadyRecord('auto-failure')
  await processEvent(sm, managed, { type: 'compaction_failed', compactionTrigger: 'automatic' })
  const pending = getPendingPlanExecution(sandbox, managed.id)
  expect(pending?.awaitingCompaction).toBe(true)
  expect(pending?.failed).not.toBe(true)

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('a stale manual compaction failure (foreign turn) does not cancel the record', async () => {
  const { sandbox, sm, managed } = await prepareReadyRecord('stale-failure')
  // The failure belongs to a different turn (generation moved): the record's
  // own compaction turn's events — or the Stop funnel — decide it, not this.
  managed.processingGeneration += 1
  await processEvent(sm, managed, { type: 'compaction_failed', compactionTrigger: 'manual' })
  expect(managed.pendingPlanExecution?.failed).not.toBe(true)

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('compaction failure keeps a durable non-executable outbox until the scoped recovery ACK', async () => {
  const { sandbox, sm, managed } = await prepareReadyRecord('outbox-protocol', true)
  const events: Array<{ type: string; restoreId?: string; executionId?: string; text?: string; references?: unknown[] }> = []
  sm.setEventSink((_channel, _target, event) => { events.push(event as never) })
  setSessionDraft(managed.id, { text: '' })

  await processEvent(sm, managed, { type: 'compaction_failed', compactionTrigger: 'manual' })

  // Terminally non-executable: never ready, never dispatchable — even though
  // its originating correlation would still match.
  const failed = getPendingPlanExecution(sandbox, managed.id)
  expect(failed?.failed).toBe(true)
  expect(failed?.awaitingCompaction).toBe(true)
  expect(await sm.dispatchPendingPlanExecution(managed.id, failed?.executionId)).toMatchObject({ ok: false, reason: 'failed' })
  expect(await sm.markCompactionComplete(managed.id, managed.pendingPlanExecution?.executionId)).toBe(false)
  // The recovery intent was delivered with the durable identities. The host
  // does NOT pre-apply the restore: the renderer commits it AFTER flushing
  // local edits (coordinator ordering), then ACKs.
  const delivered = events.find(event => event.type === 'compaction_failed')
  expect(delivered?.restoreId).toBeDefined()
  expect(delivered?.executionId).toBeDefined()
  // This fixture never consumed the draft: neither text nor reference keys
  // are part of the failed recovery payload; the draft already owns them.
  expect(delivered?.text).toBeUndefined()
  expect(delivered?.references).toBeUndefined()
  expect(getSessionDraft(managed.id)?.text ?? '').not.toContain('MSG-review-token')

  // A duplicate failure event is a no-op (terminal state).
  await processEvent(sm, managed, { type: 'compaction_failed', compactionTrigger: 'manual' })
  expect(events.filter(event => event.type === 'compaction_failed')).toHaveLength(1)

  // New user input never clears the failed outbox (recovery owns it).
  managed.messages.push({ id: 'u-followup', role: 'user', content: 'new message', timestamp: 9 } as never)
  managed.messageQueue.push({ message: 'new message' })
  await sm.cancelProcessing(managed.id, true)
  expect(managed.pendingPlanExecution?.failed).toBe(true)

  // The scoped ACK clears it; a stale ACK cannot.
  await sm.clearPendingPlanExecution(managed.id, 'wrong-id')
  expect(managed.pendingPlanExecution?.failed).toBe(true)
  await sm.clearPendingPlanExecution(managed.id, failed?.executionId)
  expect(managed.pendingPlanExecution).toBeUndefined()
  expect(getPendingPlanExecution(sandbox, managed.id)).toBeNull()

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('a persistence failure during cancellation stays terminal — a late completion cannot re-authorize', async () => {
  const { sandbox, sm, managed } = await prepareReadyRecord('terminal-persist-failure')
  const sessionDir = join(sandbox, 'sessions', managed.id)
  chmodSync(sessionDir, 0o555)
  try {
    await processEvent(sm, managed, { type: 'compaction_failed', compactionTrigger: 'manual' })
    // Terminal IN MEMORY even though the marker never reached disk.
    expect(managed.pendingPlanExecution?.failed).toBe(true)
    // Late completion with a still-matching correlation: rejected.
    expect(await sm.markCompactionComplete(managed.id, managed.pendingPlanExecution?.executionId)).toBe(false)
    expect(await sm.dispatchPendingPlanExecution(managed.id, managed.pendingPlanExecution?.executionId))
      .toMatchObject({ ok: false, reason: 'failed' })
  } finally {
    chmodSync(sessionDir, 0o755)
  }

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('a Stop during the manual compaction funnels into the failure outbox', async () => {
  const { sandbox, sm, managed } = await prepareReadyRecord('stop-funnel')
  const events: Array<{ type: string; restoreId?: string }> = []
  sm.setEventSink((_channel, _target, event) => { events.push(event as never) })
  managed.isProcessing = true
  await sm.cancelProcessing(managed.id)

  expect(managed.pendingPlanExecution?.failed).toBe(true)
  expect(getPendingPlanExecution(sandbox, managed.id)?.failed).toBe(true)
  expect(events.find(event => event.type === 'compaction_failed')?.restoreId).toBeDefined()

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('cold-load reconciliation: incomplete correlated compactions become non-executable outboxes', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'stair-pending-plan-'))
  const workspace = createWorkspaceAtPath(sandbox, 'Reconcile workspace')

  const makeStored = async (id: string, pending: Record<string, unknown>, messages: unknown[]) => {
    await saveSession({
      id, workspaceRootPath: sandbox, projectId: workspace.defaultProjectId, createdAt: 1, lastUsedAt: 1,
      messages, tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      pendingPlanExecution: pending,
    } as never)
  }

  // a) dispatched + approval persisted but NOT queued, record still present:
  // a crash BEFORE backend handoff — reconciliation re-queues it by its
  // stable approval id (at-least-once delivery, at-most-once authorization).
  await makeStored('recon-consumed', {
    planPath: '/p.md', awaitingCompaction: false, executionDispatched: true,
    executionId: 'e1', restoreId: 'r1', approvalMessageId: 'approval-1',
  }, [{ id: 'approval-1', type: 'user', content: 'Plan approved, please execute.', timestamp: 2, isQueued: false }])
  // b) dispatched but the approval message never persisted → retryable.
  await makeStored('recon-orphan-claim', {
    planPath: '/p.md', awaitingCompaction: false, executionDispatched: true,
    executionId: 'e2', restoreId: 'r2', approvalMessageId: 'approval-2',
  }, [])
  // c) awaitingCompaction with a correlated compact: the compaction died with
  // the process → non-executable outbox, NEVER readied, retained for ACK.
  await makeStored('recon-awaiting', {
    planPath: '/p.md', draftInputSnapshot: 'AWAIT-MSG', awaitingCompaction: true,
    executionId: 'e3', restoreId: 'r3', compactionTurn: { generation: 12, stopEpoch: 0 },
  }, [])
  // d) failed outbox: re-delivered, retained (renderer drives restore + ACK).
  await makeStored('recon-failed', {
    planPath: '/p.md', draftInputSnapshot: 'FAILED-MSG', awaitingCompaction: true,
    executionId: 'e4', restoreId: 'r4', failed: true,
  }, [])
  // e) legacy dispatched record: inert, never replayed.
  await makeStored('recon-legacy', {
    planPath: '/p.md', awaitingCompaction: false, executionDispatched: true,
  }, [])

  const sm = new SessionManager()
  const redelivery: string[] = []
  sm.setEventSink((_channel, _target, event) => {
    if ((event as { type?: string }).type === 'compaction_failed') redelivery.push((event as { sessionId?: string }).sessionId ?? '')
  })
  const loadManaged = async (id: string) => {
    const managed = createManagedSession({ id, projectId: workspace.defaultProjectId }, { ...workspace, rootPath: sandbox }, {})
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    await (sm as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(managed)
    return managed
  }

  const reconSends: string[] = []
  sm.sendMessage = (async (_id: string, message: string) => { reconSends.push(message) }) as never
  const consumed = await loadManaged('recon-consumed')
  const orphanClaim = await loadManaged('recon-orphan-claim')
  const awaiting = await loadManaged('recon-awaiting')
  const failedOutbox = await loadManaged('recon-failed')
  const legacy = await loadManaged('recon-legacy')
  // Let the scheduled reconciliation actions (setImmediate + lock + flush) run.
  await new Promise(r => setTimeout(r, 100))

  // a) mid-delivery crash: the approval was re-queued and replayed exactly
  // once by its stable id (no duplicate bubble — same message id).
  await new Promise(r => setTimeout(r, 60))
  expect(reconSends).toHaveLength(1)
  expect(reconSends[0]).toContain('Plan approved')
  const storedConsumed = loadSession(sandbox, 'recon-consumed')
  expect(storedConsumed?.messages.filter((m: { type?: string }) => m.type === 'user')).toHaveLength(1)
  void consumed
  // b) orphan claim: retryable again.
  expect(orphanClaim.pendingPlanExecution?.executionDispatched).toBe(false)
  // c) the incomplete correlated compaction became non-executable, is
  // retained for the renderer recovery + ACK, and was re-delivered.
  expect(awaiting.pendingPlanExecution?.failed).toBe(true)
  expect(getPendingPlanExecution(sandbox, 'recon-awaiting')?.failed).toBe(true)
  expect(redelivery).toContain('recon-awaiting')
  // The retained awaiting record cannot be readied by any later correlation
  // (its compact turn is gone) nor dispatched.
  expect(await sm.markCompactionComplete('recon-awaiting', 'e3')).toBe(false)
  expect(await sm.dispatchPendingPlanExecution('recon-awaiting', 'e3')).toMatchObject({ ok: false, reason: 'failed' })
  // d) failed outbox: re-delivered, retained until the scoped ACK.
  expect(failedOutbox.pendingPlanExecution?.failed).toBe(true)
  expect(redelivery).toContain('recon-failed')
  await sm.clearPendingPlanExecution('recon-failed', 'e4')
  expect(getPendingPlanExecution(sandbox, 'recon-failed')).toBeNull()
  // e) legacy dispatched record: inert and never cleared by reconciliation.
  expect(legacy.pendingPlanExecution?.executionDispatched).toBe(true)
  expect(getPendingPlanExecution(sandbox, 'recon-legacy')).not.toBeNull()

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('critical persistence rejects on IO failure and leaves the record retryable', async () => {
  const { sandbox, sm, managed } = await buildSession('io-failure')
  const sessionDir = join(sandbox, 'sessions', managed.id)
  chmodSync(sessionDir, 0o555)
  try {
    // The durable preparation write rejects: the renderer keeps the draft
    // unconsumed (durable-first) instead of believing a record exists.
    await expect(sm.setPendingPlanExecution(managed.id, '/review-plan.md', 'MSG', [buildRef(managed.projectId)]))
      .rejects.toThrow()
    expect(managed.pendingPlanExecution).toBeUndefined()
    expect(getPendingPlanExecution(sandbox, managed.id)).toBeNull()

    // A strict flush of an already-enqueued write also rejects (the durability
    // guarantee is real, not log-only).
    const { saveSessionStrict } = await import('@craft-agent/shared/sessions')
    const stored = loadSession(sandbox, managed.id)
    expect(stored).not.toBeNull()
    await expect(saveSessionStrict(stored!)).rejects.toThrow()
  } finally {
    chmodSync(sessionDir, 0o755)
  }

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('a stale /compact from a replaced acceptance never readies the new record', async () => {
  const { sandbox, sm, managed } = await buildSession('stale-compact')
  // Acceptance A consumed its draft, then was resolved (scoped clear) — e.g.
  // recovered after a failure. A NEW acceptance B (fresh, unconsumed) now
  // owns the session. The stale /compact that belonged to A's flow finally
  // executes: B has no consumption receipt, so the command must NOT stamp B
  // and A-turn completion can never ready it.
  await sm.setPendingPlanExecution(managed.id, '/plan-a.md', 'AAA')
  const executionA = managed.pendingPlanExecution!.executionId!
  setSessionDraft(managed.id, { text: 'AAA' })
  const consumedA = await sm.consumePendingPlanDraft(managed.id, executionA)
  expect(consumedA?.receipt.text).toBe(true)
  await sm.clearPendingPlanExecution(managed.id, executionA)
  await sm.restorePendingPlanDraft(managed.id, executionA, managed.pendingPlanExecution!.restoreId!)
  await sm.clearPendingPlanExecution(managed.id, executionA)
  await sm.setPendingPlanExecution(managed.id, '/plan-b.md', 'BBB')
  const recordB = managed.pendingPlanExecution!
  expect(recordB.executionId).toBeDefined()
  expect(recordB.executionId).not.toBe(executionA)

  // The stale A-flow /compact runs while B (which consumed nothing) is the
  // live record: no receipt for B → no correlation stamp → its completion
  // cannot ready B.
  managed.isProcessing = true
  await sm.sendMessage(managed.id, '/compact', undefined, undefined, { planExecutionId: executionA })
  expect(managed.pendingPlanExecution?.executionId).toBe(recordB.executionId)
  expect(managed.pendingPlanExecution?.awaitingCompaction).toBe(true)
  expect(managed.pendingPlanExecution?.compactionTurn).toBeUndefined()
  expect(await sm.markCompactionComplete(managed.id, recordB.executionId)).toBe(false)
  expect(getPendingPlanExecution(sandbox, managed.id)?.awaitingCompaction).toBe(true)

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})

test('deleteSession during a failing compaction cannot resurrect session or draft files', async () => {
  const { sandbox, sm, managed } = await buildSession('delete-during-failure')
  await sm.setPendingPlanExecution(managed.id, '/review-plan.md', 'MSG-delete-token')
  await stampCompactionCorrelation(managed, sandbox)
  const executionId = managed.pendingPlanExecution!.executionId
  const restoreId = managed.pendingPlanExecution!.restoreId

  // Session deletion holds the lifecycle lock; its force-abort emits the very
  // compaction_failed event whose cancellation then contends for the lock.
  const originalDelete = sm.deleteSession.bind(sm)
  let failureEmitted: (() => void) | undefined
  const emitFailure = new Promise<void>(resolve => { failureEmitted = resolve })
  sm.deleteSession = (async (id: string) => {
    void (async () => {
      await processEvent(sm, managed, { type: 'compaction_failed', compactionTrigger: 'manual' })
      failureEmitted!()
    })()
    await emitFailure
    return originalDelete(id)
  }) as never
  await sm.deleteSession(managed.id)
  await new Promise(r => setTimeout(r, 80))

  // The detached cancellation must not have recreated the session record, and
  // no draft restore may have been written for the deleted session.
  expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(managed.id)).toBe(false)
  expect(loadSession(sandbox, managed.id)).toBeNull()
  expect(getSessionDraft(managed.id)).toBeNull()
  void executionId
  void restoreId

  await sessionPersistenceQueue.flushAll()
  rmSync(sandbox, { recursive: true, force: true })
})
