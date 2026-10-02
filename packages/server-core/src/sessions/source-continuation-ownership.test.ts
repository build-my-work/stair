import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, StoredAttachment } from '@craft-agent/core/types'
import type { FileAttachment, SendMessageOptions, SessionEvent } from '@craft-agent/shared/protocol'

// Seed an isolated profile before importing modules that resolve CONFIG_DIR.
// The real SM and PendingSteers persist transcripts; the backend never calls a provider.
const profile = mkdtempSync(join(tmpdir(), 'stair-source-ownership-profile-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(join(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
// CONFIG_DIR is process-cached; keep defaults available to subsequent suites.
process.once('exit', () => rmSync(profile, { recursive: true, force: true }))
const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSession, loadSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { PendingSteers } = await import('@craft-agent/shared/agent/backend/claude/pending-steers')
const { storedToMessage } = await import('@craft-agent/core/types')

const originalText = 'Find open issues and explain them'
const steerText = 'Use Chinese'
const followUpText = 'Instead summarize the issue list'
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await sleep(5)
  expect(predicate()).toBe(true)
}

async function setup(id: string, holdSourceClose = false, keepSteeringWhileSourceCloses = false) {
  const ws = mkdtempSync(join(tmpdir(), 'stair-source-ownership-ws-'))
  const workspace = createWorkspaceAtPath(ws, 'Source continuation ownership')
  const sm = new SessionManager()
  const managed = createManagedSession(
    { id, name: 'Existing chat', projectId: workspace.defaultProjectId },
    { ...workspace, rootPath: ws },
    { messagesLoaded: true },
  )
  const internals = sm as unknown as {
    sessions: Map<string, typeof managed>
    decisionFeatureActive: () => boolean
    getOrCreateAgent: () => Promise<unknown>
  }
  internals.sessions.set(id, managed)
  internals.decisionFeatureActive = () => false
  const events: SessionEvent[] = []
  let onSourceEvent: (() => void) | undefined
  sm.setEventSink((_channel, _target, event) => {
    events.push(structuredClone(event as SessionEvent))
    if ((event as SessionEvent).type === 'source_activated') onSourceEvent?.()
  })
  await saveSession({
    id, name: 'Existing chat', workspaceRootPath: ws, projectId: managed.projectId,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })

  const pendingSteers = new PendingSteers()
  let releaseActivation!: () => void
  const activation = new Promise<void>(resolve => { releaseActivation = resolve })
  let releaseClose!: () => void
  const closing = new Promise<void>(resolve => { releaseClose = resolve })
  let releaseFollowUp!: () => void
  const followUp = new Promise<void>(resolve => { releaseFollowUp = resolve })
  const calls: { text: string; ids: string[] }[] = []
  let firstStarted = false
  let sourceCleanupEntered = false
  let failAgentSetup = false
  let failBeforeFirstEvent = false
  let holdFollowUp = false
  const agent = {
    getModel: () => 'no-model',
    setAllSources: () => {},
    setSourceServers: async () => {},
    getSessionId: () => undefined,
    isCompactionInFlight: () => false,
    redirect: (message: string, metadata: { messageId?: string }) => pendingSteers.enqueue({ message, ...metadata }),
    takePendingSteers: () => pendingSteers.drain(),
    forceAbort: () => pendingSteers.pause(),
    chat: (text: string) => {
      calls.push({ text, ids: [...(managed.lastSentMessageIds ?? [])] })
      const first = calls.length === 1
      return pendingSteers.runTurn((async function* (): AsyncGenerator<AgentEvent> {
        if (first) {
          yield { type: 'input_accepted' }
          firstStarted = true
          await activation
          yield { type: 'source_activated', sourceSlug: 'github', originalMessage: text }
          // Claude pauses after yielding activation. Returning its SDK iterator
          // can await cleanup before PendingSteers' finally drains accepted input.
          if (!keepSteeringWhileSourceCloses) pendingSteers.pause()
          sourceCleanupEntered = true
          if (holdSourceClose) await closing
          pendingSteers.pause()
          return
        }
        if (failBeforeFirstEvent && text.includes('[github activated]')) {
          failBeforeFirstEvent = false
          throw new Error('isolated continuation iterator failure')
        }
        if (holdFollowUp && text === followUpText) await followUp
        yield { type: 'input_accepted' }
        yield { type: 'status', message: 'no-model backend accepted the turn' }
        yield { type: 'complete' }
      })())
    },
  }
  internals.getOrCreateAgent = async () => {
    if (failAgentSetup && managed.lastSentMessage?.includes('[github activated]')) {
      failAgentSetup = false
      throw new Error('isolated continuation setup failure')
    }
    managed.agent = agent as never
    return agent
  }
  const original = sm.sendMessage(id, originalText)
  await waitUntil(() => firstStarted)
  await sm.sendMessage(id, steerText, undefined, undefined, { optimisticMessageId: 'optimistic-steer' })
  const steer = managed.messages.find(message => message.content === steerText)!
  expect(steer.id).toBeDefined()
  expect(managed.turnSteers).toEqual([steerText])
  const fixture = {
    ws, sm, managed, events, calls, pendingSteers, original, releaseActivation, releaseClose, releaseFollowUp, steerId: steer.id,
    get sourceCleanupEntered() { return sourceCleanupEntered },
    set onSourceEvent(value: (() => void) | undefined) { onSourceEvent = value },
    set failAgentSetup(value: boolean) { failAgentSetup = value },
    set failBeforeFirstEvent(value: boolean) { failBeforeFirstEvent = value },
    set holdFollowUp(value: boolean) { holdFollowUp = value },
  }
  cleanups.push(async () => {
    if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
    managed.autoRetryPending = undefined
    managed.pendingActivationResend = undefined
    managed.messageQueue = []
    managed.stopEpoch = (managed.stopEpoch ?? 0) + 1
    pendingSteers.pause()
    releaseActivation()
    releaseClose()
    releaseFollowUp()
    await original.catch(() => {})
    await sleep(10)
    await sessionPersistenceQueue.flushAll()
    rmSync(ws, { recursive: true, force: true })
  })
  return fixture
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

test('hidden source retry preserves the visible and durable steer ID, including fresh quote validation', async () => {
  const fixture = await setup('owned-steer-history')
  fixture.releaseActivation()
  await fixture.original
  await waitUntil(() => fixture.calls.length === 2 && !fixture.managed.isProcessing)
  await fixture.sm.flushSession(fixture.managed.id)

  expect(fixture.calls[1]!.text).toBe(`${originalText}\n\n${steerText}\n\n[github activated]`)
  const reloadedMessages = loadSession(fixture.ws, fixture.managed.id)!.messages.map(storedToMessage)
  for (const messages of [fixture.managed.messages, reloadedMessages]) {
    const original = messages.filter(message => message.id === fixture.steerId)
    expect(original).toHaveLength(1)
    expect(original[0]).toMatchObject({ content: steerText, isQueued: false })
    expect(original[0]!.hidden).not.toBe(true)
    expect(messages.find(message => message.content.includes('[github activated]'))?.hidden).toBe(true)
  }
  await fixture.sm.sendMessage(fixture.managed.id, 'Explain this correction', undefined, undefined, {
    references: [{
      version: 1, kind: 'chat-message', projectId: fixture.managed.projectId,
      sessionId: fixture.managed.id, messageId: fixture.steerId, role: 'user', quote: steerText,
      locator: { type: 'text-quote', exact: steerText, start: 0, end: steerText.length },
    }],
  })
  expect(fixture.calls[2]!.text).toContain(steerText)
})

test('fresh input cancels pending activation and replays distinct identical steers in original ID order', async () => {
  const fixture = await setup('owned-steer-new-input')
  let secondId!: string
  await fixture.sm.sendMessage(fixture.managed.id, steerText, undefined, undefined,
    { optimisticMessageId: 'optimistic-second' }, undefined, undefined, id => { secondId = id })
  fixture.releaseActivation()
  await fixture.original
  expect(fixture.managed.autoRetryPending?.ownedSteers?.map(payload => payload.messageId)).toEqual([fixture.steerId, secondId])
  let followUpId!: string
  await fixture.sm.sendMessage(fixture.managed.id, followUpText, undefined, undefined,
    undefined, undefined, undefined, id => { followUpId = id })
  await waitUntil(() => fixture.calls.length === 4 && !fixture.managed.isProcessing)
  expect(fixture.calls.slice(1)).toEqual([
    { text: steerText, ids: [fixture.steerId] },
    { text: steerText, ids: [secondId] },
    { text: followUpText, ids: [followUpId] },
  ])
  expect(fixture.events.filter(event => event.type === 'user_message' && event.status === 'processing')
    .map(event => event.type === 'user_message' ? event.optimisticMessageId : undefined)).toContain('optimistic-second')
  expect(fixture.managed.autoRetryPending).toBeUndefined()
})

test('Stop during SDK cleanup restores owned and already queued payloads with original IDs and metadata', async () => {
  const fixture = await setup('owned-steer-stop', true)
  const attachmentPath = join(fixture.ws, 'note.txt')
  writeFileSync(attachmentPath, 'attachment content')
  const attachments: FileAttachment[] = [{ name: 'note.txt', type: 'text', mimeType: 'text/plain', text: 'attachment content', path: attachmentPath, size: 18 }]
  const storedAttachments: StoredAttachment[] = [{ id: 'stored-note', name: 'note.txt', type: 'text', mimeType: 'text/plain', size: 18, storedPath: join(fixture.ws, 'note.txt') }]
  const references: NonNullable<SendMessageOptions['references']> = [{
    version: 1, kind: 'chat-message', projectId: fixture.managed.projectId,
    sessionId: fixture.managed.id, messageId: fixture.steerId, role: 'user', quote: steerText,
    locator: { type: 'text-quote', exact: steerText, start: 0, end: steerText.length },
  }]
  let queuedId!: string
  await fixture.sm.sendMessage(fixture.managed.id, 'Inspect attachment', attachments, storedAttachments,
    { references, skillSlugs: ['inspection'], optimisticMessageId: 'optimistic-file' },
    undefined, undefined, id => { queuedId = id })
  fixture.releaseActivation()
  await waitUntil(() => fixture.sourceCleanupEntered)
  expect(fixture.managed.isProcessing).toBe(true)
  await fixture.sm.cancelProcessing(fixture.managed.id)
  fixture.releaseClose()
  await fixture.original
  await fixture.sm.flushSession(fixture.managed.id)

  const interrupted = fixture.events.find(event => event.type === 'interrupted')
  expect(interrupted?.type).toBe('interrupted')
  if (interrupted?.type !== 'interrupted') return
  expect(interrupted.queuedMessages).toEqual([steerText, 'Inspect attachment'])
  expect(interrupted.queuedMessageIds).toEqual([fixture.steerId, queuedId])
  expect(interrupted.queuedReferences).toEqual(references)
  expect(interrupted.queuedAttachments).toEqual(storedAttachments)
  expect(interrupted.queuedRestoreId).toBeDefined()
  for (const messages of [fixture.managed.messages, loadSession(fixture.ws, fixture.managed.id)!.messages]) {
    expect(messages.filter(message => [fixture.steerId, queuedId].includes(message.id)).map(message => ({
      id: message.id, isQueued: message.isQueued, restoreId: message.queuedRestoreId,
    }))).toEqual([fixture.steerId, queuedId].map(id => ({ id, isQueued: true, restoreId: interrupted.queuedRestoreId })))
  }
  expect(fixture.calls.map(call => call.text)).toEqual([originalText])
})

test('Stop after source cleanup restores input without its watchdog stopping a later user turn', async () => {
  const fixture = await setup('owned-steer-idle-stop')
  fixture.releaseActivation()
  await fixture.original
  expect(fixture.managed.isProcessing).toBe(false)
  await fixture.sm.cancelProcessing(fixture.managed.id)
  const interrupted = fixture.events.find(event => event.type === 'interrupted')
  expect(interrupted?.type === 'interrupted' && interrupted.queuedMessageIds).toEqual([fixture.steerId])
  fixture.holdFollowUp = true
  const next = fixture.sm.sendMessage(fixture.managed.id, followUpText)
  await waitUntil(() => fixture.calls.length === 2)
  await sleep(5150)
  expect(fixture.managed.isProcessing).toBe(true)
  fixture.releaseFollowUp()
  await next
  expect(fixture.calls.map(call => call.text)).toEqual([originalText, followUpText])
}, 10000)

test('steer admitted while source activation is emitted joins the authoritative retry text', async () => {
  // Pi's event queue can publish activation while its turn is still accepting
  // steering. The admission already started when the event reaches the host.
  const fixture = await setup('owned-steer-late', true, true)
  let lateId!: string
  let lateSend: Promise<void> | undefined
  fixture.onSourceEvent = () => {
    lateSend = fixture.sm.sendMessage(fixture.managed.id, 'Use bullet points', undefined, undefined,
      { optimisticMessageId: 'optimistic-late' }, undefined, undefined, id => { lateId = id })
  }
  fixture.releaseActivation()
  await waitUntil(() => fixture.sourceCleanupEntered)
  await lateSend
  expect(fixture.events.some(event => event.type === 'user_message'
    && event.message.id === lateId && event.status === 'accepted')).toBe(true)
  fixture.releaseClose()
  await fixture.original
  await waitUntil(() => fixture.calls.length === 2 && !fixture.managed.isProcessing)
  expect(fixture.calls[1]!.text).toBe(`${originalText}\n\n${steerText}\n\nUse bullet points\n\n[github activated]`)
  expect(fixture.managed.messages.find(message => message.id === lateId)).toMatchObject({
    content: 'Use bullet points', isQueued: false,
  })
})

test('continuation setup failure recovers its owned payload through normal replay', async () => {
  const fixture = await setup('owned-steer-setup-error')
  fixture.failAgentSetup = true
  fixture.releaseActivation()
  await fixture.original
  await waitUntil(() => fixture.calls.length === 2 && !fixture.managed.isProcessing)
  expect(fixture.calls[1]).toEqual({ text: steerText, ids: [fixture.steerId] })
  expect(fixture.managed.autoRetryPending).toBeUndefined()
})

test('a legacy retry that wins admission also recovers owned input when setup fails', async () => {
  const fixture = await setup('owned-steer-legacy-error')
  fixture.failAgentSetup = true
  fixture.releaseActivation()
  await fixture.original
  await expect(fixture.sm.sendMessage(fixture.managed.id, `${originalText}\n\n[github activated]`))
    .rejects.toThrow('isolated continuation setup failure')
  await waitUntil(() => fixture.calls.length === 2 && !fixture.managed.isProcessing)
  expect(fixture.calls[1]).toEqual({ text: steerText, ids: [fixture.steerId] })
  expect(fixture.managed.autoRetryPending).toBeUndefined()
})

test('continuation iterator failure before first handoff recovers its owned payload', async () => {
  const fixture = await setup('owned-steer-iterator-error')
  fixture.failBeforeFirstEvent = true
  fixture.releaseActivation()
  await fixture.original
  await waitUntil(() => fixture.calls.length === 3 && !fixture.managed.isProcessing)
  expect(fixture.calls[2]).toEqual({ text: steerText, ids: [fixture.steerId] })
  expect(fixture.managed.autoRetryPending).toBeUndefined()
})

test('a continuation queued during SDK cleanup still replays after the legacy dedup deadline', async () => {
  const fixture = await setup('owned-steer-delayed-close', true)
  fixture.releaseActivation()
  await waitUntil(() => fixture.managed.messageQueue.some(payload => payload.options?.hidden === true))
  const continuationId = fixture.managed.autoRetryPending!.deliveryMessageId!
  await sleep(2050)
  fixture.releaseClose()
  await fixture.original
  await waitUntil(() => fixture.calls.length === 2 && !fixture.managed.isProcessing)
  expect(fixture.calls[1]).toEqual({
    text: `${originalText}\n\n${steerText}\n\n[github activated]`, ids: [continuationId],
  })
  expect(fixture.managed.messages.find(message => message.id === fixture.steerId)?.isQueued).toBe(false)
})

test('fresh input during SDK cleanup cancels an already queued hidden continuation', async () => {
  const fixture = await setup('owned-steer-cancel-queued', true)
  fixture.releaseActivation()
  await waitUntil(() => fixture.managed.messageQueue.some(payload => payload.options?.hidden === true))
  const continuationId = fixture.managed.autoRetryPending!.deliveryMessageId!
  let followUpId!: string
  await fixture.sm.sendMessage(fixture.managed.id, followUpText, undefined, undefined,
    undefined, undefined, undefined, id => { followUpId = id })
  expect(fixture.managed.messageQueue.map(payload => payload.messageId)).toEqual([fixture.steerId, followUpId])
  expect(fixture.managed.messages.find(message => message.id === continuationId)?.isQueued).toBe(false)
  fixture.releaseClose()
  await fixture.original
  await waitUntil(() => fixture.calls.length === 3 && !fixture.managed.isProcessing)
  expect(fixture.calls.slice(1)).toEqual([
    { text: steerText, ids: [fixture.steerId] }, { text: followUpText, ids: [followUpId] },
  ])
})
