import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionManager,
  createManagedSession,
  buildActivationRetryMessage,
  stripActivationRetrySuffixes,
  activationTurnReferences,
} from './SessionManager.ts'
import { formatReferencesForModel } from './message-references.ts'
import type { Reference } from '@craft-agent/core'

// Regression tests for the source-activation continuation defects confirmed in
// the 2026-10 review round (stair-session-review-4dqjfolr).
//
// The interrupted turn's identity is what the SM itself recorded when
// sendMessage() ran it: `lastSentMessage` (composed visible text),
// `lastSentOptions` (references of that send) and `lastSentMessageIds`. The
// fixtures below set exactly those fields — mirroring production state —
// instead of relying on any history-text search heuristic.

const reference: Reference = {
  version: 1,
  kind: 'chat-message',
  projectId: 'project-general',
  sessionId: 'quoted-chat',
  messageId: 'quoted-msg',
  role: 'assistant',
  quote: 'selected text',
  locator: { type: 'text-quote', exact: 'selected text', start: 0, end: 13 },
}

function setup(id: string) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'stair-activation-continuation-'))
  const sm = new SessionManager()
  const managed = createManagedSession(
    { id, name: 'continuation', projectId: 'project-general' },
    { id: 'isolated-ws', name: 'Review', rootPath: tmpRoot, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  )
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  return { sm, managed, tmpRoot }
}

test('references-only source activation must not resurrect previous user request', async () => {
  const { sm, managed, tmpRoot } = setup('ref-only')
  managed.messages.push({ id: 'old', role: 'user', content: 'Delete yesterday report', timestamp: 1 } as never)
  managed.messages.push({ id: 'current', role: 'user', content: '', timestamp: 2, references: [reference] } as never)
  // Production turn state as sendMessage() records it for a references-only turn.
  managed.lastSentMessage = ''
  managed.lastSentOptions = { references: [reference] }
  managed.lastSentMessageIds = ['current']
  // The turn is still running when the activation interrupts it: the retry
  // goes through sendMessage's real queued-delivery path (no agent in tests).
  managed.isProcessing = true

  await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, {
    type: 'source_activated',
    sourceSlug: 'github',
    originalMessage: formatReferencesForModel('', [reference]),
  })
  await new Promise(r => setTimeout(r, 180))

  const queued = managed.messageQueue.at(-1)
  expect(queued).toBeDefined()
  expect(queued?.message).not.toContain('Delete yesterday report')
  // The live citations of the interrupted turn travel with the retry.
  expect(queued?.options?.references).toEqual([reference])
  const persisted = managed.messages.filter(m => m.role === 'user').at(-1)
  expect(persisted?.content).not.toContain('Delete yesterday report')
  expect(persisted?.references).toEqual([reference])
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('source retry plus a steer reuses persisted quotes after quoted chat disappears', async () => {
  const { sm, managed, tmpRoot } = setup('ref-steer')
  managed.messages.push({ id: 'original', role: 'user', content: 'Explain this', timestamp: 1, references: [reference] } as never)
  managed.messages.push({ id: 'correction', role: 'user', content: 'Use Chinese', timestamp: 2 } as never)
  managed.lastSentMessage = 'Explain this'
  managed.lastSentOptions = { references: [reference] }
  managed.lastSentMessageIds = ['original']
  managed.turnSteers = ['Use Chinese']
  managed.isProcessing = true

  const send = sm.sendMessage.bind(sm)
  const calls: { ok: boolean; error?: string; content: string }[] = []
  sm.sendMessage = (async (...args: Parameters<typeof send>) => {
    try {
      await send(...args)
      calls.push({ ok: true, content: args[1] })
    } catch (error) {
      calls.push({ ok: false, error: String(error), content: args[1] })
      throw error
    }
  }) as never
  await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, {
    type: 'source_activated',
    sourceSlug: 'github',
    originalMessage: formatReferencesForModel('Explain this', [reference]),
  })
  await new Promise(r => setTimeout(r, 180))

  // The quoted Chat ('quoted-chat') was never loaded into the SM: fresh
  // validation would reject. The retry must reuse the persisted, already
  // validated references of the interrupted turn.
  expect(calls[0]?.ok).toBe(true)
  expect(managed.messageQueue.at(-1)?.options?.references).toEqual([reference])
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('a Stop during the retry window cancels the stale retry', async () => {
  const { sm, managed, tmpRoot } = setup('stop-cancels')
  managed.lastSentMessage = 'do the thing'
  managed.isProcessing = true
  const calls: string[] = []
  sm.sendMessage = (async (_id: string, message: string) => { calls.push(message) }) as never
  await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, {
    type: 'source_activated',
    sourceSlug: 'github',
    originalMessage: 'do the thing',
  })
  // User hits Stop inside the 100ms window: the stop epoch moves.
  managed.stopEpoch = (managed.stopEpoch ?? 0) + 1
  await new Promise(r => setTimeout(r, 180))

  expect(calls).toEqual([])
  expect(managed.autoRetryPending).toBeUndefined()
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('a new turn started during the retry window cancels the stale retry', async () => {
  const { sm, managed, tmpRoot } = setup('new-turn-cancels')
  managed.lastSentMessage = 'do the thing'
  managed.isProcessing = true
  const calls: string[] = []
  sm.sendMessage = (async (_id: string, message: string) => { calls.push(message) }) as never
  await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, {
    type: 'source_activated',
    sourceSlug: 'github',
    originalMessage: 'do the thing',
  })
  // A follow-up send started a new turn: the generation moved.
  managed.processingGeneration += 1
  await new Promise(r => setTimeout(r, 180))

  expect(calls).toEqual([])
  expect(managed.autoRetryPending).toBeUndefined()
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('legacy plain copy that wins the race inherits the snapshot and its steers', async () => {
  const { sm, managed, tmpRoot } = setup('legacy-steers')
  managed.messages.push({ id: 'original', role: 'user', content: 'Explain this', timestamp: 1, references: [reference] } as never)
  managed.lastSentMessage = 'Explain this'
  managed.lastSentMessageIds = ['original']
  managed.turnSteers = ['Use Chinese']
  managed.isProcessing = true

  const send = sm.sendMessage.bind(sm)
  sm.sendMessage = (async (...args: Parameters<typeof send>) => {
    // Simulate the legacy renderer's plain copy arriving before the timer.
    if (args[1] === 'Explain this\n\n[github activated]') {
      await send(managed.id, args[1], undefined, undefined, undefined, undefined, undefined, undefined, undefined, { activationReferences: managed.autoRetryPending?.references })
      return
    }
    await send(...args)
  }) as never
  await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, {
    type: 'source_activated',
    sourceSlug: 'github',
    originalMessage: formatReferencesForModel('Explain this', [reference]),
  })
  // The legacy RPC races ahead of the server's own 100ms timer.
  await sm.sendMessage(managed.id, 'Explain this\n\n[github activated]')
  await new Promise(r => setTimeout(r, 180))

  const retries = managed.messages.filter(m => m.role === 'user' && m.content.includes('[github activated]'))
  expect(retries).toHaveLength(1)
  // The steer-carrying text was substituted: accepted corrections are never lost.
  expect(retries[0]?.content).toContain('Use Chinese')
  expect(retries[0]?.references).toEqual([reference])
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('hidden input without continuation identity gets strict fresh reference validation', async () => {
  const { sm, managed, tmpRoot } = setup('strict-hidden')
  managed.messages.push({ id: 'original', role: 'user', content: 'Explain this', timestamp: 1, references: [reference] } as never)
  // The quoted Chat ('quoted-chat') does not exist in the SM: fresh
  // validation must reject even though the send is hidden — a renderer cannot
  // forge persisted-reference reuse; only the SM's internal continuation can.
  await expect(sm.sendMessage(
    managed.id,
    'Explain this',
    undefined,
    undefined,
    { hidden: true, references: [reference] },
  )).rejects.toThrow('MESSAGE_REFERENCE_SOURCE_INVALID')
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('stripActivationRetrySuffixes removes owned chained-activation markers', () => {
  expect(stripActivationRetrySuffixes('find issues')).toBe('find issues')
  expect(stripActivationRetrySuffixes('find issues\n\n[github activated]')).toBe('find issues')
  expect(stripActivationRetrySuffixes('find issues\n\n[github activated]\n\n[linear activated]')).toBe('find issues')
  // A user's own bracket line that is not an activation marker is preserved.
  expect(stripActivationRetrySuffixes('status [ok done]')).toBe('status [ok done]')
  // References-only chained retry text strips to empty.
  expect(stripActivationRetrySuffixes('[github activated]')).toBe('[github activated]')
})

test('activationTurnReferences unions the turn message ids (merged continuations)', () => {
  const first: Reference = { ...reference, messageId: 'quoted-msg' }
  const second: Reference = { ...reference, messageId: 'other-msg' }
  const messages = [
    { id: 'earlier', role: 'user', content: 'unrelated', references: [second] },
    { id: 'turn-a', role: 'user', content: 'first half', references: [first] },
    { id: 'turn-b', role: 'user', content: 'second half', references: [second] },
  ] as never
  expect(activationTurnReferences(messages, ['turn-a', 'turn-b'], undefined)).toEqual([first, second])
  // No ids recorded: falls back to the send options, never to history.
  expect(activationTurnReferences(messages, undefined, { references: [first] })).toEqual([first])
  expect(activationTurnReferences(messages, undefined, undefined)).toBeUndefined()
})

test('buildActivationRetryMessage keeps references-only continuations valid', () => {
  expect(buildActivationRetryMessage('', [], 'github')).toEqual({
    plain: '[github activated]',
    retry: '[github activated]',
  })
  expect(buildActivationRetryMessage('', ['Use Chinese'], 'github')).toEqual({
    plain: '[github activated]',
    retry: 'Use Chinese\n\n[github activated]',
  })
  expect(buildActivationRetryMessage('orig', ['fix'], 'github')).toEqual({
    plain: 'orig\n\n[github activated]',
    retry: 'orig\n\nfix\n\n[github activated]',
  })
})
