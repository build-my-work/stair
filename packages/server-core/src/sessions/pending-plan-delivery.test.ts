import { test, expect, afterAll } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@craft-agent/core/types'

// Delivery regressions for the durably accepted plan approval, ported from
// the workbench continuation-handoff review plus the two correction-B cases:
// the delivery tracker must survive EVERY pre-turn await (agent construction,
// source servers, pre-turn decisions) and only end at the real execution
// boundary — the producer's input_accepted proof. A crash before that
// re-queues the approval once by its stable message id (no duplicate bubble);
// a Stop/delete in the pre-turn window cancels without executing.
const profile = mkdtempSync(join(tmpdir(), 'stair-plan-delivery-profile-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(join(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))

const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSession, loadSession, listSessions, getPendingPlanExecution, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { setSessionDraft, getPlanDraftConsumption } = await import('@craft-agent/shared/config')
const { PendingSteers } = await import('@craft-agent/shared/agent/backend/claude/pending-steers')

const workspaces: string[] = []
afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  for (const ws of workspaces.splice(0)) rmSync(ws, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function setup(id: string) {
  const ws = mkdtempSync(join(tmpdir(), 'stair-plan-delivery-ws-'))
  workspaces.push(ws)
  const workspace = createWorkspaceAtPath(ws, 'Isolated review')
  const sm = new SessionManager()
  const managed = createManagedSession({ id, name: 'Existing chat', projectId: workspace.defaultProjectId }, { ...workspace, rootPath: ws }, { messagesLoaded: true })
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  // Forbid every model-backed decision/title path in these diagnostics.
  ;(sm as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
  await saveSession({ id, name: 'Existing chat', workspaceRootPath: ws, projectId: managed.projectId, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as never)
  return { sm, managed, ws, workspace }
}

async function ready(sm: InstanceType<typeof SessionManager>, managed: ReturnType<typeof createManagedSession>, ws: string) {
  await sm.setPendingPlanExecution(managed.id, '/plan.md', 'additional detail')
  // The real flow atomically consumes the draft BEFORE the /compact is
  // submitted; the consumption receipt is what ties the compact to THIS
  // record and gates text restoration.
  setSessionDraft(managed.id, { text: 'additional detail' })
  const consumed = await sm.consumePendingPlanDraft(managed.id, managed.pendingPlanExecution!.executionId!)
  expect(consumed?.receipt.text).toBe(true)
  managed.pendingPlanExecution!.compactionTurn = { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
  const stored = loadSession(ws, managed.id)!
  stored.pendingPlanExecution = managed.pendingPlanExecution as never
  await saveSession(stored)
  expect(await sm.markCompactionComplete(managed.id, managed.pendingPlanExecution!.executionId)).toBe(true)
}

/** Cold-reload the persisted image into a fresh SM with sendMessage spied. */
function coldRestore(ws: string, workspace: unknown, id: string) {
  const restoredSM = new SessionManager()
  const restored = createManagedSession(listSessions(ws).find(m => m.id === id)!, { ...(workspace as object), rootPath: ws } as never, {})
  ;(restoredSM as unknown as { sessions: Map<string, unknown> }).sessions.set(id, restored)
  ;(restoredSM as unknown as { decisionFeatureActive: () => boolean }).decisionFeatureActive = () => false
  const sends: string[] = []
  restoredSM.sendMessage = (async (_id: string, message: string) => { sends.push(message) }) as never
  return { restoredSM, restored, sends }
}

test('cold ready pending record can dispatch before explicit message hydration', async () => {
  const { sm, managed, ws, workspace } = await setup('cold-ready')
  await ready(sm, managed, ws)
  const { restoredSM, sends } = coldRestore(ws, workspace, managed.id)
  const pending = restoredSM.getPendingPlanExecution(managed.id)
  expect(pending?.awaitingCompaction).toBe(false)
  const dispatched = await restoredSM.dispatchPendingPlanExecution(managed.id, pending?.executionId)
  await sleep(30)
  expect(dispatched).toEqual({ ok: true })
  expect(sends).toHaveLength(1)
})

test('accepted approval remains crash recoverable while backend initialization stalls', async () => {
  const { sm, managed, ws, workspace } = await setup('approval-init-stall')
  await ready(sm, managed, ws)
  // A slow backend startup: the real sendMessage runs, but the creation seam
  // never completes — no model or credential path can be entered.
  let entered = false
  ;(sm as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
    entered = true
    return await new Promise(() => {})
  }
  const result = await sm.dispatchPendingPlanExecution(managed.id, managed.pendingPlanExecution?.executionId)
  expect(result).toEqual({ ok: true })
  await sleep(30)
  expect(entered).toBe(true)
  // A real editable metadata action while startup waits forces the live
  // snapshot to disk (the same operation the UI can invoke during startup).
  await sm.renameSession(managed.id, 'Renamed while backend is starting')
  await sm.flushSession(managed.id)
  const crashImage = loadSession(ws, managed.id)!
  const approval = crashImage.messages.find((m: { type?: string }) => m.type === 'user')
  // The approval is durably tracked (record alive, not handed off): a crash
  // here MUST leave a recoverable delivery state.
  expect(approval?.id).toBe(managed.pendingPlanExecution?.approvalMessageId)
  expect(crashImage.pendingPlanExecution?.approvalMessageId).toBe(approval?.id)

  const { restoredSM, sends } = coldRestore(ws, workspace, managed.id)
  await (restoredSM as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(coldRestoreRestored(restoredSM, managed.id))
  await sleep(30)
  // Recovered EXACTLY once, by the stable approval id (no duplicate bubble).
  expect(sends).toHaveLength(1)
  const again = loadSession(ws, managed.id)!
  expect(again.messages.filter((m: { type?: string }) => m.type === 'user')).toHaveLength(1)
})

test('pre-turn decision awaits do not destroy the delivery tracker', async () => {
  const { sm, managed, ws, workspace } = await setup('approval-preturn-stall')
  await ready(sm, managed, ws)
  // Backend constructs immediately; the pre-turn decision seam blocks BEFORE
  // agent.chat is ever called.
  ;(sm as unknown as { getOrCreateAgent: () => Promise<{}> }).getOrCreateAgent = async () => ({}) as never
  let chatCalls = 0
  ;(sm as unknown as { startPreTurnDecisions: () => Promise<never> }).startPreTurnDecisions = async () => await new Promise(() => {})
  const originalChat = (sm as unknown as { chatSpy?: unknown }).chatSpy
  void originalChat
  // Block agent.chat by making the agent stub's chat a gated generator.
  const agentStub = {
    getModel: () => 'stub',
    setAllSources: () => {},
    setSourceServers: async () => {},
    getSessionId: () => 'sdk-session',
    chat: () => { chatCalls++; return (async function* () { await new Promise(() => {}) })() },
  }
  ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => agentStub as never
  const result = await sm.dispatchPendingPlanExecution(managed.id, managed.pendingPlanExecution?.executionId)
  expect(result).toEqual({ ok: true })
  await sleep(30)
  expect(chatCalls).toBe(0) // still waiting in pre-turn decisions

  await sm.renameSession(managed.id, 'Renamed while pre-turn decisions run')
  await sm.flushSession(managed.id)
  const crashImage = loadSession(ws, managed.id)!
  expect(crashImage.pendingPlanExecution?.approvalMessageId).toBeDefined()

  const { restoredSM, restored, sends } = coldRestore(ws, workspace, managed.id)
  await (restoredSM as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(restored)
  await sleep(30)
  expect(sends).toHaveLength(1)
  expect(loadSession(ws, managed.id)!.messages.filter((m: { type?: string }) => m.type === 'user')).toHaveLength(1)
  void sm
})

test('a blocked first iterator delivery keeps the approval recoverable until real execution', async () => {
  const { sm, managed, ws, workspace } = await setup('approval-iterator-stall')
  await ready(sm, managed, ws)
  let releaseFirst!: () => void
  const firstNextGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const statusDelivered = Promise.withResolvers<void>()
  const acceptanceGate = Promise.withResolvers<void>()
  const acceptanceDelivered = Promise.withResolvers<void>()
  let chatStarted = false
  const agentStub = {
    getModel: () => 'stub',
    setAllSources: () => {},
    setSourceServers: async () => {},
    getSessionId: () => 'sdk-session',
    chat: () => {
      chatStarted = true
      return (async function* (): AsyncGenerator<AgentEvent> {
        await firstNextGate // first iterator delivery pending: no backend event
        yield { type: 'status', message: 'started' }
        statusDelivered.resolve()
        await acceptanceGate.promise
        yield { type: 'input_accepted' }
        acceptanceDelivered.resolve()
        yield { type: 'complete' }
      })()
    },
  }
  ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => agentStub as never
  const result = await sm.dispatchPendingPlanExecution(managed.id, managed.pendingPlanExecution?.executionId)
  expect(result).toEqual({ ok: true })
  const executionId = managed.pendingPlanExecution!.executionId!
  const approvalMessageId = managed.pendingPlanExecution!.approvalMessageId!
  await sleep(30)
  expect(chatStarted).toBe(true)
  // The tracker must STILL be alive: no event has arrived, so the backend has
  // not demonstrably begun executing.
  await sm.renameSession(managed.id, 'Renamed while first delivery pends')
  await sm.flushSession(managed.id)
  expect(loadSession(ws, managed.id)!.pendingPlanExecution?.approvalMessageId).toBeDefined()

  const { restoredSM, restored, sends } = coldRestore(ws, workspace, managed.id)
  await (restoredSM as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(restored)
  await sleep(30)
  expect(sends).toHaveLength(1)

  // Status alone is not producer acceptance: the live and durable outbox
  // must remain recoverable until the explicit proof arrives.
  releaseFirst()
  await statusDelivered.promise
  await sm.flushSession(managed.id)
  expect(sm.getPendingPlanExecution(managed.id)?.approvalMessageId).toBe(approvalMessageId)
  expect(loadSession(ws, managed.id)!.pendingPlanExecution?.approvalMessageId).toBe(approvalMessageId)
  expect(getPlanDraftConsumption(managed.id, executionId)?.text).toBe(true)

  acceptanceGate.resolve()
  await acceptanceDelivered.promise
  await sm.flushSession(managed.id)
  expect(sm.getPendingPlanExecution(managed.id)).toBeNull()
  const after = loadSession(ws, managed.id)!
  expect(after.pendingPlanExecution).toBeUndefined()
  expect(getPlanDraftConsumption(managed.id, executionId)).toBeNull()
  expect(after.messages.filter((m: { type?: string }) => m.type === 'user')).toHaveLength(1)
  const deliveredReload = coldRestore(ws, workspace, managed.id)
  await (deliveredReload.restoredSM as unknown as { ensureMessagesLoaded: (m: unknown) => Promise<void> }).ensureMessagesLoaded(deliveredReload.restored)
  await sleep(30)
  expect(deliveredReload.sends).toHaveLength(0)
  void restoredSM
})

test('accepted steer recovery does not suppress the interrupted original continuation', async () => {
  const { sm, managed, ws } = await setup('steer-recovery')
  managed.messages.push({ id: 'original', role: 'user', content: 'Find open issues and explain them', timestamp: 1 } as never)
  managed.lastSentMessage = 'Find open issues and explain them'
  managed.lastSentMessageIds = ['original']
  managed.processingGeneration = 7
  managed.isProcessing = true
  const pendingSteers = new PendingSteers()
  const sends: string[] = []
  // Queue replay is the production send path; stop it at backend creation,
  // before any real provider is contacted.
  ;(sm as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
    sends.push(managed.lastSentMessage!)
    return await new Promise(() => {})
  }
  managed.agent = {
    redirect: (message: string, metadata: Record<string, unknown>) => pendingSteers.enqueue({ message, ...metadata } as never),
    takePendingSteers: () => pendingSteers.drain(),
    isCompactionInFlight: () => false,
  } as never
  let release!: () => void
  const waitForSteer = new Promise<void>(r => { release = r })
  const backend = (async function* () {
    await waitForSteer
    yield { type: 'source_activated', sourceSlug: 'github', originalMessage: managed.lastSentMessage! } as never
  })()
  const draining = (async () => {
    for await (const event of pendingSteers.runTurn(backend)) {
      await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, event)
    }
    await (sm as unknown as { onProcessingStopped: (id: string, r: string) => Promise<void> }).onProcessingStopped(managed.id, 'interrupted')
  })()
  await sleep(1)
  await sm.sendMessage(managed.id, 'Use Chinese')
  expect(managed.turnSteers).toEqual(['Use Chinese'])
  release()
  await draining
  await sleep(180)
  // ONE coherent continuation: the original request plus the accepted steer.
  expect(sends.some(text => text.includes('Find open issues and explain them') && text.includes('Use Chinese'))).toBe(true)
})

test('server pending-plan dispatch retains caller browser routing', async () => {
  const { sm, managed, ws, workspace } = await setup('approval-browser-host')
  await ready(sm, managed, ws)
  const { registerSessionsHandlers } = await import('../handlers/rpc/sessions')
  const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
  const handlers = new Map<string, (ctx: unknown, ...args: unknown[]) => Promise<unknown>>()
  const server = {
    handle: (channel: string, handler: (ctx: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler),
    hasClientCapability: (id: string) => ['first-desktop', 'approving-desktop'].includes(id),
    findClientsWithCapability: () => ['first-desktop', 'approving-desktop'],
  }
  sm.setRpcServer(server as never)
  registerSessionsHandlers(server as never, { sessionManager: sm, platform: { logger: { info: () => {}, error: () => {}, warn: () => {} } } } as never)
  ;(sm as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => await new Promise(() => {})
  const dispatched = await handlers.get(RPC_CHANNELS.sessions.COMMAND)!(
    { clientId: 'approving-desktop', workspaceId: workspace.id },
    managed.id,
    { type: 'dispatchPendingPlanExecution', executionId: managed.pendingPlanExecution?.executionId },
  )
  expect(dispatched).toEqual({ ok: true })
  await sleep(30)
  const host = (sm as unknown as { getBrowserHostClient: (id: string) => string | null }).getBrowserHostClient(managed.id)
  expect(host).toBe('approving-desktop')
})

test('new user input supersedes a pending acceptance while Project File validation waits', async () => {
  const { spyOn } = await import('bun:test')
  const fsPromises = await import('node:fs/promises')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const { createProject } = await import('@craft-agent/shared/projects')
  const { sm, ws, workspace } = await setup('approval-validation-race')
  const projectRoot = join(ws, 'project')
  mkdirSync(projectRoot)
  const project = createProject(ws, { name: 'Project-file validation', workingDirectory: projectRoot })
  const managed = createManagedSession({ id: 'approval-validation-race', name: 'Existing chat', projectId: project.id }, { ...workspace, rootPath: ws }, { messagesLoaded: true })
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)
  await saveSession({ id: managed.id, name: 'Existing chat', workspaceRootPath: ws, projectId: project.id, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as never)
  const filePath = join(projectRoot, 'guide.md')
  writeFileSync(filePath, 'public selection')
  const reference = { version: 1, kind: 'project-file', projectId: project.id, relativePath: 'guide.md', fileName: 'guide.md', sourceFingerprint: `sha256:${createHash('sha256').update('public selection').digest('hex')}`, quote: 'public selection', locator: { type: 'text-quote', exact: 'public selection', start: 0, end: 16 } }
  await sm.setPendingPlanExecution(managed.id, '/plan.md', 'plan draft', [reference] as never)
  setSessionDraft(managed.id, { text: 'plan draft' })
  await sm.consumePendingPlanDraft(managed.id, managed.pendingPlanExecution!.executionId!)
  managed.pendingPlanExecution!.compactionTurn = { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
  const stored = loadSession(ws, managed.id)!
  stored.pendingPlanExecution = managed.pendingPlanExecution as never
  await saveSession(stored)
  await sm.markCompactionComplete(managed.id, managed.pendingPlanExecution!.executionId)
  let validatorEntered!: () => void
  const entry = new Promise<void>(r => { validatorEntered = r })
  let release!: () => void
  const barrier = new Promise<void>(r => { release = r })
  const actualOpen = fsPromises.open
  const openSpy = spyOn(fsPromises, 'open').mockImplementation((async (path: unknown, ...args: unknown[]) => {
    if (String(path).endsWith('/guide.md')) { validatorEntered(); await barrier }
    return (actualOpen as unknown as (p: unknown, ...a: unknown[]) => Promise<unknown>)(path, ...args)
  }) as never)
  const entered: string[] = []
  ;(sm as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
    entered.push(managed.lastSentMessage!)
    return await new Promise(() => {})
  }
  const dispatching = sm.dispatchPendingPlanExecution(managed.id, managed.pendingPlanExecution!.executionId)
  await Promise.race([entry, sleep(200).then(() => { throw new Error('Did not reach Project File validation gate') })])
  // A genuine send while dispatch is awaiting filesystem validation: the
  // safety valve cancels the awaiting intent under the shared lock.
  void sm.sendMessage(managed.id, 'Actually just explain the code; do not execute')
  for (let i = 0; i < 40 && !entered.length; i++) await sleep(2)
  expect(entered[0]).toBe('Actually just explain the code; do not execute')
  expect(managed.pendingPlanExecution?.failed).toBe(true)
  release()
  const accepted = await dispatching
  await sleep(30)
  const approvals = managed.messages.filter(m => m.content.includes('Plan approved'))
  openSpy.mockRestore()
  expect(approvals).toHaveLength(0)
  expect(accepted).toMatchObject({ ok: false, reason: 'stale' })
})

/** Helper for tests that need the restored managed instance itself. */
function coldRestoreRestored(restoredSM: InstanceType<typeof SessionManager>, id: string) {
  return (restoredSM as unknown as { sessions: Map<string, unknown> }).sessions.get(id)
}
