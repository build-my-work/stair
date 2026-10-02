import { expect, test, afterAll } from 'bun:test'
import { copyFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Reference } from '@craft-agent/core'
import type { SessionCommand } from '@craft-agent/shared/protocol'
import type { SessionDraftPersistence } from '../session-draft-coordinator'

// A fresh process owns both the profile and module cache. The App callback,
// Coordinator, host and DraftStore are production implementations; only RPC
// scheduling and model-free managed-session setup are controlled below.
if (process.env.CRAFT_PLAN_RECOVERY_TEST_CHILD !== '1') {
  test('pending plan recovery integrates App, Coordinator, host and store in isolation', () => {
    const profile = mkdtempSync(join(tmpdir(), 'stair-plan-recovery-test-'))
    try {
      copyFileSync(join(import.meta.dir, '../../../../../../apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
      const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, CRAFT_CONFIG_DIR: profile, CRAFT_PLAN_RECOVERY_TEST_CHILD: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      if (run.exitCode !== 0) throw new Error(`pending plan recovery fixture failed (exit ${run.exitCode})\n${run.stdout.toString()}\n${run.stderr.toString()}`)
      expect(run.exitCode).toBe(0)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30_000)
} else {
  if (!process.env.CRAFT_CONFIG_DIR?.includes('stair-plan-recovery-test-')) throw new Error('Expected disposable recovery profile')
  const repo = join(import.meta.dir, '../../../../../..')
  const { SessionManager, createManagedSession } = await import(`${repo}/packages/server-core/src/sessions/SessionManager.ts`)
  const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
  const { saveSession, loadSession, getPendingPlanExecution, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
  const { getSessionDraft, setSessionDraft, setSessionDraftContent, reconcileSessionDraftReferences, addSessionDraftReferenceAtomic, restoreSessionDraftAtomic, getSessionDraftHydrationState, getPlanDraftConsumption } = await import('@craft-agent/shared/config')
  const { SessionDraftCoordinator } = await import('../session-draft-coordinator')
  const { createPendingPlanDispatcher } = await import('../../components/app-shell/input/pending-plan-dispatch')
  type Coordinator = InstanceType<typeof SessionDraftCoordinator>
  type Managed = ReturnType<typeof createManagedSession>
  type Fixture = Awaited<ReturnType<typeof build>>
  type RestoreRequest = Parameters<SessionDraftPersistence['restoreDraftInput']>[1]
  type RestoreResult = Awaited<ReturnType<SessionDraftPersistence['restoreDraftInput']>>
  type Content = Parameters<SessionDraftPersistence['setDraftContent']>[1]
  type Mutation = Parameters<SessionDraftPersistence['setDraftContent']>[2]
  interface Hooks {
    beforeContent?: (content: Content, mutation: Mutation) => Promise<void>
    beforeRestore?: (request: RestoreRequest) => Promise<void>
    afterRestore?: (result: RestoreResult) => Promise<void>
    afterConsume?: () => Promise<void>
  }
  const workspaces: string[] = []
  const coordinators = new Set<Coordinator>()
  const coordinatorAdapters = new WeakMap<Coordinator, { persistence: SessionDraftPersistence; controls: Hooks & { ackGate?: { promise: Promise<void> }; restores: RestoreRequest[]; acks: Array<{ sessionId: string; executionId?: string }> } }>()
  afterAll(async () => {
    for (const coordinator of coordinators) coordinator.dispose()
    await sessionPersistenceQueue.flushAll()
    for (const ws of workspaces.splice(0)) rmSync(ws, { recursive: true, force: true })
  })
  function internals(sm: InstanceType<typeof SessionManager>) {
    return sm as unknown as {
      sessions: Map<string, Managed>
      ensureMessagesLoaded: (managed: Managed) => Promise<void>
      processEvent: (managed: Managed, event: unknown, turn?: { generation: number; stopEpoch: number }) => Promise<void>
    }
  }
  async function build(id: string) {
    const sandbox = mkdtempSync(join(tmpdir(), 'stair-plan-recovery-ws-'))
    workspaces.push(sandbox)
    const workspace = createWorkspaceAtPath(sandbox, 'Pending plan recovery integration')
    const sm = new SessionManager()
    const managed = createManagedSession({ id, projectId: workspace.defaultProjectId }, { ...workspace, rootPath: sandbox }, { messagesLoaded: true })
    internals(sm).sessions.set(id, managed)
    await saveSession({ id, workspaceRootPath: sandbox, projectId: managed.projectId, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as never)
    return { sandbox, workspace, sm, managed }
  }
  function ref(projectId: string, quote = 'REF-review-token'): Reference {
    return { version: 1, kind: 'web-selection', projectId, url: 'https://example.test', title: 'Isolated source', quote, locator: { type: 'web-text-quote', exact: quote } }
  }
  function makeCoordinator(fixture: Fixture, trace: string[], hooks: Hooks = {}) {
    const { sm, managed } = fixture
    const controls = { ...hooks, ackGate: undefined as { promise: Promise<void> } | undefined, restores: [] as RestoreRequest[], acks: [] as Array<{ sessionId: string; executionId?: string }> }
    const sessionCommand = (async (id: string, command: SessionCommand) => {
      if (command.type === 'clearPendingPlanExecution') {
        controls.acks.push({ sessionId: id, executionId: command.executionId })
        trace.push('ACK-entered:' + command.executionId)
        if (controls.ackGate) await controls.ackGate.promise
        await sm.clearPendingPlanExecution(id, command.executionId)
        trace.push('ACK-finished')
        return
      }
      if (command.type === 'consumePendingPlanDraft') {
        const result = await sm.consumePendingPlanDraft(id, command.executionId, command.local)
        trace.push('consume-committed')
        await controls.afterConsume?.()
        return result
      }
      if (command.type === 'dispatchPendingPlanExecution') {
        trace.push('unexpected-dispatch')
        return sm.dispatchPendingPlanExecution(id, command.executionId)
      }
      throw new Error('Unexpected command ' + command.type)
    }) as NonNullable<SessionDraftPersistence['sessionCommand']>
    const persistence: SessionDraftPersistence = {
      setDraftContent: async (id, draft, mutation) => {
        await controls.beforeContent?.(draft, mutation)
        trace.push('content:' + draft.text)
        return setSessionDraftContent(id, draft, mutation)
      },
      updateDraftReferences: async (id, delta) => reconcileSessionDraftReferences(id, managed.projectId, delta.baseReferences, delta.nextReferences),
      addDraftReference: async (id, r, requestId) => addSessionDraftReferenceAtomic(id, managed.projectId, r, requestId),
      restoreDraftInput: async (id, request) => {
        controls.restores.push(request)
        trace.push('restore-request:' + request.restoreId)
        await controls.beforeRestore?.(request)
        const result = request.planExecutionId
          ? await sm.restorePendingPlanDraft(id, request.planExecutionId, request.restoreId, request.local)
          : restoreSessionDraftAtomic(id, managed.projectId, request.restoreId, request.draft, request.local)
        trace.push('restore-committed:' + result.applied)
        await controls.afterRestore?.(result)
        return result
      },
      acknowledgeQueuedInputRestore: async () => {},
      sessionCommand,
    }
    const coordinator = new SessionDraftCoordinator({ getProjectId: () => managed.projectId, debounceMs: 60_000, persistence })
    coordinators.add(coordinator)
    coordinatorAdapters.set(coordinator, { persistence, controls })
    return coordinator
  }
  const appSource = readFileSync(join(import.meta.dir, '../../App.tsx'), 'utf8')
  const recoveryStart = appSource.indexOf('  const recoverFailedCompactionDraft = useCallback(')
  const recoveryEnd = appSource.indexOf('  // Re-delivery channel', recoveryStart)
  if (recoveryStart < 0 || recoveryEnd < 0) throw new Error('Actual App recovery callback not found')
  const makeActualAppRecover = new Function('ctx', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
    const { draftCoordinator, transportWorkspaceIdRef, store, sessionMetaMapAtom, sessionAtomFamily, windowWorkspaceId, window, rendererLog } = ctx;
    const useCallback = (fn) => fn;
    ${appSource.slice(recoveryStart, recoveryEnd)}
    return recoverFailedCompactionDraft;
  `))
  const consumeStart = appSource.indexOf('  const handleConsumePendingPlanDraft = useCallback(')
  const consumeEnd = appSource.indexOf('  const handleEditMessage', consumeStart)
  if (consumeStart < 0 || consumeEnd < 0) throw new Error('Actual App consume callback not found')
  const makeActualAppConsume = new Function('ctx', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
    const { draftCoordinator, windowWorkspaceId } = ctx;
    const useCallback = (fn) => fn;
    ${appSource.slice(consumeStart, consumeEnd)}
    return handleConsumePendingPlanDraft;
  `))
  function createRecovery(fixture: Fixture, coordinator: Coordinator, trace: string[], gate?: { promise: Promise<void> }) {
    const { sm, managed, workspace } = fixture
    const adapter = coordinatorAdapters.get(coordinator)!
    adapter.controls.ackGate = gate
    const windowLike = { electronAPI: { getPendingPlanExecution: async () => sm.getPendingPlanExecution(managed.id), sessionCommand: adapter.persistence.sessionCommand } }
    const meta = {}
    const recover = makeActualAppRecover({ draftCoordinator: coordinator, transportWorkspaceIdRef: { current: workspace.id }, store: { get: (atom: unknown) => atom === meta ? new Map([[managed.id, { projectId: managed.projectId }]]) : { projectId: managed.projectId } }, sessionMetaMapAtom: meta, sessionAtomFamily: () => ({}), windowWorkspaceId: workspace.id, window: windowLike, rendererLog: { warn: (...items: unknown[]) => { trace.push('warning'); console.log(...items) } } })
    return { recover, windowLike }
  }
  async function stamp(fixture: Fixture) {
    const { sandbox, managed } = fixture
    if (!managed.pendingPlanExecution) throw new Error('No prepared plan to stamp')
    managed.pendingPlanExecution.compactionTurn = { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
    const stored = loadSession(sandbox, managed.id)
    if (!stored) throw new Error('No stored session')
    stored.pendingPlanExecution = managed.pendingPlanExecution
    await saveSession(stored)
  }
  async function consumeDraft(fixture: Fixture) {
    const { sm, managed } = fixture
    const consumed = await sm.consumePendingPlanDraft(managed.id, managed.pendingPlanExecution!.executionId!)
    if (!consumed?.receipt.text) throw new Error('fixture consume failed')
  }
  async function waitFor(check: () => boolean, label: string) {
    const deadline = Date.now() + 2000
    while (!check() && Date.now() < deadline) await Bun.sleep(10)
    if (!check()) throw new Error('Timed out waiting for ' + label)
  }
  async function fail(fixture: Fixture) {
    const events: Array<{ type?: string }> = []
    ;(fixture.sm as unknown as { sendEvent: (event: unknown) => void }).sendEvent = event => events.push(event as { type?: string })
    await internals(fixture.sm).processEvent(fixture.managed, { type: 'compaction_failed', compactionTrigger: 'manual' }, { generation: fixture.managed.processingGeneration, stopEpoch: fixture.managed.stopEpoch ?? 0 })
    const event = events.find(event => event.type === 'compaction_failed')
    if (!event) throw new Error('No actual failure event')
    return event
  }

  test('failure waiting for hydration restores consumed text exactly once', async () => {
    const fixture = await build('s2-failure-hydration')
    const { sm, managed, workspace } = fixture
    const trace: string[] = []
    await sm.setPendingPlanExecution(managed.id, '/plan.md', 'SNAPSHOT-hydration-token', [ref(managed.projectId)] as never)
    // Production flow: the draft still holds the snapshot when it is atomically
    // consumed; afterwards the store text no longer contains it.
    setSessionDraft(managed.id, { text: 'SNAPSHOT-hydration-token', references: [ref(managed.projectId)] as never })
    await consumeDraft(fixture)
    setSessionDraft(managed.id, { text: 'NEWER-hydrated-token' })
    await stamp(fixture)
    const event = await fail(fixture) as { restoreId?: string; executionId?: string; text?: string; references?: unknown[] }
    const coordinator = makeCoordinator(fixture, trace)
    const handle = coordinator.beginHydration(workspace.id)
    const { recover } = createRecovery(fixture, coordinator, trace)
    recover(event)
    coordinator.hydrate(handle, getSessionDraftHydrationState())
    await waitFor(() => trace.includes('ACK-finished'), 'actual App scoped ACK')
    const after = getSessionDraft(managed.id)
    // Consumed text is restored EXACTLY once (hydration racing the restore does
    // not double-apply), merged under the newer draft.
    expect(after?.text.match(/SNAPSHOT-hydration-token/g)?.length ?? 0).toBe(1)
    expect(after?.text).toContain('NEWER-hydrated-token')
    expect(after?.references).toHaveLength(1)
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)).toBeNull()
    coordinator.dispose()
  })

  test('joint local recovery commits new text and references before the scoped ACK', async () => {
    const fixture = await build('s2-flush-before-restore')
    const { sm, managed, workspace } = fixture
    const trace: string[] = []
    const coordinator = makeCoordinator(fixture, trace)
    const handle = coordinator.beginHydration(workspace.id)
    coordinator.hydrate(handle, getSessionDraftHydrationState())
    await sm.setPendingPlanExecution(managed.id, '/plan.md', 'SNAPSHOT-flush-token', [ref(managed.projectId)] as never)
    setSessionDraft(managed.id, { text: 'SNAPSHOT-flush-token', references: [ref(managed.projectId)] })
    await consumeDraft(fixture)
    coordinator.updateText(managed.id, 'NEWER-unflushed-token')
    coordinator.replaceReferences(managed.id, [ref(managed.projectId, 'NEWER-reference-token')] as never)
    await stamp(fixture)
    const event = await fail(fixture) as { restoreId?: string; executionId?: string; text?: string; references?: unknown[] }
    let releaseAck!: () => void
    const gate = { promise: new Promise<void>(resolve => { releaseAck = resolve }) }
    const { recover } = createRecovery(fixture, coordinator, trace, gate)
    recover(event)
    await waitFor(() => trace.some(entry => entry.startsWith('ACK-entered:')), 'ACK gate')
    const beforeAck = getPendingPlanExecution(fixture.sandbox, managed.id)
    const draftBeforeAck = getSessionDraft(managed.id)
    releaseAck()
    await waitFor(() => trace.includes('ACK-finished'), 'released ACK')
    // Duplicate delivery after the scoped ACK converges through the durable id.
    recover(event)
    await waitFor(() => trace.filter(entry => entry === 'ACK-finished').length === 2, 'duplicate recovery ACK')
    expect(beforeAck?.failed).toBe(true)
    expect(draftBeforeAck?.text).toBe('NEWER-unflushed-token\n\nSNAPSHOT-flush-token')
    expect(draftBeforeAck?.references).toHaveLength(2)
    const joint = coordinatorAdapters.get(coordinator)!.controls.restores[0]!
    expect(joint.local?.content.text).toBe('NEWER-unflushed-token')
    expect(joint.local?.mutation.references?.nextReferences).toHaveLength(1)
    expect(trace.findIndex(entry => entry.startsWith('restore-committed:'))).toBeLessThan(trace.findIndex(entry => entry.startsWith('ACK-entered:')))
    expect(trace.some(entry => entry.startsWith('content:'))).toBe(false)
    expect(getSessionDraft(managed.id)?.text.match(/SNAPSHOT-flush-token/g)?.length ?? 0).toBe(1)
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)).toBeNull()
    coordinator.dispose()
  })

  test('missed failure event: the actual dispatcher outbox exposure restores before an ordinary save', async () => {
    const fixture = await build('s2-missed-failure')
    const { sm, managed, workspace } = fixture
    const trace: string[] = []
    const coordinator = makeCoordinator(fixture, trace)
    const handle = coordinator.beginHydration(workspace.id)
    coordinator.hydrate(handle, getSessionDraftHydrationState())
    await sm.setPendingPlanExecution(managed.id, '/plan.md', 'SNAPSHOT-reconnect-token', [ref(managed.projectId)] as never)
    setSessionDraft(managed.id, { text: 'SNAPSHOT-reconnect-token', references: [ref(managed.projectId)] })
    await consumeDraft(fixture)
    coordinator.updateText(managed.id, 'NEWER-live-token')
    await stamp(fixture)
    await fail(fixture) // intentionally do not deliver the captured live event
    const { recover } = createRecovery(fixture, coordinator, trace)
    coordinator.refreshHydratedDrafts(workspace.id, getSessionDraftHydrationState())
    // FreeFormInput's actual notifyFailed payload shape and App's actual callback.
    const dispatcher = createPendingPlanDispatcher({
      isBusy: () => false,
      load: async () => sm.getPendingPlanExecution(managed.id),
      dispatch: async () => { trace.push('unexpected-dispatch') },
      notifyFailed: pending => recover({ sessionId: managed.id, executionId: pending.executionId, restoreId: pending.restoreId, text: pending.draftInputSnapshot, references: pending.draftReferencesSnapshot }),
    })
    await dispatcher.request()
    await Bun.sleep(40)
    coordinator.updateText(managed.id, coordinator.getText(managed.id) + '!')
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    coordinator.dispose()
    dispatcher.dispose()
    expect(getSessionDraft(managed.id)?.text).toContain('SNAPSHOT-reconnect-token')
    expect(trace.includes('unexpected-dispatch')).toBe(false)
  })

  test('unconsumed successful prepare: cold recovery never appends the snapshot twice', async () => {
    const fixture = await build('s2-prepare-unconsumed')
    const { sm, managed, workspace } = fixture
    // Prepare succeeded; the client crashed BEFORE consuming: the draft still
    // contains the snapshot and no receipt exists.
    setSessionDraft(managed.id, { text: 'UNCONSUMED-snapshot-token', references: [ref(managed.projectId)] as never })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', 'UNCONSUMED-snapshot-token', [ref(managed.projectId)] as never)
    const coldSM = new SessionManager()
    const coldManaged = createManagedSession({ id: managed.id, projectId: managed.projectId }, { ...workspace, rootPath: fixture.sandbox }, {})
    internals(coldSM).sessions.set(managed.id, coldManaged)
    const events: Array<{ type?: string }> = []
    ;(coldSM as unknown as { sendEvent: (event: unknown) => void }).sendEvent = event => events.push(event as { type?: string })
    await internals(coldSM).ensureMessagesLoaded(coldManaged)
    await waitFor(() => events.some(event => event.type === 'compaction_failed'), 'cold outbox re-delivery')
    // The delivered payload restores NO text (unconsumed receipt absent) — the
    // user's draft already holds it.
    const delivered = events.find(event => event.type === 'compaction_failed') as { text?: string }
    expect(delivered.text).toBeUndefined()
    const trace: string[] = []
    const coordinator = makeCoordinator({ ...fixture, sm: coldSM, managed: coldManaged }, trace)
    const handle = coordinator.beginHydration(workspace.id)
    coordinator.hydrate(handle, getSessionDraftHydrationState())
    const { recover } = createRecovery({ ...fixture, sm: coldSM, managed: coldManaged }, coordinator, trace)
    recover(delivered)
    await waitFor(() => trace.includes('ACK-finished'), 'cold recovery ACK')
    const after = getSessionDraft(managed.id)
    coordinator.dispose()
    expect(after?.text.match(/UNCONSUMED-snapshot-token/g)?.length ?? 0).toBe(1)
  })

  test('partial consumption: an edited input restores nothing for text, consumed refs still recover', async () => {
    const fixture = await build('s2-partial-consumption')
    const { sm, managed, workspace } = fixture
    const trace: string[] = []
    const snapshotRef = ref(managed.projectId)
    await sm.setPendingPlanExecution(managed.id, '/plan.md', 'PARTIAL-snapshot-token', [snapshotRef] as never)
    // The user typed while the prepare RPC was in flight: the stored text no
    // longer matches the snapshot. The atomic consume records a TEXT-less
    // receipt; the matching reference is still consumed by key.
    setSessionDraft(managed.id, { text: 'EDITED-during-prepare', references: [snapshotRef] as never })
    const consumed = await sm.consumePendingPlanDraft(managed.id, managed.pendingPlanExecution!.executionId!)
    expect(consumed.receipt.text).toBe(false)
    expect(consumed.receipt.referenceKeys).toHaveLength(1)

    await stamp(fixture)
    const event = await fail(fixture) as { text?: string; references?: unknown[] }
    expect(event.text).toBeUndefined()   // unconsumed text never re-appends
    expect(event.references).toHaveLength(1) // consumed refs are recoverable

    const coordinator = makeCoordinator(fixture, trace)
    const handle = coordinator.beginHydration(workspace.id)
    coordinator.hydrate(handle, getSessionDraftHydrationState())
    const { recover } = createRecovery(fixture, coordinator, trace)
    recover(event)
    await waitFor(() => trace.includes('ACK-finished'), 'recovery ACK')
    const after = getSessionDraft(managed.id)
    coordinator.dispose()
    expect(after?.text).toBe('EDITED-during-prepare')
    expect(after?.references).toHaveLength(1)
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)).toBeNull()
  })


  test('two windows join independent local edits and one snapshot before either ACK clears the outbox', async () => {
    const fixture = await build('two-window-joint')
    const { sm, managed, workspace } = fixture
    const snapshot = 'TWO-WINDOW-SNAPSHOT'
    const snapshotRef = ref(managed.projectId, 'SNAPSHOT-SOURCE')
    setSessionDraft(managed.id, { text: snapshot, references: [snapshotRef] })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot, [snapshotRef])
    await consumeDraft(fixture)
    await stamp(fixture)
    const aTrace: string[] = []
    const bTrace: string[] = []
    let releaseB!: () => void
    const bGate = new Promise<void>(resolve => { releaseB = resolve })
    let bEntered = false
    const a = makeCoordinator(fixture, aTrace)
    const b = makeCoordinator(fixture, bTrace, { beforeRestore: async () => { bEntered = true; await bGate } })
    a.hydrate(a.beginHydration(workspace.id), getSessionDraftHydrationState())
    b.hydrate(b.beginHydration(workspace.id), getSessionDraftHydrationState())
    a.updateText(managed.id, 'WINDOW-A-NEW')
    b.updateText(managed.id, 'WINDOW-B-NEW')
    a.replaceReferences(managed.id, [ref(managed.projectId, 'A-SOURCE')])
    b.replaceReferences(managed.id, [ref(managed.projectId, 'B-SOURCE')])
    const event = await fail(fixture)
    let releaseAACK!: () => void
    const aACK = { promise: new Promise<void>(resolve => { releaseAACK = resolve }) }
    createRecovery(fixture, b, bTrace).recover(event)
    createRecovery(fixture, a, aTrace, aACK).recover(event)
    await waitFor(() => bEntered && aTrace.some(t => t.startsWith('ACK-entered:')), 'A committed, B captured and delayed')
    expect(getSessionDraft(managed.id)?.text).toContain(snapshot)
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)?.failed).toBe(true)
    releaseB()
    await waitFor(() => bTrace.includes('ACK-finished'), 'B joint commit and ACK')
    releaseAACK()
    await waitFor(() => aTrace.includes('ACK-finished'), 'A ACK')
    const after = getSessionDraft(managed.id)
    expect(after?.text).toContain('WINDOW-A-NEW')
    expect(after?.text).toContain('WINDOW-B-NEW')
    expect(after?.text.split(snapshot).length).toBe(2)
    expect(after?.references?.map(r => r.kind === 'web-selection' ? r.quote : '') .sort()).toEqual(['A-SOURCE', 'B-SOURCE', 'SNAPSHOT-SOURCE'])
    expect(b.getText(managed.id)).toContain('WINDOW-B-NEW')
    expect(bTrace).toContain('restore-committed:false')
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)).toBeNull()
  })

  test('already-inflight normal content write arriving after another window restore keeps the snapshot', async () => {
    const fixture = await build('two-window-inflight')
    const { sm, managed, workspace } = fixture
    const snapshot = 'INFLIGHT-SNAPSHOT'
    setSessionDraft(managed.id, { text: snapshot })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot)
    await consumeDraft(fixture)
    await stamp(fixture)
    const aTrace: string[] = []
    const bTrace: string[] = []
    let releaseContent!: () => void
    const contentGate = new Promise<void>(resolve => { releaseContent = resolve })
    let entered = false
    const a = makeCoordinator(fixture, aTrace)
    const b = makeCoordinator(fixture, bTrace, { beforeContent: async () => { if (!entered) { entered = true; await contentGate } } })
    a.hydrate(a.beginHydration(workspace.id), getSessionDraftHydrationState())
    b.hydrate(b.beginHydration(workspace.id), getSessionDraftHydrationState())
    a.updateText(managed.id, 'INFLIGHT-A-NEW')
    b.updateText(managed.id, 'INFLIGHT-B-NEW')
    const bFlush = b.flushContent(managed.id)
    await waitFor(() => entered, 'B captured old content mutation')
    const event = await fail(fixture)
    let releaseAACK!: () => void
    const aACK = { promise: new Promise<void>(resolve => { releaseAACK = resolve }) }
    createRecovery(fixture, a, aTrace, aACK).recover(event)
    createRecovery(fixture, b, bTrace).recover(event)
    await waitFor(() => aTrace.some(t => t.startsWith('ACK-entered:')), 'A atomic recovery before old B write')
    releaseContent()
    await bFlush
    await waitFor(() => bTrace.includes('ACK-finished'), 'B serialized write and joint recovery')
    releaseAACK()
    await waitFor(() => aTrace.includes('ACK-finished'), 'A ACK')
    const after = getSessionDraft(managed.id)?.text ?? ''
    expect(after).toContain('INFLIGHT-A-NEW')
    expect(after).toContain('INFLIGHT-B-NEW')
    expect(after.split(snapshot).length).toBe(2)
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)).toBeNull()
  })

  test('workspace switch deferred recovery retains execution identity and ACKs the original outbox', async () => {
    const fixture = await build('workspace-deferred')
    const { sm, managed, workspace } = fixture
    const snapshot = 'DEFERRED-SNAPSHOT'
    setSessionDraft(managed.id, { text: snapshot })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot)
    await consumeDraft(fixture)
    await stamp(fixture)
    const trace: string[] = []
    const coordinator = makeCoordinator(fixture, trace)
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    coordinator.updateText(managed.id, 'NEW-DEFERRED-INPUT')
    const event = await fail(fixture)
    const expected = managed.pendingPlanExecution!.executionId
    coordinator.beginWorkspaceTransition()
    createRecovery(fixture, coordinator, trace).recover(event)
    const deferred = coordinator.takeDeferredRestores(workspace.id)
    expect(deferred).toHaveLength(1)
    expect(deferred[0]!.effect.planExecutionId).toBe(expected)
    expect(deferred[0]!.effect.queuedRestoreId).toBe(managed.pendingPlanExecution!.restoreId)
    expect(trace.some(t => t.startsWith('ACK-entered:'))).toBe(false)
    coordinator.deferRestore(workspace.id, managed.id, deferred[0]!.effect)
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    expect(coordinatorAdapters.get(coordinator)!.controls.acks).toEqual([{ sessionId: managed.id, executionId: expected }])
    expect(getSessionDraft(managed.id)?.text).toContain(snapshot)
    expect(getSessionDraft(managed.id)?.text).toContain('NEW-DEFERRED-INPUT')
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)).toBeNull()
    coordinator.finishWorkspaceTransition()
    coordinator.resetForWorkspace()
  })

  test('cancelled hydration returns null without acknowledging the failed outbox', async () => {
    const fixture = await build('workspace-null')
    const { sm, managed, workspace } = fixture
    setSessionDraft(managed.id, { text: 'CANCELLED-HYDRATION-SNAPSHOT' })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', 'CANCELLED-HYDRATION-SNAPSHOT')
    await consumeDraft(fixture)
    await stamp(fixture)
    const trace: string[] = []
    const coordinator = makeCoordinator(fixture, trace)
    const hydration = coordinator.beginHydration(workspace.id)
    const restore = coordinator.restoreInput.bind(coordinator)
    let restoration: ReturnType<Coordinator['restoreInput']> | undefined
    coordinator.restoreInput = (...args) => {
      restoration = restore(...args)
      return restoration
    }
    createRecovery(fixture, coordinator, trace).recover(await fail(fixture))
    coordinator.cancelHydration(hydration)
    expect(await restoration).toBeNull()
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    expect(coordinatorAdapters.get(coordinator)!.controls.acks).toEqual([])
    expect(coordinatorAdapters.get(coordinator)!.controls.restores).toEqual([])
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)?.failed).toBe(true)
  })

  test('generation cancelled after host commit does not ACK, and a fresh window safely recovers', async () => {
    const fixture = await build('workspace-reply-cancel')
    const { sm, managed, workspace } = fixture
    const snapshot = 'CANCELLED-REPLY-SNAPSHOT'
    setSessionDraft(managed.id, { text: snapshot })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot)
    await consumeDraft(fixture)
    await stamp(fixture)
    const trace: string[] = []
    let releaseReply!: () => void
    const replyGate = new Promise<void>(resolve => { releaseReply = resolve })
    let committed = false
    const coordinator = makeCoordinator(fixture, trace, { afterRestore: async () => { committed = true; await replyGate } })
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    coordinator.updateText(managed.id, 'NEW-CANCELLED-REPLY-INPUT')
    const event = await fail(fixture)
    createRecovery(fixture, coordinator, trace).recover(event)
    await waitFor(() => committed, 'real host commit before reply')
    coordinator.finishWorkspaceTransition()
    coordinator.resetForWorkspace()
    releaseReply()
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    expect(coordinatorAdapters.get(coordinator)!.controls.acks).toEqual([])
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)?.failed).toBe(true)
    const retryTrace: string[] = []
    const retry = makeCoordinator(fixture, retryTrace)
    retry.hydrate(retry.beginHydration(workspace.id), getSessionDraftHydrationState())
    createRecovery(fixture, retry, retryTrace).recover(event)
    await waitFor(() => retryTrace.includes('ACK-finished'), 'fresh window replay ACK')
    const after = getSessionDraft(managed.id)?.text ?? ''
    expect(after).toContain('NEW-CANCELLED-REPLY-INPUT')
    expect(after.split(snapshot).length).toBe(2)
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)).toBeNull()
  })

  test('actual App consume callback preserves text and references typed while its response is pending', async () => {
    const fixture = await build('consume-new-input')
    const { sm, managed, workspace } = fixture
    const snapshot = 'CONSUME-SNAPSHOT'
    const snapshotRef = ref(managed.projectId, 'CONSUMED-OLD-SOURCE')
    const newerRef = ref(managed.projectId, 'UNCONSUMED-NEW-SOURCE')
    setSessionDraft(managed.id, { text: snapshot, references: [snapshotRef] })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot, [snapshotRef])
    const trace: string[] = []
    let releaseConsume!: () => void
    const consumeGate = new Promise<void>(resolve => { releaseConsume = resolve })
    const coordinator = makeCoordinator(fixture, trace, { afterConsume: async () => { await consumeGate } })
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    const consume = makeActualAppConsume({ draftCoordinator: coordinator, windowWorkspaceId: workspace.id })
    const executionId = managed.pendingPlanExecution!.executionId!
    const pending = consume(managed.id, executionId, { text: snapshot, references: [snapshotRef] })
    await waitFor(() => trace.includes('consume-committed'), 'durable consumption before reply')
    coordinator.updateText(managed.id, 'NEW-TEXT-DURING-CONSUME')
    coordinator.replaceReferences(managed.id, [newerRef])
    releaseConsume()
    const result = await pending
    expect(result.receipt.text).toBe(true)
    expect(result.receipt.referenceKeys).toHaveLength(1)
    expect(coordinator.getText(managed.id)).toBe('NEW-TEXT-DURING-CONSUME')
    expect(coordinator.getReferences(managed.id)).toEqual([newerRef])
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    expect(getSessionDraft(managed.id)?.text).toBe('NEW-TEXT-DURING-CONSUME')
    expect(getSessionDraft(managed.id)?.references).toEqual([newerRef])
    expect(getPlanDraftConsumption(managed.id, executionId)).toEqual(result.receipt)
  })

  test('identical text re-entered after host consumption remains a new draft', async () => {
    const fixture = await build('consume-identical-new-input')
    const { sm, managed, workspace } = fixture
    const snapshot = 'LEGITIMATE-REENTERED-SNAPSHOT'
    setSessionDraft(managed.id, { text: snapshot })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot)
    const trace: string[] = []
    let releaseConsume!: () => void
    const consumeGate = new Promise<void>(resolve => { releaseConsume = resolve })
    const coordinator = makeCoordinator(fixture, trace, { afterConsume: async () => { await consumeGate } })
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    const consume = makeActualAppConsume({ draftCoordinator: coordinator, windowWorkspaceId: workspace.id })
    const pending = consume(managed.id, managed.pendingPlanExecution!.executionId!, { text: snapshot, references: [] })
    await waitFor(() => trace.includes('consume-committed'), 'host consumed before later edits')
    // Two actual later composer edits occur while the committed consumption's
    // response is still in flight. Equality with its snapshot is incidental.
    coordinator.updateText(managed.id, '')
    coordinator.updateText(managed.id, snapshot)
    releaseConsume()
    const result = await pending
    expect(result.receipt.text).toBe(true)
    expect(coordinator.getText(managed.id)).toBe(snapshot)
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    expect(getSessionDraft(managed.id)?.text).toBe(snapshot)
  })

  test('lost consume reply preserves identical new input and restores the consumed snapshot', async () => {
    const fixture = await build('consume-identical-lost-reply')
    const { sm, managed, workspace } = fixture
    const snapshot = 'IDENTICAL-LOST-REPLY-TEXT'
    setSessionDraft(managed.id, { text: snapshot })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot)
    const executionId = managed.pendingPlanExecution!.executionId!
    const events: Array<{ type?: string; text?: string }> = []
    ;(sm as unknown as { sendEvent: (event: unknown) => void }).sendEvent = event => events.push(event as { type?: string; text?: string })
    const trace: string[] = []
    let releaseConsume!: () => void
    let loseFirstReply = true
    const consumeGate = new Promise<void>(resolve => { releaseConsume = resolve })
    const coordinator = makeCoordinator(fixture, trace, { afterConsume: async () => {
      if (!loseFirstReply) return
      loseFirstReply = false
      await consumeGate
      throw new Error('lost consume reply')
    } })
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    const consume = makeActualAppConsume({ draftCoordinator: coordinator, windowWorkspaceId: workspace.id })
    // Attach the rejection handler before injecting the transport loss.
    const pending = consume(managed.id, executionId, { text: snapshot, references: [] }).catch((error: Error) => error)
    await waitFor(() => trace.includes('consume-committed'), 'host consumption before lost reply')
    coordinator.updateText(managed.id, '')
    coordinator.updateText(managed.id, snapshot)
    releaseConsume()
    expect((await pending).message).toBe('lost consume reply')
    // This is FreeFormInput's preparation catch: cancel this exact execution,
    // receive the actual host failure outbox and replay the actual App callback.
    await sm.clearPendingPlanExecution(managed.id, executionId)
    const event = events.find(event => event.type === 'compaction_failed')
    expect(event?.text).toBe(snapshot)
    createRecovery(fixture, coordinator, trace).recover(event)
    await waitFor(() => trace.includes('ACK-finished'), 'lost reply recovery ACK')
    const after = getSessionDraft(managed.id)?.text ?? ''
    expect(after.split(snapshot).length - 1).toBe(2)
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)).toBeNull()
  })

  test('cleared then rewritten new text keeps its prefix even when it matches the consumed snapshot', async () => {
    const fixture = await build('consume-prefix-reentry')
    const { sm, managed, workspace } = fixture
    const snapshot = 'PREFIX-OWNERSHIP-TOKEN'
    const newText = snapshot + '\nNEW-SUFFIX-TOKEN'
    setSessionDraft(managed.id, { text: snapshot })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot)
    const trace: string[] = []
    let releaseConsume!: () => void
    const consumeGate = new Promise<void>(resolve => { releaseConsume = resolve })
    const coordinator = makeCoordinator(fixture, trace, { afterConsume: async () => { await consumeGate } })
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    const consume = makeActualAppConsume({ draftCoordinator: coordinator, windowWorkspaceId: workspace.id })
    const pending = consume(managed.id, managed.pendingPlanExecution!.executionId!, { text: snapshot, references: [] })
    await waitFor(() => trace.includes('consume-committed'), 'host consumed before explicit replacement')
    coordinator.updateText(managed.id, '')
    coordinator.updateText(managed.id, newText)
    releaseConsume()
    expect((await pending).receipt.text).toBe(true)
    expect(coordinator.getText(managed.id)).toBe(newText)
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    expect(getSessionDraft(managed.id)?.text).toBe(newText)
  })

  test('continuous append after consumption keeps only the new suffix in the draft', async () => {
    const fixture = await build('consume-continuous-append')
    const { sm, managed, workspace } = fixture
    const snapshot = 'CONTINUOUS-APPEND-SNAPSHOT'
    const suffix = '\nNEW-APPENDED-TEXT'
    setSessionDraft(managed.id, { text: snapshot })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot)
    const trace: string[] = []
    let releaseConsume!: () => void
    const consumeGate = new Promise<void>(resolve => { releaseConsume = resolve })
    const coordinator = makeCoordinator(fixture, trace, { afterConsume: async () => { await consumeGate } })
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    const consume = makeActualAppConsume({ draftCoordinator: coordinator, windowWorkspaceId: workspace.id })
    const pending = consume(managed.id, managed.pendingPlanExecution!.executionId!, { text: snapshot, references: [] })
    await waitFor(() => trace.includes('consume-committed'), 'host consumed before continuous append')
    coordinator.updateText(managed.id, snapshot + suffix)
    releaseConsume()
    expect((await pending).receipt.text).toBe(true)
    expect(coordinator.getText(managed.id)).toBe(suffix)
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    expect(getSessionDraft(managed.id)?.text).toBe(suffix)
  })

  test('actual App remove then add of a consumed reference key keeps the newly added reference', async () => {
    const fixture = await build('consume-same-reference-readd')
    const { sm, managed, workspace } = fixture
    const snapshot = 'REFERENCE-OWNERSHIP-SNAPSHOT'
    const reference = ref(managed.projectId, 'REFERENCE-REMOVED-THEN-READDED')
    setSessionDraft(managed.id, { text: snapshot, references: [reference] })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot, [reference])
    const trace: string[] = []
    let releaseConsume!: () => void
    const consumeGate = new Promise<void>(resolve => { releaseConsume = resolve })
    const coordinator = makeCoordinator(fixture, trace, { afterConsume: async () => { await consumeGate } })
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    const consume = makeActualAppConsume({ draftCoordinator: coordinator, windowWorkspaceId: workspace.id })
    const callbacksStart = appSource.indexOf('  const handleReferencesChange = useCallback(')
    const callbacksEnd = appSource.indexOf('  const handleAddBrowserDraftReference', callbacksStart)
    if (callbacksStart < 0 || callbacksEnd < 0) throw new Error('Actual App reference callbacks not found')
    const callbacks = new Function('ctx', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
      const { draftCoordinator } = ctx;
      const useCallback = fn => fn;
      ${appSource.slice(callbacksStart, callbacksEnd)}
      return { change: handleReferencesChange, add: handleAddDraftReference };
    `))({ draftCoordinator: coordinator })
    const pending = consume(managed.id, managed.pendingPlanExecution!.executionId!, { text: snapshot, references: [reference] })
    await waitFor(() => trace.includes('consume-committed'), 'host consumed references before remove and readd')
    expect(getSessionDraft(managed.id)?.references ?? []).toEqual([])
    expect(callbacks.change(managed.id, [])).toBe(true)
    expect(callbacks.add(managed.id, reference)).toBe(true)
    expect(coordinator.getReferences(managed.id)).toEqual([reference])
    releaseConsume()
    expect((await pending).receipt.referenceKeys).toHaveLength(1)
    expect(coordinator.getReferences(managed.id)).toEqual([reference])
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    expect(getSessionDraft(managed.id)?.references).toEqual([reference])
  })

  test('an unchanged reference is still removed by its durable consumption receipt', async () => {
    const fixture = await build('consume-unchanged-reference')
    const { sm, managed, workspace } = fixture
    const snapshot = 'UNCHANGED-REFERENCE-SNAPSHOT'
    const reference = ref(managed.projectId, 'UNCHANGED-CONSUMED-REFERENCE')
    setSessionDraft(managed.id, { text: snapshot, references: [reference] })
    await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot, [reference])
    const trace: string[] = []
    let releaseConsume!: () => void
    const consumeGate = new Promise<void>(resolve => { releaseConsume = resolve })
    const coordinator = makeCoordinator(fixture, trace, { afterConsume: async () => { await consumeGate } })
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    const consume = makeActualAppConsume({ draftCoordinator: coordinator, windowWorkspaceId: workspace.id })
    const pending = consume(managed.id, managed.pendingPlanExecution!.executionId!, { text: snapshot, references: [reference] })
    await waitFor(() => trace.includes('consume-committed'), 'host consumed unchanged reference')
    expect(getSessionDraft(managed.id)?.references ?? []).toEqual([])
    expect(coordinator.getReferences(managed.id)).toEqual([reference])
    releaseConsume()
    expect((await pending).receipt.referenceKeys).toHaveLength(1)
    expect(coordinator.getReferences(managed.id)).toEqual([])
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    expect(getSessionDraft(managed.id)?.references ?? []).toEqual([])
  })

  test('a failed plan stays restored exactly once after 64 actual Stop recoveries', async () => {
    const fixture = await build('plan-restore-receipt-history')
    const { sm, managed, workspace } = fixture
    const snapshot = 'PLAN-RESTORE-HISTORY-SNAPSHOT'
    setSessionDraft(managed.id, { text: snapshot })
    const plan = await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot)
    await consumeDraft(fixture)
    await sm.clearPendingPlanExecution(managed.id, plan.executionId)
    await sm.restorePendingPlanDraft(managed.id, plan.executionId!, plan.restoreId!)

    // The first recovery reached disk but its renderer lost the reply. Keep
    // that failed outbox unACKed while another window uses ordinary Stop.
    const trace: string[] = []
    const coordinator = makeCoordinator(fixture, trace)
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    coordinatorAdapters.get(coordinator)!.persistence.acknowledgeQueuedInputRestore =
      async (id, restoreId, ids) => sm.acknowledgeQueuedInputRestore(id, restoreId, ids)
    const events: Array<{
      type?: string
      queuedMessages?: string[]
      queuedRestoreId?: string
      queuedMessageIds?: string[]
    }> = []
    ;(sm as unknown as { sendEvent: (event: unknown) => void }).sendEvent = event => events.push(event as typeof events[number])
    // Model delivery is unnecessary: simulate only the iterator closing after
    // the production Stop calls forceAbort, retaining the real queue producer.
    managed.agent = { forceAbort: () => { managed.isProcessing = false } } as never
    for (let index = 0; index < 64; index++) {
      const id = `ordinary-stop-${index}`
      const text = `FOLLOWING-STOP-TEXT-${index}`
      managed.messages.push({ id, role: 'user', content: text, timestamp: index + 10, isQueued: true })
      managed.messageQueue.push({ message: text, messageId: id })
      managed.isProcessing = true
      await sm.cancelProcessing(managed.id)
      const event = events.filter(candidate => candidate.type === 'interrupted').at(-1)
      if (!event?.queuedRestoreId || !event.queuedMessageIds?.includes(id)) throw new Error('Actual Stop did not produce queued restore')
      await coordinator.restoreInput(workspace.id, managed.id, managed.projectId, {
        type: 'restore_input',
        text: event.queuedMessages?.join('\n\n') ?? '',
        queuedRestoreId: event.queuedRestoreId,
        messageIds: event.queuedMessageIds,
      })
      if (managed.messages.some((message: { id: string }) => message.id === id)) throw new Error('Actual queued restore ACK failed')
    }
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)?.failed).toBe(true)
    expect(trace.filter(item => item.startsWith('restore-committed:'))).toHaveLength(64)
    expect((getSessionDraft(managed.id)?.text ?? '').split(snapshot).length - 1).toBe(1)
    const replay = await sm.restorePendingPlanDraft(managed.id, plan.executionId!, plan.restoreId!)
    expect(replay.applied).toBe(false)
    expect((replay.draft?.text ?? '').split(snapshot).length - 1).toBe(1)
    await sm.clearPendingPlanExecution(managed.id, plan.executionId)
    expect(getPendingPlanExecution(fixture.sandbox, managed.id)).toBeNull()
  })

  test('same-key new quote survives lost consumption reply and another window restoring the old quote', async () => {
    const fixture = await build('consume-updated-reference-payload')
    const { sm, managed, workspace, sandbox } = fixture
    const sourceId = 'reference-payload-source'
    const source = createManagedSession({ id: sourceId, projectId: managed.projectId }, { ...workspace, rootPath: sandbox }, { messagesLoaded: true })
    source.messages = [{ id: 'quoted-message', role: 'assistant', content: 'OLD_QUOTE', timestamp: 1 }]
    internals(sm).sessions.set(sourceId, source)
    const oldReference: Reference = {
      version: 1, kind: 'chat-message', projectId: managed.projectId,
      sessionId: sourceId, messageId: 'quoted-message', role: 'assistant', quote: 'OLD_QUOTE',
      locator: { type: 'text-quote', exact: 'OLD_QUOTE', start: 0, end: 9 },
    }
    const newReference: Reference = {
      ...oldReference, quote: 'NEW_QUOTE',
      locator: { type: 'text-quote', exact: 'NEW_QUOTE', start: 0, end: 9 },
    }
    const { referenceKey } = await import('@craft-agent/core')
    expect(referenceKey(oldReference)).toBe(referenceKey(newReference))
    const snapshot = 'UPDATED-REFERENCE-SNAPSHOT'
    setSessionDraft(managed.id, { text: snapshot, references: [oldReference] })
    const plan = await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot, [oldReference])
    let loseFirstReply = true
    const trace: string[] = []
    const coordinator = makeCoordinator(fixture, trace, {
      afterConsume: async () => {
        if (loseFirstReply) {
          loseFirstReply = false
          throw new Error('Lost updated-reference consumption reply')
        }
      },
    })
    coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
    const consume = makeActualAppConsume({ draftCoordinator: coordinator, windowWorkspaceId: workspace.id })
    await expect(consume(managed.id, plan.executionId, { text: snapshot, references: [oldReference] })).rejects.toThrow('Lost updated-reference consumption reply')
    // Preview edits preserve the Chat message identity and selection offsets,
    // while the newly selected quote carries the updated source content.
    sm.updateMessageContent(sourceId, 'quoted-message', 'NEW_QUOTE')
    const { validateReferencesForSession } = await import(`${repo}/packages/server-core/src/sessions/message-references.ts`)
    expect(validateReferencesForSession([newReference], { id: managed.id, workspaceId: workspace.id, projectId: managed.projectId }, (id: string) => (
      id === sourceId ? { id: sourceId, workspaceId: workspace.id, projectId: managed.projectId, messages: source.messages } : null
    ))).toEqual([newReference])
    const callbacksStart = appSource.indexOf('  const handleReferencesChange = useCallback(')
    const callbacksEnd = appSource.indexOf('  const handleAddBrowserDraftReference', callbacksStart)
    if (callbacksStart < 0 || callbacksEnd < 0) throw new Error('Actual App reference callbacks not found')
    const callbacks = new Function('ctx', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
      const { draftCoordinator } = ctx;
      const useCallback = fn => fn;
      ${appSource.slice(callbacksStart, callbacksEnd)}
      return { change: handleReferencesChange, add: handleAddDraftReference };
    `))({ draftCoordinator: coordinator })
    expect(callbacks.change(managed.id, [])).toBe(true)
    expect(callbacks.add(managed.id, newReference)).toBe(true)
    expect(coordinator.getReferences(managed.id)).toEqual([newReference])

    const events: Array<{ type?: string; references?: Reference[] }> = []
    ;(sm as unknown as { sendEvent: (event: unknown) => void }).sendEvent = event => events.push(event as typeof events[number])
    await sm.clearPendingPlanExecution(managed.id, plan.executionId)
    const event = events.find(candidate => candidate.type === 'compaction_failed')
    expect(event?.references).toEqual([oldReference])
    const otherTrace: string[] = []
    const otherWindow = makeCoordinator(fixture, otherTrace)
    otherWindow.hydrate(otherWindow.beginHydration(workspace.id), getSessionDraftHydrationState())
    const { recover } = createRecovery(fixture, otherWindow, otherTrace)
    recover(event)
    await waitFor(() => otherTrace.includes('ACK-finished'), 'other window restoring original quote and ACK')
    expect(getSessionDraft(managed.id)?.references).toEqual([oldReference])
    // Confirm the original ambiguous consume first, then save the new local
    // quote. A same-key authority must not overwrite a genuine re-add payload.
    await coordinator.flushContent(managed.id)
    await coordinator.flushForWorkspaceSwitch(workspace.id)
    expect(coordinator.getReferences(managed.id)).toEqual([newReference])
    expect(getSessionDraft(managed.id)?.references).toEqual([newReference])
  })

  test('local input before hydration preserves another window restored snapshot before ACK', async () => {
    const fixture = await build('prehydrate-restored-snapshot')
    const { sm, managed, workspace } = fixture
    const snapshot = 'SERVER-RECOVERED-SNAPSHOT'
    const localText = 'LOCAL-TYPING-BEFORE-HYDRATION'
    const snapshotReference = ref(managed.projectId, 'SNAPSHOT-RECOVERED-REFERENCE')
    const localReference = ref(managed.projectId, 'LOCAL-PREHYDRATION-REFERENCE')
    setSessionDraft(managed.id, { text: snapshot, references: [snapshotReference] })
    const plan = await sm.setPendingPlanExecution(managed.id, '/plan.md', snapshot, [snapshotReference])
    await consumeDraft(fixture)
    const events: Array<{ type?: string }> = []
    ;(sm as unknown as { sendEvent: (event: unknown) => void }).sendEvent = event => events.push(event as typeof events[number])
    await sm.clearPendingPlanExecution(managed.id, plan.executionId)
    const event = events.find(candidate => candidate.type === 'compaction_failed')
    if (!event) throw new Error('Actual cancellation did not expose failed plan')

    const otherTrace: string[] = []
    const otherWindow = makeCoordinator(fixture, otherTrace)
    otherWindow.hydrate(otherWindow.beginHydration(workspace.id), getSessionDraftHydrationState())
    let releaseAck!: () => void
    const ackGate = { promise: new Promise<void>(resolve => { releaseAck = resolve }) }
    createRecovery(fixture, otherWindow, otherTrace, ackGate).recover(event)
    await waitFor(() => otherTrace.some(entry => entry.startsWith('ACK-entered:')), 'other window durable restore before ACK')
    expect(getSessionDraft(managed.id)?.text).toBe(snapshot)

    const trace: string[] = []
    const coordinator = makeCoordinator(fixture, trace)
    const hydration = coordinator.beginHydration(workspace.id)
    coordinator.updateText(managed.id, localText)
    coordinator.replaceReferences(managed.id, [localReference])
    createRecovery(fixture, coordinator, trace).recover(event)
    // The incoming authority already contains the restored snapshot. The
    // local edit was made without seeing it, so cannot mean to overwrite it.
    coordinator.hydrate(hydration, getSessionDraftHydrationState())
    try {
      await waitFor(() => trace.includes('ACK-finished'), 'local recovery scoped ACK after hydration')
      const after = getSessionDraft(managed.id)
      expect((after?.text ?? '').split(snapshot).length - 1).toBe(1)
      expect((after?.text ?? '').split(localText).length - 1).toBe(1)
      expect(after?.references?.map(reference => reference.quote)).toContain(snapshotReference.quote)
      expect(after?.references?.map(reference => reference.quote)).toContain(localReference.quote)
      expect(coordinator.getText(managed.id)).toBe(after?.text ?? '')
      expect(coordinator.getReferences(managed.id)).toEqual(after?.references ?? [])
      expect(getPendingPlanExecution(fixture.sandbox, managed.id)).toBeNull()
    } finally {
      releaseAck()
      await waitFor(() => otherTrace.includes('ACK-finished'), 'other window late ACK stays scoped')
    }
  })
}
