import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { StoredSession } from '../../../shared/src/sessions/types.ts'

if (process.env.CRAFT_METADATA_DURABILITY_TEST_CHILD !== '1') throw new Error('metadata fixture requires isolated entry')
const profile = mkdtempSync(join(tmpdir(), 'stair-metadata-profile-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(join(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
const { CONFIG_DIR } = await import('../../../shared/src/config/paths.ts')
if (CONFIG_DIR !== profile) throw new Error('metadata fixture requires an isolated config cache')
const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { createWorkspaceAtPath } = await import('../../../shared/src/workspaces/storage.ts')
const { saveSessionStrict, loadSession, sessionPersistenceQueue, updateSessionMetadata, updateSessionSdkId, clearSessionMessages } = await import('../../../shared/src/sessions/index.ts')
const { setSessionDraft, getSessionDraft } = await import('../../../shared/src/config/storage.ts')
const { SessionPersistenceQueue } = await import('../../../shared/src/sessions/persistence-queue.ts')
const roots: string[] = []
afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'stair-metadata-workspace-'))
  roots.push(root)
  const workspace = { ...createWorkspaceAtPath(root, 'Metadata durability'), rootPath: root }
  const id = `metadata-${randomUUID()}`
  const sm = new SessionManager()
  const managed = createManagedSession({ id, name: 'Review', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
  Reflect.get(sm, 'sessions').set(id, managed)
  Reflect.set(sm, 'processNextQueuedMessage', () => {})
  sm.setEventSink(() => {})
  await saveSessionStrict({ id, name: 'Review', projectId: managed.projectId, workspaceRootPath: root, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
  return { sm, managed, root, workspace, id }
}

test.each(['unread', 'model', 'sdk id', 'clear messages'] as const)('%s cannot erase an in-flight prepared plan before draft consumption', async kind => {
  const f = await setup()
  const text = 'RECOVERABLE-METADATA-DRAFT'
  setSessionDraft(f.id, { text })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = Reflect.get(sessionPersistenceQueue, 'performWrite')
  let gated = false
  Reflect.set(sessionPersistenceQueue, 'performWrite', async function (this: unknown, sessionId: string, entry: { data: StoredSession }) {
    if (sessionId === f.id && !gated && entry.data.pendingPlanExecution?.planPath === '/accepted.md') {
      gated = true
      entered.resolve()
      await release.promise
    }
    return original.call(this, sessionId, entry)
  })
  try {
    const preparing = f.sm.setPendingPlanExecution(f.id, '/accepted.md', text)
    await entered.promise
    const metadata = kind === 'unread' ? f.sm.markSessionUnread(f.id)
      : kind === 'model' ? f.sm.updateSessionModel(f.id, f.workspace.id, 'claude-sonnet-4-6')
      : kind === 'sdk id' ? updateSessionSdkId(f.root, f.id, 'new-sdk-id')
      : clearSessionMessages(f.root, f.id)
    release.resolve()
    const [record] = await Promise.all([preparing, metadata])
    expect(loadSession(f.root, f.id)?.pendingPlanExecution?.executionId).toBe(record.executionId)
    const receipt = await f.sm.consumePendingPlanDraft(f.id, record.executionId!)
    expect(receipt?.receipt.text).toBe(true)
    expect(getSessionDraft(f.id)).toBeNull()
    const cold = new SessionManager()
    const restored = createManagedSession({ id: f.id, projectId: f.managed.projectId }, f.workspace, { messagesLoaded: false })
    Reflect.get(cold, 'sessions').set(f.id, restored)
    Reflect.set(cold, 'processNextQueuedMessage', () => {})
    await Reflect.get(cold, 'ensureMessagesLoaded').call(cold, restored)
    expect(cold.getPendingPlanExecution(f.id)?.executionId).toBe(record.executionId)
  } finally {
    release.resolve()
    Reflect.set(sessionPersistenceQueue, 'performWrite', original)
    await sessionPersistenceQueue.flush(f.id)
  }
}, 5_000)

test('concurrent metadata updates retain both fields and the latest queued messages', async () => {
  const f = await setup()
  const latest = loadSession(f.root, f.id)!
  latest.messages = [{ id: 'latest', type: 'user', content: 'LATEST-MESSAGE', timestamp: 2 }]
  latest.tokenUsage.inputTokens = 123
  sessionPersistenceQueue.enqueue(latest)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = Reflect.get(sessionPersistenceQueue, 'performWrite')
  let gated = false
  Reflect.set(sessionPersistenceQueue, 'performWrite', async function (this: unknown, sessionId: string, entry: { data: StoredSession }) {
    if (sessionId === f.id && !gated && entry.data.name === 'UPDATED-NAME') {
      gated = true
      entered.resolve()
      await release.promise
    }
    return original.call(this, sessionId, entry)
  })
  try {
    const name = updateSessionMetadata(f.root, f.id, { name: 'UPDATED-NAME' })
    await entered.promise
    const labels = updateSessionMetadata(f.root, f.id, { labels: ['important'] })
    release.resolve()
    await Promise.all([name, labels])
    const stored = loadSession(f.root, f.id)!
    expect(stored.name).toBe('UPDATED-NAME')
    expect(stored.labels).toEqual(['important'])
    expect(stored.messages).toEqual(latest.messages)
    expect(stored.tokenUsage.inputTokens).toBe(123)
  } finally {
    release.resolve()
    Reflect.set(sessionPersistenceQueue, 'performWrite', original)
    await sessionPersistenceQueue.flush(f.id)
  }
}, 5_000)

test('resetting the session model also clears the durable override', async () => {
  const f = await setup()
  await f.sm.updateSessionModel(f.id, f.workspace.id, 'claude-sonnet-4-6')
  await f.sm.updateSessionModel(f.id, f.workspace.id, null)
  expect(f.managed.model).toBeUndefined()
  expect(loadSession(f.root, f.id)?.model).toBeUndefined()
})

test('shutdown flush waits for a write already taken out of the pending queue', async () => {
  const f = await setup()
  const queue = new SessionPersistenceQueue()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = Reflect.get(queue, 'performWrite')
  Reflect.set(queue, 'performWrite', async function (this: unknown, id: string, entry: { data: StoredSession }) {
    entered.resolve()
    await release.promise
    return original.call(this, id, entry)
  })
  const latest = loadSession(f.root, f.id)!
  latest.name = 'LATEST-BEFORE-QUIT'
  queue.enqueue(latest)
  const writing = queue.flush(f.id)
  await entered.promise
  let completed = false
  const shutdown = queue.flushAll().then(() => { completed = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    expect(queue.hasPending(f.id)).toBe(false)
    expect(completed).toBe(false)
  } finally {
    release.resolve()
    await Promise.all([writing, shutdown])
  }
  expect(loadSession(f.root, f.id)?.name).toBe('LATEST-BEFORE-QUIT')
})
