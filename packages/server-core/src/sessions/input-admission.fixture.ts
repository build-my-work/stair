import { afterAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repo = new URL('../../../..', import.meta.url).pathname
const profile = realpathSync(mkdtempSync(join(tmpdir(), 'stair-admission-')))
mkdirSync(profile, { recursive: true })
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(join(repo, 'apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
const config = await import(`${repo}/packages/shared/src/config/index.ts`)
const { createWorkspaceAtPath } = await import(`${repo}/packages/shared/src/workspaces/index.ts`)
const { createProject } = await import(`${repo}/packages/shared/src/projects/index.ts`)
const { saveSession, loadSession, sessionPersistenceQueue } = await import(`${repo}/packages/shared/src/sessions/index.ts`)
const { saveTaskSpec, loadTaskSpec, taskYamlPath } = await import(`${repo}/packages/shared/src/tasks/index.ts`)
const { RPC_CHANNELS } = await import(`${repo}/packages/shared/src/protocol/index.ts`)
const { storedToMessage } = await import(`${repo}/packages/core/src/types/index.ts`)
const { SessionManager, createManagedSession } = await import(`${repo}/packages/server-core/src/sessions/SessionManager.ts`)
const { registerTasksHandlers } = await import(`${repo}/packages/server-core/src/handlers/rpc/tasks.ts`)
const { registerSettingsHandlers } = await import(`${repo}/packages/server-core/src/handlers/rpc/settings.ts`)
const { registerSessionsHandlers } = await import(`${repo}/packages/server-core/src/handlers/rpc/sessions.ts`)
const { WsRpcServer } = await import(`${repo}/packages/server-core/src/transport/server.ts`)
const { WsRpcClient } = await import(`${repo}/packages/server-core/src/transport/client.ts`)
const { CLIENT_DRAWNIX_BOARD_INVOKE } = await import(`${repo}/packages/server-core/src/transport/capabilities.ts`)
if (config.CONFIG_DIR !== profile) throw new Error('Config imported before the controlled fixture was selected')
const observations: Record<string, unknown> = { profile, transport: 'real loopback WebSocket using production client/server/handlers/storage; no model' }
const workspaceA = { ...createWorkspaceAtPath(join(profile, 'workspace-a'), 'Review A'), rootPath: join(profile, 'workspace-a') }
const workspaceB = { ...createWorkspaceAtPath(join(profile, 'workspace-b'), 'Review B'), rootPath: join(profile, 'workspace-b') }
const secondProjectInA = createProject(workspaceA.rootPath, { name: 'Second project' })
config.saveConfig({ workspaces: [workspaceA, workspaceB], activeWorkspaceId: workspaceA.id } as never)
const sm: any = new SessionManager()
sm.decisionFeatureActive = () => false
const server = new WsRpcServer({ host: '127.0.0.1', port: 0, onClientDisconnected: (id: string) => sm.onClientDisconnected(id) })
sm.rpcServer = server
const calls: string[] = []
const handle = server.handle.bind(server)
server.handle = (channel: string, handler: (...args: any[]) => any) => handle(channel, (ctx: any, ...args: any[]) => { calls.push(channel); return handler(ctx, ...args) })
const deps: any = { sessionManager: sm, platform: { logger: { info() {}, warn() {}, error() {} } } }
registerTasksHandlers(server, deps)
registerSettingsHandlers(server, deps)
registerSessionsHandlers(server, deps)
sm.setEventSink(server.push.bind(server))
await server.listen()
const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, { workspaceId: workspaceA.id, autoReconnect: false, requestTimeout: 3000 })
client.connect()

afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  client.destroy()
  server.close()
  observations.rpcChannels = calls
  rmSync(profile, { recursive: true, force: true })
})

async function session(id: string, workspace = workspaceA, extra: Record<string, unknown> = {}) {
  const managed = createManagedSession({ id, name: `Review ${id}`, projectId: workspace.defaultProjectId, ...extra }, workspace, { messagesLoaded: true })
  sm.sessions.set(id, managed)
  await saveSession({ id, name: `Review ${id}`, workspaceRootPath: workspace.rootPath, projectId: managed.projectId,
    createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 }, ...extra } as never)
  return managed
}

test('L04 control: text, refs, attachment content and writer receipts round-trip over actual WS and disk', async () => {
  const managed = await session('wire-fields')
  const reference = { version: 1, kind: 'web-selection', projectId: managed.projectId, url: 'https://example.test/review', title: 'Wire review',
    quote: '引用内容 WIRE-REF', locator: { type: 'web-text-quote', exact: '引用内容 WIRE-REF', prefix: 'before', suffix: 'after' } }
  const attachment = { path: 'wire-inline.txt', name: 'wire-inline.txt', content: { type: 'text', mimeType: 'text/plain', size: 19, text: '附件正文 WIRE-ATT' } }
  const content = { text: '正文 WIRE-TEXT', attachments: [attachment] }
  const mutation = { id: 'wire-edit-one', clientId: 'wire-writer', sequence: 1, baseRevision: 0, base: { text: '' } }
  const ack: any = await client.invoke(RPC_CHANNELS.drafts.SET_CONTENT, managed.id, content, mutation)
  expect(ack).toMatchObject(content)
  expect(ack.revision).toBeGreaterThan(0)
  await client.invoke(RPC_CHANNELS.drafts.ADD_REFERENCE, managed.id, reference, 'wire-add-ref')
  const loaded: any = await client.invoke(RPC_CHANNELS.drafts.GET, managed.id)
  expect(loaded).toMatchObject({ ...content, references: [reference] })
  expect(config.getSessionDraft(managed.id)).toMatchObject(loaded)
  const replay: any = await client.invoke(RPC_CHANNELS.drafts.SET_CONTENT, managed.id, content, mutation)
  expect(replay).toMatchObject({ ...content, references: [reference], revision: ack.revision + 1 })
  observations.wireDraft = { ack, loaded, replay, disk: config.getSessionDraft(managed.id) }
})

test('L04 control: mixed send reaches actual SessionManager agent seam and stored user message through WS', async () => {
  const managed = await session('wire-mixed-send')
  const reference = { version: 1, kind: 'web-selection', projectId: managed.projectId, url: 'https://example.test/mixed', title: 'Mixed input',
    quote: 'MIXED-REF', locator: { type: 'web-text-quote', exact: 'MIXED-REF' } }
  const path = join(profile, 'wire-mixed.txt')
  writeFileSync(path, 'MIXED-ATT')
  const attachments = [{ name: 'wire-mixed.txt', path, storedPath: path, type: 'text', mimeType: 'text/plain', size: 9, text: 'MIXED-ATT' }]
  const stored = [{ id: 'wire-att', name: 'wire-mixed.txt', storedPath: path, type: 'text', mimeType: 'text/plain', size: 9 }]
  const inputs: any[] = []
  const agent = { getModel: () => 'no-provider', setAllSources() {}, getSessionId: () => undefined, isCompactionInFlight: () => false,
    chat: async function* (text: string, files: any) { inputs.push({ text, files }); yield { type: 'input_accepted' }; yield { type: 'complete' } } }
  sm.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'MIXED-BODY', attachments, stored, { references: [reference] })
  for (let n = 0; n < 300 && (inputs.length === 0 || managed.isProcessing); n++) await Bun.sleep(5)
  await sm.flushSession(managed.id)
  const user = loadSession(workspaceA.rootPath, managed.id)!.messages.map(storedToMessage).find((m: any) => m.role === 'user')
  observations.wireSend = { inputs, user }
  expect(inputs).toHaveLength(1)
  expect(inputs[0].text).toContain('MIXED-BODY')
  expect(inputs[0].text).toContain('MIXED-REF')
  expect(inputs[0].files).toEqual(attachments)
  expect(user?.content).toBe('MIXED-BODY')
  expect(user?.references).toEqual([reference])
  expect(user?.attachments).toEqual(stored)
})

test('L04/P03 control: plan identities, refs, consume receipt and exactly-one concurrent dispatch persist over WS', async () => {
  const managed = await session('wire-plan')
  const reference = { version: 1, kind: 'web-selection', projectId: managed.projectId, url: 'https://example.test/plan', title: 'Plan input',
    quote: 'PLAN-REF', locator: { type: 'web-text-quote', exact: 'PLAN-REF' } }
  const text = 'PLAN-EXTRA'
  const write: any = await client.invoke(RPC_CHANNELS.drafts.SET_CONTENT, managed.id, { text }, {
    id: 'plan-write-1', clientId: 'plan-writer', sequence: 1, baseRevision: 0, base: { text: '' },
  })
  await client.invoke(RPC_CHANNELS.drafts.ADD_REFERENCE, managed.id, reference, 'plan-ref-1')
  const pending: any = await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, {
    type: 'setPendingPlanExecution', planPath: '/synthetic-plan.md', draftInputSnapshot: text,
    draftReferencesSnapshot: [reference], approvalText: `Approved plan.\n\n${text}`,
  })
  const readPending: any = await client.invoke(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION, managed.id)
  expect(readPending.executionId).toBe(pending.executionId)
  expect(readPending.restoreId).toBe(pending.restoreId)
  expect(readPending.draftReferencesSnapshot).toEqual([reference])
  const consumed: any = await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, {
    type: 'consumePendingPlanDraft', executionId: pending.executionId,
    local: { content: { text }, mutation: { id: 'plan-consume-1', clientId: 'plan-writer', sequence: 2, baseRevision: write.revision, base: { text } } },
  })
  expect(consumed.receipt.text).toBe(true)
  expect(consumed.receipt.referenceKeys).toHaveLength(1)
  const agent = { getModel: () => 'no-provider', setAllSources() {}, getSessionId: () => undefined, isCompactionInFlight: () => false,
    chat: async function* () { yield { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' }; yield { type: 'complete' } } }
  sm.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  sm.processNextQueuedMessage = () => {}
  await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, '/compact', undefined, undefined, { planExecutionId: pending.executionId })
  for (let n = 0; n < 300 && (managed.isProcessing || sm.getPendingPlanExecution(managed.id)?.awaitingCompaction); n++) await Bun.sleep(5)
  const dispatches: any[] = await Promise.all([0, 1].map(() => client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, { type: 'dispatchPendingPlanExecution', executionId: pending.executionId })))
  await sessionPersistenceQueue.flushAll()
  const stored = loadSession(workspaceA.rootPath, managed.id)!
  const approvals = stored.messages.filter((m: any) => m.id === stored.pendingPlanExecution?.approvalMessageId)
  observations.wirePlan = { pending, readPending, consumed, dispatches, storedPlan: stored.pendingPlanExecution, approvals }
  // The host already admitted the approval when the compact turn ended.
  // Both later renderer wakeups must converge on that single admission.
  expect(stored.pendingPlanExecution?.executionDispatched).toBe(true)
  expect(dispatches.filter(x => x.reason === 'already-dispatched')).toHaveLength(2)
  expect(approvals).toHaveLength(1)
  expect(approvals[0].references).toEqual([reference])
  expect(approvals[0].isQueued).toBe(true)
  expect(managed.messageQueue).toHaveLength(1)
}, 10000)

test('P03: two clients can approve a submitted plan only once, including after session reload', async () => {
  const managed = await session('wire-plain-plan')
  const plan = { id: 'submitted-plan', role: 'plan', content: '# One inert execution',
    planPath: join(profile, 'plain-plan.md'), timestamp: 1 }
  managed.messages.push(plan)
  sm.persistSession(managed)
  await sm.flushSession(managed.id)
  const reference = { version: 1, kind: 'web-selection', projectId: managed.projectId,
    url: 'https://example.test/plain-plan', title: 'Approval context', quote: 'APPROVAL-REF',
    locator: { type: 'web-text-quote', exact: 'APPROVAL-REF' } }
  const path = join(profile, 'plain-approval.txt')
  writeFileSync(path, 'APPROVAL-ATT')
  const attachments = [{ name: 'plain-approval.txt', path, storedPath: path, type: 'text', mimeType: 'text/plain', size: 12, text: 'APPROVAL-ATT' }]
  const stored = [{ id: 'approval-att', name: 'plain-approval.txt', storedPath: path, type: 'text', mimeType: 'text/plain', size: 12 }]
  const inputs: any[] = []
  const agent = { getModel: () => 'no-provider', setAllSources() {}, getSessionId: () => undefined,
    isCompactionInFlight: () => false, chat: async function* (text: string, files: any) {
      inputs.push({ text, files }); yield { type: 'input_accepted' }; yield { type: 'complete' }
    } }
  sm.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  const secondClient = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
    workspaceId: workspaceA.id, autoReconnect: false, requestTimeout: 3000,
  })
  secondClient.connect()
  try {
    const results = await Promise.allSettled([client, secondClient].map((sender, n) => sender.invoke(
      RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, `Plan approved, please execute. Window ${n}`,
      attachments, stored, { optimisticMessageId: `plain-window-${n}`, approvedPlanMessageId: plan.id, references: [reference] },
    )))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    for (let n = 0; n < 300 && (inputs.length === 0 || managed.isProcessing); n++) await Bun.sleep(5)
    await sm.flushSession(managed.id)
    const disk = loadSession(workspaceA.rootPath, managed.id)!
    const approvals = disk.messages.map(storedToMessage).filter((m: any) => m.role === 'user')
    expect(approvals).toHaveLength(1)
    expect(approvals[0].approvedPlanMessageId).toBe(plan.id)
    expect(approvals[0].references).toEqual([reference])
    expect(approvals[0].attachments).toEqual(stored)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].text).toContain('APPROVAL-REF')
    expect(inputs[0].files).toEqual(attachments)

    const accepted = approvals[0]
    const originalBody = accepted.content
    const retry = await secondClient.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, originalBody,
      attachments, stored, { optimisticMessageId: accepted.clientMessageId, approvedPlanMessageId: plan.id, references: [reference] })
    expect(retry).toEqual({ accepted: true, messageId: accepted.id })
    await expect(secondClient.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, originalBody,
      attachments, stored, { optimisticMessageId: accepted.clientMessageId, approvedPlanMessageId: 'another-plan', references: [reference] },
    )).rejects.toThrow('INPUT_ID_CONFLICT')

    managed.messages = []
    managed.messagesLoaded = false
    await expect(secondClient.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'Plan approved again',
      undefined, undefined, { optimisticMessageId: 'plain-after-reload', approvedPlanMessageId: plan.id },
    )).rejects.toThrow('PLAN_ALREADY_APPROVED')
    expect(inputs).toHaveLength(1)

    const nextPlan = { ...plan, id: 'next-submitted-plan', timestamp: Date.now() }
    managed.messages.push(nextPlan)
    sm.persistSession(managed)
    await sm.flushSession(managed.id)
    await expect(secondClient.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'Old plan',
      undefined, undefined, { approvedPlanMessageId: plan.id },
    )).rejects.toThrow('PLAN_STALE')
    // A lost response still reconciles to the original row after another
    // plan becomes current; it cannot execute either plan again.
    expect(await secondClient.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, originalBody,
      attachments, stored, { optimisticMessageId: accepted.clientMessageId, approvedPlanMessageId: plan.id, references: [reference] },
    )).toEqual(retry)
    await secondClient.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'New plan approved',
      undefined, undefined, { optimisticMessageId: 'plain-next-plan', approvedPlanMessageId: nextPlan.id })
    for (let n = 0; n < 300 && (inputs.length < 2 || managed.isProcessing); n++) await Bun.sleep(5)
    expect(inputs).toHaveLength(2)
    observations.plainPlan = { results: results.map(result => result.status), approvals, inputs }
  } finally {
    secondClient.destroy()
  }
}, 10000)

test('P03: ordinary and compact approval share the submitted plan claim over RPC', async () => {
  const managed = await session('wire-shared-plan-claim')
  const plan = { id: 'compact-submitted-plan', role: 'plan', content: '# Approved once', planPath: '/submitted.md', timestamp: 1 }
  managed.messages.push(plan)
  sm.persistSession(managed)
  await sm.flushSession(managed.id)
  sm.processNextQueuedMessage = () => {}
  const pending: any = await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, {
    type: 'setPendingPlanExecution', planPath: plan.planPath, approvedPlanMessageId: plan.id, draftInputSnapshot: 'FIRST-SNAPSHOT',
  })
  expect(pending.approvedPlanMessageId).toBe(plan.id)
  await expect(client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'Second approval',
    undefined, undefined, { approvedPlanMessageId: plan.id },
  )).rejects.toThrow('PLAN_ALREADY_APPROVED')
  expect(sm.getPendingPlanExecution(managed.id)).toMatchObject({ executionId: pending.executionId, draftInputSnapshot: 'FIRST-SNAPSHOT' })

  const write: any = await client.invoke(RPC_CHANNELS.drafts.SET_CONTENT, managed.id, { text: 'FIRST-SNAPSHOT' }, {
    id: 'shared-plan-write', clientId: 'shared-plan-writer', sequence: 1, baseRevision: 0, base: { text: '' },
  })
  await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, { type: 'consumePendingPlanDraft', executionId: pending.executionId,
    local: { content: { text: 'FIRST-SNAPSHOT' }, mutation: { id: 'shared-plan-consume', clientId: 'shared-plan-writer', sequence: 2,
      baseRevision: write.revision, base: { text: 'FIRST-SNAPSHOT' } } },
  })
  await expect(client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, {
    type: 'setPendingPlanExecution', planPath: plan.planPath, approvedPlanMessageId: plan.id, draftInputSnapshot: 'SECOND-SNAPSHOT',
  })).rejects.toThrow('PENDING_PLAN_EXISTS')
  const agent = { getModel: () => 'no-provider', setAllSources() {}, getSessionId: () => undefined, isCompactionInFlight: () => false,
    chat: async function* () { yield { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' }; yield { type: 'complete' } } }
  sm.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, '/compact', undefined, undefined, { planExecutionId: pending.executionId })
  for (let n = 0; n < 300 && (managed.isProcessing || sm.getPendingPlanExecution(managed.id)?.awaitingCompaction); n++) await Bun.sleep(5)
  await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, { type: 'dispatchPendingPlanExecution', executionId: pending.executionId })
  await sm.flushSession(managed.id)
  const approvals = loadSession(workspaceA.rootPath, managed.id)!.messages.filter((message: any) => message.approvedPlanMessageId === plan.id)
  expect(approvals).toHaveLength(1)
  expect(approvals[0].type).toBe('user')
  // The approval remains claimed when the compact outbox is retired and
  // only its durable user message remains after hydration.
  await sm.commitPendingPlanExecution(managed, undefined)
  managed.messages = []
  managed.messagesLoaded = false
  await expect(client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, {
    type: 'setPendingPlanExecution', planPath: plan.planPath, approvedPlanMessageId: plan.id,
  })).rejects.toThrow('PLAN_ALREADY_APPROVED')
  await expect(sm.acceptPlan(managed.id, plan.planPath)).rejects.toThrow('PLAN_ALREADY_APPROVED')
}, 10000)

test('P03: compact preparation wins while ordinary approval validates a source', async () => {
  const projectRoot = join(profile, 'approval-source')
  mkdirSync(projectRoot)
  const project = createProject(workspaceA.rootPath, { name: 'Approval source', workingDirectory: projectRoot })
  const managed = await session('wire-approval-validation-race', workspaceA, { projectId: project.id })
  const plan = { id: 'validation-plan', role: 'plan', content: '# Approve once', planPath: '/validation-plan.md', timestamp: 1 }
  managed.messages.push(plan)
  sm.persistSession(managed)
  await sm.flushSession(managed.id)
  const marker = 'APPROVAL-SOURCE'
  const path = join(projectRoot, 'source.txt')
  writeFileSync(path, marker)
  const reference = { version: 1, kind: 'project-file', projectId: project.id, relativePath: 'source.txt', fileName: 'source.txt',
    sourceFingerprint: `sha256:${createHash('sha256').update(marker).digest('hex')}`, quote: marker,
    locator: { type: 'text-quote', exact: marker, start: 0, end: marker.length } }
  let entered!: () => void
  const entry = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const actualOpen = fsPromises.open
  const openSpy = spyOn(fsPromises, 'open').mockImplementation((async (p: any, ...args: any[]) => {
    if (String(p) === path) { entered(); await gate }
    return (actualOpen as any)(p, ...args)
  }) as never)
  const ordinary = client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'Waiting normal approval', undefined, undefined,
    { approvedPlanMessageId: plan.id, optimisticMessageId: 'validation-normal-approval', references: [reference] })
  // Install the rejection observer before releasing the validation gate.
  const outcome = ordinary.then(() => 'accepted', (error: unknown) => String(error))
  try {
    await Promise.race([entry, Bun.sleep(1000).then(() => { throw new Error('Approval validation gate not reached') })])
    const prepared: any = await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, {
      type: 'setPendingPlanExecution', planPath: plan.planPath, approvedPlanMessageId: plan.id, draftInputSnapshot: 'COMPACT-WINNER',
    })
    release()
    expect(await outcome).toContain('PLAN_ALREADY_APPROVED')
    expect(managed.messages.filter((message: any) => message.role === 'user')).toHaveLength(0)
    expect(sm.getPendingPlanExecution(managed.id)).toMatchObject({ executionId: prepared.executionId, draftInputSnapshot: 'COMPACT-WINNER' })
  } finally { release(); await outcome; openSpy.mockRestore() }
}, 10000)

test('P03: a failed approval write releases the plan claim without changing permissions or starting an agent', async () => {
  const managed = await session('wire-plan-write-failure', workspaceA, { permissionMode: 'safe', previousPermissionMode: 'guarded' })
  const plan = { id: 'failed-write-plan', role: 'plan', content: '# Retry after storage recovery', planPath: '/retry.md', timestamp: 1 }
  managed.messages.push(plan)
  sm.persistSession(managed)
  await sm.flushSession(managed.id)
  const inputs: string[] = []
  const agent = { getModel: () => 'no-provider', setAllSources() {}, getSessionId: () => undefined, isCompactionInFlight: () => false,
    chat: async function* (text: string) { inputs.push(text); yield { type: 'input_accepted' }; yield { type: 'complete' } } }
  sm.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  const directory = join(workspaceA.rootPath, 'sessions', managed.id)
  chmodSync(directory, 0o500)
  try {
    await expect(sm.acceptPlan(managed.id, plan.planPath)).rejects.toThrow()
    expect(inputs).toHaveLength(0)
    expect(managed.permissionMode).toBe('safe')
    expect(managed.messages.filter((message: any) => message.approvedPlanMessageId === plan.id)).toHaveLength(0)
    expect(loadSession(workspaceA.rootPath, managed.id)!.messages.filter((message: any) => message.approvedPlanMessageId === plan.id)).toHaveLength(0)
  } finally { chmodSync(directory, 0o700) }
  await sm.acceptPlan(managed.id, plan.planPath)
  for (let n = 0; n < 300 && (inputs.length === 0 || managed.isProcessing); n++) await Bun.sleep(5)
  await sm.flushSession(managed.id)
  expect(inputs).toHaveLength(1)
  expect(managed.permissionMode).toBe('guarded')
  await expect(client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, {
    type: 'setPendingPlanExecution', planPath: plan.planPath, approvedPlanMessageId: plan.id,
  })).rejects.toThrow('PLAN_ALREADY_APPROVED')
}, 10000)

test.each(['Stop', 'reconcileInput'] as const)('I09: %s during reference validation prevents late admission', async (cancelMethod) => {
  const projectRoot = join(profile, `stop-source-${cancelMethod}`)
  mkdirSync(projectRoot)
  const project = createProject(workspaceA.rootPath, { name: 'Stop source', workingDirectory: projectRoot })
  const managed = await session(`stop-during-validation-${cancelMethod}`, workspaceA, { projectId: project.id })
  const marker = 'STOP-VALIDATION-QUOTE'
  const path = join(projectRoot, 'source.txt')
  writeFileSync(path, marker)
  const reference = { version: 1, kind: 'project-file', projectId: project.id, relativePath: 'source.txt', fileName: 'source.txt',
    sourceFingerprint: `sha256:${createHash('sha256').update(marker).digest('hex')}`, quote: marker,
    locator: { type: 'text-quote', exact: marker, start: 0, end: marker.length } }
  let entered!: () => void
  const entry = new Promise<void>(r => { entered = r })
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const actualOpen = fsPromises.open
  const openSpy = spyOn(fsPromises, 'open').mockImplementation((async (p: any, ...args: any[]) => {
    if (String(p) === path) { entered(); await gate }
    return (actualOpen as any)(p, ...args)
  }) as never)
  const inputs: string[] = []
  const agent = { getModel: () => 'no-provider', setAllSources() {}, getSessionId: () => undefined, isCompactionInFlight: () => false,
    chat: async function* (text: string) { inputs.push(text); yield { type: 'input_accepted' }; yield { type: 'complete' } } }
  sm.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  let response: any
  let error: string | undefined
  const pending = client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'Cancelled body', undefined, undefined,
    { references: [reference], optimisticMessageId: 'cancelled-during-validation' })
    .then((value: any) => { response = value }, (err: unknown) => { error = String(err) })
  try {
    await Promise.race([entry, Bun.sleep(1000).then(() => { throw new Error('Validation gate not reached') })])
    const before = { isProcessing: managed.isProcessing, stopEpoch: managed.stopEpoch ?? 0 }
    if (cancelMethod === 'Stop') {
      await client.invoke(RPC_CHANNELS.sessions.CANCEL, managed.id)
    } else {
      expect(await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id,
        { type: 'reconcileInput', clientMessageId: 'cancelled-during-validation' })).toEqual({ state: 'not_accepted' })
      await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'NEW-AFTER-CANCEL')
    }
    const afterStop = { isProcessing: managed.isProcessing, stopEpoch: managed.stopEpoch ?? 0 }
    release()
    await pending
    for (let n = 0; n < 100 && managed.isProcessing; n++) await Bun.sleep(5)
    await sm.flushSession(managed.id)
    observations.stopValidation = { before, afterStop, response: response ?? null, error: error ?? null, inputs,
      persistedUsers: loadSession(workspaceA.rootPath, managed.id)!.messages.filter((m: any) => m.type === 'user') }
    expect(inputs).toEqual(cancelMethod === 'Stop' ? [] : ['NEW-AFTER-CANCEL'])
  } finally { release(); await pending; openSpy.mockRestore() }
}, 10000)

test('I02: different reference validation latency cannot invert queued input order', async () => {
  const projectRoot = join(profile, 'queue-source')
  mkdirSync(projectRoot)
  const project = createProject(workspaceA.rootPath, { name: 'Queue source', workingDirectory: projectRoot })
  const managed = await session('validation-fifo', workspaceA, { projectId: project.id })
  managed.isProcessing = true
  const marker = 'FIFO-VALIDATION-QUOTE'
  const path = join(projectRoot, 'source.txt')
  writeFileSync(path, marker)
  const reference = { version: 1, kind: 'project-file', projectId: project.id, relativePath: 'source.txt', fileName: 'source.txt',
    sourceFingerprint: `sha256:${createHash('sha256').update(marker).digest('hex')}`, quote: marker,
    locator: { type: 'text-quote', exact: marker, start: 0, end: marker.length } }
  let entered!: () => void
  const entry = new Promise<void>(r => { entered = r })
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const actualOpen = fsPromises.open
  const openSpy = spyOn(fsPromises, 'open').mockImplementation((async (p: any, ...args: any[]) => {
    if (String(p) === path) { entered(); await gate }
    return (actualOpen as any)(p, ...args)
  }) as never)
  const first = client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'FIRST', undefined, undefined, { references: [reference] })
  try {
    await Promise.race([entry, Bun.sleep(1000).then(() => { throw new Error('Validation gate not reached') })])
    const secondRequest = client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'SECOND')
    await Bun.sleep(20)
    release()
    const [firstAck, second] = await Promise.all([first, secondRequest])
    await sm.flushSession(managed.id)
    const order = managed.messageQueue.map((entry: any) => entry.message)
    observations.queueValidationOrder = { firstAck, secondAck: second, order,
      persistedOrder: loadSession(workspaceA.rootPath, managed.id)!.messages.filter((m: any) => m.type === 'user').map((m: any) => m.content) }
    expect(order).toEqual(['FIRST', 'SECOND'])
  } finally { release(); await first; openSpy.mockRestore() }
}, 10000)

test('I08: a real session write failure cannot acknowledge durable input or start its agent', async () => {
  const managed = await session('failed-user-write')
  const sessionDir = join(workspaceA.rootPath, 'sessions', managed.id)
  const inputs: string[] = []
  const agent = { getModel: () => 'no-provider', setAllSources() {}, getSessionId: () => undefined, isCompactionInFlight: () => false,
    chat: async function* (text: string) { inputs.push(text); yield { type: 'input_accepted' }; yield { type: 'complete' } } }
  sm.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  chmodSync(sessionDir, 0o500)
  let response: any
  let error: string | undefined
  try {
    try { response = await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'UNSAVED-INPUT') }
    catch (err) { error = String(err) }
    for (let n = 0; n < 100 && managed.isProcessing; n++) await Bun.sleep(5)
    await sessionPersistenceQueue.flushAll()
    const diskUsers = loadSession(workspaceA.rootPath, managed.id)!.messages.filter((m: any) => m.type === 'user')
    observations.writeFailure = { error: error ?? null, response: response ?? null, inputs, diskUsers, inMemoryUserCount: managed.messages.filter((m: any) => m.role === 'user').length }
    expect(diskUsers).toHaveLength(0)
    expect(response).toBeUndefined()
    expect(error).toBeDefined()
    expect(inputs).toHaveLength(0)
  } finally { chmodSync(sessionDir, 0o700) }
}, 10000)

for (const variant of ['count', 'single-utf8-bytes', 'aggregate-bytes']) {
  test(`R08 transport control: ${variant} is rejected before persistence or agent input`, async () => {
    const managed = await session(`budget-${variant}`)
    const body = `DRAFT-PRESERVED-${variant}`
    const draftBefore: any = await client.invoke(RPC_CHANNELS.drafts.SET_CONTENT, managed.id, { text: body }, {
      id: `budget-write-${variant}`, clientId: 'budget-writer', sequence: 1, baseRevision: 0, base: { text: '' },
    })
    const count = variant === 'count' ? 33 : variant === 'single-utf8-bytes' ? 1 : 24
    const quote = variant === 'single-utf8-bytes' ? '汉'.repeat(3000) : variant === 'aggregate-bytes' ? 'x'.repeat(3000) : 'short quote'
    const references = Array.from({ length: count }, (_, i) => ({ version: 1, kind: 'web-selection', projectId: managed.projectId,
      url: `https://example.test/budget/${i}`, title: `Budget ${i}`, quote, locator: { type: 'web-text-quote', exact: quote } }))
    const calls: string[] = []
    sm.getOrCreateAgent = async () => { calls.push('unexpected agent creation'); throw new Error('Unexpected agent creation') }
    let error: string | undefined
    try { await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, body, undefined, undefined, { references }) }
    catch (err) { error = String(err) }
    const after = await client.invoke(RPC_CHANNELS.drafts.GET, managed.id)
    const diskUsers = loadSession(workspaceA.rootPath, managed.id)!.messages.filter((m: any) => m.type === 'user')
    observations[`budget-${variant}`] = { inputCount: count, serializedBytes: Buffer.byteLength(JSON.stringify(references)), error, draftBefore, draftAfter: after, diskUsers, calls }
    expect(error).toContain('MESSAGE_REFERENCE_')
    expect(after).toMatchObject({ text: body })
    expect(diskUsers).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
}


test('I05: startup failure restores the complete unaccepted input through the durable outbox', async () => {
  const managed = await session('startup-recovery')
  const path = join(profile, 'startup-attachment.txt')
  writeFileSync(path, 'STARTUP-ATTACHMENT')
  const stored = [{ id: 'startup-file', type: 'text', name: 'startup.txt', mimeType: 'text/plain', size: 18, storedPath: path }]
  const reference = { version: 1, kind: 'web-selection', projectId: managed.projectId,
    url: 'https://example.test/startup', title: 'Startup', quote: 'STARTUP-REF', locator: { type: 'web-text-quote', exact: 'STARTUP-REF' } }
  sm.getOrCreateAgent = async () => { throw new Error('controlled startup failure') }
  await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'STARTUP-BODY',
    [{ type: 'text', name: 'startup.txt', mimeType: 'text/plain', size: 18, text: 'STARTUP-ATTACHMENT', path }], stored,
    { references: [reference], optimisticMessageId: 'startup-client-input' })
  for (let i = 0; i < 100 && managed.isProcessing; i++) await Bun.sleep(5)
  await sm.flushSession(managed.id)
  const user = loadSession(workspaceA.rootPath, managed.id)!.messages.find((m: any) => m.type === 'user')!
  expect(user).toMatchObject({ content: 'STARTUP-BODY', references: [reference], attachments: stored,
    isQueued: true, queuedRestoreId: `input-${user.id}`, clientMessageId: 'startup-client-input' })
  expect(managed.messageQueue).toHaveLength(0)
  expect(managed.isProcessing).toBe(false)
})

test('I06/I09: thinking and a late input acknowledgement after Stop cannot consume restored input', async () => {
  const managed = await session('stop-before-acceptance')
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  let entered = false
  const agent = { getModel: () => 'no-provider', setAllSources() {}, getSessionId: () => undefined,
    forceAbort() {}, isCompactionInFlight: () => false,
    chat: async function* () { entered = true; yield { type: 'status', message: 'Thinking' }; await gate;
      yield { type: 'input_accepted' }; yield { type: 'complete' } } }
  sm.getOrCreateAgent = async () => { managed.agent = agent; return agent }
  await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'WAITING-FOR-ACCEPTANCE')
  for (let i = 0; i < 100 && !entered; i++) await Bun.sleep(5)
  expect(entered).toBe(true)
  try {
    await client.invoke(RPC_CHANNELS.sessions.CANCEL, managed.id)
    const before = managed.messages.find((m: any) => m.role === 'user')
    expect(before.queuedRestoreId).toBeString()
    const restoreId = before.queuedRestoreId
    finish()
    for (let i = 0; i < 100 && managed.isProcessing; i++) await Bun.sleep(5)
    await sm.flushSession(managed.id)
    expect(loadSession(workspaceA.rootPath, managed.id)!.messages.find((m: any) => m.type === 'user'))
      .toMatchObject({ queuedRestoreId: restoreId, isQueued: true })
  } finally { finish() }
})

test('I05: retrying a durably acknowledged client identity never starts a second turn', async () => {
  const managed = await session('deduplicate-input')
  const inputs: string[] = []
  const agent = { getModel: () => 'no-provider', setAllSources() {}, getSessionId: () => undefined, isCompactionInFlight: () => false,
    chat: async function* (text: string) { inputs.push(text); yield { type: 'input_accepted' }; yield { type: 'complete' } } }
  sm.getOrCreateAgent = async () => { managed.agent = agent; return agent }
  const args = [managed.id, 'ONCE', undefined, undefined, { optimisticMessageId: 'same-input' }]
  const first = await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, ...args)
  const second = await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, ...args)
  for (let i = 0; i < 100 && managed.isProcessing; i++) await Bun.sleep(5)
  expect(first).toEqual(second)
  expect(inputs).toEqual(['ONCE'])
  await expect(client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'DIFFERENT', undefined, undefined,
    { optimisticMessageId: 'same-input' })).rejects.toThrow('INPUT_ID_CONFLICT')
})

test('I04/I05: cold unacknowledged input restores instead of silently replaying', async () => {
  const managed = await session('cold-uncertain-input')
  await saveSession({ id: managed.id, workspaceRootPath: workspaceA.rootPath, projectId: managed.projectId,
    createdAt: 1, lastUsedAt: 1, messages: [{ id: 'uncertain', type: 'user', content: 'COLD-UNCERTAIN', timestamp: 1, pendingDelivery: true }],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as never)
  managed.messagesLoaded = false
  const loaded = await sm.getSession(managed.id)
  expect(loaded.messages[0]).toMatchObject({ content: 'COLD-UNCERTAIN', isQueued: true, queuedRestoreId: 'input-uncertain' })
  expect(managed.messageQueue).toHaveLength(0)
  expect(managed.isProcessing).toBe(false)
})

test('I08: a failed recovery acknowledgement keeps its outbox until deletion is durable', async () => {
  const managed = await session('restore-ack-write-failure')
  managed.messages.push({ id: 'restored-input', role: 'user', content: 'RESTORED', timestamp: 1,
    isQueued: true, queuedRestoreId: 'recovery-receipt' })
  sm.persistSession(managed)
  await sm.flushSession(managed.id)
  const directory = join(workspaceA.rootPath, 'sessions', managed.id)
  chmodSync(directory, 0o500)
  try {
    await expect(client.invoke(RPC_CHANNELS.sessions.ACK_QUEUED_INPUT_RESTORE,
      managed.id, 'recovery-receipt', ['restored-input'])).rejects.toThrow()
    expect(managed.messages.find((message: any) => message.id === 'restored-input')).toBeDefined()
    expect(loadSession(workspaceA.rootPath, managed.id)!.messages.find((message: any) => message.id === 'restored-input')).toBeDefined()
  } finally { chmodSync(directory, 0o700) }
  await client.invoke(RPC_CHANNELS.sessions.ACK_QUEUED_INPUT_RESTORE,
    managed.id, 'recovery-receipt', ['restored-input'])
  expect(managed.messages.find((message: any) => message.id === 'restored-input')).toBeUndefined()
  expect(loadSession(workspaceA.rootPath, managed.id)!.messages.find((message: any) => message.id === 'restored-input')).toBeUndefined()
})

test('I05: reconciliation distinguishes owned input from cancellation and survives restart', async () => {
  const managed = await session('input-reconciliation')
  managed.isProcessing = true
  const ack: any = await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'OWNED', undefined, undefined,
    { optimisticMessageId: 'owned-client-input' })
  expect(await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id,
    { type: 'reconcileInput', clientMessageId: 'owned-client-input' })).toEqual({ state: 'owned', messageId: ack.messageId })
  expect(await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id,
    { type: 'reconcileInput', clientMessageId: 'cancelled-client-input' })).toEqual({ state: 'not_accepted' })
  expect(managed.isProcessing).toBe(true)
  expect(managed.messageQueue).toHaveLength(1)
  const stored = loadSession(workspaceA.rootPath, managed.id)!
  expect(stored.cancelledInputIds).toContain('cancelled-client-input')
  const restarted = createManagedSession(stored, workspaceA, { messagesLoaded: false })
  sm.sessions.set(managed.id, restarted)
  await expect(client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'TOO LATE', undefined, undefined,
    { optimisticMessageId: 'cancelled-client-input' })).rejects.toThrow('INPUT_CANCELLED')
  expect(restarted.messages.some((message: any) => message.content === 'TOO LATE')).toBe(false)
})

test('I05: reconciliation cannot report absence when the cancellation record cannot be saved', async () => {
  const managed = await session('reconcile-write-failure')
  const directory = join(workspaceA.rootPath, 'sessions', managed.id)
  chmodSync(directory, 0o500)
  try {
    await expect(client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id,
      { type: 'reconcileInput', clientMessageId: 'uncertain-write' })).rejects.toThrow()
  } finally { chmodSync(directory, 0o700) }
  expect(await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id,
    { type: 'reconcileInput', clientMessageId: 'uncertain-write' })).toEqual({ state: 'not_accepted' })
})

test('I05/I07: an acknowledged restored outbox still owns a closed window journal identity', async () => {
  const managed = await session('retired-journal-identity')
  managed.messages.push({ id: 'owned-outbox', clientMessageId: 'closed-window-journal', role: 'user', content: 'ALREADY RESTORED',
    timestamp: 1, isQueued: true, queuedRestoreId: 'stop-restore' })
  sm.persistSession(managed)
  await sm.flushSession(managed.id)
  await client.invoke(RPC_CHANNELS.sessions.ACK_QUEUED_INPUT_RESTORE, managed.id, 'stop-restore', ['owned-outbox'])
  const stored = loadSession(workspaceA.rootPath, managed.id)!
  expect(stored.messages).toHaveLength(0)
  sm.sessions.set(managed.id, createManagedSession(stored, workspaceA))
  expect(await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id,
    { type: 'reconcileInput', clientMessageId: 'closed-window-journal' })).toEqual({ state: 'owned', messageId: 'owned-outbox' })
  expect(await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'ALREADY RESTORED', undefined, undefined,
    { optimisticMessageId: 'closed-window-journal' })).toEqual({ accepted: true, messageId: 'owned-outbox' })
  expect(loadSession(workspaceA.rootPath, managed.id)!.messages).toHaveLength(0)
})

test('I02/I05: cancelling the middle admission preserves order behind a slow valid predecessor', async () => {
  const root = join(profile, 'cancel-middle-source')
  mkdirSync(root)
  const project = createProject(workspaceA.rootPath, { name: 'Cancel middle', workingDirectory: root })
  const managed = await session('cancel-middle', workspaceA, { projectId: project.id })
  managed.isProcessing = true
  const marker = 'FIRST-REFERENCE'
  const path = join(root, 'source.txt')
  writeFileSync(path, marker)
  const reference = { version: 1, kind: 'project-file', projectId: project.id, relativePath: 'source.txt', fileName: 'source.txt',
    sourceFingerprint: `sha256:${createHash('sha256').update(marker).digest('hex')}`, quote: marker,
    locator: { type: 'text-quote', exact: marker, start: 0, end: marker.length } }
  let entered!: () => void
  let release!: () => void
  const entry = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const actualOpen = fsPromises.open
  const openSpy = spyOn(fsPromises, 'open').mockImplementation((async (target: any, ...args: any[]) => {
    if (String(target) === path) { entered(); await gate }
    return (actualOpen as any)(target, ...args)
  }) as never)
  const first = client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'FIRST', undefined, undefined,
    { references: [reference], optimisticMessageId: 'first-input' })
  let second: Promise<unknown> | undefined
  let third: Promise<unknown> | undefined
  try {
    await entry
    second = client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'CANCELLED', undefined, undefined,
      { optimisticMessageId: 'middle-input' }).catch(() => undefined)
    third = client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, managed.id, 'THIRD', undefined, undefined,
      { optimisticMessageId: 'third-input' })
    await client.invoke(RPC_CHANNELS.sessions.COMMAND, managed.id, { type: 'reconcileInput', clientMessageId: 'middle-input' })
    await Bun.sleep(10)
    expect(managed.messageQueue).toHaveLength(0)
    release()
    await Promise.all([first, second, third])
    expect(managed.messageQueue.map((input: any) => input.message)).toEqual(['FIRST', 'THIRD'])
  } finally { release(); await Promise.allSettled([first, second, third]); openSpy.mockRestore() }
})
