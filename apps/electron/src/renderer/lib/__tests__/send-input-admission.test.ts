import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { FileAttachment } from '@craft-agent/shared/protocol'
import { PendingInputJournal, rollbackRejectedOptimisticUserMessage } from '../send-message-recovery'
import { toDraftRef } from '../drafts'
import { findEmptySessionsLeavingWorkbench, sessionDraftHasContent } from '../../workbench/session-auto-cleanup'

// Exercise App's real admission/reconciliation callbacks at the API boundary.
// They deliberately remain in App: the fixture injects persistence and transport,
// rather than duplicating their decision logic in a test-only implementation.
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const start = app.indexOf('  const refreshPendingInputSessions = useCallback(')
const end = app.indexOf('\n  /**\n   * Unified handler for all session option changes.', start)
if (start < 0 || end < 0) throw new Error('App input admission boundaries changed')
const compiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  const { useCallback, useEffect, store, sessionAtomFamily, sessionMetaMapAtom,
    windowWorkspaceId, windowWorkspaceSlug, workspaceSwitchingRef, transportWorkspaceIdRef,
    workspaceTransitionGenerationRef, pendingInputJournal, setPendingInputSessionIds,
    cancelledInputIdsRef, inputSenderRef, draftCoordinator, draftsLoadedWorkspaceId, window, navigator,
    generateMessageId, updateSessionById, rendererLog, toast, toDraftRef,
    rollbackRejectedOptimisticUserMessage, skills, sources, extractBadges } = deps;
  ${app.slice(start, end)}
  return { send: handleSendMessage, cancel: handleCancelPendingInput, recover: recoverPendingInput };
`)
const build = new Function('deps', compiled)
const reference = { version: 1, kind: 'chat-message', projectId: 'project-a', sessionId: 'source', messageId: 'source-message', role: 'assistant', quote: 'quote', locator: { type: 'text-quote', exact: 'quote', start: 0, end: 5 } }
const attachment: FileAttachment = { path: 'paste.txt', name: 'paste.txt', type: 'text', mimeType: 'text/plain', size: 7, text: 'PAYLOAD' }
let fixtureId = 0

function fixture(overrides: Record<string, unknown> = {}, previousStorage?: Map<string, string>) {
  const values = previousStorage ?? new Map<string, string>()
  const storage = {
    get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  const journal = new PendingInputJournal(storage)
  let nextId = 0
  let session: any = { id: 'chat-a', isProcessing: false, messages: [] }
  const restores: any[] = []
  const sends: any[] = []
  const errors: string[] = []
  const consumptions: unknown[] = []
  const jobs: Promise<unknown>[] = []
  const effects: Array<() => void | (() => void)> = []
  const storageEvents = new Map<string, () => void>()
  const tails = new Map<string, Promise<unknown>>()
  const api = {
    storeAttachment: async (_id: string, input: any) => ({ ...input, id: 'attachment-id', storedPath: '/stored/paste.txt' }),
    sendMessage: async (...args: any[]) => { sends.push(args); return { accepted: true, messageId: 'server-message' } },
    sessionCommand: async () => ({ state: 'not_accepted' }),
    getSessionMessages: async () => ({ messages: [] }),
    onReconnected: () => () => {},
    ...overrides,
  }
  const context: any = {
    useCallback: (fn: unknown) => fn, useEffect: (effect: () => void | (() => void)) => { effects.push(effect) },
    store: { get: (key: string) => key === 'session' ? session : new Map([['chat-a', { workspaceId: 'workspace-a', projectId: 'project-a' }]]) },
    sessionAtomFamily: () => 'session', sessionMetaMapAtom: 'meta',
    windowWorkspaceId: 'workspace-a', windowWorkspaceSlug: 'workspace-a',
    workspaceSwitchingRef: { current: false }, transportWorkspaceIdRef: { current: 'workspace-a' },
    workspaceTransitionGenerationRef: { current: 0 },
    pendingInputJournal: journal, setPendingInputSessionIds() {}, cancelledInputIdsRef: { current: new Set() },
    inputSenderRef: { current: { id: `renderer-${++fixtureId}`, ready: true } },
    draftCoordinator: {
      captureSubmittedDraft: () => ({ content: { text: '' }, mutation: { id: 'consume', baseRevision: 0, base: { text: '' } } }),
      consumeSubmittedDraft: async (...args: unknown[]) => { consumptions.push(args); return true }, isHydrated: () => true,
      restoreInput: async (...args: any[]) => { restores.push(args); return { text: args[3].text } },
    },
    draftsLoadedWorkspaceId: 'workspace-a', window: {
      electronAPI: api,
      addEventListener: (name: string, callback: () => void) => { storageEvents.set(name, callback) },
      removeEventListener: (name: string) => { storageEvents.delete(name) },
    },
    navigator: { locks: { request: (name: string, optionsOrCallback: any, callback?: any) => {
      const fn = callback ?? optionsOrCallback
      const task = (tails.get(name) ?? Promise.resolve()).catch(() => {}).then(() => fn({ name }))
      tails.set(name, task)
      if (callback || !name.startsWith('stair:input-sender:')) jobs.push(task)
      return task
    } } },
    generateMessageId: () => `request-${++nextId}`,
    updateSessionById: (_id: string, change: any) => { session = { ...session, ...change(session) } },
    rendererLog: { warn() {} }, toast: { error: (message: string) => errors.push(message) },
    toDraftRef, rollbackRejectedOptimisticUserMessage, skills: [], sources: [], extractBadges: () => [],
  }
  return {
    ...build(context), journal, storage, values, restores, sends, errors, context, consumptions, effects, storageEvents,
    get session() { return session },
    processing: (value: boolean) => { session = { ...session, isProcessing: value } },
    settle: async () => { while (jobs.length) await Promise.all(jobs.splice(0)) },
  }
}

const cleanupStart = app.indexOf('  const hasSessionDraft = useCallback(')
const cleanupEnd = app.indexOf('  const handleFlagSession = useCallback(', cleanupStart)
if (cleanupStart < 0 || cleanupEnd < 0) throw new Error('App cleanup boundaries changed')
const makeCleanup = new Function('deps', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  const { useCallback, draftCoordinator, pendingInputJournal, window, windowWorkspaceId,
    workspaceTransitionGenerationRef, store, retainedWorkbenchSessionIdsAtom, sessionMetaMapAtom,
    sessionDraftHasContent, findEmptySessionsLeavingWorkbench, handleDeleteSession, rendererLog } = deps;
  ${app.slice(cleanupStart, cleanupEnd)}
  return { cleanup: handleAutoDeleteEmptySession, hasDraft: hasSessionDraft };
`))

describe('ordinary input admission and recovery', () => {
  it('protects a live publisher before send-lock admission, then recovers its complete orphan after it closes', async () => {
    const sender = fixture()
    const observer = fixture({}, sender.values)
    const tails = new Map<string, Promise<unknown>>()
    const jobs: Promise<unknown>[] = []
    const request = (name: string, optionsOrCallback: any, callback?: any) => {
      const fn = callback ?? optionsOrCallback
      if (callback && optionsOrCallback.ifAvailable && tails.has(name)) return Promise.resolve(fn(null))
      const task = (tails.get(name) ?? Promise.resolve()).then(() => fn({ name }))
      tails.set(name, task)
      if (callback || !name.startsWith('stair:input-sender:')) jobs.push(task)
      void task.finally(() => { if (tails.get(name) === task) tails.delete(name) })
      return task
    }
    sender.context.navigator.locks.request = request
    observer.context.navigator.locks.request = request
    sender.context.inputSenderRef.current.ready = false
    const releaseSender = sender.effects[0]()
    await Bun.sleep(0)
    const stopRecovery = observer.effects.at(-1)!()
    const setItem = sender.storage.setItem
    sender.storage.setItem = (key: string, value: string) => {
      setItem(key, value)
      observer.storageEvents.get('storage')?.()
    }
    try {
      expect(sender.send('chat-a', 'live body', [attachment], undefined, undefined, [reference], { consumeDraft: true })).toBe(true)
      while (jobs.length) await Promise.all(jobs.splice(0))
      expect(sender.sends).toHaveLength(1)
      expect(observer.restores).toEqual([])
      expect(sender.journal.list('workspace-a')).toEqual([])
      sender.journal.write({
        version: 1, workspaceId: 'workspace-a', projectId: 'project-a', sessionId: 'chat-a',
        clientMessageId: 'orphan-request', senderId: sender.context.inputSenderRef.current.id,
        createdAt: 20, text: 'orphan body', references: [reference], attachments: [toDraftRef(attachment)!],
        consumption: sender.context.draftCoordinator.captureSubmittedDraft(),
      })
      while (jobs.length) await Promise.all(jobs.splice(0))
      expect(observer.restores).toEqual([])
      if (typeof releaseSender === 'function') releaseSender()
      await Bun.sleep(0)
      observer.storageEvents.get('storage')?.()
      while (jobs.length) await Promise.all(jobs.splice(0))
      expect(observer.restores).toHaveLength(1)
      expect(observer.restores[0][3]).toMatchObject({ text: 'orphan body', references: [reference], attachments: [toDraftRef(attachment)!] })
      expect(sender.journal.list('workspace-a')).toEqual([])
    } finally {
      if (typeof stopRecovery === 'function') stopRecovery()
      if (typeof releaseSender === 'function') releaseSender()
    }
  })

  it('refuses input until the renderer has claimed its recovery ownership', async () => {
    const f = fixture()
    f.context.inputSenderRef.current.ready = false
    expect(f.send('chat-a', 'keep body', [attachment], undefined, undefined, [reference], { consumeDraft: true })).toBe(false)
    await f.settle()
    expect(f.sends).toHaveLength(0)
    expect(f.journal.list('workspace-a')).toEqual([])
    expect(f.errors).toHaveLength(1)
  })

  it('synchronously refuses journal quota failure before the caller clears input', async () => {
    const f = fixture()
    f.storage.setItem = () => { throw new Error('quota') }
    expect(f.send('chat-a', 'body', [attachment], undefined, undefined, [reference], { consumeDraft: true })).toBe(false)
    await f.settle()
    expect(f.sends).toHaveLength(0)
    expect(f.errors).toHaveLength(1)
  })

  it('releases an unresolved input for reconnect recovery while its publishing window remains open', async () => {
    let connected = false
    const f = fixture({
      sendMessage: async () => { throw new Error('Not connected') },
      sessionCommand: async () => {
        if (!connected) throw new Error('Not connected')
        return { state: 'not_accepted' }
      },
    })
    f.send('chat-a', 'retained body', [attachment], undefined, undefined, [reference], { consumeDraft: true })
    await f.settle()
    expect(f.journal.list('workspace-a')).toHaveLength(1)
    expect(f.journal.list('workspace-a')[0].senderId).toBeUndefined()
    connected = true
    const stopRecovery = f.effects.at(-1)!()
    try {
      await f.settle()
      expect(f.restores[0][3]).toMatchObject({ text: 'retained body', references: [reference], attachments: [{ path: '/stored/paste.txt', name: 'paste.txt' }] })
      expect(f.journal.list('workspace-a')).toEqual([])
      expect(f.sends).toHaveLength(0)
    } finally {
      if (typeof stopRecovery === 'function') stopRecovery()
    }
  })

  it('retains an unknown disconnected send across renderer restart, then restores all fields only after a rejection receipt', async () => {
    const f = fixture({
      sendMessage: async () => { throw new Error('Not connected') },
      sessionCommand: async () => { throw new Error('Not connected') },
    })
    expect(f.send('chat-a', 'body', [attachment], undefined, undefined, [reference], { consumeDraft: true })).toBe(true)
    expect(f.journal.list('workspace-a')).toHaveLength(1)
    await f.settle()
    expect(f.restores).toHaveLength(0)
    const restarted = fixture({}, f.values)
    const pending = restarted.journal.list('workspace-a')[0]
    await restarted.recover(pending)
    expect(restarted.restores[0][3]).toMatchObject({ text: 'body', references: [reference], attachments: [{ path: '/stored/paste.txt', name: 'paste.txt' }] })
    expect(restarted.journal.list('workspace-a')).toEqual([])
    expect(restarted.sends).toHaveLength(0)
  })

  it('does not restore or resend an unknown request that the host durably owns', async () => {
    const f = fixture({
      sendMessage: async () => { throw new Error('Request timeout') },
      sessionCommand: async () => ({ state: 'owned', messageId: 'host-id' }),
    })
    f.send('chat-a', 'body', [attachment], undefined, undefined, [reference], { consumeDraft: true })
    await f.settle()
    expect(f.restores).toHaveLength(0)
    expect(f.journal.list('workspace-a')).toEqual([])
  })

  it('reconciles a lost user_message event without replacing newer state or offering a duplicate retry', async () => {
    const accepted = { id: 'host-id', clientMessageId: 'request-1', role: 'user', content: 'body', timestamp: 10, references: [reference] }
    const f = fixture({
      sendMessage: async () => { throw new Error('Request timeout') },
      sessionCommand: async () => ({ state: 'owned', messageId: 'host-id' }),
      getSessionMessages: async () => ({ messages: [accepted] }),
    })
    f.processing(true)
    f.send('chat-a', 'body', undefined, undefined, undefined, [reference], { consumeDraft: true })
    await f.settle()
    expect(f.session.isProcessing).toBe(true)
    expect(f.session.messages).toEqual([{ ...accepted, id: 'request-1', serverMessageId: 'host-id', isPending: false }])
    expect(f.journal.list('workspace-a')).toEqual([])
  })

  it('does not replace a newer confirmation that arrives during reconciliation lookup', async () => {
    let finishLookup!: (value: unknown) => void
    const f = fixture({
      sendMessage: async () => { throw new Error('Request timeout') },
      sessionCommand: async () => ({ state: 'owned', messageId: 'host-id' }),
      getSessionMessages: () => new Promise(resolve => { finishLookup = resolve }),
    })
    f.send('chat-a', 'body')
    await Bun.sleep(0)
    f.context.updateSessionById('chat-a', (current: any) => ({
      messages: current.messages.map((message: any) => ({ ...message, isPending: false, content: 'newer event content' })),
    }))
    finishLookup({ messages: [{ id: 'host-id', clientMessageId: 'request-1', role: 'user', content: 'stale snapshot' }] })
    await f.settle()
    expect(f.session.messages[0].content).toBe('newer event content')
    expect(f.journal.list('workspace-a')).toEqual([])
  })

  it('keeps the journal when a definitive rejection cannot yet be durably restored', async () => {
    const f = fixture({ sendMessage: async () => { throw new Error('INPUT_NOT_ACCEPTED: fingerprint') } })
    f.context.draftCoordinator.restoreInput = async () => { throw new Error('disk unavailable') }
    f.send('chat-a', 'body', [attachment], undefined, undefined, [reference], { consumeDraft: true })
    await f.settle()
    expect(f.journal.list('workspace-a')).toHaveLength(1)
  })

  it('never rewrites a newer host processing state after an older storage failure', async () => {
    let rejectStore!: (error: Error) => void
    const f = fixture({ storeAttachment: () => new Promise((_resolve, reject) => { rejectStore = reject }) })
    f.send('chat-a', 'older', [attachment])
    await Bun.sleep(0)
    f.processing(true)
    rejectStore(new Error('late storage failure'))
    await f.settle()
    expect(f.session.isProcessing).toBe(true)
    expect(f.restores[0][3].text).toBe('older')
  })

  it('keeps unrelated composer input when Compact or Retry submits outside the composer', async () => {
    const f = fixture()
    f.send('chat-a', '/compact')
    await f.settle()
    expect(f.consumptions).toEqual([])
    expect(f.sends[0][1]).toBe('/compact')
  })

  it('cancels a journal-owned message while attachment storage is still pending', async () => {
    let finishStore!: (value: unknown) => void
    const f = fixture({ storeAttachment: () => new Promise(resolve => { finishStore = resolve }) })
    f.send('chat-a', 'cancel me', [attachment], undefined, undefined, [reference], { consumeDraft: true })
    await Bun.sleep(0)
    const cancel = f.cancel('chat-a')
    finishStore({ ...attachment, id: 'stored', storedPath: '/stored/paste.txt' })
    await cancel
    await f.settle()
    expect(f.sends).toHaveLength(0)
    expect(f.restores[0][3].text).toBe('cancel me')
    expect(f.journal.list('workspace-a')).toEqual([])
  })

  it('does not submit a stale async result after switching Workspace away and back', async () => {
    let finishStore!: (value: unknown) => void
    const f = fixture({ storeAttachment: () => new Promise(resolve => { finishStore = resolve }) })
    f.send('chat-a', 'old workspace request', [attachment])
    await Bun.sleep(0)
    f.context.workspaceTransitionGenerationRef.current += 2
    finishStore({ ...attachment, id: 'stored', storedPath: '/stored/paste.txt' })
    await f.settle()
    expect(f.sends).toHaveLength(0)
    expect(f.journal.list('workspace-a')).toHaveLength(1)
  })

  it('never auto-deletes a fresh Chat with a journal-owned send, including after a pending draft lookup', async () => {
    let finishStore!: (value: unknown) => void
    let finishLookup!: (value: unknown) => void
    const f = fixture({ storeAttachment: () => new Promise(resolve => { finishStore = resolve }) })
    const deleted: string[] = []
    f.context.draftCoordinator.hasDraft = () => false
    f.context.window.electronAPI.getDraft = () => new Promise(resolve => { finishLookup = resolve })
    const originalGet = f.context.store.get
    f.context.store.get = (key: string) => key === 'retained' ? new Set() : originalGet(key)
    const cleanup = makeCleanup({
      ...f.context, retainedWorkbenchSessionIdsAtom: 'retained', findEmptySessionsLeavingWorkbench, sessionDraftHasContent,
      handleDeleteSession: async (id: string) => { deleted.push(id) },
    })
    const leaving = cleanup.cleanup('chat-a')
    f.send('chat-a', 'do not delete', [attachment], undefined, undefined, undefined, { consumeDraft: true })
    await Bun.sleep(0)
    expect(cleanup.hasDraft('chat-a')).toBe(true)
    finishLookup(null)
    await leaving
    await cleanup.cleanup('chat-a')
    expect(deleted).toEqual([])
    finishStore({ ...attachment, id: 'stored', storedPath: '/stored/paste.txt' })
    await f.settle()
  })

  it('still auto-deletes a truly empty abandoned Chat', async () => {
    const f = fixture()
    const deleted: string[] = []
    f.context.draftCoordinator.hasDraft = () => false
    f.context.window.electronAPI.getDraft = async () => null
    const originalGet = f.context.store.get
    f.context.store.get = (key: string) => key === 'retained' ? new Set() : originalGet(key)
    const cleanup = makeCleanup({
      ...f.context, retainedWorkbenchSessionIdsAtom: 'retained', findEmptySessionsLeavingWorkbench, sessionDraftHasContent,
      handleDeleteSession: async (id: string) => { deleted.push(id) },
    })
    await cleanup.cleanup('chat-a')
    expect(deleted).toEqual(['chat-a'])
  })

  it('preserves submission order while the first message stores attachments', async () => {
    let finishStore!: (value: unknown) => void
    const f = fixture({ storeAttachment: () => new Promise(resolve => { finishStore = resolve }) })
    f.send('chat-a', 'first', [attachment])
    f.send('chat-a', 'second')
    await Bun.sleep(0)
    expect(f.sends).toHaveLength(0)
    finishStore({ ...attachment, id: 'stored-id', storedPath: '/stored/paste.txt' })
    await f.settle()
    expect(f.sends.map((call: any[]) => call[1])).toEqual(['first', 'second'])
  })
})
