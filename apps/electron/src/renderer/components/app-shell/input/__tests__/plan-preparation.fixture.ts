import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { coerceInputText } from '../../../../lib/input-text'
import { shouldHandleScopedInputEvent } from '../input-event-guards'
import { referenceKey } from '@craft-agent/core'
import { planExecutionMode } from '@craft-agent/shared/agent'
import { buildPlanApprovalMessage } from '../../plan-approval-message'
import { extractBadges } from '../../../../lib/mentions'
import i18next from 'i18next'

const profile = process.env.CRAFT_CONFIG_DIR
if (!profile?.includes('stair-plan-preparation-profile-')) throw new Error('Disposable profile required')
const repo = resolve(import.meta.dir, '../../../../../../../..')
const { CONFIG_DIR, getSessionDraft, getSessionDraftHydrationState, setSessionDraftContent, reconcileSessionDraftReferences, addSessionDraftReferenceAtomic } = await import('@craft-agent/shared/config')
if (CONFIG_DIR !== profile) throw new Error('Profile imported before isolation')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSession, loadSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { SessionManager, createManagedSession } = await import(join(repo, 'packages/server-core/src/sessions/SessionManager.ts'))
const { SessionDraftCoordinator } = await import('../../../../lib/session-draft-coordinator')
const { registerSessionsHandlers } = await import(join(repo, 'packages/server-core/src/handlers/rpc/sessions.ts'))
const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')

// Execute the callbacks that production JSX actually wires, including both
// debounces. No duplicate implementation of the acceptance logic lives here.
const inputSource = readFileSync(join(import.meta.dir, '../FreeFormInput.tsx'), 'utf8')
const appSource = readFileSync(join(repo, 'apps/electron/src/renderer/App.tsx'), 'utf8')
function sourceBetween(source: string, start: string, end: string) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error('Production callback not found')
  return source.slice(from, to)
}
const inputCode = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
const { sessionId, planPreparationInFlightRef, processingRef, liveInputRef, inputRef, referencesValueRef, focusedPanelRef, permissionModeRef, changePermissionModeRef, activeSessionIdRef, richInputRef, changeReferencesRef, submitRef, requestPendingPlanRef, consumePlanDraftRef, preparePlanRef, changeInputRef, setInput, syncTimeoutRef, onInputChange, prevInputValueRef, window } = ctx;
const React = { useCallback: (fn) => fn };
let effectActive = true;
${sourceBetween(inputSource, '  const syncToParent = React.useCallback', '  // Sync immediately on unmount')}
${sourceBetween(inputSource, '  const clearInputDraft = React.useCallback', '  const handleToggleModelVision')}
const clearInputDraftRef = { current: clearInputDraft };
${sourceBetween(inputSource, '    const handleApprovePlanWithCompact = async', "    window.addEventListener('craft:approve-plan-with-compact'")}
return { handler: handleApprovePlanWithCompact, type: (text) => { setInput(text); syncToParent(text); }, dispose: () => { effectActive = false; if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current); } };
`)
const makeInput = new Function('ctx', 'coerceInputText', 'shouldHandleScopedInputEvent', 'planExecutionMode', 'buildPlanApprovalMessage', 'referenceKey', inputCode)
const appCode = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
const { draftCoordinator, windowWorkspaceId } = ctx;
const useCallback = (fn) => fn;
${sourceBetween(appSource, '  const handleConsumePendingPlanDraft = useCallback', '  const handleEditMessage = useCallback')}
return handleConsumePendingPlanDraft;
`)
const makeAppConsume = new Function('ctx', appCode)
const prepareCode = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
const { windowWorkspaceSlug, skills, sources, window } = ctx;
const useCallback = (fn) => fn;
${sourceBetween(appSource, '  const handlePreparePendingPlanExecution = useCallback', '  const handleConsumePendingPlanDraft = useCallback')}
return handlePreparePendingPlanExecution;
`)
const makeAppPrepare = new Function('ctx', 'extractBadges', prepareCode)
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function waitFor(check: () => boolean) {
  for (let n = 0; n < 200 && !check(); n++) await Bun.sleep(5)
  expect(check()).toBe(true)
}
const fixtures: any[] = []
async function setup(id: string) {
  const sandbox = mkdtempSync(join(tmpdir(), 'stair-plan-preparation-workspace-'))
  const workspace = createWorkspaceAtPath(sandbox, 'Plan preparation tests')
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
  const live = { current: '' }, rich = { current: { value: '', setValue(text: string) { this.value = text } } }, previous = { current: '' }
  const referencesValueRef = { current: ui.references }
  const syncTimeoutRef = { current: null as ReturnType<typeof setTimeout> | null }
  const consumes: any[] = [], submitted: any[] = []
  const api = { sessionCommand: async (sid: string, command: any) => {
    const result = await handlers.get(RPC_CHANNELS.sessions.COMMAND)!(client, sid, command)
    if (command.type === 'consumePendingPlanDraft') consumes.push(result)
    return result
  } }
  let coordinator: InstanceType<typeof SessionDraftCoordinator>
  const changeText = (text: string) => coordinator.updateText(id, text)
  const flushUI = () => {
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    syncTimeoutRef.current = null
    changeText(rich.current.value)
    previous.current = rich.current.value
  }
  coordinator = new SessionDraftCoordinator({ getProjectId: () => managed.projectId, debounceMs: 60_000,
    onBeforeRestore: flushUI,
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
  const preparePlanRef: { current: any } = { current: undefined }
  const input = makeInput({ sessionId: id, focusedPanelRef, activeSessionIdRef, planPreparationInFlightRef: { current: null }, processingRef: { current: false }, liveInputRef: live, inputRef: live, referencesValueRef, permissionModeRef: { current: { permissionMode: 'ask' } }, changePermissionModeRef: { current: () => {} }, richInputRef: rich, changeReferencesRef: { current: (refs: any[]) => { ui.references = refs; referencesValueRef.current = refs; coordinator.replaceReferences(id, refs) } }, submitRef: { current: (...args: any[]) => submitted.push(args) }, requestPendingPlanRef: { current: () => {} }, preparePlanRef, consumePlanDraftRef: { current: (executionId: string, draft: any) => consume(id, executionId, draft) }, changeInputRef: { current: changeText }, setInput: (text: string) => { ui.text = text; live.current = text; rich.current.value = text }, syncTimeoutRef, onInputChange: changeText, prevInputValueRef: previous, window: { electronAPI: api } }, coerceInputText, shouldHandleScopedInputEvent, planExecutionMode, buildPlanApprovalMessage, referenceKey)
  const f = { id, sm, managed, sandbox, workspace, ui, rich, live, referencesValueRef, coordinator, api, input, consumes, submitted, focusedPanelRef, activeSessionIdRef, preparePlanRef, approve: () => input.handler({ detail: { sessionId: id, planPath: '/plan.md', includeDraftInput: true } }) }
  fixtures.push(f)
  return f
}
afterAll(async () => {
  for (const f of fixtures) { f.input.dispose(); f.coordinator.dispose() }
  await sessionPersistenceQueue.flushAll()
  for (const f of fixtures) rmSync(f.sandbox, { recursive: true, force: true })
})

test('fresh DOM input is consumed before either debounce fires, with the observed compact id', async () => {
  const f = await setup('fresh-dom')
  f.input.type('Fresh unsaved context')
  expect(f.coordinator.getText(f.id)).toBe('')
  expect(getSessionDraft(f.id)).toBeNull()
  await f.approve()
  expect(f.consumes[0].receipt.text).toBe(true)
  expect(f.ui.text).toBe('')
  expect(f.submitted).toHaveLength(1)
  expect(f.submitted[0][4].planExecutionId).toBe(f.managed.pendingPlanExecution.executionId)
  await f.coordinator.flushContent(f.id)
  expect(getSessionDraft(f.id)?.text ?? '').toBe('')
})

test('actual DOM value wins over a lagging React value in the acceptance snapshot', async () => {
  const f = await setup('dom-snapshot')
  f.live.current = 'Lagging React state'
  f.rich.current.value = 'Current DOM state'
  f.ui.text = f.rich.current.value
  await f.approve()
  expect(f.managed.pendingPlanExecution.draftInputSnapshot).toBe('Current DOM state')
  expect(f.consumes[0].receipt.text).toBe(true)
})

test('text and a new reference typed during the actual consume RPC response survive', async () => {
  const f = await setup('during-consume')
  f.input.type('Accepted context')
  const old: import('@craft-agent/core').WebSelectionReferenceV1 = { version: 1, kind: 'web-selection', projectId: f.managed.projectId, url: 'https://example.test/old', title: 'Old', quote: 'OLD', locator: { type: 'web-text-quote', exact: 'OLD' } }
  const newer: import('@craft-agent/core').WebSelectionReferenceV1 = { ...old, url: 'https://example.test/new', title: 'New', quote: 'NEW', locator: { type: 'web-text-quote', exact: 'NEW' } }
  f.referencesValueRef.current = [old]
  f.coordinator.replaceReferences(f.id, [old])
  const actual = f.api.sessionCommand
  const response = gate(), entered = gate()
  f.api.sessionCommand = async (sid: string, command: any) => {
    const result = await actual(sid, command)
    if (command.type === 'consumePendingPlanDraft') { entered.release(); await response.promise }
    return result
  }
  const preparing = f.approve()
  await entered.promise
  f.input.type('New text entered during RPC')
  f.referencesValueRef.current = [old, newer]
  f.coordinator.replaceReferences(f.id, [old, newer])
  response.release()
  await preparing
  expect(f.ui.text).toBe('New text entered during RPC')
  expect(f.referencesValueRef.current).toEqual([newer])
  await f.coordinator.flushPendingDrafts(f.workspace.id)
  expect(getSessionDraft(f.id)?.text).toBe('New text entered during RPC')
  expect(getSessionDraft(f.id)?.references).toEqual([newer])
})

test('a real already-inflight content write finishes before atomic consumption', async () => {
  const f = await setup('inflight-write')
  f.input.type('Accepted inflight context')
  f.coordinator.updateText(f.id, f.ui.text)
  const write = gate(), entered = gate()
  const persistence = (f.coordinator as unknown as { persistence: import('../../../../lib/session-draft-coordinator').SessionDraftPersistence }).persistence
  const actual = persistence.setDraftContent
  persistence.setDraftContent = async (sid, draft, mutation) => { entered.release(); await write.promise; return actual(sid, draft, mutation) }
  const saving = f.coordinator.flushContent(f.id)
  await entered.promise
  const preparing = f.approve()
  await Bun.sleep(15)
  expect(f.consumes).toHaveLength(0)
  write.release()
  await saving
  await preparing
  expect(f.consumes[0].receipt.text).toBe(true)
  await f.coordinator.flushContent(f.id)
  expect(getSessionDraft(f.id)?.text ?? '').toBe('')
})

test('focus change and duplicate events do not invalidate an owned preparation', async () => {
  const f = await setup('focus-lifetime')
  f.input.type('Owned context')
  const actual = f.api.sessionCommand
  const response = gate(), entered = gate()
  f.api.sessionCommand = async (sid: string, command: any) => {
    const result = await actual(sid, command)
    if (command.type === 'setPendingPlanExecution') { entered.release(); await response.promise }
    return result
  }
  const preparing = f.approve()
  await entered.promise
  f.focusedPanelRef.current = false
  await f.approve()
  response.release()
  await preparing
  expect(f.consumes).toHaveLength(1)
  expect(f.submitted).toHaveLength(1)
  // Production effect ownership depends on session, not focus/typing renders.
  const effect = sourceBetween(inputSource, '  const planPreparationInFlightRef', '  // Synchronize the input')
  expect(effect).toContain('}, [sessionId])')
})

test('unmount during prepare preserves the draft and cancels only its scoped record', async () => {
  const f = await setup('unmount-prepare')
  f.input.type('Unmount preserved context')
  const actual = f.api.sessionCommand
  const response = gate(), entered = gate()
  f.api.sessionCommand = async (sid: string, command: any) => {
    const result = await actual(sid, command)
    if (command.type === 'setPendingPlanExecution') { entered.release(); await response.promise }
    return result
  }
  const preparing = f.approve()
  await entered.promise
  f.input.dispose()
  response.release()
  await preparing
  expect(f.consumes).toHaveLength(0)
  expect(f.submitted).toHaveLength(0)
  expect(f.ui.text).toBe('Unmount preserved context')
  expect(f.sm.getPendingPlanExecution(f.id)).toBeNull()
})

test('agent setup failure returns the compact acceptance to a durable failed outbox', async () => {
  const f = await setup('compact-agent-setup-failure')
  f.input.type('Setup failure preserves accepted context')
  await f.approve()
  const executionId = f.managed.pendingPlanExecution.executionId
  f.sm.getOrCreateAgent = async () => { throw new Error('isolated agent setup failure') }
  await expect(f.sm.sendMessage(f.id, '/compact', undefined, undefined, { planExecutionId: executionId })).rejects.toThrow('isolated agent setup failure')
  expect(f.sm.getPendingPlanExecution(f.id)).toMatchObject({ executionId, failed: true, draftInputSnapshot: 'Setup failure preserves accepted context' })
  expect(f.managed.isProcessing).toBe(false)
  expect(f.managed.messageQueue).toHaveLength(0)
})

test('a compact iterator ending without manual success retains recoverable input', async () => {
  const f = await setup('compact-no-manual-success')
  f.input.type('No manual success preserves accepted context')
  await f.approve()
  const agent = { getModel: () => 'no-model', setAllSources() {}, getSessionId: () => undefined, isCompactionInFlight: () => false, chat: async function* () {} }
  f.sm.getOrCreateAgent = async () => { f.managed.agent = agent; return agent }
  const executionId = f.managed.pendingPlanExecution.executionId
  await f.sm.sendMessage(f.id, '/compact', undefined, undefined, { planExecutionId: executionId })
  expect(f.sm.getPendingPlanExecution(f.id)).toMatchObject({ executionId, failed: true, draftInputSnapshot: 'No manual success preserves accepted context' })
  expect(f.managed.isProcessing).toBe(false)
  expect(f.managed.messageQueue).toHaveLength(0)
})

test('a delayed compact for acceptance A never stamps an already-consumed acceptance B', async () => {
  const f = await setup('compact-observed-identity')
  f.input.type('Accepted A')
  await f.approve()
  const oldId = f.managed.pendingPlanExecution.executionId
  await f.sm.clearPendingPlanExecution(f.id, oldId)
  const failed = f.sm.getPendingPlanExecution(f.id)
  await f.coordinator.restoreInput(f.workspace.id, f.id, f.managed.projectId, { type: 'restore_input', text: failed.draftInputSnapshot, queuedRestoreId: failed.restoreId, planExecutionId: oldId })
  f.input.type('Accepted B')
  await f.approve()
  const newId = f.managed.pendingPlanExecution.executionId
  const agent = { getModel: () => 'no-model', setAllSources() {}, getSessionId: () => undefined, isCompactionInFlight: () => false, chat: async function* () {} }
  f.sm.getOrCreateAgent = async () => { f.managed.agent = agent; return agent }
  await f.sm.sendMessage(f.id, '/compact', undefined, undefined, { planExecutionId: oldId })
  expect(f.managed.pendingPlanExecution).toMatchObject({ executionId: newId, awaitingCompaction: true })
  expect(f.managed.pendingPlanExecution.compactionTurn).toBeUndefined()
  expect(await f.sm.markCompactionComplete(f.id, newId)).toBe(false)
})

test('actual App preparation preserves long localized approval text and mention badges through durable dispatch', async () => {
  const f = await setup('localized-approval-metadata')
  await i18next.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: { plan: { approved: '计划已批准，请执行。', additionalUserContext: '补充要求' } } } } })
  const skills = [{ slug: 'review', metadata: { name: 'Review skill' }, source: 'workspace' }]
  const prepare = makeAppPrepare({ windowWorkspaceSlug: 'test-workspace', skills, sources: [], window: { electronAPI: f.api } }, extractBadges)
  f.preparePlanRef.current = (command: any) => prepare(f.id, command)
  const text = `[skill:test-workspace:review]\n${'保留完整的额外要求。'.repeat(600)}`
  f.input.type(text)
  await f.approve()
  const record = f.managed.pendingPlanExecution
  expect(record.approvalMessage).toBe(buildPlanApprovalMessage({ draftInput: text }))
  expect(record.approvalMessage.length).toBeGreaterThan(4000)
  expect(record.approvalBadges).toHaveLength(1)
  record.compactionTurn = { generation: f.managed.processingGeneration, stopEpoch: f.managed.stopEpoch ?? 0 }
  const stored = loadSession(f.sandbox, f.id)!
  stored.pendingPlanExecution = record
  await saveSession(stored)
  expect(await f.sm.markCompactionComplete(f.id, record.executionId)).toBe(true)
  expect(await f.sm.dispatchPendingPlanExecution(f.id, record.executionId)).toEqual({ ok: true })
  const dispatchedSession = loadSession(f.sandbox, f.id)!
  const approval = dispatchedSession.messages.find(message => message.id === dispatchedSession.pendingPlanExecution?.approvalMessageId)
  expect(approval?.content).toBe(record.approvalMessage)
  expect(approval?.badges).toEqual(record.approvalBadges)
  expect(f.managed.messageQueue[0].options.badges).toEqual(record.approvalBadges)
})
