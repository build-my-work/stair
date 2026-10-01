import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { coerceInputText } from '../../../../lib/input-text'
import { shouldHandleScopedInputEvent } from '../input-event-guards'
import { referenceKey } from '@craft-agent/core'
import { planExecutionMode } from '@craft-agent/shared/agent'
import { buildPlanApprovalMessage } from '../../plan-approval-message'
import { findMentionMatches } from '../../../../lib/mentions'

const profile = process.env.CRAFT_CONFIG_DIR
if (!profile?.includes('stair-draft-consumption-profile-')) throw new Error('Disposable profile required')
const repo = resolve(import.meta.dir, '../../../../../../../..')
const { CONFIG_DIR, getSessionDraft, getSessionDraftHydrationState, setSessionDraftContent, reconcileSessionDraftReferences, addSessionDraftReferenceAtomic } = await import('@craft-agent/shared/config')
if (CONFIG_DIR !== profile) throw new Error('Profile imported before isolation')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { SessionManager, createManagedSession } = await import(join(repo, 'packages/server-core/src/sessions/SessionManager.ts'))
const { SessionDraftCoordinator } = await import('../../../../lib/session-draft-coordinator')
const { registerSessionsHandlers } = await import(join(repo, 'packages/server-core/src/handlers/rpc/sessions.ts'))
const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')

// Execute the callbacks that production JSX actually wires, including both
// debounces. No duplicate implementation of the acceptance logic lives here.
const inputSource = readFileSync(join(import.meta.dir, '../FreeFormInput.tsx'), 'utf8')
const appSource = readFileSync(join(repo, 'apps/electron/src/renderer/App.tsx'), 'utf8')
const richSource = readFileSync(join(repo, 'apps/electron/src/renderer/components/ui/rich-text-input.tsx'), 'utf8')
function sourceBetween(source: string, start: string, end: string) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error('Production callback not found')
  return source.slice(from, to)
}
const inputCode = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
const { sessionId, planPreparationInFlightRef, processingRef, liveInputRef, inputRef, referencesValueRef, focusedPanelRef, permissionModeRef, changePermissionModeRef, activeSessionIdRef, richInputRef, changeReferencesRef, submitRef, requestPendingPlanRef, consumePlanDraftRef, preparePlanRef, changeInputRef, setInput, syncTimeoutRef, onInputChange, prevInputValueRef, window } = ctx;
const cleanups = [];
const React = { useCallback: (fn) => fn, useEffect: (fn) => { cleanups.push(fn()); } };
let effectActive = true;
${sourceBetween(inputSource, '  const syncToParent = React.useCallback', '  // Sync immediately on unmount')}
${sourceBetween(inputSource, '  const clearInputDraft = React.useCallback', '  const handleToggleModelVision')}
const clearInputDraftRef = { current: clearInputDraft };
${sourceBetween(inputSource, '    const handleApprovePlanWithCompact = async', "    window.addEventListener('craft:approve-plan-with-compact'")}
${sourceBetween(inputSource, "  // Synchronize the input's 300ms debounce", '  // Listen for craft:focus-input events')}
return { handler: handleApprovePlanWithCompact, type: (text) => { richInputRef.current.setValue(text); setInput(text); syncToParent(text); }, dispose: () => { effectActive = false; if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current); for (const cleanup of cleanups) cleanup?.(); } };
`)
const makeInput = new Function('ctx', 'coerceInputText', 'shouldHandleScopedInputEvent', 'planExecutionMode', 'buildPlanApprovalMessage', 'referenceKey', inputCode)
const makeRichInput = new Function('ctx', 'findMentionMatches', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
const { divRef, lastValueRef, lastMentionSignatureRef, cursorPositionRef, document } = ctx;
const skills = [], sources = [], skillSlugs = [], sourceSlugs = [], workspaceId = undefined;
${sourceBetween(richSource, 'function textToHTML(', '// RotatingPlaceholder Component')}
return {
${sourceBetween(richSource, '      get value() { return lastValueRef.current },', '      setSelectionRange:')}
};
`))
const makeDraftInputEvents = new Function('window', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
return {
${sourceBetween(appSource, '      onBeforeRestore: sessionId => {', '      onReferencesChanged:')}
};
`))
const appCode = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
const { draftCoordinator, windowWorkspaceId } = ctx;
const useCallback = (fn) => fn;
${sourceBetween(appSource, '  const handleConsumePendingPlanDraft = useCallback', '  const handleInputChange = useCallback')}
return handleConsumePendingPlanDraft;
`)
const makeAppConsume = new Function('ctx', appCode)
async function waitFor(check: () => boolean) {
  for (let n = 0; n < 200 && !check(); n++) await Bun.sleep(5)
  expect(check()).toBe(true)
}
const fixtures: any[] = []
async function setup(id: string) {
  const sandbox = mkdtempSync(join(tmpdir(), 'stair-draft-consumption-workspace-'))
  const workspace = createWorkspaceAtPath(sandbox, 'Draft consumption protocol tests')
  const sm = new SessionManager()
  const managed = createManagedSession({ id, name: 'Existing Chat', projectId: workspace.defaultProjectId }, { ...workspace, rootPath: sandbox }, { messagesLoaded: true })
  sm.sessions.set(id, managed)
  sm.decisionFeatureActive = () => false
  sm.processNextQueuedMessage = () => {}
  await saveSession({ id, name: 'Existing Chat', workspaceRootPath: sandbox, projectId: managed.projectId, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as never)
  const handlers = new Map<string, (...args: any[]) => any>()
  registerSessionsHandlers({ handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never, { sessionManager: sm, platform: { logger: { info() {}, warn() {}, error() {} } } } as never)
  const client = { clientId: 'preparation-client', workspaceId: workspace.id }
  const ui = { text: '', references: [] as any[] }
  const live = { current: '' }, previous = { current: '' }
  const element = { innerHTML: '<br>' }
  // DOM content stays independent of React state. Only the production handle's
  // setValue updates it; setInput below deliberately does not force a render.
  const rich = { current: makeRichInput({ divRef: { current: element }, lastValueRef: { current: '' }, lastMentionSignatureRef: { current: '' }, cursorPositionRef: { current: 0 }, document: { activeElement: null } }, findMentionMatches) }
  const referencesValueRef = { current: ui.references }
  const syncTimeoutRef = { current: null as ReturnType<typeof setTimeout> | null }
  const consumes: any[] = [], submitted: any[] = []
  const api = { sessionCommand: async (sid: string, command: any) => {
    const result = await handlers.get(RPC_CHANNELS.sessions.COMMAND)!(client, sid, command)
    if (command.type === 'consumePendingPlanDraft') consumes.push(result)
    return result
  } }
  const windowLike = Object.assign(new EventTarget(), { electronAPI: api })
  let coordinator: InstanceType<typeof SessionDraftCoordinator>
  const changeText = (text: string) => coordinator.updateText(id, text)
  coordinator = new SessionDraftCoordinator({ getProjectId: () => managed.projectId, debounceMs: 60_000,
    ...makeDraftInputEvents(windowLike),
    persistence: {
      setDraftContent: async (sid: string, draft: any, mutation: any) => setSessionDraftContent(sid, draft, mutation),
      updateDraftReferences: async (sid: string, request: any) => reconcileSessionDraftReferences(sid, managed.projectId, request.baseReferences, request.nextReferences),
      addDraftReference: async (sid: string, ref: any, requestId: string) => addSessionDraftReferenceAtomic(sid, managed.projectId, ref, requestId),
      restoreDraftInput: async (sid: string, request: any) => sm.restorePendingPlanDraft(sid, request.planExecutionId, request.restoreId, request.local),
      acknowledgeQueuedInputRestore: async () => {},
      sessionCommand: (sid: string, command: any) => api.sessionCommand(sid, command),
    } as never,
  })
  coordinator.hydrate(coordinator.beginHydration(workspace.id), getSessionDraftHydrationState())
  const consume = makeAppConsume({ draftCoordinator: coordinator, windowWorkspaceId: workspace.id })
  const focusedPanelRef = { current: true }, activeSessionIdRef = { current: id }
  const input = makeInput({ sessionId: id, focusedPanelRef, activeSessionIdRef, planPreparationInFlightRef: { current: null }, processingRef: { current: false }, liveInputRef: live, inputRef: live, referencesValueRef, permissionModeRef: { current: { permissionMode: 'ask' } }, changePermissionModeRef: { current: () => {} }, richInputRef: rich, changeReferencesRef: { current: (refs: any[]) => { ui.references = refs; referencesValueRef.current = refs; coordinator.replaceReferences(id, refs) } }, submitRef: { current: (...args: any[]) => submitted.push(args) }, requestPendingPlanRef: { current: () => {} }, preparePlanRef: { current: undefined }, consumePlanDraftRef: { current: (executionId: string, draft: any) => consume(id, executionId, draft) }, changeInputRef: { current: changeText }, setInput: (text: string) => { ui.text = text; live.current = text }, syncTimeoutRef, onInputChange: changeText, prevInputValueRef: previous, window: windowLike }, coerceInputText, shouldHandleScopedInputEvent, planExecutionMode, buildPlanApprovalMessage, referenceKey)
  const f = { id, sm, managed, sandbox, workspace, ui, rich, element, live, referencesValueRef, coordinator, api, window: windowLike, input, consumes, submitted, focusedPanelRef, activeSessionIdRef, approve: () => input.handler({ detail: { sessionId: id, planPath: '/plan.md', includeDraftInput: true } }) }
  fixtures.push(f)
  return f
}
afterAll(async () => {
  for (const f of fixtures) { f.input.dispose(); f.coordinator.dispose() }
  await sessionPersistenceQueue.flushAll()
  for (const f of fixtures) rmSync(f.sandbox, { recursive: true, force: true })
})

const { createPendingPlanDispatcher } = await import('../pending-plan-dispatch')
const makeAppRecover = new Function('ctx', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
const { draftCoordinator, transportWorkspaceIdRef, store, sessionMetaMapAtom, sessionAtomFamily, windowWorkspaceId, rendererLog } = ctx;
const useCallback = (fn) => fn;
${sourceBetween(appSource, '  const recoverFailedCompactionDraft = useCallback', '  // Re-delivery channel')}
return recoverFailedCompactionDraft;
`))
const makeOutboxListener = new Function('recoverFailedCompactionDraft', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
${sourceBetween(appSource, '    const handleOutboxRedelivery = (event: Event) => {', "    window.addEventListener('craft:compaction-failed', handleOutboxRedelivery)")}
return handleOutboxRedelivery;
`))
const makeDispatcher = new Function('createPendingPlanDispatcher', 'ctx', new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
const { processingRef, sessionId, window } = ctx;
${sourceBetween(inputSource, '    const dispatcher = createPendingPlanDispatcher({', '    const request = () => {')}
return dispatcher;
`))

test('a conditional consumption preserves another window\'s authoritative text after the real input handler', async () => {
  const f = await setup('foreign-window-consumption')
  const b = new SessionDraftCoordinator({
    getProjectId: () => f.managed.projectId, debounceMs: 60_000,
    persistence: {
      setDraftContent: async (id, content, mutation) => setSessionDraftContent(id, content, mutation),
      updateDraftReferences: async (id, request) => reconcileSessionDraftReferences(id, f.managed.projectId, request.baseReferences, request.nextReferences),
      addDraftReference: async (id, reference, requestId) => addSessionDraftReferenceAtomic(id, f.managed.projectId, reference, requestId),
      restoreDraftInput: async (id, request) => f.sm.restorePendingPlanDraft(id, request.planExecutionId, request.restoreId, request.local),
      acknowledgeQueuedInputRestore: async () => {},
    },
  })
  try {
    b.hydrate(b.beginHydration(f.workspace.id), getSessionDraftHydrationState())
    f.input.type('ACCEPTED-WINDOW-A')
    b.updateText(f.id, 'NEW-CONTEXT-WINDOW-B')
    await b.flushContent(f.id)
    await f.approve()
    expect(f.consumes[0].receipt.text).toBe(false)
    expect(getSessionDraft(f.id)?.text).toContain('NEW-CONTEXT-WINDOW-B')
    await f.coordinator.flushContent(f.id)
    const durable = getSessionDraft(f.id)?.text ?? ''
    expect(durable).toContain('NEW-CONTEXT-WINDOW-B')
    expect(durable).toContain('ACCEPTED-WINDOW-A')
    expect(f.ui.text).toBe(durable)
    expect(f.coordinator.getText(f.id)).toBe(durable)
    expect(f.rich.current.value).toBe(durable)
    expect(f.element.innerHTML).toBe(durable.replace(/\n/g, '<br>'))
  } finally {
    b.dispose()
  }
})

test('a lost consumption reply recovers the accepted text once through the actual failed-outbox delivery', async () => {
  const f = await setup('lost-consume-response')
  const snapshot = 'SNAPSHOT-ONCE-AFTER-LOST-CONSUME'
  f.input.type(snapshot)
  const actual = f.api.sessionCommand
  let loseReply = true
  f.api.sessionCommand = async (id: string, command: any) => {
    const result = await actual(id, command)
    if (command.type === 'consumePendingPlanDraft' && loseReply) {
      loseReply = false
      throw new Error('Reply lost after server consumption commit')
    }
    return result
  }
  await f.approve()
  const failed = f.sm.getPendingPlanExecution(f.id)!
  expect(failed.failed).toBe(true)
  expect(f.submitted).toHaveLength(0)
  expect(getSessionDraft(f.id)?.text ?? '').toBe('')
  const windowLike = Object.assign(new EventTarget(), {
    electronAPI: { ...f.api, getPendingPlanExecution: async () => f.sm.getPendingPlanExecution(f.id) },
  })
  const meta = {}
  const recover = makeAppRecover({
    draftCoordinator: f.coordinator, transportWorkspaceIdRef: { current: f.workspace.id },
    store: { get: (atom: unknown) => atom === meta ? new Map([[f.id, { projectId: f.managed.projectId }]]) : { projectId: f.managed.projectId } },
    sessionMetaMapAtom: meta, sessionAtomFamily: () => ({}), windowWorkspaceId: f.workspace.id,
    rendererLog: { warn: (...items: unknown[]) => console.warn(...items) },
  })
  const listener = makeOutboxListener(recover)
  windowLike.addEventListener('craft:compaction-failed', listener)
  const dispatcher = makeDispatcher(createPendingPlanDispatcher, { processingRef: { current: false }, sessionId: f.id, window: windowLike })
  try {
    await dispatcher.request()
    await waitFor(() => f.sm.getPendingPlanExecution(f.id) === null)
    const durable = getSessionDraft(f.id)?.text ?? ''
    expect(durable.split(snapshot).length - 1).toBe(1)
    expect(durable).toBe(snapshot)
    expect(f.coordinator.getText(f.id)).toBe(snapshot)
    expect(f.rich.current.value).toBe(snapshot)
    expect(f.element.innerHTML).toBe(snapshot)
    expect(f.submitted).toHaveLength(0)
  } finally {
    dispatcher.dispose()
    windowLike.removeEventListener('craft:compaction-failed', listener)
  }
})

test('a peer recovery ACK does not turn an original lost consumption into a new edit', async () => {
  const f = await setup('peer-ack-before-consumption-retry')
  const snapshot = 'PEER-RECOVERY-SNAPSHOT-ONCE'
  f.input.type(snapshot)
  const actual = f.api.sessionCommand
  let loseReply = true
  f.api.sessionCommand = async (id: string, command: any) => {
    const result = await actual(id, command)
    if (command.type === 'consumePendingPlanDraft' && loseReply) {
      loseReply = false
      throw new Error('Reply lost after server consumption commit')
    }
    return result
  }
  await f.approve()
  expect(f.sm.getPendingPlanExecution(f.id)?.failed).toBe(true)
  const b = new SessionDraftCoordinator({
    getProjectId: () => f.managed.projectId, debounceMs: 60_000,
    persistence: {
      setDraftContent: async (id, content, mutation) => setSessionDraftContent(id, content, mutation),
      updateDraftReferences: async (id, request) => reconcileSessionDraftReferences(id, f.managed.projectId, request.baseReferences, request.nextReferences),
      addDraftReference: async (id, reference, requestId) => addSessionDraftReferenceAtomic(id, f.managed.projectId, reference, requestId),
      restoreDraftInput: async (id, request) => f.sm.restorePendingPlanDraft(id, request.planExecutionId, request.restoreId, request.local),
      acknowledgeQueuedInputRestore: async () => {},
      sessionCommand: (id, command) => f.api.sessionCommand(id, command),
    },
  })
  b.hydrate(b.beginHydration(f.workspace.id), getSessionDraftHydrationState())
  const windowLike = Object.assign(new EventTarget(), {
    electronAPI: { ...f.api, getPendingPlanExecution: async () => f.sm.getPendingPlanExecution(f.id) },
  })
  const meta = {}
  const recover = makeAppRecover({
    draftCoordinator: b, transportWorkspaceIdRef: { current: f.workspace.id },
    store: { get: (atom: unknown) => atom === meta ? new Map([[f.id, { projectId: f.managed.projectId }]]) : { projectId: f.managed.projectId } },
    sessionMetaMapAtom: meta, sessionAtomFamily: () => ({}), windowWorkspaceId: f.workspace.id,
    rendererLog: { warn: (...items: unknown[]) => console.warn(...items) },
  })
  const listener = makeOutboxListener(recover)
  windowLike.addEventListener('craft:compaction-failed', listener)
  const dispatcher = makeDispatcher(createPendingPlanDispatcher, { processingRef: { current: false }, sessionId: f.id, window: windowLike })
  try {
    await dispatcher.request()
    await waitFor(() => f.sm.getPendingPlanExecution(f.id) === null)
    expect(getSessionDraft(f.id)?.text).toBe(snapshot)
    // A survives its transient disconnect with the old pending consumption.
    // Its next actual 300ms input debounce must add only the newly typed suffix.
    f.input.type(`${snapshot}\nNEW-A-AFTER-RECONNECT`)
    await waitFor(() => f.coordinator.getText(f.id).includes('NEW-A-AFTER-RECONNECT'))
    await f.coordinator.flushContent(f.id)
    const durable = getSessionDraft(f.id)?.text ?? ''
    expect(durable.split(snapshot).length - 1).toBe(1)
    expect(durable).toContain('NEW-A-AFTER-RECONNECT')
    expect(f.coordinator.getText(f.id)).toBe(durable)
    expect(f.rich.current.value).toBe(durable)
    expect(f.element.innerHTML).toBe(durable.replace(/\n/g, '<br>'))
    expect(f.submitted).toHaveLength(0)
  } finally {
    b.dispose()
    dispatcher.dispose()
    windowLike.removeEventListener('craft:compaction-failed', listener)
  }
})

test('starting a new actual Accept after peer ACK first resolves the original window consumption', async () => {
  const f = await setup('peer-ack-before-consumption-retry')
  const snapshot = 'PEER-RECOVERY-SNAPSHOT-ONCE'
  f.input.type(snapshot)
  const actual = f.api.sessionCommand
  let loseReply = true
  f.api.sessionCommand = async (id: string, command: any) => {
    const result = await actual(id, command)
    if (command.type === 'consumePendingPlanDraft' && loseReply) {
      loseReply = false
      throw new Error('Reply lost after server consumption commit')
    }
    return result
  }
  await f.approve()
  const originalExecutionId = f.sm.getPendingPlanExecution(f.id)?.executionId
  expect(f.sm.getPendingPlanExecution(f.id)?.failed).toBe(true)
  const b = new SessionDraftCoordinator({
    getProjectId: () => f.managed.projectId, debounceMs: 60_000,
    persistence: {
      setDraftContent: async (id, content, mutation) => setSessionDraftContent(id, content, mutation),
      updateDraftReferences: async (id, request) => reconcileSessionDraftReferences(id, f.managed.projectId, request.baseReferences, request.nextReferences),
      addDraftReference: async (id, reference, requestId) => addSessionDraftReferenceAtomic(id, f.managed.projectId, reference, requestId),
      restoreDraftInput: async (id, request) => f.sm.restorePendingPlanDraft(id, request.planExecutionId, request.restoreId, request.local),
      acknowledgeQueuedInputRestore: async () => {},
      sessionCommand: (id, command) => f.api.sessionCommand(id, command),
    },
  })
  b.hydrate(b.beginHydration(f.workspace.id), getSessionDraftHydrationState())
  const windowLike = Object.assign(new EventTarget(), {
    electronAPI: { ...f.api, getPendingPlanExecution: async () => f.sm.getPendingPlanExecution(f.id) },
  })
  const meta = {}
  const recover = makeAppRecover({
    draftCoordinator: b, transportWorkspaceIdRef: { current: f.workspace.id },
    store: { get: (atom: unknown) => atom === meta ? new Map([[f.id, { projectId: f.managed.projectId }]]) : { projectId: f.managed.projectId } },
    sessionMetaMapAtom: meta, sessionAtomFamily: () => ({}), windowWorkspaceId: f.workspace.id,
    rendererLog: { warn: (...items: unknown[]) => console.warn(...items) },
  })
  const listener = makeOutboxListener(recover)
  windowLike.addEventListener('craft:compaction-failed', listener)
  const dispatcher = makeDispatcher(createPendingPlanDispatcher, { processingRef: { current: false }, sessionId: f.id, window: windowLike })
  try {
    await dispatcher.request()
    await waitFor(() => f.sm.getPendingPlanExecution(f.id) === null)
    expect(getSessionDraft(f.id)?.text).toBe(snapshot)
    await f.approve()
    const next = f.consumes.at(-1)
    expect(next.receipt.text).toBe(true)
    expect(getSessionDraft(f.id)?.text ?? '').toBe('')
    expect(f.submitted).toHaveLength(1)
    const nextExecutionId = f.sm.getPendingPlanExecution(f.id)?.executionId
    expect(nextExecutionId).toBeDefined()
    expect(nextExecutionId).not.toBe(originalExecutionId)
    expect(f.submitted[0][4].planExecutionId).toBe(nextExecutionId)
    expect(f.coordinator.getText(f.id)).toBe('')
    expect(f.rich.current.value).toBe('')
    expect(f.element.innerHTML).toBe('<br>')
    await f.coordinator.flushContent(f.id)
    expect(getSessionDraft(f.id)?.text ?? '').toBe('')
  } finally {
    b.dispose()
    dispatcher.dispose()
    windowLike.removeEventListener('craft:compaction-failed', listener)
  }
})
