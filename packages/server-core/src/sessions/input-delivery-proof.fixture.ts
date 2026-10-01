import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentEvent } from '@craft-agent/core/types'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import type { SessionEvent } from '@craft-agent/shared/protocol'

const configDir = mkdtempSync(join(tmpdir(), 'input-delivery-proof-profile-'))
process.env.CRAFT_CONFIG_DIR = configDir
copyFileSync(resolve(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'), join(configDir, 'config-defaults.json'))
const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { messageToStored } = await import('@craft-agent/core/types')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSessionStrict, loadSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { setSessionDraft, getSessionDraft, getPlanDraftConsumption, CONFIG_DIR } = await import('@craft-agent/shared/config')
const { PiAgent } = await import('@craft-agent/shared/agent/pi-agent')
if (CONFIG_DIR !== configDir) throw new Error('Input-delivery fixture needs isolated config')

type ManagedSession = ReturnType<typeof createManagedSession>
interface SessionHarness {
  sessions: Map<string, ManagedSession>
  decisionFeatureActive(): boolean
  getOrCreateAgent(managed: ManagedSession): Promise<AgentBackend>
  processNextQueuedMessage(sessionId: string): void
  processEvent(managed: ManagedSession, event: AgentEvent): Promise<void>
}
interface PiHarness {
  ensureSubprocess(): Promise<void>
  send(message: Record<string, unknown>): void
  handleLine(line: string): void
  chatImpl(): AsyncGenerator<AgentEvent>
}
const fixtures: Array<{ root: string; managed: ManagedSession; agents: InstanceType<typeof PiAgent>[] }> = []
afterAll(async () => {
  for (const fixture of fixtures) {
    if (fixture.managed.autoRetryTimer) clearTimeout(fixture.managed.autoRetryTimer)
    for (const agent of fixture.agents) agent.destroy()
  }
  await sessionPersistenceQueue.flushAll()
  for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

async function waitUntil(predicate: () => boolean) {
  for (let n = 0; n < 400 && !predicate(); n++) await Bun.sleep(5)
  expect(predicate()).toBe(true)
}

async function prepareApproval(id: string, text: string, mode: 'missing-skill' | 'startup' | 'child-preflight' | 'accepted') {
  const root = mkdtempSync(join(tmpdir(), 'input-delivery-proof-workspace-'))
  const workspace = { ...createWorkspaceAtPath(root, 'Delivery proof'), rootPath: root }
  const sm = new SessionManager()
  const harness = sm as unknown as SessionHarness
  const managed = createManagedSession({ id, name: 'Existing chat', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
  harness.sessions.set(id, managed)
  harness.decisionFeatureActive = () => false
  const events: SessionEvent[] = []
  sm.setEventSink((_channel, _target, event) => events.push(structuredClone(event as SessionEvent)))
  await saveSessionStrict({
    id, name: 'Existing chat', workspaceRootPath: root, projectId: managed.projectId,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  const actualDrain = harness.processNextQueuedMessage.bind(sm)
  harness.processNextQueuedMessage = () => {}
  setSessionDraft(id, { text })
  const prepared = await sm.setPendingPlanExecution(id, '/accepted.md', text, undefined, `Approved plan.\n\n${text}`)
  if (!prepared.executionId) throw new Error('Prepared approval must have an execution identity')
  expect((await sm.consumePendingPlanDraft(id, prepared.executionId))?.receipt.text).toBe(true)
  const turn = { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
  managed.pendingPlanExecution!.compactionTurn = turn
  const stored = loadSession(root, id)!
  stored.pendingPlanExecution = managed.pendingPlanExecution
  await saveSessionStrict(stored)
  expect(await sm.markCompactionComplete(id, prepared.executionId, turn)).toBe(true)
  const agent = new PiAgent({
    provider: 'pi', isHeadless: true, workspace, model: 'isolated-model',
    session: { id, projectId: managed.projectId, workspaceRootPath: root, createdAt: 1, lastUsedAt: 1 },
  })
  const pi = agent as unknown as PiHarness
  const sent: Record<string, unknown>[] = []
  let providerTurns = 0
  if (mode === 'missing-skill') pi.chatImpl = async function* () {
    providerTurns++
    throw new Error('Forbidden provider boundary reached')
  }
  if (mode === 'child-preflight' || mode === 'accepted') pi.ensureSubprocess = async () => {}
  pi.send = message => {
    sent.push(message)
    if (mode !== 'child-preflight' && mode !== 'accepted') throw new Error('Forbidden child write reached')
    if (message.type !== 'prompt') return
    if (mode === 'child-preflight') {
      pi.handleLine(JSON.stringify({ type: 'error', code: 'prompt_error', message: 'No API key available for isolated model' }))
    } else {
      pi.handleLine(JSON.stringify({ type: 'prompt_accepted', id: 'foreign-prompt' }))
      pi.handleLine(JSON.stringify({ type: 'prompt_accepted', id: message.id }))
      pi.handleLine(JSON.stringify({ type: 'prompt_accepted', id: message.id }))
    }
    pi.handleLine(JSON.stringify({ type: 'event', event: { type: 'agent_end', messages: [] } }))
  }
  harness.getOrCreateAgent = async () => { managed.agent = agent; return agent }
  fixtures.push({ root, managed, agents: [agent] })
  expect(await sm.dispatchPendingPlanExecution(id, prepared.executionId)).toEqual({ ok: true })
  actualDrain(id)
  await waitUntil(() => !managed.isProcessing && events.some(event => event.type === 'complete'))
  await sm.flushSession(id)
  return { root, sm, managed, events, sent, prepared: { ...prepared, executionId: prepared.executionId }, providerTurns }
}

for (const mode of ['missing-skill', 'startup', 'child-preflight'] as const) {
  test(`${mode} cannot ACK an accepted approval without producer delivery`, async () => {
    const text = mode === 'missing-skill' ? '[skill:deleted-skill] Keep these approved instructions' : 'Keep these approved instructions'
    const fixture = await prepareApproval(`delivery-${mode}`, text, mode)
    expect(fixture.providerTurns).toBe(0)
    expect(fixture.sent.filter(message => message.type === 'prompt')).toHaveLength(mode === 'child-preflight' ? 1 : 0)
    expect(fixture.events.some(event => event.type === 'error' || event.type === 'typed_error')).toBe(true)
    expect(getSessionDraft(fixture.managed.id)?.text ?? '').toBe('')
    expect(fixture.sm.getPendingPlanExecution(fixture.managed.id)?.executionId).toBe(fixture.prepared.executionId)
    expect(loadSession(fixture.root, fixture.managed.id)?.pendingPlanExecution?.executionId).toBe(fixture.prepared.executionId)
    expect(getPlanDraftConsumption(fixture.managed.id, fixture.prepared.executionId)?.text).toBe(true)
    expect(fixture.sm.getPendingPlanExecution(fixture.managed.id)?.draftInputSnapshot).toBe(text)
  }, 5_000)
}

test('matching Pi preflight receipt hands the accepted approval to the backend once', async () => {
  const fixture = await prepareApproval('delivery-accepted', 'Execute these approved instructions', 'accepted')
  expect(fixture.sent.filter(message => message.type === 'prompt')).toHaveLength(1)
  expect(fixture.sm.getPendingPlanExecution(fixture.managed.id)).toBeNull()
  expect(loadSession(fixture.root, fixture.managed.id)?.pendingPlanExecution).toBeUndefined()
  expect(getPlanDraftConsumption(fixture.managed.id, fixture.prepared.executionId)).toBeNull()
  expect(fixture.managed.messages.filter(message => message.id === fixture.managed.lastSentMessageIds?.[0])).toHaveLength(1)
}, 5_000)

test('Pi foreign receipts and error-before-preflight never acknowledge a prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-preflight-workspace-'))
  const workspace = { ...createWorkspaceAtPath(root, 'Pi preflight'), rootPath: root }
  const managed = createManagedSession({ id: 'pi-preflight', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
  const agent = new PiAgent({
    provider: 'pi', isHeadless: true, workspace, model: 'isolated-model',
    session: { id: managed.id, projectId: managed.projectId, workspaceRootPath: root, createdAt: 1, lastUsedAt: 1 },
  })
  fixtures.push({ root, managed, agents: [agent] })
  const pi = agent as unknown as PiHarness
  pi.ensureSubprocess = async () => {}
  pi.send = message => {
    if (message.type !== 'prompt') return
    pi.handleLine(JSON.stringify({ type: 'prompt_accepted', id: 'obsolete-turn-id' }))
    pi.handleLine(JSON.stringify({ type: 'error', code: 'prompt_error', message: 'Model preflight rejected the prompt' }))
    pi.handleLine(JSON.stringify({ type: 'event', event: { type: 'agent_end', messages: [] } }))
  }
  const events: AgentEvent[] = []
  for await (const event of agent.chat('Original user input')) events.push(event)
  expect(events.some(event => event.type === 'error' || event.type === 'typed_error')).toBe(true)
  expect(events.some(event => event.type === 'input_accepted')).toBe(false)
})

test('source continuation preflight failure recovers an already accepted host steer with its original identity and text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-delivery-proof-workspace-'))
  const workspace = { ...createWorkspaceAtPath(root, 'Source delivery'), rootPath: root }
  const sm = new SessionManager()
  const harness = sm as unknown as SessionHarness
  const managed = createManagedSession({ id: 'source-delivery-proof', name: 'Existing chat', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
  harness.sessions.set(managed.id, managed)
  harness.decisionFeatureActive = () => false
  const events: SessionEvent[] = []
  sm.setEventSink((_channel, _target, event) => events.push(structuredClone(event as SessionEvent)))
  const originalText = 'Find open issues and explain them'
  const steerText = 'Use Chinese'
  const steerId = 'source-steer-message'
  // Start after the original producer accepted the steer, before activation
  // cleanup returned it. These are the host fields written by sendMessage,
  // not extra Pi steering methods (Pi does not implement takePendingSteers).
  managed.messages = [
    { id: 'source-original-message', role: 'user', content: originalText, timestamp: 1 },
    { id: steerId, role: 'user', content: steerText, timestamp: 2, isQueued: false },
  ]
  managed.lastSentMessage = originalText
  managed.lastSentMessageIds = ['source-original-message']
  managed.turnSteers = [steerText]
  managed.acceptedSteers = new Map([[steerId, {
    message: steerText, messageId: steerId, optimisticMessageId: 'source-owned-steer',
    options: { optimisticMessageId: 'source-owned-steer' },
  }]])
  await saveSessionStrict({
    id: managed.id, name: 'Existing chat', workspaceRootPath: root, projectId: managed.projectId,
    createdAt: 1, lastUsedAt: 1, messages: managed.messages.map(messageToStored),
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  const config = {
    provider: 'pi' as const, isHeadless: true, workspace, model: 'isolated-model',
    session: { id: managed.id, projectId: managed.projectId, workspaceRootPath: root, createdAt: 1, lastUsedAt: 1 },
  }
  const retryAgent = new PiAgent(config)
  fixtures.push({ root, managed, agents: [retryAgent] })
  const retry = retryAgent as unknown as PiHarness
  const sent: Record<string, unknown>[] = []
  retry.send = message => { sent.push(message); throw new Error('Provider/child execution forbidden') }
  const calls: string[] = []
  harness.getOrCreateAgent = async () => {
    calls.push(managed.lastSentMessage!)
    managed.agent = retryAgent
    return retryAgent
  }
  // Inspect the recovery boundary before the normal queue drain retries it.
  // The source timer still calls the real sendMessage/Pi producer directly.
  harness.processNextQueuedMessage = () => {}
  await harness.processEvent(managed, { type: 'source_activated', sourceSlug: 'github', originalMessage: originalText })
  await harness.processEvent(managed, { type: 'steer_undelivered', message: steerText, messageId: steerId })
  expect(managed.autoRetryPending?.ownedSteers?.map(entry => entry.messageId)).toEqual([steerId])
  await waitUntil(() => calls.length === 1 && !managed.isProcessing)
  await sm.flushSession(managed.id)
  expect(calls[0]).toContain(originalText)
  expect(calls[0]).toContain(steerText)
  expect(sent).toHaveLength(0)
  expect(events.some(event => event.type === 'error' && event.error.includes('piServerPath not configured'))).toBe(true)
  const recovered = managed.messageQueue.filter(entry => entry.messageId === steerId)
  expect(recovered).toHaveLength(1)
  expect(recovered[0]!.message).toBe(steerText)
  expect(recovered[0]!.optimisticMessageId).toBe('source-owned-steer')
  expect(managed.messages.find(message => message.id === steerId)).toMatchObject({ content: steerText, isQueued: true })
  expect(loadSession(root, managed.id)?.messages.find(message => message.id === steerId)).toMatchObject({ content: steerText, isQueued: true })
}, 5_000)
