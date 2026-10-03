import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Read-only review probes. Imports are actual production modules at the pinned SHA.
// All writable state belongs to this temporary fixture; no provider is called.
const repo = new URL('../../../..', import.meta.url).pathname
const profile = mkdtempSync(join(tmpdir(), 'stair-review-contract-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(join(repo, 'apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
const { SessionManager, createManagedSession } = await import(`${repo}/packages/server-core/src/sessions/SessionManager.ts`)
const { createWorkspaceAtPath } = await import(`${repo}/packages/shared/src/workspaces/index.ts`)
const { saveSession, loadSession, sessionPersistenceQueue } = await import(`${repo}/packages/shared/src/sessions/index.ts`)
const { storedToMessage } = await import(`${repo}/packages/core/src/types/index.ts`)
const observations: Record<string, unknown> = {}
afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  rmSync(profile, { recursive: true, force: true })
})

function authFixture(id: string) {
  const manager = new SessionManager()
  const managed = createManagedSession({ id, projectId: 'project-a' }, {
    id: 'workspace-a', name: 'Review', rootPath: profile,
  }, { messagesLoaded: true })
  const request = { type: 'oauth', requestId: `${id}-request`, sourceSlug: 'review-source', sourceName: 'Review Source' }
  managed.pendingAuthRequestId = request.requestId
  managed.pendingAuthRequest = request
  managed.messages.push({ id: 'auth-card', role: 'auth-request', content: 'Sign in', timestamp: 1,
    authRequestId: request.requestId, authStatus: 'pending' })
  const calls: unknown[][] = []
  ;(manager as any).sessions.set(id, managed)
  ;(manager as any).persistSession = () => {}
  ;(manager as any).sendMessage = async (...args: unknown[]) => { calls.push(args) }
  manager.setEventSink(() => {})
  return { manager, managed, request, calls }
}

test('control: matching pending auth completion resumes exactly once', async () => {
  const f = authFixture('matching-auth')
  await f.manager.completeAuthRequest(f.managed.id, { requestId: f.request.requestId, sourceSlug: f.request.sourceSlug, success: true })
  expect(f.calls).toHaveLength(1)
  expect(f.managed.messages[0].authStatus).toBe('completed')
})

test('S02: Stop while waiting for auth invalidates the late completion', async () => {
  const f = authFixture('stopped-auth')
  const epochBefore = f.managed.stopEpoch ?? 0
  await f.manager.cancelProcessing(f.managed.id)
  await f.manager.completeAuthRequest(f.managed.id, { requestId: f.request.requestId, sourceSlug: f.request.sourceSlug, success: true })
  observations.stoppedAuth = { epochBefore, epochAfter: f.managed.stopEpoch ?? 0, newTurns: f.calls, status: f.managed.messages[0].authStatus }
  expect(f.calls).toHaveLength(0)
})

test('S02: a stale auth completion cannot consume a newer pending request', async () => {
  const f = authFixture('newer-auth')
  await f.manager.completeAuthRequest(f.managed.id, { requestId: 'older-request', sourceSlug: 'older-source', success: true })
  observations.staleAuth = { expectedPending: f.request.requestId, actualPending: f.managed.pendingAuthRequestId ?? null, newTurns: f.calls }
  expect(f.managed.pendingAuthRequestId).toBe(f.request.requestId)
  expect(f.calls).toHaveLength(0)
})

test('S01: an approved plan resumes with its original references and attachment after source activation', async () => {
  const ws = join(profile, 'workspace')
  mkdirSync(ws)
  const workspace = createWorkspaceAtPath(ws, 'Review fixture')
  const manager = new SessionManager()
  const id = 'source-attachment-continuation'
  const managed = createManagedSession({ id, name: 'Existing review chat', projectId: workspace.defaultProjectId }, { ...workspace, rootPath: ws }, { messagesLoaded: true })
  ;(manager as any).sessions.set(id, managed)
  ;(manager as any).decisionFeatureActive = () => false
  manager.setEventSink(() => {})
  await saveSession({ id, name: 'Existing review chat', workspaceRootPath: ws, projectId: managed.projectId, createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
  const plan = { id: 'source-activation-plan', role: 'plan' as const, content: '# Source activation plan', planPath: '/activation.md', timestamp: 1 }
  managed.messages.push(plan)
  const reference = { version: 1 as const, kind: 'web-selection' as const, projectId: managed.projectId, url: 'https://example.test/activation',
    title: 'Activation context', quote: 'ACTIVATION-REF', locator: { type: 'web-text-quote' as const, exact: 'ACTIVATION-REF' } }
  const attachmentPath = join(ws, 'review-attachment.txt')
  writeFileSync(attachmentPath, 'REVIEW-ATTACHMENT-CONTENT')
  const attachments = [{ name: 'review-attachment.txt', type: 'text', mimeType: 'text/plain', size: 25,
    text: 'REVIEW-ATTACHMENT-CONTENT', path: attachmentPath, storedPath: attachmentPath }]
  const stored = [{ id: 'review-attachment', name: 'review-attachment.txt', type: 'text', mimeType: 'text/plain', size: 25, storedPath: attachmentPath }]
  const calls: { text: string; attachments: unknown }[] = []
  const agent = {
    getModel: () => 'no-model', setAllSources() {}, setSourceServers: async () => {},
    getSessionId: () => undefined, isCompactionInFlight: () => false, forceAbort() {},
    chat: (text: string, files: unknown) => {
      calls.push({ text, attachments: files ?? null })
      const first = calls.length === 1
      return (async function* () {
        yield { type: 'input_accepted' }
        if (first) yield { type: 'source_activated', sourceSlug: 'review-source', originalMessage: text }
        yield { type: 'complete' }
      })()
    },
  }
  ;(manager as any).getOrCreateAgent = async () => { managed.agent = agent; return agent }
  try {
    await manager.sendMessage(id, 'Read the attached review marker', attachments, stored, { approvedPlanMessageId: plan.id, references: [reference] })
    for (let i = 0; i < 400 && (calls.length < 2 || managed.isProcessing); i++) await Bun.sleep(5)
    await manager.flushSession(id)
    observations.sourceActivation = { calls, persistedUsers: loadSession(ws, id)?.messages.map(storedToMessage).filter((m: any) => m.role === 'user') }
    expect(calls).toHaveLength(2)
    expect(calls[0].attachments).toEqual(attachments)
    expect(calls[1].attachments).toEqual(attachments)
    expect(calls[1].text).toContain('ACTIVATION-REF')
    expect(managed.messages.filter((message: any) => message.approvedPlanMessageId === plan.id)).toHaveLength(1)
  } finally {
    if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
    managed.autoRetryPending = undefined
    managed.pendingActivationResend = undefined
    await sessionPersistenceQueue.flushAll()
  }
}, 15000)
