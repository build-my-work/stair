import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FileAttachment } from '../../../shared/types'

const repo = new URL('../../../../../..', import.meta.url).pathname
if (process.env.STAIR_ATTACHMENT_HYDRATION_CHILD !== '1') {
  test('attachment hydration and user edits compose through actual React effects and the durable store', () => {
    const profile = mkdtempSync(join(tmpdir(), 'stair-attachment-hydration-'))
    try {
      copyFileSync(join(repo, 'apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
      const child = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, CRAFT_CONFIG_DIR: profile, STAIR_ATTACHMENT_HYDRATION_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe',
      })
      if (child.exitCode !== 0) throw new Error(child.stdout.toString() + child.stderr.toString())
      expect(child.exitCode).toBe(0)
    } finally { rmSync(profile, { recursive: true, force: true }) }
  })
} else {
  const profile = process.env.CRAFT_CONFIG_DIR
  if (!profile?.includes('stair-attachment-hydration-')) throw new Error('Disposable profile required')
  const config = await import('@craft-agent/shared/config')
  const { SessionDraftCoordinator } = await import('../../lib/session-draft-coordinator')
  const { shouldHandleScopedInputEvent } = await import('../../components/app-shell/input/input-event-guards')
  const { readFileAttachment } = await import('@craft-agent/shared/utils')
  const require = createRequire(join(repo, 'apps/electron/package.json'))
  const React = require('react')
  const { act } = React
  const { createRoot } = require('react-dom/client')
  const domino = require('@mixmark-io/domino')
  const page = readFileSync(join(repo, 'apps/electron/src/renderer/pages/ChatPage.tsx'), 'utf8')
  const input = readFileSync(join(repo, 'apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx'), 'utf8')
  const app = readFileSync(join(repo, 'apps/electron/src/renderer/App.tsx'), 'utf8')
  const transpile = (source: string) => new Bun.Transpiler({ loader: 'tsx' }).transformSync(source)
  const pageStart = page.indexOf('  const [attachmentsValue, setAttachmentsValue]')
  const pageEnd = page.indexOf('  const [referencesValue, setReferencesValue]', pageStart)
  const inputStart = input.indexOf('  const [attachments, setAttachments]')
  const inputEnd = input.indexOf('  // Optimistic state for source selection', inputStart)
  const hydrateStart = app.indexOf('  const hydrateDraftAttachments = useCallback')
  const hydrateEnd = app.indexOf('  const handlePreparePendingPlanExecution', hydrateStart)
  const ownerStart = input.indexOf('  const [loadingCount, setLoadingCount]')
  const ownerEnd = input.indexOf('  const [sourceDropdownOpen', ownerStart)
  const processStart = input.indexOf('  const processFileAttachment = async')
  const processEnd = input.indexOf('  // File attachment handlers', processStart)
  const fileInputStart = input.indexOf('  const handleFileInputChange = async')
  const fileInputEnd = input.indexOf('  const handleRemoveAttachment', fileInputStart)
  const pasteStart = input.indexOf('  // Get the next available number for a pasted file prefix')
  const pasteEnd = input.indexOf('  // Build active commands list', pasteStart)
  if ([pageStart, pageEnd, inputStart, inputEnd, hydrateStart, hydrateEnd, ownerStart, ownerEnd, processStart, processEnd, fileInputStart, fileInputEnd, pasteStart, pasteEnd].some(index => index < 0)) throw new Error('Production hook boundaries changed')
  const usePage = new Function('React', transpile(`return function(context) {
    const {sessionId, hydrateDraftAttachments, onAttachmentsChange} = context;
    ${page.slice(pageStart, pageEnd)}
    return { attachmentsValue, handleAttachmentsChange };
  }`))(React)
  const useInput = new Function('React', 'shouldHandleScopedInputEvent', transpile(`return function(context) {
    const {attachmentsValue, onAttachmentsChange, sessionId, readFileAsAttachment, richInputRef} = context;
    const disabled = false, isFocusedPanel = true, focusedPanelRef = { current: true };
    ${input.slice(inputStart, inputEnd)}
    ${input.slice(ownerStart, ownerEnd)}
    ${input.slice(processStart, processEnd)}
    ${input.slice(fileInputStart, fileInputEnd)}
    ${input.slice(pasteStart, pasteEnd)}
    return { attachments, setAttachments, handleFileInputChange, loadingCount };
  }`))(React, shouldHandleScopedInputEvent)
  const makeHydrator = new Function('useCallback', 'draftCoordinator', 'attachmentFromContentRef', transpile(`
    ${app.slice(hydrateStart, hydrateEnd)}
    return hydrateDraftAttachments;
  `))
  let root: ReturnType<typeof createRoot>
  let activeCoordinator: InstanceType<typeof SessionDraftCoordinator> | undefined
  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    root = undefined
    activeCoordinator?.dispose()
    activeCoordinator = undefined
  })

  function seed(sessionId: string) {
    const path = join(profile!, `${sessionId}.txt`)
    writeFileSync(path, `ATTACHMENT-${sessionId}`)
    const refs = [{ path, name: `original-${sessionId}.txt` }]
    config.setSessionDraft(sessionId, { text: 'A\n\nB', attachments: refs })
    return refs
  }

  function setup(strict = true, read: (path: string) => Promise<FileAttachment | null> = async path => readFileAttachment(path), readFileAsAttachment: (file: File) => Promise<FileAttachment | null> = async () => null) {
    const w = domino.createWindow('<html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, Node: w.Node, IS_REACT_ACT_ENVIRONMENT: true })
    w.electronAPI = { readUserAttachment: read }
    const coordinator = new SessionDraftCoordinator({
      getProjectId: () => 'project-a', debounceMs: 60_000,
      persistence: {
        setDraftContent: async (id, content, mutation) => config.setSessionDraftContent(id, content, mutation),
        updateDraftReferences: async (id, update) => config.reconcileSessionDraftReferences(id, 'project-a', update.baseReferences, update.nextReferences),
        addDraftReference: async (id, ref) => config.addSessionDraftReferenceAtomic(id, 'project-a', ref),
        restoreDraftInput: async (id, request) => config.restoreSessionDraftAtomic(id, 'project-a', request.restoreId, request.draft, request.local),
        acknowledgeQueuedInputRestore: async () => {},
      },
    })
    activeCoordinator = coordinator
    const hydration = coordinator.beginHydration('workspace-a')
    coordinator.hydrate(hydration, config.getSessionDraftHydrationState())
    const hydrateDraftAttachments = makeHydrator((callback: unknown) => callback, coordinator, () => { throw new Error('Expected a path attachment') })
    const changes: Array<{ sessionId: string; attachments: FileAttachment[] }> = []
    const onAttachmentsChange = (sessionId: string, attachments: FileAttachment[]) => {
      changes.push({ sessionId, attachments })
      coordinator.updateAttachments(sessionId, attachments.map(attachment => ({ path: attachment.path!, name: attachment.name })))
    }
    let focusCount = 0
    const richInputRef = { current: { focus: () => { focusCount += 1 } } }
    let visible: { attachments: FileAttachment[]; setAttachments: (attachments: FileAttachment[]) => void; handleFileInputChange: (event: { target: { files: File[]; value: string } }) => Promise<void>; loadingCount: number }
    function Composer(props: unknown) { visible = useInput(props); return null }
    function Page({ sessionId }: { sessionId: string }) {
      const state = usePage({ sessionId, hydrateDraftAttachments, onAttachmentsChange })
      // Deliberately no session key: production reuses the same freeform input.
      return React.createElement(Composer, { sessionId, attachmentsValue: state.attachmentsValue, onAttachmentsChange: state.handleAttachmentsChange, readFileAsAttachment, richInputRef })
    }
    root = createRoot(w.document.getElementById('root'))
    const render = async (sessionId: string) => {
      await act(async () => root.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Page, { sessionId })) : React.createElement(Page, { sessionId })))
    }
    const unmount = async () => { await act(async () => root.unmount()); root = undefined }
    return { render, changes, coordinator, w, unmount, get focusCount() { return focusCount }, get input() { return visible! } }
  }

  test.each([false, true])('persisted background-session attachment survives first mount (StrictMode=%s)', async strict => {
    const id = `reopened-${strict}`
    const refs = seed(id)
    const h = setup(strict)
    await h.render(id)
    await h.coordinator.flushContent(id)
    expect(h.input.attachments.map(attachment => attachment.name)).toEqual([refs[0]!.name])
    expect(config.getSessionDraft(id)?.attachments).toEqual(refs)
    expect(h.changes).toEqual([])
  })

  test('switching sessions with the same composer neither echoes the old attachments nor loses either draft', async () => {
    const a = seed('switch-a')
    const b = seed('switch-b')
    const h = setup()
    await h.render('switch-a')
    expect(h.input.attachments[0]?.name).toBe(a[0]!.name)
    await h.render('switch-b')
    expect(h.input.attachments[0]?.name).toBe(b[0]!.name)
    await h.render('switch-a')
    expect(h.input.attachments[0]?.name).toBe(a[0]!.name)
    expect(h.changes).toEqual([])
    expect(config.getSessionDraft('switch-a')?.attachments).toEqual(a)
    expect(config.getSessionDraft('switch-b')?.attachments).toEqual(b)
  })

  test('a local add followed by removal remains authoritative when an earlier hydration read completes', async () => {
    const refs = seed('late-read')
    const pending = Promise.withResolvers<FileAttachment | null>()
    const h = setup(true, () => pending.promise)
    await h.render('late-read')
    const added = { ...readFileAttachment(refs[0]!.path)!, name: 'new-local.txt' }
    await act(async () => h.input.setAttachments([added]))
    await h.coordinator.flushContent('late-read')
    expect(config.getSessionDraft('late-read')?.attachments?.[0]?.name).toBe('new-local.txt')
    await act(async () => h.input.setAttachments([]))
    await act(async () => { pending.resolve(readFileAttachment(refs[0]!.path)); await pending.promise })
    await h.coordinator.flushContent('late-read')
    expect(h.input.attachments).toEqual([])
    expect(h.coordinator.getAttachmentRefs('late-read')).toEqual([])
    expect(config.getSessionDraft('late-read')?.attachments).toBeUndefined()
    expect(h.changes.map(change => change.attachments.map(attachment => attachment.name))).toEqual([['new-local.txt'], []])
  })

  test('an upload started in A cannot complete into B or a later visit to A', async () => {
    const a = seed('upload-a')
    const b = seed('upload-b')
    const pending = Promise.withResolvers<FileAttachment | null>()
    const h = setup(true, async path => readFileAttachment(path), () => pending.promise)
    await h.render('upload-a')
    let reading!: Promise<void>
    const event = { target: { files: [new File(['bytes'], 'incoming.txt')], value: 'selected' } }
    await act(async () => { reading = h.input.handleFileInputChange(event) })
    expect(h.input.loadingCount).toBe(1)
    await h.render('upload-b')
    expect(h.input.loadingCount).toBe(0)
    await h.render('upload-a')
    await act(async () => { pending.resolve({ ...readFileAttachment(a[0]!.path)!, name: 'late-incoming.txt' }); await reading })
    expect(h.input.attachments.map(attachment => attachment.name)).toEqual([a[0]!.name])
    expect(h.changes).toEqual([])
    expect(event.target.value).toBe('selected')
    expect(config.getSessionDraft('upload-a')?.attachments).toEqual(a)
    expect(config.getSessionDraft('upload-b')?.attachments).toEqual(b)
  })

  test('a completed upload still appends and persists in its current session', async () => {
    const refs = seed('upload-current')
    const added = { ...readFileAttachment(refs[0]!.path)!, name: 'added.txt' }
    const h = setup(true, async path => readFileAttachment(path), async () => added)
    await h.render('upload-current')
    const event = { target: { files: [new File(['bytes'], 'incoming.txt')], value: 'selected' } }
    await act(async () => h.input.handleFileInputChange(event))
    await h.coordinator.flushContent('upload-current')
    expect(h.input.attachments.map(attachment => attachment.name)).toEqual([refs[0]!.name, 'added.txt'])
    expect(config.getSessionDraft('upload-current')?.attachments?.map(attachment => attachment.name)).toEqual([refs[0]!.name, 'added.txt'])
    expect(h.input.loadingCount).toBe(0)
    expect(event.target.value).toBe('')
  })

  test.each(['switch', 'unmount'])('global paste completion cannot mutate or focus after its session ownership ends (%s)', async action => {
    const a = seed(`paste-a-${action}`)
    const b = seed(`paste-b-${action}`)
    const pending = Promise.withResolvers<FileAttachment | null>()
    const h = setup(true, async path => readFileAttachment(path), () => pending.promise)
    await h.render(`paste-a-${action}`)
    await act(async () => {
      const event = h.w.document.createEvent('Event')
      event.initEvent('craft:paste-files', false, false)
      Object.defineProperty(event, 'detail', { value: { sessionId: `paste-a-${action}`, files: [new File(['bytes'], 'incoming.txt')] } })
      h.w.dispatchEvent(event)
    })
    expect(h.input.loadingCount).toBe(1)
    if (action === 'switch') await h.render(`paste-b-${action}`)
    else await h.unmount()
    await act(async () => { pending.resolve({ ...readFileAttachment(a[0]!.path)!, name: 'late-paste.txt' }); await pending.promise })
    expect(h.changes).toEqual([])
    expect(h.focusCount).toBe(0)
    expect(config.getSessionDraft(`paste-a-${action}`)?.attachments).toEqual(a)
    expect(config.getSessionDraft(`paste-b-${action}`)?.attachments).toEqual(b)
    if (action === 'switch') expect(h.input.loadingCount).toBe(0)
  })
}
