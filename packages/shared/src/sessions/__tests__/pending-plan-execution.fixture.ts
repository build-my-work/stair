import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Reference } from '@craft-agent/core/types'
import type { StoredSession } from '../types.ts'

// This suite replaces drafts.json to exercise strict IO failures. Never use
// the caller's profile, even when this fixture is run directly.
const configDir = mkdtempSync(join(tmpdir(), 'pending-plan-profile-'))
process.env.CRAFT_CONFIG_DIR = configDir
afterAll(() => rmSync(configDir, { recursive: true, force: true }))
copyFileSync(
  resolve(import.meta.dir, '../../../../../apps/electron/resources/config-defaults.json'),
  join(configDir, 'config-defaults.json'),
)

const { CONFIG_DIR } = await import('../../config/paths.ts')
if (CONFIG_DIR !== configDir) throw new Error('Pending-plan fixture requires an isolated config module cache')
const { createWorkspaceAtPath } = await import('../../workspaces/storage.ts')
const {
  clearPendingPlanExecution,
  getPendingPlanExecution,
  getSessionFilePath,
  markCompactionComplete,
  markPendingPlanExecutionDispatched,
  saveSession,
  setPendingPlanExecution,
} = await import('../storage.ts')

function makeTmpDir(): string {
  const dir = join(tmpdir(), `pending-plan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeReference(projectId: string): Reference {
  return {
    version: 1,
    kind: 'chat-message',
    projectId,
    sessionId: 'source-session',
    messageId: 'source-message',
    role: 'assistant',
    quote: 'selected text',
    locator: {
      type: 'text-quote',
      exact: 'selected text',
      start: 0,
      end: 13,
    },
  }
}

function makeStoredSession(workspaceRootPath: string, projectId: string): StoredSession {
  return {
    id: 'session-1',
    workspaceRootPath,
    projectId,
    createdAt: 1000,
    lastUsedAt: 1000,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  } as StoredSession
}

describe('pending plan execution persistence', () => {
  let workspaceRoot: string
  let projectId: string

  beforeEach(async () => {
    workspaceRoot = makeTmpDir()
    projectId = createWorkspaceAtPath(workspaceRoot, 'Pending plan').defaultProjectId
    const session = makeStoredSession(workspaceRoot, projectId)
    await saveSession(session)
  })

  afterEach(() => {
    if (existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })


  /** Stamp the compaction correlation the way the /compact turn does. */
  async function stampCompactionTurn(correlation: { generation: number; stopEpoch: number }) {
    const session = (await import('../storage.ts')).loadSession(workspaceRoot, 'session-1')!
    session.pendingPlanExecution!.compactionTurn = correlation
    await saveSession(session)
  }

  it('mints stable record identities and persists transitions', async () => {
    const reference = makeReference(projectId)
    const record = await setPendingPlanExecution(
      workspaceRoot,
      'session-1',
      '/tmp/plan.md',
      'draft snapshot',
      [reference],
    )
    // New records carry a stable execution identity and restore key.
    expect(record?.executionId).toBeDefined()
    expect(record?.restoreId).toBeDefined()

    const stored = getPendingPlanExecution(workspaceRoot, 'session-1')!
    expect(stored.planPath).toBe('/tmp/plan.md')
    expect(stored.draftInputSnapshot).toBe('draft snapshot')
    expect(stored.draftReferencesSnapshot).toEqual([reference])
    expect(stored.awaitingCompaction).toBe(true)
    expect(stored.executionDispatched).toBe(false)

    // Uncorrelated records can never be claimed or readied; a NO-IDENTITY
    // claim can never touch an identified record.
    const executionId = stored.executionId
    expect(executionId).toBeDefined()
    expect(await markPendingPlanExecutionDispatched(workspaceRoot, 'session-1')).toBe(false)
    expect(await markCompactionComplete(workspaceRoot, 'session-1')).toBe(false)

    // The record's own /compact correlation readies it; foreign ones do not.
    await stampCompactionTurn({ generation: 7, stopEpoch: 3 })
    expect(await markCompactionComplete(workspaceRoot, 'session-1', { generation: 8, stopEpoch: 3 })).toBe(false)
    expect(await markCompactionComplete(workspaceRoot, 'session-1', { generation: 7, stopEpoch: 3 })).toBe(true)

    // Identified records NEVER take the legacy claim path — dispatch is the
    // only modern execution route (server-side durable approval handoff).
    expect(await markPendingPlanExecutionDispatched(workspaceRoot, 'session-1')).toBe(false)
    expect(getPendingPlanExecution(workspaceRoot, 'session-1')?.executionDispatched).toBe(false)
  })

  it('serialized legacy claim: concurrent claims on a LEGACY record accept exactly one', async () => {
    // Only pre-identity records use the legacy claim-then-send path; the
    // transaction still accepts exactly one concurrent claimant.
    const session = makeStoredSession(workspaceRoot, projectId)
    session.pendingPlanExecution = {
      planPath: '/tmp/legacy.md',
      awaitingCompaction: false,
      executionDispatched: false,
    }
    await saveSession(session)
    const claims = await Promise.all([
      markPendingPlanExecutionDispatched(workspaceRoot, 'session-1'),
      markPendingPlanExecutionDispatched(workspaceRoot, 'session-1'),
      markPendingPlanExecutionDispatched(workspaceRoot, 'session-1'),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('a stale claim cannot affect a replaced record', async () => {
    const first = await setPendingPlanExecution(workspaceRoot, 'session-1', '/tmp/plan-a.md')
    const firstId = first?.executionId
    await setPendingPlanExecution(workspaceRoot, 'session-1', '/tmp/plan-b.md')
    await stampCompactionTurn({ generation: 1, stopEpoch: 0 })

    // The replaced record is ready, but neither the OLD identity nor a
    // no-identity command may claim the identified replacement.
    await markCompactionComplete(workspaceRoot, 'session-1', { generation: 1, stopEpoch: 0 })
    expect(await markPendingPlanExecutionDispatched(workspaceRoot, 'session-1')).toBe(false)
    expect(await markPendingPlanExecutionDispatched(workspaceRoot, 'session-1')).toBe(false)
    expect(getPendingPlanExecution(workspaceRoot, 'session-1')?.executionDispatched).toBe(false)
  })

  it('clears a pending plan, and leaves the file alone when nothing is pending', async () => {
    const path = getSessionFilePath(workspaceRoot, 'session-1')
    const untouched = statSync(path).mtimeMs
    await new Promise(resolve => setTimeout(resolve, 15))
    // Runs on every user message: no rewrite (concurrent sends used to race on the .tmp file).
    await Promise.all([
      clearPendingPlanExecution(workspaceRoot, 'session-1'),
      clearPendingPlanExecution(workspaceRoot, 'session-1'),
    ])
    expect(statSync(path).mtimeMs).toBe(untouched)

    await setPendingPlanExecution(workspaceRoot, 'session-1', '/tmp/plan.md')
    // Identified records are cleared only by their scoped identity.
    await clearPendingPlanExecution(workspaceRoot, 'session-1', getPendingPlanExecution(workspaceRoot, 'session-1')?.executionId)
    expect(getPendingPlanExecution(workspaceRoot, 'session-1')).toBeNull()
  })

  it('a stale or no-identity clear never deletes an identified replacement', async () => {
    const first = await setPendingPlanExecution(workspaceRoot, 'session-1', '/tmp/plan-a.md')
    await setPendingPlanExecution(workspaceRoot, 'session-1', '/tmp/plan-b.md')
    await clearPendingPlanExecution(workspaceRoot, 'session-1', first?.executionId)
    expect(getPendingPlanExecution(workspaceRoot, 'session-1')?.planPath).toBe('/tmp/plan-b.md')
    await clearPendingPlanExecution(workspaceRoot, 'session-1')
    expect(getPendingPlanExecution(workspaceRoot, 'session-1')?.planPath).toBe('/tmp/plan-b.md')
    // The scoped clear with the current identity works.
    const current = getPendingPlanExecution(workspaceRoot, 'session-1')?.executionId
    await clearPendingPlanExecution(workspaceRoot, 'session-1', current)
    expect(getPendingPlanExecution(workspaceRoot, 'session-1')).toBeNull()
  })

  it('strict set/claim writes reject on IO failure and report failure', async () => {
    const sessionDir = join(workspaceRoot, 'sessions', 'session-1')
    chmodSync(sessionDir, 0o555)
    try {
      await expect(setPendingPlanExecution(workspaceRoot, 'session-1', '/tmp/plan.md'))
        .rejects.toThrow()
      expect(getPendingPlanExecution(workspaceRoot, 'session-1')).toBeNull()
    } finally {
      chmodSync(sessionDir, 0o755)
    }
  })
})

// ---------------------------------------------------------------------------
// Atomic plan-draft consumption: the preparation crash boundary.
// ---------------------------------------------------------------------------

const {
  consumeSessionDraftForPlan,
  getPlanDraftConsumption,
  getSessionDraft: getPlanDraft,
  setSessionDraft: setPlanDraft,
} = await import('../../config/storage.ts')

describe('atomic plan draft consumption (crash matrix)', () => {
  let workspaceRoot: string
  let projectId: string

  beforeEach(async () => {
    workspaceRoot = makeTmpDir()
    projectId = createWorkspaceAtPath(workspaceRoot, 'Plan consumption').defaultProjectId
    const session = makeStoredSession(workspaceRoot, projectId)
    await saveSession(session)
  })

  afterEach(() => {
    if (existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('crash BEFORE the consume write: no receipt, draft intact', async () => {
    setPlanDraft('session-1', { text: 'SNAPSHOT', references: [makeReference(projectId)] })
    // (no consume call — simulated crash between prepare and consumption)
    expect(getPlanDraftConsumption('session-1', 'exec-crash')).toBeNull()
    expect(getPlanDraft('session-1')?.text).toBe('SNAPSHOT')
  })

  it('the consume write is atomic: receipt and consumed draft land together', async () => {
    const reference = makeReference(projectId)
    setPlanDraft('session-1', { text: 'SNAPSHOT', references: [reference] })
    const result = consumeSessionDraftForPlan('session-1', projectId, 'exec-atomic', { text: 'SNAPSHOT', references: [reference] })
    expect(result.receipt.text).toBe(true)
    expect(result.receipt.referenceKeys).toHaveLength(1)
    // Same drafts-file write: the draft no longer holds either component and
    // the receipt is readable — a crash between them is impossible.
    expect(getPlanDraft('session-1')?.text ?? '').toBe('')
    expect(getPlanDraftConsumption('session-1', 'exec-atomic')?.text).toBe(true)
  })

  it('partial consumption when the input changed: text stays, matching refs leave', async () => {
    const reference = makeReference(projectId)
    setPlanDraft('session-1', { text: 'EDITED-during-prepare', references: [reference] })
    const result = consumeSessionDraftForPlan('session-1', projectId, 'exec-partial', { text: 'SNAPSHOT', references: [reference] })
    expect(result.receipt.text).toBe(false)
    expect(result.receipt.referenceKeys).toHaveLength(1)
    expect(getPlanDraft('session-1')?.text).toBe('EDITED-during-prepare')
    expect(getPlanDraft('session-1')?.references ?? []).toHaveLength(0)
    expect(getPlanDraftConsumption('session-1', 'exec-partial')?.text).toBe(false)
  })

  it('duplicate consume calls are idempotent: the recorded receipt is replayed', async () => {
    setPlanDraft('session-1', { text: 'SNAPSHOT' })
    const first = consumeSessionDraftForPlan('session-1', projectId, 'exec-idem', { text: 'SNAPSHOT', references: [] })
    // A newer draft written between attempts must NOT be clobbered by replay.
    setPlanDraft('session-1', { text: 'NEWER-after-consume' })
    const second = consumeSessionDraftForPlan('session-1', projectId, 'exec-idem', { text: 'SNAPSHOT', references: [] })
    expect(second.receipt).toEqual(first.receipt)
    expect(getPlanDraft('session-1')?.text).toBe('NEWER-after-consume')
  })

  it('cross-Project snapshot references are rejected without consuming', async () => {
    setPlanDraft('session-1', { text: 'SNAPSHOT' })
    const foreign = { ...makeReference(projectId), projectId: 'other-project' }
    expect(() => consumeSessionDraftForPlan('session-1', projectId, 'exec-foreign', { text: 'SNAPSHOT', references: [foreign] }))
      .toThrow('DRAFT_REFERENCE_REJECTED')
    expect(getPlanDraft('session-1')?.text).toBe('SNAPSHOT')
    expect(getPlanDraftConsumption('session-1', 'exec-foreign')).toBeNull()
  })

  it('a strict consume IO failure rejects and consumes nothing', async () => {
    setPlanDraft('session-1', { text: 'SNAPSHOT' })
    const draftsPath = join(CONFIG_DIR, 'drafts.json')
    const draftsDirStat = statSync(draftsPath)
    expect(draftsDirStat).toBeDefined()
    // Make the drafts file unreadable/corrupt: a directory in its place makes
    // the strict read throw instead of silently reporting "unconsumed".
    rmSync(draftsPath)
    mkdirSync(draftsPath)
    try {
      expect(() => consumeSessionDraftForPlan('session-1', projectId, 'exec-io', { text: 'SNAPSHOT', references: [] })).toThrow()
      expect(() => getPlanDraftConsumption('session-1', 'exec-io')).toThrow()
    } finally {
      rmSync(draftsPath, { recursive: true, force: true })
      setPlanDraft('session-1', { text: 'SNAPSHOT' })
    }
  })
})
