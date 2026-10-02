import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentEvent, StoredMessage } from '@craft-agent/core/types'
import {
  getSessionFilePath,
  loadSession,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { getPendingPlanExecution, saveSession } from '../../../shared/src/sessions/storage.ts'
import * as backendFactory from '../../../shared/src/agent/backend/factory.ts'
import { ClaudeAgent } from '../../../shared/src/agent/claude-agent.ts'
import { PendingSteers } from '../../../shared/src/agent/backend/claude/pending-steers.ts'
import { createWorkspaceAtPath } from '@craft-agent/shared/workspaces'
import {
  SessionManager,
  createManagedSession,
  resolveMidStreamDeliveryOutcome,
  shouldAttemptMidStreamSteer,
  canSteerTextPayload,
} from './SessionManager.ts'
import { setSessionDraft as setSessionDraftForPlan } from '@craft-agent/shared/config'
import { formatReferencesForModel } from './message-references'

describe('mid-stream queue runtime invariants', () => {
  let tmpRoot: string
  let sm: SessionManager
  let workspaceId: string
  let defaultProjectId: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-midstream-'))
    const workspace = createWorkspaceAtPath(tmpRoot, 'Test Workspace')
    workspaceId = workspace.id
    defaultProjectId = workspace.defaultProjectId
    sm = new SessionManager()
  })

  afterEach(() => {
    mock.restore()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: workspaceId,
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'mid-stream test', projectId: defaultProjectId },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  it('distinguishes non-interrupting queue mode from a failed steer', () => {
    expect(resolveMidStreamDeliveryOutcome('queue', false)).toEqual({
      shouldQueue: true,
      wasInterrupted: false,
    })
    expect(resolveMidStreamDeliveryOutcome('steer', false)).toEqual({
      shouldQueue: true,
      wasInterrupted: true,
    })
    expect(resolveMidStreamDeliveryOutcome('steer', true)).toEqual({
      shouldQueue: false,
      wasInterrupted: false,
    })
  })

  it('queues instead of steering while a manual compaction owns the turn (#1058)', () => {
    const compacting = { isCompactionInFlight: () => true }
    const idle = { isCompactionInFlight: () => false }
    expect(shouldAttemptMidStreamSteer('steer', true, compacting)).toBe(false)
    expect(shouldAttemptMidStreamSteer('steer', true, idle)).toBe(true)
    // Backends without the concept behave as before.
    expect(shouldAttemptMidStreamSteer('steer', true, {})).toBe(true)
    expect(shouldAttemptMidStreamSteer('queue', true, idle)).toBe(false)
    expect(shouldAttemptMidStreamSteer('steer', false, idle)).toBe(false)
    expect(shouldAttemptMidStreamSteer('steer', true, undefined)).toBe(false)
    // The forced queue path is not an interruption: the compaction runs to
    // completion and the replayed turn must not claim it was cut off.
    expect(resolveMidStreamDeliveryOutcome('queue', false)).toEqual({ shouldQueue: true, wasInterrupted: false })

    // Claude reports a live /compact turn through its event adapter; a bare
    // prototype without an adapter reads as not compacting.
    const claude = Object.create(ClaudeAgent.prototype) as any
    claude.currentQuery = { interrupt: async () => {} }
    expect(claude.isCompactionInFlight()).toBe(false)
    claude.eventAdapter = { isManualCompactionRequested: () => true }
    expect(claude.isCompactionInFlight()).toBe(true)
    expect(shouldAttemptMidStreamSteer('steer', true, claude)).toBe(false)
    claude.currentQuery = null
    expect(claude.isCompactionInFlight()).toBe(false)
  })

  it('recovers distinct identical-text steers by identity without interrupting or duplicating', async () => {
    const managed = buildSession('recover')
    const payloads = ['a', 'b', 'c'].map(messageId => ({ message: 'same', messageId, optimisticMessageId: `optimistic-${messageId}` }))
    managed.messages = payloads.map(p => ({ id: p.messageId, content: p.message, role: 'user', timestamp: 1 }))
    ;(managed as any).acceptedSteers = new Map(payloads.map(p => [p.messageId, p]))
    ;(sm as any).persistSession = () => {}
    for (const p of payloads) await (sm as any).processEvent(managed, { type: 'steer_undelivered', message: p.message, messageId: p.messageId })
    expect(managed.messageQueue).toEqual(payloads)
    expect(managed.messages).toHaveLength(3)
    expect(managed.messages.every(m => m.isQueued)).toBe(true)
    expect(managed.wasInterrupted).not.toBe(true)
    await (sm as any).processEvent(managed, { type: 'steer_undelivered', message: 'same', messageId: 'a' })
    expect(managed.messageQueue).toHaveLength(3)
  })

  it('allows empty presentation metadata but queues semantic and future options', () => {
    expect(canSteerTextPayload([], [], { skillSlugs: [], badges: [], hidden: false, optimisticMessageId: 'id' })).toBe(true)
    expect(canSteerTextPayload(undefined, undefined, { skillSlugs: ['skill'] })).toBe(false)
    expect(canSteerTextPayload(undefined, undefined, { hidden: true })).toBe(false)
    expect(canSteerTextPayload(undefined, undefined, { futureOption: false } as any)).toBe(false)
    expect(canSteerTextPayload(undefined, [{ id: 'stored' }] as any)).toBe(false)
  })

  it('queues attachments and semantic options intact without calling a text-only redirect', async () => {
    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue({ providerType: 'pi', midStreamBehavior: 'steer' } as any)
    const managed = buildSession('attachments')
    managed.isProcessing = true
    const redirect = mock(() => true)
    managed.agent = { redirect } as any
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const attachments = [{ name: 'photo.png', type: 'image', mimeType: 'image/png', base64: 'image-bytes' }] as any
    const storedAttachments = [{ id: 'file', name: 'photo.png', type: 'image', storedPath: '/tmp/photo.png' }] as any
    const options = { skillSlugs: ['image-skill'], hidden: true, optimisticMessageId: 'optimistic' }
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    await sm.sendMessage(managed.id, 'inspect image', attachments, storedAttachments, options)
    expect(redirect).not.toHaveBeenCalled()
    expect(managed.wasInterrupted).not.toBe(true)
    expect(managed.messageQueue[0]).toMatchObject({ attachments, storedAttachments, options, messageId: managed.messages[0]!.id })
    expect(managed.messages[0]!.isQueued).toBe(true)
    expect(events.find(e => e.type === 'user_message').status).toBe('queued')
    // Also prove the existing supported replay path receives the same objects.
    const replay = mock(async (..._args: unknown[]) => {})
    ;(sm as any).sendMessage = replay
    ;(sm as any).processNextQueuedMessage(managed.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(replay.mock.calls[0]).toEqual([managed.id, 'inspect image', attachments, storedAttachments, options, managed.messages[0]!.id])
  })

  it('marks Accept & Compact ready only after a manual compaction success and preserves the fresh snapshot', async () => {
    const managed = buildSession('manual-compact-ready')
    managed.isProcessing = true
    managed.tokenUsage = { inputTokens: 419_000, outputTokens: 10, totalTokens: 419_010, contextTokens: 0, costUsd: 0 }
    await saveSession({ id: managed.id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: managed.tokenUsage } as any)
    await sm.setPendingPlanExecution(managed.id, '/tmp/plan.md', 'draft')
    // The record's /compact turn correlation (production: stamped+persisted by
    // the sendMessage that runs /compact). Only the record's own compaction
    // turn may ready it.
    const correlation = { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
    managed.pendingPlanExecution!.compactionTurn = correlation
    const stored = loadSession(tmpRoot, managed.id)!
    stored.pendingPlanExecution = managed.pendingPlanExecution as any
    await saveSession(stored)
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await (sm as any).processEvent(managed, { type: 'context_usage', contextUsage: { usedTokens: 12_000, limitTokens: 200_000, limitKind: 'compaction', isEstimate: true, isStale: false, canCompact: true } })
    await (sm as any).processEvent(managed, { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' })

    expect(getPendingPlanExecution(tmpRoot, managed.id)).toMatchObject({ awaitingCompaction: false, executionDispatched: false })
    expect(managed.tokenUsage.contextUsage?.usedTokens).toBe(12_000)
    expect(events.find(e => e.type === 'usage_update').tokenUsage.contextUsage.usedTokens).toBe(12_000)
    expect(events.find(e => e.type === 'info')).toMatchObject({ statusType: 'compaction_complete' })
    // The legacy claim path never consumes an identified record; the durable
    // dispatch is the only modern execution route.
    const executionId = (getPendingPlanExecution(tmpRoot, managed.id) as { executionId?: string } | null)?.executionId
    expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(false)
    managed.isProcessing = false
    // Verify durable admission here without starting a provider turn.
    ;(sm as any).processNextQueuedMessage = () => {}
    const dispatched = await sm.dispatchPendingPlanExecution(managed.id, executionId)
    expect(dispatched).toEqual({ ok: true })
  })

  it('does not release pending plan execution for auto or failed compaction outcomes', async () => {
    for (const [id, event] of [
      ['auto-compact', { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'auto' }],
      ['failed-compact', { type: 'compaction_failed' }],
    ] as const) {
      const managed = buildSession(id)
      await saveSession({ id: managed.id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any)
      await sm.setPendingPlanExecution(managed.id, '/tmp/plan.md', 'draft')
      // Correlate the record's own compaction turn: the manual failure below
      // must cancel it (and restore the consumed draft), while an automatic
      // completion never releases it.
      const correlation = { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
      managed.pendingPlanExecution!.compactionTurn = correlation
      const stored = loadSession(tmpRoot, managed.id)!
      stored.pendingPlanExecution = managed.pendingPlanExecution as any
      await saveSession(stored)
      ;(sm as any).persistSession = () => {}
      await (sm as any).processEvent(managed, event)
      managed.isProcessing = false
      expect(await sm.markPendingPlanExecutionDispatched(managed.id)).toBe(false)
      const pending = getPendingPlanExecution(tmpRoot, managed.id)
      if (id === 'auto-compact') {
        expect(pending).toMatchObject({ awaitingCompaction: true, executionDispatched: false })
      } else {
        // A failed manual compaction leaves a terminally non-executable
        // outbox (recoverable snapshot) — never released, never cleared by
        // input. (This suite stubs persistSession, so the live record is the
        // assertion target; the stored-copy persistence is covered by the
        // pending-plan suite.)
        expect(managed.pendingPlanExecution).toMatchObject({ awaitingCompaction: true, executionDispatched: false, failed: true })
      }
    }
  })

  it('keeps the pending plan through /compact and durably hands off after success', async () => {
    const managed = buildSession('send-compact')
    await saveSession({ id: managed.id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any)
    await sm.setPendingPlanExecution(managed.id, '/tmp/plan.md', 'draft snapshot')
    // Production flow: the draft is atomically consumed (receipt recorded)
    // before the /compact is submitted — the receipt is what ties THIS
    // record's compact correlation to the command.
    setSessionDraftForPlan(managed.id, { text: 'draft snapshot' })
    const consumed = await sm.consumePendingPlanDraft(managed.id, managed.pendingPlanExecution!.executionId!)
    expect(consumed?.receipt.text).toBe(true)
    const executionId = managed.pendingPlanExecution!.executionId
    const agent = {
      getModel: () => 'claude-sonnet-4-6',
      setAllSources: () => {},
      getSessionId: () => 'sdk-session',
      chat: async function* () {
        expect(managed.pendingPlanExecution).toMatchObject({ executionId, awaitingCompaction: true, executionDispatched: false })
        yield { type: 'context_usage', contextUsage: { usedTokens: 12_000, limitTokens: 200_000, limitKind: 'compaction', isEstimate: true, isStale: false, canCompact: true } }
        yield { type: 'info', message: 'Compacted Conversation', compactionTrigger: 'manual' }
        yield { type: 'complete' }
      },
    }
    ;(sm as any).getOrCreateAgent = async () => agent
    // Inspect the durable approval admission without starting a provider turn.
    ;(sm as any).processNextQueuedMessage = () => {}
    sm.setEventSink(() => {})
    await sm.sendMessage(managed.id, '/compact', undefined, undefined, { planExecutionId: managed.pendingPlanExecution!.executionId })
    const pending = getPendingPlanExecution(tmpRoot, managed.id)
    expect(pending).toMatchObject({ executionId, awaitingCompaction: false, executionDispatched: true })
    expect(managed.messages.filter(message => message.id === pending?.approvalMessageId)).toHaveLength(1)
    expect(managed.messageQueue[0]).toMatchObject({ messageId: pending?.approvalMessageId })
  })

  it('the actual host sendMessage loop consumes Claude recovery before stopping at complete', async () => {
    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue({ providerType: 'pi', midStreamBehavior: 'steer' } as any)
    const managed = buildSession('host-completion')
    managed.sdkSessionId = 'offline-sdk'
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.pendingSteers = new PendingSteers()
    agent.currentQuery = { interrupt: async () => {} }
    agent.currentQueryAbortController = new AbortController()
    agent.debug = () => {}
    agent.getModel = () => 'claude-sonnet-4-6'
    agent.setAllSources = () => {}
    agent.getSessionId = () => 'offline-sdk'
    agent.chat = agent.chatImpl.bind(agent)
    const acceptedIds: string[] = []
    agent.chatTurn = async function* () {
      for (const id of ['a', 'b', 'c']) {
        await sm.sendMessage(managed.id, 'same', undefined, undefined, { optimisticMessageId: `opt-${id}` })
        acceptedIds.push(managed.messages.at(-1)!.id)
      }
      yield { type: 'complete' }
    }
    managed.agent = agent
    ;(sm as any).getOrCreateAgent = async () => agent
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const stopped = mock(async () => { managed.isProcessing = false })
    ;(sm as any).onProcessingStopped = stopped
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    await sm.sendMessage(managed.id, 'initial')
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(managed.messageQueue.map(p => p.messageId)).toEqual(acceptedIds)
    expect(managed.messageQueue.map(p => p.optimisticMessageId)).toEqual(['opt-a', 'opt-b', 'opt-c'])
    expect(managed.messages.filter(m => m.role === 'user')).toHaveLength(4)
    expect(managed.wasInterrupted).not.toBe(true)
    expect(events.filter(e => e.type === 'user_message' && e.status === 'queued').map(e => e.message.id)).toEqual(acceptedIds)
  })

  it.each(['complete', 'error'])('ignores a trailing %s from a handed-off turn after a newer turn starts', async terminal => {
    const managed = buildSession('handoff-new-turn')
    managed.sdkSessionId = 'offline-sdk'
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.pendingSteers = new PendingSteers()
    agent.currentQuery = { interrupt: async () => {} }
    agent.currentQueryAbortController = new AbortController()
    agent.debug = () => {}
    agent.getModel = () => 'claude-sonnet-4-6'
    agent.setAllSources = () => {}
    agent.getSessionId = () => 'offline-sdk'
    agent.chat = agent.chatImpl.bind(agent)
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let turn = 0
    agent.chatTurn = async function* () {
      const index = turn++
      starts[index]!.resolve()
      await gates[index]!.promise
      if (index === 0 && terminal === 'error') throw new Error('old query aborted')
      yield { type: 'complete' }
    }
    managed.agent = agent
    ;(sm as any).getOrCreateAgent = async () => agent
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    const stopped = mock(async () => { managed.isProcessing = false })
    ;(sm as any).onProcessingStopped = stopped
    const first = sm.sendMessage(managed.id, 'first')
    await starts[0]!.promise
    ;(sm as any).recoverPendingSteers(managed)
    managed.isProcessing = false // The UI handoff callback pauses without waiting for the old SDK result.
    const second = sm.sendMessage(managed.id, 'second')
    await starts[1]!.promise
    gates[0]!.resolve()
    try {
      await first
      expect(stopped).not.toHaveBeenCalled()
      expect(managed.isProcessing).toBe(true)
    } finally {
      gates[1]!.resolve()
      await second
    }
    expect(stopped).toHaveBeenCalledTimes(1)
  })

  it('transfers handoff steers ahead of already queued later attachments', () => {
    const managed = buildSession('handoff-order')
    managed.messages = ['a', 'b', 'c'].map(id => ({ id, role: 'user', content: id, timestamp: 1 }))
    const payloads = ['a', 'c'].map(messageId => ({ message: messageId, messageId }))
    managed.acceptedSteers = new Map(payloads.map(p => [p.messageId, p]))
    managed.messageQueue = [{ message: 'b', messageId: 'b', attachments: [{ name: 'keep' }] as any }]
    managed.agent = { takePendingSteers: () => payloads } as any
    ;(sm as any).persistSession = () => {}
    ;(sm as any).recoverPendingSteers(managed)
    expect(managed.messageQueue.map(p => p.messageId)).toEqual(['a', 'b', 'c'])
    expect(managed.messageQueue[1]!.attachments).toEqual([{ name: 'keep' }] as any)
    expect(managed.wasInterrupted).not.toBe(true)
  })

  it('hard Stop visibly cancels accepted pending steers and rejects trailing recovery', async () => {
    const managed = buildSession('stop')
    managed.isProcessing = true
    managed.messages = [{ id: 'a', role: 'user', content: 'pending', timestamp: 1 }]
    const payload = { message: 'pending', messageId: 'a' }
    managed.acceptedSteers = new Map([['a', payload]])
    const forceAbort = mock(() => {})
    managed.agent = { takePendingSteers: () => [payload], forceAbort } as any
    ;(sm as any).persistSession = () => {}
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    await sm.cancelProcessing(managed.id)
    expect(forceAbort).toHaveBeenCalledTimes(1)
    expect(events.find(e => e.type === 'interrupted').queuedMessages).toEqual(['pending'])
    // Stair keeps the queued bubble visible until the renderer acknowledges the
    // restored draft (queuedRestoreId handshake) instead of removing it at once.
    expect(managed.messages.some(m => m.id === 'a')).toBe(true)
    expect(managed.messages.find(m => m.id === 'a')?.queuedRestoreId).toBeTruthy()
    expect(managed.messageQueue).toEqual([])
    await (sm as any).processEvent(managed, { type: 'steer_undelivered', ...payload })
    expect(managed.messageQueue).toEqual([])
    managed.isProcessing = false // Disarm the production Stop backstop timer.
  })

  it('re-stamps replay after the prior final response and emits that timestamp', async () => {
    const sessionId = 'queue-ordering'
    const managed = buildSession(sessionId)
    const priorFinalTimestamp = Date.now()
    managed.messages = [
      {
        id: 'initial-user',
        role: 'user',
        content: 'question',
        timestamp: priorFinalTimestamp - 200,
      },
      {
        id: 'queued-user',
        role: 'user',
        content: 'follow up',
        timestamp: priorFinalTimestamp - 100,
        isQueued: true,
      },
      {
        id: 'prior-answer',
        role: 'assistant',
        content: 'complete answer',
        timestamp: priorFinalTimestamp,
      },
    ]
    managed.messageQueue.push({
      message: 'follow up',
      messageId: 'queued-user',
      optimisticMessageId: 'optimistic-user',
    })

    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(structuredClone(event)))
    ;(sm as unknown as { lastTimestamp: number }).lastTimestamp = priorFinalTimestamp
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(sm as any).decisionFeatureActive = () => false
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const replays: string[] = []
    const agent = {
      getModel: () => 'no-model',
      setAllSources: () => {},
      getSessionId: () => undefined,
      chat: async function* (message: string): AsyncGenerator<AgentEvent> {
        replays.push(message)
        yield { type: 'input_accepted' }
        entered.resolve()
        try {
          await release.promise
          yield { type: 'complete' }
        } finally { finished.resolve() }
      },
    }
    ;(sm as any).getOrCreateAgent = async () => agent

    ;(sm as unknown as { processNextQueuedMessage: (id: string) => void })
      .processNextQueuedMessage(sessionId)
    const replayed = managed.messages.find(message => message.id === 'queued-user')
    expect(replayed?.isQueued).toBe(true)
    expect(replayed?.timestamp).toBeGreaterThan(priorFinalTimestamp)
    const scheduledEvent = events.find(event => event.type === 'user_message')
    expect(scheduledEvent?.status).toBe('processing')
    expect(scheduledEvent?.message.isQueued).toBe(true)
    expect(scheduledEvent?.message.timestamp).toBe(replayed?.timestamp)
    expect(scheduledEvent?.optimisticMessageId).toBe('optimistic-user')
    try {
      await entered.promise
      expect(replayed?.isQueued).toBe(false)
      const processingEvent = events.findLast(event => event.type === 'user_message' && event.message.id === 'queued-user')
      expect(processingEvent?.status).toBe('processing')
      expect(processingEvent?.message.isQueued).toBe(false)
      expect(processingEvent?.message.timestamp).toBe(replayed?.timestamp)
      expect(processingEvent?.optimisticMessageId).toBe('optimistic-user')
      expect(replays).toEqual(['follow up'])
      expect(managed.lastSentMessageIds).toEqual(['queued-user'])
    } finally {
      release.resolve()
      await finished.promise
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  })

  it('retains queued messages until the restored draft is acknowledged', async () => {
    const managed = buildSession('queue-stop')
    const reference = {
      version: 1,
      kind: 'chat-message',
      projectId: defaultProjectId,
      sessionId: 'source-session',
      messageId: 'source-message',
      role: 'assistant',
      quote: 'quoted text',
      locator: {
        type: 'text-quote',
        exact: 'quoted text',
        start: 0,
        end: 11,
      },
    } as const
    managed.isProcessing = true
    managed.messages = [{
      id: 'queued-user',
      role: 'user',
      content: 'queued with reference',
      timestamp: Date.now(),
      isQueued: true,
      references: [reference],
      attachments: [{
        id: 'attachment-1',
        type: 'text',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 12,
        storedPath: '/tmp/session/attachments/notes.txt',
      }],
    }]
    managed.messageQueue.push({
      message: 'queued with reference',
      messageId: 'queued-user',
      storedAttachments: managed.messages[0]!.attachments,
      options: { references: [reference] },
    })
    managed.agent = { forceAbort: () => {} } as never

    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await sm.cancelProcessing(managed.id)

    const interrupted = events.find(event => event.type === 'interrupted')
    expect(interrupted?.queuedMessages).toEqual(['queued with reference'])
    expect(interrupted?.queuedReferences).toEqual([reference])
    expect(interrupted?.queuedAttachments).toEqual(managed.messages[0]!.attachments)
    expect(interrupted?.queuedRestoreId).toBeString()
    expect(interrupted?.queuedMessageIds).toEqual(['queued-user'])
    expect(managed.messages.find(message => message.id === 'queued-user')).toEqual(expect.objectContaining({
      isQueued: true,
      queuedRestoreId: interrupted.queuedRestoreId,
    }))
    expect(loadSession(tmpRoot, managed.id)?.messages.find(message => message.id === 'queued-user'))
      .toEqual(expect.objectContaining({
        isQueued: true,
        queuedRestoreId: interrupted.queuedRestoreId,
      }))

    managed.isProcessing = false
  })

  it('acknowledges only matching queued restore messages and is idempotent', async () => {
    const managed = buildSession('queue-restore-ack')
    managed.isProcessing = true
    managed.messages = [
      {
        id: 'queued-one',
        role: 'user',
        content: 'queued one',
        timestamp: Date.now(),
        isQueued: true,
      },
      {
        id: 'queued-two',
        role: 'user',
        content: 'queued two',
        timestamp: Date.now() + 1,
        isQueued: true,
      },
    ]
    managed.messageQueue.push(
      { message: 'queued one', messageId: 'queued-one' },
      { message: 'queued two', messageId: 'queued-two' },
    )
    managed.agent = { forceAbort: () => {} } as never

    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    await sm.cancelProcessing(managed.id)
    managed.isProcessing = false

    const interrupted = events.find(event => event.type === 'interrupted')
    const acknowledge = (restoreId: string, messageIds: string[]) => (
      sm as unknown as {
        acknowledgeQueuedInputRestore: (
          sessionId: string,
          restoreId: string,
          messageIds: string[],
        ) => Promise<void>
      }
    ).acknowledgeQueuedInputRestore(managed.id, restoreId, messageIds)

    await acknowledge('wrong-restore', ['queued-one'])
    expect(managed.messages.map(message => message.id)).toContain('queued-one')

    await acknowledge(interrupted.queuedRestoreId, ['queued-one', 'not-queued'])
    expect(managed.messages.map(message => message.id)).not.toContain('queued-one')
    expect(managed.messages.map(message => message.id)).toContain('queued-two')
    expect(events.find(event => event.type === 'queued_input_restored')).toEqual({
      type: 'queued_input_restored',
      sessionId: managed.id,
      queuedRestoreId: interrupted.queuedRestoreId,
      messageIds: ['queued-one'],
    })
    expect(events.filter(event => event.type === 'queued_input_restored')).toHaveLength(1)

    await acknowledge(interrupted.queuedRestoreId, ['queued-one', 'not-queued'])
    expect(managed.messages.map(message => message.id)).toEqual(['queued-two', expect.any(String)])
    expect(events.filter(event => event.type === 'queued_input_restored')).toHaveLength(1)
    expect(loadSession(tmpRoot, managed.id)?.messages.map(message => message.id))
      .toEqual(['queued-two', expect.any(String)])
  })

  it('re-emits a pending queued restore after a cold load without auto-replaying it', async () => {
    const sessionId = 'pending-restore-cold-load'
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, {
      id: sessionId,
      projectId: defaultProjectId,
      workspaceRootPath: tmpRoot,
      name: 'pending restore',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [{
        id: 'pending-queued-user',
        type: 'user',
        content: 'do not replay me',
        timestamp: Date.now(),
        isQueued: true,
        queuedRestoreId: 'restore-after-restart',
        attachments: [{
          id: 'attachment-after-restart',
          type: 'text',
          name: 'restart.txt',
          mimeType: 'text/plain',
          size: 7,
          storedPath: '/tmp/session/attachments/restart.txt',
        }],
      } as StoredMessage],
    } as StoredSession)

    const managed = createManagedSession(
      { id: sessionId, name: 'pending restore', projectId: defaultProjectId },
      {
        id: workspaceId,
        name: 'Test Workspace',
        rootPath: tmpRoot,
        createdAt: Date.now(),
      } as never,
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    const events: any[] = []
    const targets: any[] = []
    let resolveReconnectRestore!: () => void
    const reconnectRestore = new Promise<void>(resolve => { resolveReconnectRestore = resolve })
    sm.setEventSink((_channel, target, event) => {
      targets.push(target)
      events.push(event)
      if (target.to === 'client' && target.clientId === 'reconnected-client'
        && event.type === 'interrupted' && event.queuedRestoreId === 'restore-after-restart') {
        resolveReconnectRestore()
      }
    })

    await sm.getSession(sessionId)

    expect(managed.messageQueue).toEqual([])
    expect(managed.messages[0]).toEqual(expect.objectContaining({
      id: 'pending-queued-user',
      isQueued: true,
      queuedRestoreId: 'restore-after-restart',
    }))
    expect(events).toContainEqual({
      type: 'interrupted',
      sessionId,
      queuedMessages: ['do not replay me'],
      queuedAttachments: [expect.objectContaining({
        name: 'restart.txt',
        storedPath: '/tmp/session/attachments/restart.txt',
      })],
      queuedRestoreId: 'restore-after-restart',
      queuedMessageIds: ['pending-queued-user'],
    })

    sm.onClientDisconnected('client-that-received-the-first-restore')
    ;(sm as unknown as {
      onClientConnected: (clientId: string, workspaceId: string | null) => void
    }).onClientConnected('reconnected-client', workspaceId)
    await reconnectRestore
    expect(events.filter(event => (
      event.type === 'interrupted'
      && event.queuedRestoreId === 'restore-after-restart'
    ))).toHaveLength(2)
    expect(targets.at(-1)).toEqual({ to: 'client', clientId: 'reconnected-client' })
  })

  it('continues authoritative Chat deletion when agent disposal throws', async () => {
    const managed = buildSession('delete-dispose-failure')
    managed.agent = {
      dispose: () => {
        throw new Error('dispose failed')
      },
    } as never
    const destroyBrowserWindowsForSession = mock(async () => {})
    ;(sm as unknown as {
      destroyBrowserWindowsForSession: typeof destroyBrowserWindowsForSession
    }).destroyBrowserWindowsForSession = destroyBrowserWindowsForSession
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await expect(sm.deleteSession(managed.id)).resolves.toBeUndefined()

    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(managed.id)).toBe(false)
    expect(events).toContainEqual({ type: 'session_deleted', sessionId: managed.id })
    expect(destroyBrowserWindowsForSession).toHaveBeenCalledWith(workspaceId, managed.id)
  })

  it('把未送达 steer 的结构化引用按原始消息重新入队', async () => {
    const managed = buildSession('steer-undelivered-reference')
    const reference = {
      version: 1,
      kind: 'chat-message',
      projectId: managed.projectId,
      sessionId: 'source-session',
      messageId: 'source-message',
      role: 'assistant',
      quote: 'quoted text',
      locator: {
        type: 'text-quote',
        exact: 'quoted text',
        start: 0,
        end: 11,
      },
    } as const
    managed.messages.push({
      id: 'steered-user',
      role: 'user',
      content: 'explain',
      timestamp: Date.now(),
      references: [reference],
    })
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(sm as unknown as { flushSession: () => Promise<void> }).flushSession = async () => {}

    await (sm as unknown as {
      processEvent: (session: typeof managed, event: {
        type: 'steer_undelivered'
        message: string
      }) => Promise<void>
    }).processEvent(managed, {
      type: 'steer_undelivered',
      message: formatReferencesForModel('explain', [reference]),
    })

    expect(managed.messageQueue).toEqual([expect.objectContaining({
      message: 'explain',
      messageId: 'steered-user',
      options: { references: [reference] },
    })])
    expect(managed.messages[0]?.isQueued).toBe(true)
  })

  it('找不到原消息时也不会把内部引用数据块重新入队', async () => {
    const managed = buildSession('steer-undelivered-fallback')
    const reference = {
      version: 1,
      kind: 'chat-message',
      projectId: managed.projectId,
      sessionId: 'source-session',
      messageId: 'source-message',
      role: 'assistant',
      quote: 'quoted text',
      locator: {
        type: 'text-quote',
        exact: 'quoted text',
        start: 0,
        end: 11,
      },
    } as const

    await (sm as unknown as {
      processEvent: (session: typeof managed, event: {
        type: 'steer_undelivered'
        message: string
      }) => Promise<void>
    }).processEvent(managed, {
      type: 'steer_undelivered',
      message: formatReferencesForModel('raw user text', [reference]),
    })

    expect(managed.messageQueue).toEqual([{ message: 'raw user text' }])
  })
})
