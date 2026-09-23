import { describe, expect, it, mock } from 'bun:test'
import type { Reference } from '@craft-agent/core'
import { SessionDraftCoordinator } from '../session-draft-coordinator'

const reference = (messageId: string): Reference => ({
  version: 1,
  kind: 'chat-message',
  projectId: 'project-a',
  sessionId: 'source-chat',
  messageId,
  role: 'assistant',
  quote: messageId,
  locator: {
    type: 'text-quote',
    exact: messageId,
    start: 0,
    end: messageId.length,
  },
})

function createPersistence(overrides: Record<string, unknown> = {}) {
  return {
    setDraftContent: mock(async () => null),
    updateDraftReferences: mock(async (_sessionId: string, input: {
      nextReferences: Reference[]
    }) => ({ text: '', references: input.nextReferences })),
    addDraftReference: mock(async (_sessionId: string, value: Reference) => ({
      text: '',
      references: [value],
    })),
    restoreDraftInput: mock(async (_sessionId: string, input: {
      draft: { text: string; references?: Reference[] }
    }) => ({ draft: input.draft, applied: true })),
    acknowledgeQueuedInputRestore: mock(async () => {}),
    ...overrides,
  }
}

describe('SessionDraftCoordinator', () => {
  it('retries a failed debounced content write without losing the latest draft', async () => {
    let attempts = 0
    const persistence = createPersistence({
      setDraftContent: mock(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('transient')
        return null
      }),
    })
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
      debounceMs: 1,
      warn: () => {},
    })

    coordinator.updateText('chat-a', 'latest')
    await Bun.sleep(20)

    expect(attempts).toBe(2)
    expect(coordinator.getText('chat-a')).toBe('latest')
    coordinator.dispose()
  })

  it('flushes pending fields before an atomic queued restore and ACKs last', async () => {
    const calls: string[] = []
    const persistence = createPersistence({
      setDraftContent: mock(async () => {
        calls.push('content')
        return null
      }),
      updateDraftReferences: mock(async (_sessionId: string, input: {
        nextReferences: Reference[]
      }) => {
        calls.push('references')
        return { text: '', references: input.nextReferences }
      }),
      restoreDraftInput: mock(async () => {
        calls.push('restore')
        return {
          draft: { text: 'restored', references: [reference('restored')] },
          applied: true,
        }
      }),
      acknowledgeQueuedInputRestore: mock(async () => {
        calls.push('ack')
      }),
    })
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
      debounceMs: 60_000,
    })
    const hydration = coordinator.beginHydration('workspace-a')
    coordinator.hydrate(hydration, { drafts: {}, appliedRestoreIds: {} })
    coordinator.updateText('chat-a', 'local')
    coordinator.replaceReferences('chat-a', [reference('local')])

    await coordinator.restoreInput('workspace-a', 'chat-a', 'project-a', {
      type: 'restore_input',
      text: 'restored',
      references: [reference('restored')],
      queuedRestoreId: 'restore-1',
      messageIds: ['queued-message'],
    })

    expect(calls.indexOf('content')).toBeLessThan(calls.indexOf('restore'))
    expect(calls.indexOf('references')).toBeLessThan(calls.indexOf('restore'))
    expect(calls.at(-1)).toBe('ack')
    expect(coordinator.getDraft('chat-a')?.text).toBe('restored')
    coordinator.dispose()
  })

  it('aborts Browser work, blocks new work, and awaits the admitted task during transition', async () => {
    const persistence = createPersistence()
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
    })
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    let observedSignal!: AbortSignal
    const running = coordinator.runBrowserSelectionTask(async signal => {
      observedSignal = signal
      await released
      return 'done'
    })

    coordinator.beginWorkspaceTransition()
    expect(observedSignal.aborted).toBe(true)
    await expect(coordinator.runBrowserSelectionTask(async () => 'late'))
      .rejects.toThrow('switching Workspace')

    let flushed = false
    const flush = coordinator.flushForWorkspaceSwitch('workspace-a').then(() => {
      flushed = true
    })
    await Bun.sleep(5)
    expect(flushed).toBe(false)
    release()
    await flush
    await expect(running).resolves.toBe('done')
    coordinator.dispose()
  })

  it('merges an atomic Browser reference with references added locally while it is pending', async () => {
    let release!: (draft: { text: string; references: Reference[] }) => void
    const pending = new Promise<{ text: string; references: Reference[] }>(resolve => {
      release = resolve
    })
    const persistence = createPersistence({
      addDraftReference: mock(async () => pending),
    })
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
      debounceMs: 60_000,
    })
    const remote = reference('browser')
    const local = reference('local')
    const browserAdd = coordinator.addBrowserReference('chat-a', remote, 'request-1')
    expect(coordinator.addReference('chat-a', local)).toBe(true)
    release({ text: '', references: [remote] })

    await expect(browserAdd).resolves.toBe(true)
    expect(coordinator.getReferences('chat-a')).toEqual([remote, local])
    coordinator.dispose()
  })

  it('keeps late restores for their owning Workspace across a transport switch', () => {
    const coordinator = new SessionDraftCoordinator({
      persistence: createPersistence(),
      getProjectId: () => 'project-a',
    })
    coordinator.beginWorkspaceTransition()
    expect(coordinator.deferRestore('workspace-a', 'chat-a', {
      type: 'restore_input',
      text: 'old',
    })).toBe(true)
    expect(coordinator.deferRestore('workspace-b', 'chat-b', {
      type: 'restore_input',
      text: 'new',
    })).toBe(true)

    coordinator.resetForWorkspace()
    expect(coordinator.takeDeferredRestores('workspace-a')).toHaveLength(1)
    expect(coordinator.takeDeferredRestores('workspace-b')).toHaveLength(1)
    coordinator.dispose()
  })

  it('executes a deferred restore before the owning Workspace transport is switched', async () => {
    const persistence = createPersistence()
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
    })
    const hydration = coordinator.beginHydration('workspace-a')
    coordinator.hydrate(hydration, { drafts: {}, appliedRestoreIds: {} })
    coordinator.beginWorkspaceTransition()
    coordinator.deferRestore('workspace-a', 'chat-a', {
      type: 'restore_input',
      text: 'queued',
      queuedRestoreId: 'restore-before-switch',
      messageIds: ['message-a'],
    })

    await coordinator.flushForWorkspaceSwitch('workspace-a')

    expect(persistence.restoreDraftInput).toHaveBeenCalledTimes(1)
    expect(persistence.acknowledgeQueuedInputRestore).toHaveBeenCalledWith(
      'chat-a',
      'restore-before-switch',
      ['message-a'],
    )
    expect(coordinator.takeDeferredRestores('workspace-a')).toEqual([])
    coordinator.dispose()
  })

  it('notifies the composer with edits made while a queued restore is being saved', async () => {
    let releaseWrite!: () => void
    let markWriteStarted!: () => void
    const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve })
    const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve })
    const restoredTexts: string[] = []
    const persistence = createPersistence({
      setDraftContent: mock(async () => {
        markWriteStarted()
        await writeReleased
        return null
      }),
    })
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
      debounceMs: 60_000,
      onTextRestored: (_sessionId, text) => restoredTexts.push(text),
    })
    const hydration = coordinator.beginHydration('workspace-a')
    coordinator.hydrate(hydration, { drafts: {}, appliedRestoreIds: {} })

    const restoring = coordinator.restoreInput('workspace-a', 'chat-a', 'project-a', {
      type: 'restore_input',
      text: 'restored',
      queuedRestoreId: 'restore-concurrent-edit',
      messageIds: ['message-a'],
    })
    await writeStarted
    coordinator.updateText('chat-a', 'restored + typed while saving')
    releaseWrite()
    await restoring

    expect(coordinator.getText('chat-a')).toBe('restored + typed while saving')
    expect(restoredTexts).toEqual(['restored + typed while saving'])
    coordinator.dispose()
  })

  it('keeps and retries a non-queued restore after a transient write failure', async () => {
    const persistedTexts: string[] = []
    let attempts = 0
    const persistence = createPersistence({
      setDraftContent: mock(async (_sessionId: string, input: { text: string }) => {
        attempts += 1
        persistedTexts.push(input.text)
        if (attempts === 1) throw new Error('transient')
        return null
      }),
    })
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
      debounceMs: 1,
      warn: () => {},
    })
    const hydration = coordinator.beginHydration('workspace-a')
    coordinator.hydrate(hydration, { drafts: {}, appliedRestoreIds: {} })

    await expect(coordinator.restoreInput('workspace-a', 'chat-a', 'project-a', {
      type: 'restore_input',
      text: 'interrupted message',
    })).rejects.toThrow('transient')
    expect(coordinator.getText('chat-a')).toBe('interrupted message')
    await Bun.sleep(20)
    expect(persistedTexts.at(-1)).toBe('interrupted message')
    expect(attempts).toBeGreaterThanOrEqual(2)
    coordinator.dispose()
  })

  it('cancels pending writes when a deleted Chat draft is cleared', async () => {
    const persistence = createPersistence()
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
      debounceMs: 5,
    })

    coordinator.updateText('chat-a', 'temporary')
    coordinator.clearSession('chat-a')
    await Bun.sleep(15)

    expect(coordinator.hasDraft('chat-a')).toBe(false)
    expect(persistence.setDraftContent).not.toHaveBeenCalled()
    coordinator.dispose()
  })
})
