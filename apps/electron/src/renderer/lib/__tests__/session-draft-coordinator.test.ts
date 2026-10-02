import { describe, expect, it, mock } from 'bun:test'
import type { Reference } from '@craft-agent/core'
import { SessionDraftCoordinator, type SessionDraftPersistence } from '../session-draft-coordinator'

type DraftContent = Parameters<SessionDraftPersistence['setDraftContent']>[1]
type DraftMutation = Parameters<SessionDraftPersistence['setDraftContent']>[2]
type RestoreRequest = Parameters<SessionDraftPersistence['restoreDraftInput']>[1]

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
    setDraftContent: mock(async (_sessionId: string, input: DraftContent, _mutation?: DraftMutation) => ({
      ...input,
      revision: 1,
    })),
    updateDraftReferences: mock(async (_sessionId: string, input: {
      nextReferences: Reference[]
    }) => ({ text: '', references: input.nextReferences })),
    addDraftReference: mock(async (_sessionId: string, value: Reference) => ({
      text: '',
      references: [value],
    })),
    restoreDraftInput: mock(async (_sessionId: string, input: RestoreRequest) => ({
      draft: {
        text: [input.local?.content.text, input.draft.text].filter(Boolean).join('\n\n'),
        references: [
          ...(input.local?.mutation.references?.nextReferences ?? []),
          ...(input.draft.references ?? []),
        ],
      },
      applied: true,
      committed: true,
      revision: 1,
    })),
    acknowledgeQueuedInputRestore: mock(async () => {}),
    ...overrides,
  }
}

describe('SessionDraftCoordinator', () => {
  it('does not rewrite a confirmed draft when identical text is synchronized again', async () => {
    const persistence = createPersistence()
    const coordinator = new SessionDraftCoordinator({
      persistence, getProjectId: () => 'project-a', debounceMs: 60_000,
    })
    try {
      coordinator.hydrate(coordinator.beginHydration('workspace-a'), {
        drafts: {}, appliedRestoreIds: {},
      })
      coordinator.updateText('chat-a', 'same complete input')
      await coordinator.flushPendingDrafts('workspace-a')
      coordinator.updateText('chat-a', 'same complete input')
      await coordinator.flushPendingDrafts('workspace-a')
      expect(persistence.setDraftContent).toHaveBeenCalledTimes(1)
    } finally { coordinator.dispose() }
  })

  it('preserves an explicit empty edit made before draft hydration', () => {
    const coordinator = new SessionDraftCoordinator({
      persistence: createPersistence(), getProjectId: () => 'project-a', debounceMs: 60_000,
    })
    try {
      const hydration = coordinator.beginHydration('workspace-a')
      coordinator.updateText('chat-a', '')
      coordinator.hydrate(hydration, {
        drafts: { 'chat-a': { text: 'old stored input' } }, appliedRestoreIds: {},
      })
      expect(coordinator.getText('chat-a')).toBe('')
    } finally { coordinator.dispose() }
  })

  it('flushes a visible edit made while an earlier draft write is still pending', async () => {
    let visible = 'stored input'
    let releaseWrite!: () => void
    let startWrite!: () => void
    const started = new Promise<void>(resolve => { startWrite = resolve })
    const released = new Promise<void>(resolve => { releaseWrite = resolve })
    const writes: string[] = []
    const persistence = createPersistence({
      setDraftContent: async (_id: string, content: DraftContent) => {
        writes.push(content.text)
        if (writes.length === 1) {
          startWrite()
          await released
        }
        return { ...content, revision: writes.length }
      },
    })
    const coordinator = new SessionDraftCoordinator({
      persistence, getProjectId: () => 'project-a', debounceMs: 60_000,
      onBeforeRestore: id => {
        if (coordinator.getText(id) !== visible) coordinator.updateText(id, visible)
      },
    })
    try {
      coordinator.hydrate(coordinator.beginHydration('workspace-a'), {
        drafts: { 'chat-a': { text: visible } }, appliedRestoreIds: {},
      })
      visible = 'first edit'
      coordinator.updateText('chat-a', visible)
      const flush = coordinator.flushPendingDrafts('workspace-a')
      await started
      visible = 'first edit plus the still un-debounced final tail'
      releaseWrite()
      await flush
      expect(writes.at(-1)).toBe(visible)
      expect(coordinator.getText('chat-a')).toBe(visible)
    } finally { coordinator.dispose() }
  })

  it('flushes an un-debounced visible edit before initial hydration can publish old text', () => {
    let visible = 'new visible edit'
    const coordinator = new SessionDraftCoordinator({
      persistence: createPersistence(), getProjectId: () => 'project-a', debounceMs: 60_000,
      onBeforeRestore: id => coordinator.updateText(id, visible),
      onTextRestored: (_id, text) => { visible = text },
    })
    try {
      const handle = coordinator.beginHydration('workspace-a')
      coordinator.hydrate(handle, { drafts: { 'chat-a': { text: 'old disk input' } }, appliedRestoreIds: {} })
      expect(visible).toBe('new visible edit')
      expect(coordinator.getText('chat-a')).toBe('new visible edit')
    } finally { coordinator.dispose() }
  })

  it('retries a failed restore, publishes its complete input, and acknowledges only after persistence', async () => {
    let attempts = 0
    let visible = ''
    const references: Reference[][] = []
    let attachmentsChanged = 0
    const input = { text: 'unsent', references: [reference('quote')], attachments: [{ path: '/fixture/file.txt', name: 'file.txt' }] }
    const persistence = createPersistence({
      restoreDraftInput: mock(async () => {
        if (++attempts === 1) throw new Error('transient')
        return { draft: input, applied: true, committed: true, revision: 1 }
      }),
    })
    const coordinator = new SessionDraftCoordinator({
      persistence, getProjectId: () => 'project-a', debounceMs: 1, warn: () => {},
      onTextRestored: (_id, text) => { visible = text },
      onReferencesChanged: (_id, refs) => references.push(refs),
      onAttachmentsChanged: () => { attachmentsChanged += 1 },
    })
    try {
      const handle = coordinator.beginHydration('workspace-a')
      coordinator.hydrate(handle, { drafts: {}, appliedRestoreIds: {} })
      await expect(coordinator.restoreInput('workspace-a', 'chat-a', 'project-a', {
        type: 'restore_input', ...input, queuedRestoreId: 'rejected-message', messageIds: ['message'],
      })).rejects.toThrow('transient')
      expect(persistence.acknowledgeQueuedInputRestore).not.toHaveBeenCalled()
      await Bun.sleep(25)
      expect(attempts).toBe(2)
      expect(visible).toBe('unsent')
      expect(references.at(-1)).toEqual(input.references)
      expect(attachmentsChanged).toBeGreaterThan(0)
      expect(coordinator.getAttachmentRefs('chat-a')).toEqual(input.attachments)
      expect(persistence.acknowledgeQueuedInputRestore).toHaveBeenCalledTimes(1)
    } finally { coordinator.dispose() }
  })

  it('publishes all hydrated fields to mounted consumers without replacing local edits', () => {
    const attachments: string[] = []
    const texts: string[] = []
    const coordinator = new SessionDraftCoordinator({
      persistence: createPersistence(), getProjectId: () => 'project-a', debounceMs: 60_000,
      onAttachmentsChanged: id => attachments.push(id),
      onTextRestored: (_id, text) => texts.push(text),
    })
    try {
      const handle = coordinator.beginHydration('workspace-a')
      coordinator.updateText('edited', 'local')
      coordinator.hydrate(handle, { drafts: {
        loaded: { text: 'from disk', attachments: [{ path: '/fixture/a.txt', name: 'a.txt' }] },
        edited: { text: 'old disk' },
      }, appliedRestoreIds: {} })
      expect(coordinator.getAttachmentRefs('loaded')).toHaveLength(1)
      expect(attachments).toEqual(['loaded'])
      expect(texts).toEqual(['from disk'])
      expect(coordinator.getText('edited')).toBe('local')
    } finally { coordinator.dispose() }
  })

  it('publishes attachments introduced by an authoritative content write even when text is unchanged', async () => {
    let attachmentUpdates = 0
    const attachments = [{ path: '/remote.txt', name: 'remote.txt' }]
    const coordinator = new SessionDraftCoordinator({
      persistence: createPersistence({ setDraftContent: async (_id: string, content: DraftContent) => ({ ...content, attachments, revision: 1 }) }),
      getProjectId: () => 'project-a', debounceMs: 60_000,
      onAttachmentsChanged: () => { attachmentUpdates += 1 },
    })
    try {
      coordinator.updateText('chat-a', 'same')
      await coordinator.flushContent('chat-a')
      expect(coordinator.getAttachmentRefs('chat-a')).toEqual(attachments)
      expect(attachmentUpdates).toBe(1)
    } finally { coordinator.dispose() }
  })

  it('retries a failed debounced content write without losing the latest draft', async () => {
    let attempts = 0
    const persistence = createPersistence({
      setDraftContent: mock(async (_sessionId: string, input: DraftContent) => {
        attempts += 1
        if (attempts === 1) throw new Error('transient')
        return { ...input, revision: 1 }
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
    expect(persistence.setDraftContent).toHaveBeenCalledWith('chat-a', { text: 'latest' }, expect.objectContaining({
      id: expect.any(String),
      baseRevision: 0,
      base: { text: '' },
    }))
    expect(persistence.setDraftContent.mock.calls[1]?.[2]?.id)
      .toBe(persistence.setDraftContent.mock.calls[0]?.[2]?.id)
    coordinator.dispose()
  })

  it('commits pending fields with the atomic queued restore and ACKs last', async () => {
    const calls: string[] = []
    const persistence = createPersistence({
      setDraftContent: mock(async (_sessionId: string, input: DraftContent) => {
        calls.push('content')
        return { ...input, revision: 1 }
      }),
      updateDraftReferences: mock(async (_sessionId: string, input: {
        nextReferences: Reference[]
      }) => {
        calls.push('references')
        return { text: '', references: input.nextReferences }
      }),
      restoreDraftInput: mock(async (_sessionId: string, input: RestoreRequest) => {
        calls.push('restore')
        expect(input).toMatchObject({
          restoreId: 'restore-1',
          draft: { text: 'restored', references: [reference('restored')] },
          local: {
            content: { text: 'local' },
            mutation: {
              id: expect.any(String),
              baseRevision: 0,
              base: { text: '' },
              references: { baseReferences: [], nextReferences: [reference('local')] },
            },
          },
        })
        return {
          draft: { text: 'local\n\nrestored', references: [reference('local'), reference('restored')] },
          applied: true,
          committed: true,
          revision: 1,
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

    expect(calls).toEqual(['restore', 'ack'])
    expect(persistence.setDraftContent).not.toHaveBeenCalled()
    expect(persistence.updateDraftReferences).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('ack')
    expect(coordinator.getDraft('chat-a')?.text).toBe('local\n\nrestored')
    expect(coordinator.getReferences('chat-a')).toEqual([reference('local'), reference('restored')])
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
    const flush = coordinator.flushPendingDrafts('workspace-a').then(() => {
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

    await coordinator.flushPendingDrafts('workspace-a')

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
    const calls: string[] = []
    const persistence = createPersistence({
      restoreDraftInput: mock(async (_sessionId: string, input: RestoreRequest) => {
        calls.push('restore')
        expect(input.local?.content.text).toBe('local')
        markWriteStarted()
        await writeReleased
        return {
          draft: { text: 'local\n\nrestored', references: [reference('restored')] },
          applied: true,
          committed: true,
          revision: 7,
        }
      }),
      setDraftContent: mock(async (_sessionId: string, input: DraftContent, mutation: DraftMutation) => {
        calls.push('new-edit')
        expect(mutation).toMatchObject({ baseRevision: 7, base: { text: 'local\n\nrestored' } })
        return { ...input, revision: 8 }
      }),
      updateDraftReferences: mock(async (_sessionId: string, input: { nextReferences: Reference[] }) => {
        calls.push('new-references')
        return { text: 'local\n\nrestored + typed while saving', references: input.nextReferences }
      }),
      acknowledgeQueuedInputRestore: mock(async () => {
        calls.push('ack')
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
    coordinator.updateText('chat-a', 'local')

    const restoring = coordinator.restoreInput('workspace-a', 'chat-a', 'project-a', {
      type: 'restore_input',
      text: 'restored',
      queuedRestoreId: 'restore-concurrent-edit',
      messageIds: ['message-a'],
    })
    await writeStarted
    coordinator.updateText('chat-a', 'local + typed while saving')
    coordinator.addReference('chat-a', reference('typed while saving'))
    releaseWrite()
    await restoring

    expect(coordinator.getText('chat-a')).toBe('local\n\nrestored + typed while saving')
    expect(restoredTexts).toEqual(['local\n\nrestored + typed while saving'])
    expect(coordinator.getReferences('chat-a')).toEqual([reference('restored'), reference('typed while saving')])
    expect(persistence.setDraftContent).toHaveBeenCalledTimes(1)
    expect(persistence.setDraftContent.mock.calls[0]?.[2]?.id)
      .not.toBe(persistence.restoreDraftInput.mock.calls[0]?.[1]?.local?.mutation.id)
    expect(calls).toEqual(['restore', 'new-edit', 'new-references', 'ack'])
    coordinator.dispose()
  })

  it('keeps and retries a non-queued restore after a transient write failure', async () => {
    const persistedTexts: string[] = []
    let attempts = 0
    const persistence = createPersistence({
      setDraftContent: mock(async (_sessionId: string, input: DraftContent) => {
        attempts += 1
        persistedTexts.push(input.text)
        if (attempts === 1) throw new Error('transient')
        return { ...input, revision: 1 }
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

describe('SessionDraftCoordinator compaction-failure restore (ordered outbox protocol)', () => {
  it('commits local edits and the recovered snapshot together, preserving both', async () => {
    // The failed-compaction outbox protocol: the renderer is the ONLY writer
    // that commits the restore. One host transaction accepts pending local
    // content/reference edits and merges the snapshot under the live draft.
    const calls: string[] = []
    const persistence = createPersistence({
      setDraftContent: mock(async (_sessionId: string, input: DraftContent) => {
        calls.push('content')
        return { ...input, revision: 1 }
      }),
      updateDraftReferences: mock(async (_sessionId: string, input: { nextReferences: Reference[] }) => {
        calls.push('references')
        return { text: '', references: input.nextReferences }
      }),
      restoreDraftInput: mock(async (_sessionId: string, input: RestoreRequest) => {
        calls.push('atomic-restore')
        expect(input.planExecutionId).toBe('plan-execution-1')
        expect(input.local?.content).toEqual({ text: 'live draft' })
        expect(input.local?.mutation).toMatchObject({
          id: expect.any(String),
          baseRevision: 0,
          base: { text: '' },
          references: { baseReferences: [], nextReferences: [reference('live')] },
        })
        return {
          draft: {
            text: `${input.local!.content.text}\n\n${input.draft.text}`,
            references: [...input.local!.mutation.references!.nextReferences, ...(input.draft.references ?? [])],
          },
          applied: true,
          committed: true,
          revision: 1,
        }
      }),
      sessionCommand: mock(async (_sessionId: string, command: { type: string; executionId: string }) => {
        expect(command).toEqual({ type: 'clearPendingPlanExecution', executionId: 'plan-execution-1' })
        calls.push('plan-ack')
      }),
    })
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
      debounceMs: 60_000,
    })
    const hydration = coordinator.beginHydration('workspace-a')
    coordinator.hydrate(hydration, { drafts: {}, appliedRestoreIds: {} })
    // Local edits typed while the compaction was running — still pending
    // (debounced) when the failure is delivered.
    coordinator.updateText('chat-a', 'live draft')
    coordinator.replaceReferences('chat-a', [reference('live')])

    await coordinator.restoreInput('workspace-a', 'chat-a', 'project-a', {
      type: 'restore_input',
      text: 'MSG-consumed',
      references: [reference('consumed')],
      queuedRestoreId: 'plan-restore-1',
      planExecutionId: 'plan-execution-1',
    })

    expect(calls).toEqual(['atomic-restore', 'plan-ack'])
    expect(persistence.acknowledgeQueuedInputRestore).not.toHaveBeenCalled()
    expect(persistence.setDraftContent).not.toHaveBeenCalled()
    expect(persistence.updateDraftReferences).not.toHaveBeenCalled()
    expect(coordinator.getText('chat-a')).toBe('live draft\n\nMSG-consumed')
    const merged = coordinator.getReferences('chat-a').map(r => (r as { quote?: string }).quote).sort()
    expect(merged).toEqual(['consumed', 'live'])
    coordinator.dispose()
  })

  it('a duplicate delivery of the same restore converges without duplicating text', async () => {
    // Second delivery: the store already applied restoreId — the atomic
    // restore returns the current (already merged) draft and nothing is
    // appended a second time.
    let appliedOnce = false
    const persistence = createPersistence({
      restoreDraftInput: mock(async (_sessionId: string, input: { draft: { text: string } }) => {
        if (appliedOnce) {
          return { draft: { text: 'live draft\n\nMSG-consumed' }, applied: false, committed: true, revision: 1 }
        }
        appliedOnce = true
        return { draft: { text: `live draft\n\n${input.draft.text}` }, applied: true, committed: true, revision: 1 }
      }),
    })
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
      debounceMs: 60_000,
    })
    const hydration = coordinator.beginHydration('workspace-a')
    coordinator.hydrate(hydration, { drafts: {}, appliedRestoreIds: {} })
    coordinator.updateText('chat-a', 'live draft')

    const effect = { type: 'restore_input' as const, text: 'MSG-consumed', queuedRestoreId: 'plan-restore-1' }
    await coordinator.restoreInput('workspace-a', 'chat-a', 'project-a', effect)
    await coordinator.restoreInput('workspace-a', 'chat-a', 'project-a', effect)

    expect(coordinator.getText('chat-a')).toBe('live draft\n\nMSG-consumed')
    coordinator.dispose()
  })
})

describe('SessionDraftCoordinator compaction-failure restore (no queuedRestoreId)', () => {
  it('merges restored text under the live draft and unions references', async () => {
    // The compaction-failure channel constructs a plain restore_input effect
    // (no queuedRestoreId): the coordinator merges the server-restored
    // snapshot into the LIVE draft — newer typed text stays on top and the
    // pending debounced empty write is replaced by the merged persist.
    const persistence = createPersistence()
    const coordinator = new SessionDraftCoordinator({
      persistence,
      getProjectId: () => 'project-a',
      debounceMs: 60_000,
    })
    const hydration = coordinator.beginHydration('workspace-a')
    coordinator.hydrate(hydration, { drafts: {}, appliedRestoreIds: {} })
    coordinator.updateText('chat-a', 'newer draft')
    coordinator.replaceReferences('chat-a', [reference('live')])

    await coordinator.restoreInput('workspace-a', 'chat-a', 'project-a', {
      type: 'restore_input',
      text: 'MSG-consumed',
      references: [reference('consumed')],
    })

    expect(coordinator.getText('chat-a')).toBe('newer draft\n\nMSG-consumed')
    const references = coordinator.getReferences('chat-a')
    expect(references.map(r => (r as { quote?: string }).quote).sort()).toEqual(['consumed', 'live'])
    coordinator.dispose()
  })
})
