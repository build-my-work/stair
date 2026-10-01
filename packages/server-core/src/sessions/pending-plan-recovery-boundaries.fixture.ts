import { afterAll, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Reference } from '@craft-agent/core'

// Permanent versions of the seven receipt probes from the rebase review.
// Never inherit a caller's profile or CONFIG_DIR module cache.
const profile = mkdtempSync(join(tmpdir(), 'pending-plan-recovery-profile-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(
  resolve(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'),
  join(profile, 'config-defaults.json'),
)
const { CONFIG_DIR } = await import('@craft-agent/shared/config/paths')
if (CONFIG_DIR !== profile) throw new Error('Pending-plan recovery fixture requires an isolated config module cache')
const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSessionStrict, loadSession, getPendingPlanExecution, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { setSessionDraft, getSessionDraft, getPlanDraftConsumption, restoreSessionDraftAtomic, hasAppliedDraftRestore } = await import('@craft-agent/shared/config')

type Managed = ReturnType<typeof createManagedSession>
type Internals = {
  sessions: Map<string, Managed>
  processNextQueuedMessage: () => void
  ensureMessagesLoaded: (managed: Managed) => Promise<void>
}
type RecoveryEvent = {
  type: string
  executionId?: string
  restoreId?: string
  text?: string
  references?: Reference[]
}
const workspaces: string[] = []
afterAll(async () => {
  try {
    await sessionPersistenceQueue.flushAll()
  } finally {
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

async function fixture(id: string) {
  const sandbox = mkdtempSync(join(tmpdir(), 'pending-plan-recovery-workspace-'))
  workspaces.push(sandbox)
  const workspace = createWorkspaceAtPath(sandbox, id)
  const sm = new SessionManager()
  const host = sm as unknown as Internals
  const managed = createManagedSession({ id, projectId: workspace.defaultProjectId }, { ...workspace, rootPath: sandbox }, { messagesLoaded: true })
  host.sessions.set(id, managed)
  // Dispatch assertions inspect durable messages/queues, never start a provider.
  host.processNextQueuedMessage = () => {}
  await saveSessionStrict({ id, workspaceRootPath: sandbox, projectId: managed.projectId, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
  return { sm, host, managed, sandbox, workspace }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function prepare(f: Fixture, text: string, references?: Reference[]) {
  const record = await f.sm.setPendingPlanExecution(f.managed.id, '/plan.md', text, references)
  if (!record.executionId || !record.restoreId) throw new Error('Preparation did not persist recovery identities')
  return { ...record, executionId: record.executionId, restoreId: record.restoreId }
}

function webReference(f: Fixture, title: string): Reference {
  return { version: 1, kind: 'web-selection', projectId: f.managed.projectId, url: `https://example.test/${title}`, title, quote: title, locator: { type: 'web-text-quote', exact: title } }
}

async function coldCancel(f: Fixture) {
  const sm = new SessionManager()
  const host = sm as unknown as Internals
  const managed = createManagedSession({ id: f.managed.id, projectId: f.managed.projectId }, { ...f.workspace, rootPath: f.sandbox })
  host.sessions.set(managed.id, managed)
  host.processNextQueuedMessage = () => {}
  const events: RecoveryEvent[] = []
  sm.setEventSink((_clientId, _channel, event) => events.push(event as RecoveryEvent))
  await host.ensureMessagesLoaded(managed)
  const deadline = Date.now() + 1000
  while (getPendingPlanExecution(f.sandbox, managed.id)?.failed !== true && Date.now() < deadline) await Bun.sleep(5)
  expect(managed.pendingPlanExecution?.failed).toBe(true)
  expect(getPendingPlanExecution(f.sandbox, managed.id)?.failed).toBe(true)
  return { ...f, sm, host, managed, events }
}

async function recoverAndAck(f: Fixture, record: { executionId: string; restoreId: string }) {
  const restored = await f.sm.restorePendingPlanDraft(f.managed.id, record.executionId, record.restoreId)
  expect(restored.committed).toBe(true)
  expect(hasAppliedDraftRestore(f.managed.id, record.restoreId, record.executionId)).toBe(true)
  await f.sm.clearPendingPlanExecution(f.managed.id, record.executionId)
  expect(getPendingPlanExecution(f.sandbox, f.managed.id)).toBeNull()
  return restored
}

test('a delayed consume cannot erase the draft after failed cold recovery applied an empty snapshot', async () => {
  const old = await fixture('recovery-delayed-consume')
  setSessionDraft(old.managed.id, { text: 'SNAPSHOT' })
  const record = await prepare(old, 'SNAPSHOT')
  const f = await coldCancel(old)
  const event = f.events.find(event => event.type === 'compaction_failed')!
  expect(event.text).toBeUndefined()
  const restored = await f.sm.restorePendingPlanDraft(f.managed.id, record.executionId, record.restoreId)
  expect(restored.committed).toBe(true)
  expect(hasAppliedDraftRestore(f.managed.id, record.restoreId, record.executionId)).toBe(true)
  expect(await f.sm.consumePendingPlanDraft(f.managed.id, record.executionId)).toBeNull()
  await f.sm.clearPendingPlanExecution(f.managed.id, record.executionId)
  expect(getSessionDraft(f.managed.id)?.text).toBe('SNAPSHOT')
  expect(getPendingPlanExecution(f.sandbox, f.managed.id)).toBeNull()
})

test('failed GET exposes no unconsumed snapshot and redelivery preserves the existing text exactly once', async () => {
  const old = await fixture('recovery-get-unconsumed')
  setSessionDraft(old.managed.id, { text: 'SNAPSHOT' })
  const record = await prepare(old, 'SNAPSHOT')
  const f = await coldCancel(old)
  const pending = f.sm.getPendingPlanExecution(f.managed.id)!
  expect(pending.failed).toBe(true)
  expect(pending.draftInputSnapshot).toBeUndefined()
  expect(pending.draftReferencesSnapshot).toBeUndefined()
  await recoverAndAck(f, record)
  expect(getSessionDraft(f.managed.id)?.text).toBe('SNAPSHOT')
})

test('cancellation and failed GET recover only the reference keys actually consumed', async () => {
  const old = await fixture('recovery-partial-references')
  const a = webReference(old, 'A')
  const b = webReference(old, 'B')
  const record = await prepare(old, 'SNAPSHOT', [a, b])
  setSessionDraft(old.managed.id, { text: 'NEWER', references: [a] })
  const consumed = await old.sm.consumePendingPlanDraft(old.managed.id, record.executionId)
  expect(consumed?.receipt.text).toBe(false)
  expect(consumed?.receipt.referenceKeys).toHaveLength(1)
  expect(consumed?.receipt.consumedAt).toEqual(expect.any(Number))
  const f = await coldCancel(old)
  const event = f.events.find(event => event.type === 'compaction_failed')!
  expect(event.text).toBeUndefined()
  expect(event.references).toEqual([a])
  expect(f.sm.getPendingPlanExecution(f.managed.id)?.draftReferencesSnapshot).toEqual([a])
  await recoverAndAck(f, record)
  expect(getSessionDraft(f.managed.id)?.text).toBe('NEWER')
  expect(getSessionDraft(f.managed.id)?.references).toEqual([a])
})

test('a malformed existing receipt rejects reads and cannot authorize recovery ACK', async () => {
  const old = await fixture('recovery-malformed-receipt')
  setSessionDraft(old.managed.id, { text: 'SNAPSHOT' })
  const record = await prepare(old, 'SNAPSHOT')
  await old.sm.consumePendingPlanDraft(old.managed.id, record.executionId)
  const file = join(profile, 'drafts.json')
  const valid = readFileSync(file, 'utf8')
  const data = JSON.parse(valid)
  data.planConsumption[old.managed.id][record.executionId].referenceKeys = null
  writeFileSync(file, JSON.stringify(data))
  let f: Fixture | undefined
  try {
    expect(() => getPlanDraftConsumption(old.managed.id, record.executionId)).toThrow('Invalid plan consumption receipt')
    f = await coldCancel(old)
    await f.sm.clearPendingPlanExecution(f.managed.id, record.executionId)
    expect(getPendingPlanExecution(f.sandbox, f.managed.id)?.executionId).toBe(record.executionId)
    expect(f.managed.pendingPlanExecution?.executionId).toBe(record.executionId)
  } finally {
    // Restore the exact disposable file before any later receipt probe runs.
    writeFileSync(file, valid)
  }
  if (!f) throw new Error('Cold cancellation fixture failed')
  await recoverAndAck(f, record)
  expect(getSessionDraft(f.managed.id)?.text).toBe('SNAPSHOT')
})

test('parent-directory IO failure is an error and preserves the recovery outbox', async () => {
  const old = await fixture('recovery-receipt-parent-io')
  setSessionDraft(old.managed.id, { text: 'SNAPSHOT' })
  const record = await prepare(old, 'SNAPSHOT')
  await old.sm.consumePendingPlanDraft(old.managed.id, record.executionId)
  const f = await coldCancel(old)
  const mode = statSync(profile).mode & 0o777
  try {
    chmodSync(profile, 0o000)
    expect(() => getPlanDraftConsumption(f.managed.id, record.executionId)).toThrow()
    await expect(f.sm.restorePendingPlanDraft(f.managed.id, record.executionId, record.restoreId)).rejects.toThrow()
    await f.sm.clearPendingPlanExecution(f.managed.id, record.executionId)
    expect(getPendingPlanExecution(f.sandbox, f.managed.id)?.executionId).toBe(record.executionId)
    expect(f.managed.pendingPlanExecution?.executionId).toBe(record.executionId)
  } finally {
    chmodSync(profile, mode)
  }
  await recoverAndAck(f, record)
  expect(getSessionDraft(f.managed.id)?.text).toBe('SNAPSHOT')
})

test('empty consumption requires no restored content and permits a scoped ACK', async () => {
  const old = await fixture('recovery-empty-consumption')
  const record = await prepare(old, '')
  const consumed = await old.sm.consumePendingPlanDraft(old.managed.id, record.executionId)
  expect(consumed?.receipt.text).toBe(false)
  expect(consumed?.receipt.referenceKeys).toEqual([])
  expect(consumed?.receipt.consumedAt).toEqual(expect.any(Number))
  const f = await coldCancel(old)
  await f.sm.clearPendingPlanExecution(f.managed.id, record.executionId)
  expect(getPendingPlanExecution(f.sandbox, f.managed.id)).toBeNull()
  expect(getSessionDraft(f.managed.id)).toBeNull()
})

for (const identified of [false, true]) {
  test(`${identified ? 'identified pre-marker' : 'legacy ready'} Chat quotes require fresh validation before durable dispatch`, async () => {
    const f = await fixture(identified ? 'recovery-pre-marker-chat' : 'recovery-legacy-chat')
    const other = createManagedSession({ id: 'other-project-chat', projectId: 'other-project' }, { ...f.workspace, rootPath: f.sandbox }, { messagesLoaded: true })
    other.messages = [{ id: 'private-message', role: 'assistant', content: 'private quote', timestamp: 1 }]
    f.host.sessions.set(other.id, other)
    const ref: Reference = { version: 1, kind: 'chat-message', projectId: f.managed.projectId, sessionId: other.id, messageId: 'private-message', role: 'assistant', quote: 'private quote', locator: { type: 'text-quote', exact: 'private quote', start: 0, end: 13 } }
    await expect(f.sm.sendMessage(f.managed.id, 'explain', undefined, undefined, { references: [ref] })).rejects.toThrow('MESSAGE_REFERENCE_PROJECT_MISMATCH')
    // Old setters normalized target scope without validating source ownership.
    f.managed.pendingPlanExecution = {
      planPath: '/old-plan.md', draftInputSnapshot: 'explain', draftReferencesSnapshot: [ref],
      awaitingCompaction: false, executionDispatched: false,
      ...(identified ? { executionId: 'pre-marker-execution', restoreId: 'pre-marker-restore' } : {}),
    }
    const stored = loadSession(f.sandbox, f.managed.id)!
    stored.pendingPlanExecution = f.managed.pendingPlanExecution
    await saveSessionStrict(stored)
    expect(await f.sm.dispatchPendingPlanExecution(f.managed.id, f.managed.pendingPlanExecution.executionId)).toEqual({ ok: false, reason: 'invalid-references' })
    expect(f.managed.messageQueue).toHaveLength(0)
    expect(loadSession(f.sandbox, f.managed.id)?.messages).toHaveLength(0)
  })
}

test('a generic fabricated restore receipt cannot ACK a consumed host snapshot', async () => {
  const old = await fixture('recovery-fabricated-generic-restore')
  setSessionDraft(old.managed.id, { text: 'SNAPSHOT' })
  const record = await prepare(old, 'SNAPSHOT')
  await old.sm.consumePendingPlanDraft(old.managed.id, record.executionId)
  const f = await coldCancel(old)
  const generic = restoreSessionDraftAtomic(f.managed.id, f.managed.projectId, record.restoreId, { text: '' })
  expect(generic.committed).toBe(true)
  expect(hasAppliedDraftRestore(f.managed.id, record.restoreId)).toBe(true)
  expect(hasAppliedDraftRestore(f.managed.id, record.restoreId, record.executionId)).toBe(false)
  await f.sm.clearPendingPlanExecution(f.managed.id, record.executionId)
  expect(getPendingPlanExecution(f.sandbox, f.managed.id)?.executionId).toBe(record.executionId)
  expect(f.managed.pendingPlanExecution?.draftInputSnapshot).toBe('SNAPSHOT')
  expect(getSessionDraft(f.managed.id)).toBeNull()
})

test('cold-load phase cancellation closes consume admission before its deferred persistence runs', async () => {
  const old = await fixture('recovery-phase-cancellation')
  setSessionDraft(old.managed.id, { text: 'SNAPSHOT' })
  const record = await prepare(old, 'SNAPSHOT')
  const sm = new SessionManager()
  const host = sm as unknown as Internals
  const managed = createManagedSession({ id: old.managed.id, projectId: old.managed.projectId }, { ...old.workspace, rootPath: old.sandbox })
  host.sessions.set(managed.id, managed)
  host.processNextQueuedMessage = () => {}
  const callbacks: Array<() => void> = []
  const original = globalThis.setImmediate
  globalThis.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    callbacks.push(() => callback(...args))
    return 1 as never
  }) as never
  try {
    await host.ensureMessagesLoaded(managed)
  } finally {
    globalThis.setImmediate = original
  }
  expect(callbacks.length).toBeGreaterThan(0)
  expect(managed.pendingPlanExecution?.failed).toBe(true)
  expect(getPendingPlanExecution(old.sandbox, managed.id)?.failed).not.toBe(true)
  expect(await sm.consumePendingPlanDraft(managed.id, record.executionId)).toBeNull()
  expect(getPlanDraftConsumption(managed.id, record.executionId)).toBeNull()
  expect(getSessionDraft(managed.id)?.text).toBe('SNAPSHOT')
  await sm.clearPendingPlanExecution(managed.id, record.executionId)
  for (const callback of callbacks) callback()
  await Bun.sleep(10)
  expect(getSessionDraft(managed.id)?.text).toBe('SNAPSHOT')
  expect(getPendingPlanExecution(old.sandbox, managed.id)).toBeNull()
})

test('a fresh validated accepted Chat quote survives source deletion and still dispatches durably', async () => {
  const f = await fixture('recovery-validated-deleted-source')
  const source = createManagedSession({ id: 'accepted-source-chat', projectId: f.managed.projectId }, { ...f.workspace, rootPath: f.sandbox }, { messagesLoaded: true })
  source.messages = [{ id: 'accepted-message', role: 'assistant', content: 'accepted quote', timestamp: 1 }]
  f.host.sessions.set(source.id, source)
  const ref: Reference = { version: 1, kind: 'chat-message', projectId: f.managed.projectId, sessionId: source.id, messageId: 'accepted-message', role: 'assistant', quote: 'accepted quote', locator: { type: 'text-quote', exact: 'accepted quote', start: 0, end: 14 } }
  const record = await prepare(f, 'explain', [ref])
  expect(record.referencesValidated).toBe(true)
  expect(getPendingPlanExecution(f.sandbox, f.managed.id)?.referencesValidated).toBe(true)
  setSessionDraft(f.managed.id, { text: 'explain', references: [ref] })
  expect((await f.sm.consumePendingPlanDraft(f.managed.id, record.executionId))?.receipt.text).toBe(true)
  const origin = { generation: f.managed.processingGeneration, stopEpoch: f.managed.stopEpoch ?? 0 }
  f.managed.pendingPlanExecution!.compactionTurn = origin
  const stored = loadSession(f.sandbox, f.managed.id)!
  stored.pendingPlanExecution = f.managed.pendingPlanExecution
  await saveSessionStrict(stored)
  expect(await f.sm.markCompactionComplete(f.managed.id, record.executionId, origin)).toBe(true)
  f.host.sessions.delete(source.id)
  // A new send intentionally cancels that Chat's old intent. Use a separate
  // ordinary Chat to prove fresh validation without cancelling this acceptance.
  const fresh = createManagedSession({ id: 'fresh-unaccepted-chat', projectId: f.managed.projectId }, { ...f.workspace, rootPath: f.sandbox }, { messagesLoaded: true })
  f.host.sessions.set(fresh.id, fresh)
  await expect(f.sm.sendMessage(fresh.id, 'new request', undefined, undefined, { references: [ref] })).rejects.toThrow('MESSAGE_REFERENCE_SOURCE_INVALID')
  expect(await f.sm.dispatchPendingPlanExecution(f.managed.id, record.executionId)).toEqual({ ok: true })
  const approvalId = f.managed.pendingPlanExecution!.approvalMessageId
  expect(approvalId).toBeDefined()
  expect(loadSession(f.sandbox, f.managed.id)?.messages.find(message => message.id === approvalId)?.references).toEqual([ref])
  expect(f.managed.messageQueue).toHaveLength(1)
})
