import { test, expect, afterAll } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Ported from the Codex plan-boundary review (stair-plan-boundary-review-3gif3rcr,
// session-boundaries-v2.test.ts): production SM regressions proven against the
// frozen snapshot — fresh cross-Project validation at prepare, durable quotes
// for fresh-validated accepts, stale-clear preservation of a replacement in
// memory AND on disk, the legacy claim path never consuming modern intent,
// and deferred cold cleanup scoped to the hydrated record identity.
const profile = mkdtempSync(join(tmpdir(), 'stair-plan-boundary-profile-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(join(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))

const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSession, loadSession, getPendingPlanExecution, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { setSessionDraft: setSessionDraftForTest, getSessionDraft: getSessionDraftForTest } = await import('@craft-agent/shared/config')

type Managed = ReturnType<typeof createManagedSession>

const workspaces: string[] = []
afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  for (const ws of workspaces.splice(0)) rmSync(ws, { recursive: true, force: true })
})

async function fixture(id: string) {
  const sandbox = mkdtempSync(join(tmpdir(), 'stair-plan-boundary-ws-'))
  workspaces.push(sandbox)
  const workspace = createWorkspaceAtPath(sandbox, id)
  const sm = new SessionManager()
  const managed = createManagedSession({ id, projectId: workspace.defaultProjectId }, { ...workspace, rootPath: sandbox }, { messagesLoaded: true })
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  // Never start a model turn from these fixtures (queue assertions inspect
  // the durable entries instead).
  ;(sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}
  await saveSession({ id, workspaceRootPath: sandbox, projectId: managed.projectId, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as never)
  return { sm, managed, sandbox, workspace }
}

async function ready(sm: InstanceType<typeof SessionManager>, managed: Managed, sandbox: string) {
  managed.pendingPlanExecution!.compactionTurn = { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
  const stored = loadSession(sandbox, managed.id)!
  stored.pendingPlanExecution = managed.pendingPlanExecution as never
  await saveSession(stored)
  expect(await sm.markCompactionComplete(managed.id, managed.pendingPlanExecution!.executionId)).toBe(true)
}

test('fresh plan acceptance must not turn cross-Project chat refs into trusted durable refs', async () => {
  const f = await fixture('fresh-cross-project')
  const other = createManagedSession({ id: 'private-project-chat', projectId: 'other-project' }, { ...f.workspace, rootPath: f.sandbox }, { messagesLoaded: true })
  other.messages = [{ id: 'private-message', role: 'assistant', content: 'private Project quote', timestamp: 1 }] as never
  ;(f.sm as unknown as { sessions: Map<string, unknown> }).sessions.set(other.id, other)
  const ref = { version: 1, kind: 'chat-message', projectId: f.managed.projectId, sessionId: other.id, messageId: 'private-message', role: 'assistant', quote: 'private Project quote', locator: { type: 'text-quote', exact: 'private Project quote', start: 0, end: 21 } }
  await expect(f.sm.sendMessage(f.managed.id, 'explain', undefined, undefined, { references: [ref] } as never)).rejects.toThrow('MESSAGE_REFERENCE_PROJECT_MISMATCH')
  await expect(f.sm.setPendingPlanExecution(f.managed.id, '/accepted-plan.md', 'explain', [ref] as never)).rejects.toThrow('MESSAGE_REFERENCE_PROJECT_MISMATCH')
  expect(f.managed.pendingPlanExecution).toBeUndefined()
  expect(getPendingPlanExecution(f.sandbox, f.managed.id)).toBeNull()
  expect(f.managed.messageQueue).toHaveLength(0)
})

test('fresh-validated accepted plan keeps its durable quotes after source deletion', async () => {
  const f = await fixture('durable-plan-chat')
  const source = createManagedSession({ id: 'valid-source', projectId: f.managed.projectId }, { ...f.workspace, rootPath: f.sandbox }, { messagesLoaded: true })
  source.messages = [{ id: 'valid-message', role: 'assistant', content: 'accepted quote', timestamp: 1 }] as never
  ;(f.sm as unknown as { sessions: Map<string, unknown> }).sessions.set(source.id, source)
  const refs = [{ version: 1, kind: 'chat-message', projectId: f.managed.projectId, sessionId: source.id, messageId: 'valid-message', role: 'assistant', quote: 'accepted quote', locator: { type: 'text-quote', exact: 'accepted quote', start: 0, end: 14 } }]
  await f.sm.setPendingPlanExecution(f.managed.id, '/validated-plan.md', 'explain', refs as never)
  await ready(f.sm, f.managed, f.sandbox)
  ;(f.sm as unknown as { sessions: Map<string, unknown> }).sessions.delete(source.id)
  const result = await f.sm.dispatchPendingPlanExecution(f.managed.id, f.managed.pendingPlanExecution!.executionId)
  const approval = loadSession(f.sandbox, f.managed.id)?.messages.find((m: { id?: string }) => m.id === f.managed.pendingPlanExecution?.approvalMessageId)
  expect(result).toEqual({ ok: true })
  expect((approval as { references?: unknown } | undefined)?.references).toEqual(refs)
  expect(f.managed.messageQueue).toHaveLength(1)
})

test('stale identified clear must preserve the replacement in memory and after a normal persist', async () => {
  const f = await fixture('stale-memory-clear')
  await f.sm.setPendingPlanExecution(f.managed.id, '/plan-a.md', 'draft-A')
  const staleId = f.managed.pendingPlanExecution!.executionId
  await f.sm.setPendingPlanExecution(f.managed.id, '/plan-b.md', 'draft-B')
  const replacementId = f.managed.pendingPlanExecution!.executionId
  await ready(f.sm, f.managed, f.sandbox)
  await f.sm.clearPendingPlanExecution(f.managed.id, staleId)
  const diskBefore = getPendingPlanExecution(f.sandbox, f.managed.id)
  const memory = f.managed.pendingPlanExecution
  const dispatchResult = await f.sm.dispatchPendingPlanExecution(f.managed.id, f.managed.pendingPlanExecution?.executionId)
  // An ordinary metadata save (rename-style persist) must not propagate the
  // stale clear to disk either.
  ;(f.sm as unknown as { persistSession: (m: unknown) => void }).persistSession(f.managed)
  await f.sm.flushSession(f.managed.id)
  const diskAfter = getPendingPlanExecution(f.sandbox, f.managed.id)
  expect(memory?.executionId).toBe(replacementId)
  expect(diskBefore?.executionId).toBe(replacementId)
  expect(dispatchResult).toEqual({ ok: true })
  expect(diskAfter?.executionId).toBe(replacementId)
})

test('a legacy identity-less claim must never consume a modern identified record', async () => {
  const f = await fixture('legacy-claim')
  ;(f.sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}
  await f.sm.setPendingPlanExecution(f.managed.id, '/modern-plan.md', 'draft')
  await ready(f.sm, f.managed, f.sandbox)
  const modernId = f.managed.pendingPlanExecution!.executionId
  const claimed = await f.sm.markPendingPlanExecutionDispatched(f.managed.id)
  const dispatch = await f.sm.dispatchPendingPlanExecution(f.managed.id, f.managed.pendingPlanExecution?.executionId)
  // The legacy claim is rejected; the modern record still dispatches durably
  // (queued approval + approvalMessageId), so no handoff is lost or stranded.
  expect(claimed).toBe(false)
  expect(dispatch).toEqual({ ok: true })
  expect(f.managed.messageQueue).toHaveLength(1)
  expect(getPendingPlanExecution(f.sandbox, f.managed.id)?.approvalMessageId).toBeDefined()
  expect(modernId).toBeDefined()
})

test('deferred cold cleanup must be scoped to the hydrated record', async () => {
  const f = await fixture('cold-clear-replacement')
  const stored = loadSession(f.sandbox, f.managed.id)!
  stored.messages = [{ id: 'old-approval', type: 'user', content: 'Plan approved, please execute.', timestamp: 2 }] as never
  // Legacy-inert dispatched record (pre-identity, never replayed): the
  // captured-identity cleanup must still not touch a later replacement.
  stored.pendingPlanExecution = { planPath: '/old-plan.md', awaitingCompaction: false, executionDispatched: true }
  await saveSession(stored)
  f.managed.messagesLoaded = false
  const callbacks: Array<() => void> = []
  const original = globalThis.setImmediate
  globalThis.setImmediate = ((cb: (...args: unknown[]) => void, ...args: unknown[]) => {
    callbacks.push(() => cb(...args))
    return 1 as never
  }) as never
  try {
    await (f.sm as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(f.managed)
  } finally {
    globalThis.setImmediate = original
  }
  await f.sm.setPendingPlanExecution(f.managed.id, '/fresh-plan.md', 'new-draft')
  const replacementId = f.managed.pendingPlanExecution!.executionId
  // Deliver the actual recovery callback AFTER a fresh Accept completed: it
  // captured the hydrated identity and must not delete the replacement.
  for (const cb of callbacks) cb()
  await new Promise(r => setTimeout(r, 50))
  expect(f.managed.pendingPlanExecution?.executionId).toBe(replacementId)
  expect(getPendingPlanExecution(f.sandbox, f.managed.id)?.executionId).toBe(replacementId)
})

test('a legacy already-ready stored record still dispatches after upgrade (correlation gates only the transition)', async () => {
  const f = await fixture('legacy-ready-record')
  const stored = loadSession(f.sandbox, f.managed.id)!
  stored.pendingPlanExecution = { planPath: '/legacy-plan.md', awaitingCompaction: false, executionDispatched: false }
  await saveSession(stored)
  f.managed.messagesLoaded = false
  await (f.sm as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(f.managed)
  const result = await f.sm.dispatchPendingPlanExecution(f.managed.id, f.managed.pendingPlanExecution?.executionId)
  expect(result).toEqual({ ok: true })
  expect(f.managed.messageQueue).toHaveLength(1)
})

test('a new acceptance never replaces a record holding an unrecoverable snapshot', async () => {
  const f = await fixture('no-replace-outbox')
  const first = await f.sm.setPendingPlanExecution(f.managed.id, '/first.md', 'FIRST-snapshot-token')
  // A crashed PREPARATION that consumed nothing is replaceable: its snapshot
  // is still the user's live draft, so nothing can be lost.
  await expect(f.sm.setPendingPlanExecution(f.managed.id, '/crashed-prepare.md', 'again')).resolves.toBeDefined()

  // Once the draft was atomically consumed (receipt + cleared draft in one
  // durable write), replacement is rejected — dropping the record now would
  // lose the snapshot.
  setSessionDraftForTest(f.managed.id, { text: 'again' })
  const consumed = await f.sm.consumePendingPlanDraft(f.managed.id, f.managed.pendingPlanExecution!.executionId!)
  expect(consumed?.receipt.text).toBe(true)
  expect(getSessionDraftForTest(f.managed.id)?.text ?? '').not.toContain('again')
  await expect(f.sm.setPendingPlanExecution(f.managed.id, '/second.md', 'second'))
    .rejects.toThrow('PENDING_PLAN_EXISTS')
  // The consumed record and its snapshot are intact.
  expect(f.managed.pendingPlanExecution?.draftInputSnapshot).toBe('again')
  expect(getPendingPlanExecution(f.sandbox, f.managed.id)?.draftInputSnapshot).toBe('again')
  // A ready (compacted) record is equally unresolved.
  await ready(f.sm, f.managed, f.sandbox)
  await expect(f.sm.setPendingPlanExecution(f.managed.id, '/third.md', 'third'))
    .rejects.toThrow('PENDING_PLAN_EXISTS')
  // Scoped cancellation keeps a consumed snapshot until real recovery ACK.
  const executionId = f.managed.pendingPlanExecution!.executionId!
  await f.sm.clearPendingPlanExecution(f.managed.id, executionId)
  const failed = f.managed.pendingPlanExecution!
  expect(failed.failed).toBe(true)
  await expect(f.sm.setPendingPlanExecution(f.managed.id, '/third.md', 'third')).rejects.toThrow('PENDING_PLAN_EXISTS')
  await f.sm.restorePendingPlanDraft(f.managed.id, executionId, failed.restoreId!)
  await f.sm.clearPendingPlanExecution(f.managed.id, executionId)
  await expect(f.sm.setPendingPlanExecution(f.managed.id, '/third.md', 'third')).resolves.toBeDefined()
  expect(first?.executionId).toBeDefined()
})
