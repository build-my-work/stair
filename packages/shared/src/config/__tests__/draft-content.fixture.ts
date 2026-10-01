import { expect, test } from 'bun:test'
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Reference } from '../../../../core/src/index.ts'
import type { DraftContentMutation } from '../draft-content.ts'
import type { SessionDraft } from '../storage.ts'

// This file is deliberately not discovered as a standalone test. The entry
// starts it in a subprocess with an isolated profile before loading storage.
const profile = process.env.CRAFT_CONFIG_DIR
if (
  process.env.CRAFT_DRAFT_CONTENT_TEST_CHILD !== '1'
  || !profile?.includes('craft-draft-content-test-')
) throw new Error('draft-content.fixture.ts requires the isolated test entry')
const store = await import('../storage.ts')
const core = await import('../../../../core/src/index.ts')

const projectId = 'review-protocol-project'

function reference(quote: string): Reference {
 return { version: 1, kind: 'web-selection', projectId, url: 'https://example.test', title: 'Review source', quote, locator: { type: 'web-text-quote', exact: quote } }
}
function revision(sessionId: string): number {
 return store.getSessionDraftHydrationState().revisions?.[sessionId] ?? 0
}
function content(draft: Pick<SessionDraft, 'text' | 'attachments'> | null | undefined) {
 return { text: draft?.text ?? '', ...(draft?.attachments?.length ? { attachments: draft.attachments } : {}) }
}
function mutation(id: string, baseRevision: number, base: Pick<SessionDraft, 'text' | 'attachments'>, references?: DraftContentMutation['references']): DraftContentMutation {
 return { id, baseRevision, base: content(base), ...(references ? { references } : {}) }
}
function fixture(baseText = '', refs: Reference[] = []) {
 const sessionId = 'review-store-' + randomUUID()
 // Fixture seeding uses the production full-draft setter. Ordinary modern
 // set-content mutations intentionally cannot carry references (no Project
 // boundary there); only scoped joint restore/consume reference deltas do.
 store.setSessionDraft(sessionId, { text: baseText, ...(refs.length ? { references: refs } : {}) })
 const draft = store.getSessionDraft(sessionId) ?? { text: '' }
 return { sessionId, base: content(draft), baseRevision: revision(sessionId), restoreId: 'restore-' + randomUUID() }
}
function read(f: { sessionId: string }): SessionDraft {
 const draft = store.getSessionDraft(f.sessionId)
 if (!draft) throw new Error('Expected a persisted draft')
 return draft
}
function count(text: string | undefined, token: string) { return text ? text.split(token).length - 1 : 0 }

// Inputs carry immutable captured baselines/mutation ids: a stale write must
// merge a delta or return a conflict, never silently replace the recovered draft.
test('joint recovery applies two independent local deltas and one snapshot', () => {
 const f = fixture()
 const snapshot = { text: 'UNIQUE-RECOVERY-SNAPSHOT', references: [reference('SOURCE-REFERENCE')] }
 const a = mutation('local-A-' + randomUUID(), f.baseRevision, f.base)
 const b = mutation('local-B-' + randomUUID(), f.baseRevision, f.base)
 const first = store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'WINDOW-A-NEW' }, mutation: a })
 expect(first.committed).toBe(true)
 expect(first.applied).toBe(true)
 const second = store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'WINDOW-B-NEW' }, mutation: b })
 expect(second.committed).toBe(true)
 expect(second.applied).toBe(false)
 const after = read(f)
 expect(after.text).toContain('WINDOW-A-NEW')
 expect(after.text).toContain('WINDOW-B-NEW')
 expect(count(after.text, snapshot.text)).toBe(1)
 expect(after.references).toHaveLength(1)
 expect(second.revision).toBe(revision(f.sessionId))
 // Same restore and same local mutation replay add neither component again.
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'WINDOW-B-NEW' }, mutation: b })
 expect(count(read(f).text, 'WINDOW-B-NEW')).toBe(1)
 expect(count(read(f).text, snapshot.text)).toBe(1)
})

test('already-inflight content mutation arriving after first restore preserves snapshot', () => {
 const f = fixture()
 const snapshot = { text: 'LATE-WRITE-SNAPSHOT' }
 const a = mutation('local-A-' + randomUUID(), f.baseRevision, f.base)
 const b = mutation('local-B-' + randomUUID(), f.baseRevision, f.base)
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'WINDOW-A-TEXT' }, mutation: a })
 // This is B's actual delayed draft-content RPC payload, captured before A
 // restored. The production setter is called only after A's atomic commit.
 store.setSessionDraftContent(f.sessionId, { text: 'WINDOW-B-TEXT' }, b)
 expect(read(f).text).toContain('WINDOW-A-TEXT')
 expect(read(f).text).toContain('WINDOW-B-TEXT')
 expect(count(read(f).text, snapshot.text)).toBe(1)
 // B then observes/replays the same outbox; this cannot duplicate B or R.
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'WINDOW-B-TEXT' }, mutation: b })
 expect(count(read(f).text, 'WINDOW-B-TEXT')).toBe(1)
 expect(count(read(f).text, snapshot.text)).toBe(1)
})

test('common nonempty baseline and concurrent appends preserve both additions', () => {
 const f = fixture('COMMON-BASE')
 const snapshot = { text: 'APPEND-SNAPSHOT' }
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'COMMON-BASE\nADD-A' }, mutation: mutation('append-A-' + randomUUID(), f.baseRevision, f.base) })
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'COMMON-BASE\nADD-B' }, mutation: mutation('append-B-' + randomUUID(), f.baseRevision, f.base) })
 expect(read(f).text).toContain('ADD-A')
 expect(read(f).text).toContain('ADD-B')
 expect(count(read(f).text, snapshot.text)).toBe(1)
})

test('divergent whole-text rewrites keep both proposals and snapshot', () => {
 const f = fixture('ORIGINAL-COMMON-TEXT')
 const snapshot = { text: 'REWRITE-SNAPSHOT' }
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'WINDOW-A-REWRITE' }, mutation: mutation('rewrite-A-' + randomUUID(), f.baseRevision, f.base) })
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'WINDOW-B-REWRITE' }, mutation: mutation('rewrite-B-' + randomUUID(), f.baseRevision, f.base) })
 expect(read(f).text).toContain('WINDOW-A-REWRITE')
 expect(read(f).text).toContain('WINDOW-B-REWRITE')
 expect(count(read(f).text, snapshot.text)).toBe(1)
})

test('distinct mutations with identical newly typed text are not string-deduplicated', () => {
 const f = fixture()
 const snapshot = { text: 'SAME-TEXT-SNAPSHOT' }
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'LEGITIMATE-SAME-INPUT' }, mutation: mutation('same-A-' + randomUUID(), f.baseRevision, f.base) })
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'LEGITIMATE-SAME-INPUT' }, mutation: mutation('same-B-' + randomUUID(), f.baseRevision, f.base) })
 expect(count(read(f).text, 'LEGITIMATE-SAME-INPUT')).toBe(2)
 expect(count(read(f).text, snapshot.text)).toBe(1)
})

test('stale clear preserves foreign recovery, fresh clear remains intentional', () => {
 const f = fixture('CLEAR-BASE')
 const snapshot = { text: 'CLEAR-SNAPSHOT' }
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'FOREIGN-WINDOW-TEXT' }, mutation: mutation('foreign-' + randomUUID(), f.baseRevision, f.base) })
 store.setSessionDraftContent(f.sessionId, { text: '' }, mutation('stale-clear-' + randomUUID(), f.baseRevision, f.base))
 expect(read(f).text).toContain('FOREIGN-WINDOW-TEXT')
 expect(read(f).text).toContain(snapshot.text)
 const confirmed = read(f)
 const confirmedRevision = revision(f.sessionId)
 const cleared = store.setSessionDraftContent(f.sessionId, { text: '' }, mutation('fresh-clear-' + randomUUID(), confirmedRevision, confirmed))
 expect(cleared?.text ?? '').toBe('')
 expect(revision(f.sessionId)).toBeGreaterThan(confirmedRevision)
 // Same restore already committed: intentional subsequent deletion stands.
 const repeat = store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot)
 expect(repeat.committed).toBe(true)
 expect(repeat.applied).toBe(false)
 expect(repeat.draft?.text ?? '').toBe('')
})

test('joint local reference deltas and snapshot union preserve each window source', () => {
 const common = reference('COMMON-SOURCE')
 const aRef = reference('WINDOW-A-SOURCE')
 const bRef = reference('WINDOW-B-SOURCE')
 const snapshotRef = reference('CONSUMED-SOURCE')
 const f = fixture('', [common])
 const snapshot = { text: 'REFERENCES-SNAPSHOT', references: [snapshotRef] }
 const a = mutation('refs-A-' + randomUUID(), f.baseRevision, f.base, { baseReferences: [common], nextReferences: [common, aRef] })
 const b = mutation('refs-B-' + randomUUID(), f.baseRevision, f.base, { baseReferences: [common], nextReferences: [common, bRef] })
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'A-TEXT' }, mutation: a })
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, snapshot, { content: { text: 'B-TEXT' }, mutation: b })
 expect((read(f).references ?? []).map((r) => r.quote).sort()).toEqual(['COMMON-SOURCE', 'CONSUMED-SOURCE', 'WINDOW-A-SOURCE', 'WINDOW-B-SOURCE'])
})

test('production consumption receipt exactly matches removed text and reference keys', () => {
 const old = reference('OLD-CONSUMED-SOURCE')
 const newer = reference('NEWER-UNCONSUMED-SOURCE')
 const f = fixture('ACCEPTED-SNAPSHOT-TEXT', [old, newer])
 const executionId = 'execution-' + randomUUID()
 const consumed = store.consumeSessionDraftForPlan(f.sessionId, projectId, executionId, { text: 'ACCEPTED-SNAPSHOT-TEXT', references: [old] })
 expect(consumed.receipt.text).toBe(true)
 expect(consumed.receipt.referenceKeys).toHaveLength(1)
 expect(read(f)?.text ?? '').toBe('')
 expect((read(f).references ?? []).map((r) => r.quote)).toEqual(['NEWER-UNCONSUMED-SOURCE'])
 expect(store.getPlanDraftConsumption(f.sessionId, executionId)).toEqual(consumed.receipt)
 // Replay uses the real durable receipt; it must not consume later new text.
 const state = read(f)
 store.setSessionDraftContent(f.sessionId, { text: 'NEWLY-TYPED-TEXT' }, mutation('post-consume-' + randomUUID(), revision(f.sessionId), state))
 const repeated = store.consumeSessionDraftForPlan(f.sessionId, projectId, executionId, { text: 'ACCEPTED-SNAPSHOT-TEXT', references: [old] })
 expect(repeated.receipt).toEqual(consumed.receipt)
 expect(read(f).text).toBe('NEWLY-TYPED-TEXT')
})

test('unconsumed changed draft creates no false text/reference consumption receipt', () => {
 const newer = reference('NEW-REF')
 const f = fixture('NEWER-CHANGED-TEXT', [newer])
 const executionId = 'unconsumed-' + randomUUID()
 const consumed = store.consumeSessionDraftForPlan(f.sessionId, projectId, executionId, { text: 'OLD-ACCEPTED-SNAPSHOT', references: [reference('OLD-REF')] })
 expect(consumed.receipt.text).toBe(false)
 expect(consumed.receipt.referenceKeys).toEqual([])
 expect(read(f).text).toBe('NEWER-CHANGED-TEXT')
 expect((read(f).references ?? []).map((r) => r.quote)).toEqual(['NEW-REF'])
})

test('reference-limit failure cannot partially commit local text, revision or restore receipt', () => {
 const refs = Array.from({ length: core.MAX_REFERENCES_PER_MESSAGE }, (_, i) => reference('FULL-' + i))
 const f = fixture('UNCHANGED-ON-FAILURE', refs)
 const before = store.getSessionDraftHydrationState()
 expect(() => store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, { text: 'OVER-LIMIT-SNAPSHOT', references: [reference('EXTRA-REF')] }, { content: { text: 'LOCAL-CHANGE-MUST-ROLLBACK' }, mutation: mutation('limits-' + randomUUID(), f.baseRevision, f.base) })).toThrow()
 const after = store.getSessionDraftHydrationState()
 expect(after.drafts[f.sessionId]).toEqual(before.drafts[f.sessionId])
 expect(after.revisions?.[f.sessionId]).toBe(before.revisions?.[f.sessionId])
 expect(after.appliedRestoreIds[f.sessionId] ?? []).not.toContain(f.restoreId)
})


test('same content mutation replay after a lost response is durable across processes', () => {
 const f = fixture('BEFORE-LOST-RESPONSE')
 const next = { text: 'COMMITTED-LOCAL-MUTATION' }
 const pending = mutation('lost-response-' + randomUUID(), f.baseRevision, f.base)
 // The first call commits but its response is lost. A later restore has
 // already changed the draft when another process retries the old request.
 store.setSessionDraftContent(f.sessionId, next, pending)
 store.restoreSessionDraftAtomic(f.sessionId, projectId, f.restoreId, { text: 'AFTER-LOST-RESPONSE-SNAPSHOT' })
 const storagePath = fileURLToPath(new URL('../storage.ts', import.meta.url))
 const replay = Bun.spawnSync([process.execPath, '--eval', `
   const store = await import(${JSON.stringify(storagePath)});
   store.setSessionDraftContent(${JSON.stringify(f.sessionId)}, ${JSON.stringify(next)}, ${JSON.stringify(pending)});
 `], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
 if (replay.exitCode !== 0) throw new Error(replay.stderr.toString())
 expect(count(read(f).text, next.text)).toBe(1)
 expect(count(read(f).text, 'AFTER-LOST-RESPONSE-SNAPSHOT')).toBe(1)
})

function withDraftsSnapshot(callback: (path: string) => void): void {
 const path = join(profile!, 'drafts.json')
 const before = readFileSync(path)
 const mode = statSync(path).mode & 0o777
 try {
  callback(path)
 } finally {
  // Every permission probe restores permissions before returning here.
  writeFileSync(path, before)
  chmodSync(path, mode)
 }
}

test('a genuinely missing store has no consumption or recovery receipt', () => {
 withDraftsSnapshot(path => {
  rmSync(path)
  expect(store.getPlanDraftConsumption('missing-session', 'missing-execution')).toBeNull()
  expect(store.hasAppliedDraftRestore('missing-session', 'missing-restore')).toBe(false)
 })
})

test('a corrupt store is rejected instead of fabricating an unconsumed receipt', () => {
 const f = fixture('KEEP-CORRUPT-STORE-SNAPSHOT')
 withDraftsSnapshot(path => {
  writeFileSync(path, '{')
  expect(() => store.getPlanDraftConsumption(f.sessionId, 'unknown-execution')).toThrow()
  expect(() => store.consumeSessionDraftForPlan(f.sessionId, projectId, 'new-execution', { text: 'KEEP-CORRUPT-STORE-SNAPSHOT', references: [] })).toThrow()
  expect(() => store.hasAppliedDraftRestore(f.sessionId, f.restoreId)).toThrow()
  expect(readFileSync(path, 'utf8')).toBe('{')
 })
})

// chmod is not an IO-failure injection on Windows or as root.
const permissionTest = process.platform === 'win32' || process.getuid?.() === 0 ? test.skip : test
permissionTest('an unreadable store rejects receipt decisions instead of treating it as missing', () => {
 const f = fixture('KEEP-UNREADABLE-STORE-SNAPSHOT')
 withDraftsSnapshot(path => {
  const mode = statSync(path).mode & 0o777
  try {
   chmodSync(path, 0o000)
   expect(() => store.getPlanDraftConsumption(f.sessionId, 'unknown-execution')).toThrow()
   expect(() => store.consumeSessionDraftForPlan(f.sessionId, projectId, 'new-execution', { text: 'KEEP-UNREADABLE-STORE-SNAPSHOT', references: [] })).toThrow()
   expect(() => store.hasAppliedDraftRestore(f.sessionId, f.restoreId)).toThrow()
  } finally {
   chmodSync(path, mode)
  }
 })
})

permissionTest('failed atomic consumption write leaves the draft and no false receipt', () => {
 const f = fixture('KEEP-UNWRITABLE-STORE-SNAPSHOT')
 const executionId = 'write-failure-' + randomUUID()
 withDraftsSnapshot(() => {
  const mode = statSync(profile!).mode & 0o777
  try {
   chmodSync(profile!, 0o555)
   expect(() => store.consumeSessionDraftForPlan(f.sessionId, projectId, executionId, { text: 'KEEP-UNWRITABLE-STORE-SNAPSHOT', references: [] })).toThrow()
  } finally {
   chmodSync(profile!, mode)
  }
  expect(read(f).text).toBe('KEEP-UNWRITABLE-STORE-SNAPSHOT')
  expect(store.getPlanDraftConsumption(f.sessionId, executionId)).toBeNull()
 })
})
