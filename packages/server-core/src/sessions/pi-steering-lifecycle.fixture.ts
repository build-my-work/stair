import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import type { Message } from '@craft-agent/core/types'

const profile = mkdtempSync(join(tmpdir(), 'pi-steering-lifecycle-profile-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(resolve(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
writeFileSync(join(profile, 'config.json'), JSON.stringify({
  workspaces: [], defaultLlmConnection: 'offline-pi',
  llmConnections: [{ slug: 'offline-pi', name: 'Offline Pi', providerType: 'pi_compat',
    authType: 'api_key_with_endpoint', baseUrl: 'https://pi-steering.invalid', piAuthProvider: 'openai',
    customEndpoint: { api: 'openai-completions' }, defaultModel: 'offline-model',
    models: [{ id: 'offline-model', name: 'Offline', contextWindow: 64000, supportsImages: true }], createdAt: 1 }],
}))
const { SessionManager, createManagedSession, setSessionPlatform } = await import('./SessionManager.ts')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSessionStrict, loadSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { PiAgent } = await import('@craft-agent/shared/agent/pi-agent')
setSessionPlatform({
  appRootPath: resolve(import.meta.dir, '../../../..'), resourcesPath: profile,
  isPackaged: false, appVersion: 'test', isDebugMode: false,
  imageProcessor: { getMetadata: async () => null, process: async () => { throw new Error('No native image access') } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
})

const roots: string[] = []
const agents: InstanceType<typeof PiAgent>[] = []
afterAll(async () => {
  for (const agent of agents) { (agent as any).subprocess = null; agent.destroy() }
  await sessionPersistenceQueue.flushAll()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
})

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5)
  expect(condition()).toBe(true)
}

async function fixture(id: string) {
  const root = mkdtempSync(join(tmpdir(), 'pi-steering-lifecycle-ws-'))
  roots.push(root)
  const workspace = { ...createWorkspaceAtPath(root, 'Pi steering lifecycle'), rootPath: root }
  const sm = new SessionManager()
  const managed = createManagedSession({ id, name: 'Existing chat', projectId: workspace.defaultProjectId,
    llmConnection: 'offline-pi' }, workspace, { messagesLoaded: true })
  const host = sm as any
  host.sessions.set(id, managed)
  host.decisionFeatureActive = () => false
  host.startPreTurnDecisions = () => null
  host.decideMidTurnDelivery = async () => 'steer'
  const events: any[] = []
  sm.setEventSink((_channel, _target, event) => events.push(structuredClone(event)))
  await saveSessionStrict({ id, name: 'Existing chat', workspaceRootPath: root, projectId: managed.projectId,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
  return { root, workspace, sm, host, managed, events }
}

async function queuedFixture(id: string) {
  const f = await fixture(id)
  const user: Message = { id: `${id}-input`, role: 'user', content: 'correction', timestamp: 1, isQueued: true }
  const payload = { messageId: user.id, message: user.content }
  f.managed.messages.push(user)
  f.managed.messageQueue.push(payload)
  f.managed.isProcessing = true
  const redirected: Array<{ text: string; disk: unknown }> = []
  f.managed.agent = {
    canSteerNow: () => true, takePendingSteers: () => [], settlePendingSteers: async () => [],
    redirect: (text: string) => {
      redirected.push({ text, disk: loadSession(f.root, id)?.messages.find(message => message.id === user.id) })
      return true
    },
  } as unknown as AgentBackend
  f.host.persistSession(f.managed)
  await f.host.flushSessionStrict(id)
  return { ...f, user, payload, redirected }
}

test('a decided steer persists uncertain delivery before the SDK can consume it', async () => {
  const f = await queuedFixture('decided-durable')
  await f.host.steerQueuedIfDecided(f.managed, f.payload, f.user, 'queue')
  expect(f.redirected).toHaveLength(1)
  expect(f.redirected[0]!.disk).toMatchObject({ id: f.user.id, pendingDelivery: true })
  expect(f.managed.messageQueue).toEqual([])
  expect(f.managed.acceptedSteers?.get(f.user.id)).toBe(f.payload)
  expect(f.user.pendingDelivery).toBe(true)
})

test.each(['stop', 'generation', 'agent', 'queue', 'continuation'] as const)(
  'a decided steer rechecks %s ownership after its durable write', async (change) => {
    const f = await queuedFixture(`decided-${change}`)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const flush = f.host.flushSessionStrict.bind(f.sm)
    f.host.flushSessionStrict = async (id: string) => { await flush(id); entered.resolve(); await release.promise }
    const work = f.host.steerQueuedIfDecided(f.managed, f.payload, f.user, 'steer')
    await entered.promise
    if (change === 'stop') f.managed.stopEpoch = (f.managed.stopEpoch ?? 0) + 1
    if (change === 'generation') f.managed.processingGeneration++
    if (change === 'agent') f.managed.agent = { canSteerNow: () => true } as unknown as AgentBackend
    if (change === 'queue') f.managed.messageQueue = []
    if (change === 'continuation') f.managed.messageQueue.push({ message: 'continued', mergeWith: f.payload })
    release.resolve()
    await work
    expect(f.redirected).toEqual([])
    expect(f.managed.acceptedSteers?.size ?? 0).toBe(0)
    if (change !== 'queue') expect(f.user.pendingDelivery).toBeUndefined()
  },
)

test('a failed decided-steer write keeps the known unsubmitted payload queued', async () => {
  const f = await queuedFixture('decided-save-failure')
  f.host.flushSessionStrict = async () => { throw new Error('controlled write failure') }
  await f.host.steerQueuedIfDecided(f.managed, f.payload, f.user, 'steer')
  expect(f.redirected).toEqual([])
  expect(f.managed.messageQueue).toEqual([f.payload])
  expect(f.user.pendingDelivery).toBeUndefined()
})

test.each([false, 'throw'] as const)('a decided steer handles redirect %s without losing or silently replaying input', async (result) => {
  const f = await queuedFixture(`decided-redirect-${result}`)
  f.managed.agent!.redirect = () => { if (result === 'throw') throw new Error('delivery unknown'); return false }
  await f.host.steerQueuedIfDecided(f.managed, f.payload, f.user, 'steer')
  if (result === false) {
    expect(f.managed.messageQueue).toEqual([f.payload])
    expect(f.user.pendingDelivery).toBeUndefined()
    expect(f.managed.acceptedSteers?.size ?? 0).toBe(0)
  } else {
    expect(f.managed.messageQueue).toEqual([])
    expect(f.user.pendingDelivery).toBe(true)
    expect(f.managed.acceptedSteers?.get(f.user.id)).toBe(f.payload)
  }
})

async function livePiFixture(id: string) {
  const f = await fixture(id)
  const agent = new PiAgent({ provider: 'pi', providerType: 'pi_compat', authType: 'api_key',
    model: 'offline-model', workspace: f.workspace, isHeadless: true,
    session: { id, workspaceRootPath: f.root, projectId: f.managed.projectId, createdAt: 1, lastUsedAt: 1 } })
  agents.push(agent)
  f.managed.agent = agent
  f.host.getOrCreateAgent = async () => agent
  const pi = agent as any
  pi.ensureSubprocess = async () => {}
  pi.subprocess = { stdin: { writable: true } }
  const commands: Record<string, any>[] = []
  const prompts: Record<string, any>[] = []
  pi.send = (command: Record<string, any>) => {
    commands.push(command)
    if (command.type === 'prompt') {
      prompts.push(command)
      pi.handleLine(JSON.stringify({ type: 'prompt_accepted', id: command.id }))
      if (prompts.length > 1) {
        pi.eventQueue.enqueue({ type: 'complete' })
        pi.eventQueue.complete()
      }
    }
  }
  const first = f.sm.sendMessage(id, 'initial')
  await waitFor(() => prompts.length === 1 && f.managed.messages[0]?.pendingDelivery === undefined)
  return { ...f, agent, pi, commands, prompts, first }
}

test('Stop consumes a late matching receipt, restores only the pending steer and gates new sends behind its barrier', async () => {
  const f = await livePiFixture('stop-receipts')
  await f.sm.sendMessage(f.managed.id, 'consumed late')
  await f.sm.sendMessage(f.managed.id, 'not consumed')
  const steers = f.commands.filter(command => command.type === 'steer')
  expect(steers).toHaveLength(2)
  const stopping = f.sm.cancelProcessing(f.managed.id)
  await waitFor(() => f.commands.some(command => command.type === 'settle_steers'))
  const barrier = f.commands.find(command => command.type === 'settle_steers')!
  const sending = f.sm.sendMessage(f.managed.id, 'next input')
  await Bun.sleep(10)
  expect(f.prompts).toHaveLength(1)
  expect(f.managed.messages.some(message => message.content === 'next input')).toBe(false)
  f.pi.handleLine(JSON.stringify({ type: 'steer_consumed', id: steers[0]!.id }))
  f.pi.handleLine(JSON.stringify({ type: 'steers_settled', id: barrier.id, success: true, pendingIds: [steers[1]!.id] }))
  await stopping
  await f.first
  await sending
  await waitFor(() => !f.managed.isProcessing)
  expect(f.prompts).toHaveLength(2)
  expect(f.events.filter(event => event.type === 'interrupted').flatMap(event => event.queuedMessages ?? []))
    .toEqual(['not consumed'])
  await f.sm.flushSession(f.managed.id)
  const disk = loadSession(f.root, f.managed.id)!
  expect(disk.messages.find(message => message.id === steers[0]!.messageId)?.pendingDelivery).toBeUndefined()
  expect(disk.messages.find(message => message.id === steers[0]!.messageId)?.queuedRestoreId).toBeUndefined()
  expect(disk.messages.find(message => message.id === steers[1]!.messageId)?.queuedRestoreId).toBeString()
  expect(disk.messages.find(message => message.content === 'next input')?.pendingDelivery).toBeUndefined()
})

test('a failed Stop barrier preserves unknown input for manual recovery and never auto-replays it after reload', async () => {
  const f = await livePiFixture('stop-unknown')
  await f.sm.sendMessage(f.managed.id, 'uncertain input')
  const steer = f.commands.find(command => command.type === 'steer')!
  const send = f.pi.send
  f.pi.send = (command: Record<string, any>) => {
    send(command)
    if (command.type === 'settle_steers') queueMicrotask(() => f.pi.handleLine(JSON.stringify({
      type: 'steers_settled', id: command.id, success: false, errorMessage: 'delivery is uncertain',
    })))
  }
  const stopping = f.sm.cancelProcessing(f.managed.id)
  await expect(stopping).rejects.toThrow('delivery is uncertain')
  await f.first
  await waitFor(() => !f.managed.isProcessing)
  expect(f.prompts).toHaveLength(1)
  expect(f.agent.takePendingSteers()).toEqual([])
  await f.sm.flushSession(f.managed.id)
  const disk = loadSession(f.root, f.managed.id)!
  expect(disk.messages.find(message => message.id === steer.messageId)).toMatchObject({
    content: 'uncertain input', queuedRestoreId: expect.any(String),
  })
  const cold = new SessionManager()
  const coldManaged = createManagedSession({ id: f.managed.id, name: 'Existing chat', projectId: f.managed.projectId },
    f.workspace, { messagesLoaded: false })
  ;(cold as any).sessions.set(coldManaged.id, coldManaged)
  const coldEvents: any[] = []
  cold.setEventSink((_channel, _target, event) => coldEvents.push(event))
  let replayed = false
  ;(cold as any).getOrCreateAgent = async () => { replayed = true; throw new Error('Unexpected automatic replay') }
  await cold.getSession(coldManaged.id)
  expect(coldManaged.messageQueue).toEqual([])
  expect(replayed).toBe(false)
  expect(coldEvents.some(event => event.type === 'interrupted' && event.queuedMessages?.includes('uncertain input'))).toBe(true)
})

test('concurrent Stop callers observe the same delivery-confirmation failure', async () => {
  const f = await livePiFixture('concurrent-stop-failure')
  await f.sm.sendMessage(f.managed.id, 'uncertain input')
  const send = f.pi.send
  f.pi.send = (command: Record<string, any>) => {
    send(command)
    if (command.type === 'settle_steers') queueMicrotask(() => f.pi.handleLine(JSON.stringify({
      type: 'steers_settled', id: command.id, success: false, errorMessage: 'delivery is uncertain',
    })))
  }
  const results = await Promise.allSettled([
    f.sm.cancelProcessing(f.managed.id), f.sm.cancelProcessing(f.managed.id),
  ])
  await f.first
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(f.agent.takePendingSteers()).toEqual([])
})

test('natural completion recovers a definitely undelivered Pi steer before replaying it once', async () => {
  const f = await livePiFixture('natural-undelivered')
  await f.sm.sendMessage(f.managed.id, 'last-moment correction')
  const steer = f.commands.find(command => command.type === 'steer')!
  f.pi.eventQueue.enqueue({ type: 'complete' })
  f.pi.eventQueue.complete()
  await waitFor(() => f.commands.some(command => command.type === 'settle_steers'))
  const barrier = f.commands.find(command => command.type === 'settle_steers')!
  f.pi.handleLine(JSON.stringify({ type: 'steers_settled', id: barrier.id, success: true, pendingIds: [steer.id] }))
  await f.first
  await waitFor(() => f.prompts.length === 2 && !f.managed.isProcessing)
  expect(f.prompts[1]!.message).toContain('last-moment correction')
  expect(f.events.some(event => event.type === 'interrupted' && event.queuedMessages?.includes('last-moment correction'))).toBe(false)
  await f.sm.flushSession(f.managed.id)
  const disk = loadSession(f.root, f.managed.id)!
  expect(disk.messages.filter(message => message.id === steer.messageId)).toHaveLength(1)
  expect(disk.messages.find(message => message.id === steer.messageId)?.pendingDelivery).toBeUndefined()
})

test('reconciliation of a known input cannot deadlock behind its duplicate sender', async () => {
  const f = await fixture('reconcile-duplicate-lock')
  f.managed.messages.push({ id: 'owned-input', clientMessageId: 'same-client-input', role: 'user',
    content: 'already owned', timestamp: 1 })
  f.host.persistSession(f.managed)
  await f.host.flushSessionStrict(f.managed.id)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = f.host.withSessionLifecycleLock(f.managed.id, async () => { entered.resolve(); await release.promise })
  await entered.promise
  let answer: unknown
  let ack: string | undefined
  let reconciled = false
  let duplicateFinished = false
  let newTurns = 0
  f.host.getOrCreateAgent = async () => { newTurns++; throw new Error('A duplicate must not launch an agent') }
  const recovery = f.sm.reconcileInput(f.managed.id, 'same-client-input').then(result => { answer = result; reconciled = true })
  const duplicate = f.sm.sendMessage(f.managed.id, 'already owned', undefined, undefined,
    { optimisticMessageId: 'same-client-input' }, undefined, undefined, id => { ack = id })
    .then(() => { duplicateFinished = true })
  release.resolve()
  await held
  await waitFor(() => reconciled && duplicateFinished)
  await Promise.all([recovery, duplicate])
  expect(answer).toEqual({ state: 'owned', messageId: 'owned-input' })
  expect(ack).toBe('owned-input')
  expect(newTurns).toBe(0)
  expect(f.managed.messages).toHaveLength(1)
})
