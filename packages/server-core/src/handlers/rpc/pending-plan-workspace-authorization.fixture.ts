import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Reference } from '../../../../core/src/index.ts'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/index.ts'
import type { HandlerDeps } from '../handler-deps.ts'
import type { SessionCommand } from '../../../../shared/src/protocol/dto.ts'

if (process.env.CRAFT_PENDING_PLAN_WORKSPACE_TEST_CHILD !== '1') {
  throw new Error('pending-plan Workspace fixture requires its isolated test entry')
}
const profile = mkdtempSync(join(tmpdir(), 'stair-plan-workspace-profile-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(
  join(import.meta.dir, '../../../../../apps/electron/resources/config-defaults.json'),
  join(profile, 'config-defaults.json'),
)
const { CONFIG_DIR } = await import('../../../../shared/src/config/paths.ts')
if (CONFIG_DIR !== profile) throw new Error('pending-plan Workspace fixture requires an isolated config module cache')
const { SessionManager, createManagedSession } = await import('../../sessions/SessionManager.ts')
const { createWorkspaceAtPath } = await import('../../../../shared/src/workspaces/storage.ts')
const { saveSessionStrict, loadSession, sessionPersistenceQueue } = await import('../../../../shared/src/sessions/index.ts')
const { setSessionDraft, getSessionDraft } = await import('../../../../shared/src/config/storage.ts')
const { RPC_CHANNELS } = await import('../../../../shared/src/protocol/index.ts')
const { registerSessionsHandlers } = await import('./sessions.ts')
const { registerSettingsHandlers } = await import('./settings.ts')

type Managed = ReturnType<typeof createManagedSession>
const workspaces: string[] = []
afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  for (const root of workspaces) rmSync(root, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
})

function workspace(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'stair-plan-workspace-scope-'))
  workspaces.push(root)
  return { ...createWorkspaceAtPath(root, name), rootPath: root }
}
const foreignWorkspace = workspace('Other Workspace')
const foreignContext: RequestContext = { clientId: 'foreign-client', workspaceId: foreignWorkspace.id, webContentsId: null }
const accessDenied = /^DRAFT_SESSION_ACCESS_DENIED:/

async function setup() {
  const owner = workspace('Pending-plan owner')
  const sm = new SessionManager()
  const id = `workspace-scope-${randomUUID()}`
  const managed = createManagedSession({ id, name: 'Review', projectId: owner.defaultProjectId }, owner, { messagesLoaded: true })
  ;(sm as unknown as { sessions: Map<string, Managed> }).sessions.set(id, managed)
  ;(sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}
  sm.setEventSink(() => {})
  await saveSessionStrict({
    id, name: 'Review', projectId: managed.projectId, workspaceRootPath: owner.rootPath,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  } as never)
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler),
    push: () => {}, invokeClient: async () => undefined,
    hasClientCapability: () => false, findClientsWithCapability: () => [],
  } as unknown as RpcServer
  const deps = { sessionManager: sm, oauthFlowStore: {}, platform: { logger: console } } as unknown as HandlerDeps
  registerSessionsHandlers(server, deps)
  registerSettingsHandlers(server, deps)
  const ownContext: RequestContext = { clientId: 'owner-client', workspaceId: owner.id, webContentsId: null }
  const invoke = (ctx: RequestContext, command: SessionCommand) => handlers.get(RPC_CHANNELS.sessions.COMMAND)!(ctx, id, command)
  const text = 'OWNED-WORKSPACE-DRAFT'
  const reference: Reference = { version: 1, kind: 'web-selection', projectId: managed.projectId,
    url: 'https://example.test', title: 'Review source', quote: 'OWNED-QUOTE',
    locator: { type: 'web-text-quote', exact: 'OWNED-QUOTE' } }
  setSessionDraft(id, { text, references: [reference] })
  const prepared = await sm.setPendingPlanExecution(id, '/accepted.md', text, [reference])
  return { sm, managed, owner, handlers, ownContext, invoke, prepared, text, reference }
}

test('pending GET rejects another Workspace without exposing the acceptance snapshot', async () => {
  const f = await setup()
  await expect(f.handlers.get(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION)!(foreignContext, f.managed.id))
    .rejects.toThrow(accessDenied)
})

test('pending prepare rejects another Workspace before replacing its acceptance', async () => {
  const f = await setup()
  await expect(f.invoke(foreignContext, { type: 'setPendingPlanExecution', planPath: '/foreign.md', draftInputSnapshot: 'FOREIGN' }))
    .rejects.toThrow(accessDenied)
  expect(f.managed.pendingPlanExecution?.executionId).toBe(f.prepared.executionId)
  expect(loadSession(f.owner.rootPath, f.managed.id)?.pendingPlanExecution?.executionId).toBe(f.prepared.executionId)
})

test('atomic consumption cannot bypass the ordinary draft RPC Workspace boundary', async () => {
  const f = await setup()
  await expect(f.handlers.get(RPC_CHANNELS.drafts.SET_CONTENT)!(foreignContext, f.managed.id, { text: 'FOREIGN' }))
    .rejects.toThrow(accessDenied)
  await expect(f.invoke(foreignContext, { type: 'consumePendingPlanDraft', executionId: f.prepared.executionId! }))
    .rejects.toThrow(accessDenied)
  expect(getSessionDraft(f.managed.id)).toEqual({ text: f.text, references: [f.reference] })
})

test('pending dispatch cannot execute another Workspace acceptance', async () => {
  const f = await setup()
  const turn = { generation: f.managed.processingGeneration, stopEpoch: f.managed.stopEpoch ?? 0 }
  f.managed.pendingPlanExecution!.compactionTurn = turn
  const before = loadSession(f.owner.rootPath, f.managed.id)!
  before.pendingPlanExecution = f.managed.pendingPlanExecution
  await saveSessionStrict(before)
  expect(await f.sm.markCompactionComplete(f.managed.id, f.prepared.executionId, turn)).toBe(true)
  await expect(f.invoke(foreignContext, { type: 'dispatchPendingPlanExecution', executionId: f.prepared.executionId }))
    .rejects.toThrow(accessDenied)
  expect(f.managed.messageQueue).toHaveLength(0)
  expect(f.managed.pendingPlanExecution?.executionDispatched).toBe(false)
})

test('pending clear cannot erase another Workspace acceptance', async () => {
  const f = await setup()
  await expect(f.invoke(foreignContext, { type: 'clearPendingPlanExecution', executionId: f.prepared.executionId }))
    .rejects.toThrow(accessDenied)
  expect(f.managed.pendingPlanExecution?.executionId).toBe(f.prepared.executionId)
  expect(loadSession(f.owner.rootPath, f.managed.id)?.pendingPlanExecution?.executionId).toBe(f.prepared.executionId)
})

test('an absent Workspace never authorizes draft consumption', async () => {
  const f = await setup()
  await expect(f.invoke({ ...f.ownContext, workspaceId: null }, { type: 'consumePendingPlanDraft', executionId: f.prepared.executionId! }))
    .rejects.toThrow(/^DRAFT_WORKSPACE_REQUIRED:/)
  expect(getSessionDraft(f.managed.id)?.text).toBe(f.text)
})

test('the owning Workspace can prepare, consume, cancel, restore and ACK through real RPC handlers', async () => {
  const f = await setup()
  // Replace the unconsumed fixture preparation through the real command.
  const prepared = await f.invoke(f.ownContext, { type: 'setPendingPlanExecution', planPath: '/owned.md', draftInputSnapshot: f.text, draftReferencesSnapshot: [f.reference] }) as typeof f.prepared
  const pending = await f.handlers.get(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION)!(f.ownContext, f.managed.id) as ReturnType<typeof f.sm.getPendingPlanExecution>
  expect(pending?.executionId).toBe(prepared.executionId)
  const consumed = await f.invoke(f.ownContext, { type: 'consumePendingPlanDraft', executionId: prepared.executionId! }) as Awaited<ReturnType<typeof f.sm.consumePendingPlanDraft>>
  expect(consumed?.receipt.text).toBe(true)
  expect(consumed?.receipt.referenceKeys).toHaveLength(1)
  expect(getSessionDraft(f.managed.id)).toBeNull()
  await f.invoke(f.ownContext, { type: 'clearPendingPlanExecution', executionId: prepared.executionId })
  const failed = f.sm.getPendingPlanExecution(f.managed.id)!
  expect(failed.failed).toBe(true)
  await f.handlers.get(RPC_CHANNELS.drafts.RESTORE_INPUT)!(f.ownContext, f.managed.id, {
    restoreId: failed.restoreId, planExecutionId: prepared.executionId,
    draft: { text: 'CLIENT-SUPPLIED-SNAPSHOT-IS-NOT-AUTHORITATIVE' },
  })
  await f.invoke(f.ownContext, { type: 'clearPendingPlanExecution', executionId: prepared.executionId })
  expect(f.sm.getPendingPlanExecution(f.managed.id)).toBeNull()
  expect(getSessionDraft(f.managed.id)).toEqual({ text: f.text, references: [f.reference] })
})
