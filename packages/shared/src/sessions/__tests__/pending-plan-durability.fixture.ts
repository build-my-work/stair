import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PendingPlanExecutionRecord, StoredSession } from '../types.ts'

const configDir = mkdtempSync(join(tmpdir(), 'pending-plan-durability-profile-'))
process.env.CRAFT_CONFIG_DIR = configDir
afterAll(() => rmSync(configDir, { recursive: true, force: true }))
copyFileSync(
  resolve(import.meta.dir, '../../../../../apps/electron/resources/config-defaults.json'),
  join(configDir, 'config-defaults.json'),
)
const { CONFIG_DIR } = await import('../../config/paths.ts')
if (CONFIG_DIR !== configDir) throw new Error('Pending-plan durability fixture requires an isolated config module cache')
const { createWorkspaceAtPath } = await import('../../workspaces/storage.ts')
const { sessionPersistenceQueue } = await import('../persistence-queue.ts')
const {
  clearPendingPlanExecution,
  getSessionFilePath,
  loadSession,
  markCompactionComplete,
  markPendingPlanExecutionDispatched,
  saveSessionStrict,
  setPendingPlanExecution,
} = await import('../storage.ts')

describe('pending-plan transactions preserve debounced history', () => {
  let workspaceRoot: string
  let session: StoredSession

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'pending-plan-durability-workspace-'))
    const projectId = createWorkspaceAtPath(workspaceRoot, 'Pending-plan durability').defaultProjectId
    session = {
      id: `pending-plan-${randomUUID()}`,
      workspaceRootPath: workspaceRoot,
      projectId,
      createdAt: 1,
      lastUsedAt: 1,
      messages: [{ id: 'old', type: 'user', content: 'already persisted', timestamp: 1 }],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    await saveSessionStrict(session)
  })

  afterEach(async () => {
    await sessionPersistenceQueue.flush(session.id)
    sessionPersistenceQueue.cancel(session.id)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  async function seedPending(record: PendingPlanExecutionRecord) {
    session.pendingPlanExecution = record
    await saveSessionStrict(session)
  }

  function enqueueNewerHistory() {
    session.messages.push({ id: 'new', type: 'assistant', content: 'still debounced', timestamp: 2 })
    session.tokenUsage.outputTokens = 17
    sessionPersistenceQueue.enqueue(session)
    expect(sessionPersistenceQueue.hasPending(session.id)).toBe(true)
    expect(loadSession(workspaceRoot, session.id)?.messages.map(message => message.id)).toEqual(['old'])
  }

  function expectNewerHistoryPersisted() {
    const stored = loadSession(workspaceRoot, session.id)!
    expect(stored.messages.map(message => message.id)).toEqual(['old', 'new'])
    expect(stored.tokenUsage.outputTokens).toBe(17)
    expect(sessionPersistenceQueue.hasPending(session.id)).toBe(false)
    return stored
  }

  it('set preserves the newer debounced messages and token usage', async () => {
    enqueueNewerHistory()
    const record = await setPendingPlanExecution(workspaceRoot, session.id, '/tmp/plan.md')
    expect(record?.executionId).toBeDefined()
    expect(expectNewerHistoryPersisted().pendingPlanExecution?.executionId).toBe(record?.executionId)
  })

  it('compaction completion preserves the newer debounced messages', async () => {
    await seedPending({
      planPath: '/tmp/plan.md',
      executionId: 'modern',
      awaitingCompaction: true,
      compactionTurn: { generation: 7, stopEpoch: 3 },
    })
    enqueueNewerHistory()
    expect(await markCompactionComplete(workspaceRoot, session.id, { generation: 7, stopEpoch: 3 })).toBe(true)
    expect(expectNewerHistoryPersisted().pendingPlanExecution?.awaitingCompaction).toBe(false)
  })

  it('legacy dispatch claim preserves the newer debounced messages', async () => {
    await seedPending({ planPath: '/tmp/legacy.md', awaitingCompaction: false, executionDispatched: false })
    enqueueNewerHistory()
    expect(await markPendingPlanExecutionDispatched(workspaceRoot, session.id)).toBe(true)
    expect(expectNewerHistoryPersisted().pendingPlanExecution?.executionDispatched).toBe(true)
  })

  it('scoped clear preserves the newer debounced messages', async () => {
    await seedPending({ planPath: '/tmp/plan.md', executionId: 'modern', awaitingCompaction: true })
    enqueueNewerHistory()
    await clearPendingPlanExecution(workspaceRoot, session.id, 'modern')
    expect(expectNewerHistoryPersisted().pendingPlanExecution).toBeUndefined()
  })

  it('a failed strict history flush rejects before preparing a record', async () => {
    enqueueNewerHistory()
    const path = getSessionFilePath(workspaceRoot, session.id)
    const before = readFileSync(path, 'utf8')
    mkdirSync(`${path}.tmp`)
    try {
      await expect(setPendingPlanExecution(workspaceRoot, session.id, '/tmp/plan.md')).rejects.toThrow()
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(loadSession(workspaceRoot, session.id)?.pendingPlanExecution).toBeUndefined()
      // A failed transaction must not replace the live queued data with the
      // older disk snapshot. Retrying that live data restores its history.
      rmSync(`${path}.tmp`, { recursive: true })
      sessionPersistenceQueue.enqueue(session)
      await sessionPersistenceQueue.flush(session.id, { strict: true })
      expectNewerHistoryPersisted()
      await expect(setPendingPlanExecution(workspaceRoot, session.id, '/tmp/plan.md')).resolves.toBeDefined()
    } finally {
      rmSync(`${path}.tmp`, { recursive: true, force: true })
    }
  })

  it('clear rejects when its own durable write fails and leaves the stored record intact', async () => {
    await seedPending({ planPath: '/tmp/plan.md', executionId: 'modern', awaitingCompaction: true })
    const path = getSessionFilePath(workspaceRoot, session.id)
    const before = readFileSync(path, 'utf8')
    mkdirSync(`${path}.tmp`)
    try {
      await expect(clearPendingPlanExecution(workspaceRoot, session.id, 'modern')).rejects.toThrow()
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(loadSession(workspaceRoot, session.id)?.pendingPlanExecution?.executionId).toBe('modern')
    } finally {
      rmSync(`${path}.tmp`, { recursive: true, force: true })
    }
  })

  it('stores reference-validation provenance only on an explicit server acceptance', async () => {
    const unvalidated = await setPendingPlanExecution(workspaceRoot, session.id, '/tmp/plan.md', undefined, undefined, 'Accept')
    expect(unvalidated).not.toHaveProperty('referencesValidated')
    const rejectedMarker = await setPendingPlanExecution(workspaceRoot, session.id, '/tmp/plan.md', undefined, undefined, 'Accept', false)
    expect(rejectedMarker).not.toHaveProperty('referencesValidated')
    const accepted = await setPendingPlanExecution(workspaceRoot, session.id, '/tmp/plan.md', undefined, undefined, 'Accept', true)
    expect(accepted?.referencesValidated).toBe(true)
    expect(loadSession(workspaceRoot, session.id)?.pendingPlanExecution?.referencesValidated).toBe(true)
    expect(accepted?.approvalMessage).toBe('Accept')
  })
})
