import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createStore } from 'jotai'
import { workbenchAtom, createEmptyProjectWorkbench, workbenchPanelLayoutWidthAtom } from '@/workbench/workbench-state'
import { closeWorkbenchPanelAtom, resizeWorkbenchPanelAtom } from '@/workbench/workbench-commands'
import { openNotionPageAtom } from './notion-workbench'
import { notionGuestReady, removeNotionGuest } from './notion-view-state'
import { hydrateWorkbenchLayouts, serializeWorkbenchLayouts } from '@/workbench/workbench-persistence'
import type { PersistedWorkbenchLayoutDocument } from '@craft-agent/shared/workbench-layout'

const page = '11111111-1111-1111-1111-111111111111'
const second = '22222222-2222-2222-2222-222222222222'

const originalWindow = globalThis.window

describe('Notion workbench commands', () => {
  afterEach(() => { globalThis.window = originalWindow })
  beforeEach(() => { removeNotionGuest('a'); notionGuestReady('a').resolve() })
  it('reuses one panel and permits parked Project navigation without changing active Project', async () => {
    const store = createStore()
    store.set(workbenchPanelLayoutWidthAtom, 1200)
    const calls: string[] = []
    globalThis.window = { electronAPI: { notionView: async ({ pageId }: { pageId: string }) => { calls.push(pageId); return { pageId } } } } as unknown as Window & typeof globalThis
    store.set(workbenchAtom, { workspaceId: 'w', activeProjectId: 'a', layoutsByProject: { a: createEmptyProjectWorkbench(), b: createEmptyProjectWorkbench() } })
    await store.set(openNotionPageAtom, { projectId: 'a', pageId: page })
    const panel = store.get(workbenchAtom).layoutsByProject.a!.auxiliary[0]!
    expect(panel.widthRatio * 1200).toBeCloseTo(760)
    store.set(resizeWorkbenchPanelAtom, { projectId: 'a', panelId: panel.id, widthRatio: 0.5 })
    store.set(workbenchAtom, { ...store.get(workbenchAtom), activeProjectId: 'b' })
    await store.set(openNotionPageAtom, { projectId: 'a', pageId: second })
    expect(store.get(workbenchAtom).activeProjectId).toBe('b')
    expect(store.get(workbenchAtom).layoutsByProject.a!.auxiliary).toHaveLength(1)
    expect(calls).toEqual([page, second])
    expect(store.get(workbenchAtom).layoutsByProject.a!.auxiliary[0]!.widthRatio).toBe(0.5)
  })
  it('retains a panel when Notion prevents closing it', async () => {
    const store = createStore()
    globalThis.window = { electronAPI: { notionView: async (request: { action: string }) => request.action === 'close' ? false : { pageId: page } } } as unknown as Window & typeof globalThis
    store.set(workbenchAtom, { workspaceId: 'w', activeProjectId: 'a', layoutsByProject: { a: createEmptyProjectWorkbench() } })
    await store.set(openNotionPageAtom, { projectId: 'a', pageId: page })
    const panel = store.get(workbenchAtom).layoutsByProject.a!.auxiliary[0]!
    expect(await store.set(closeWorkbenchPanelAtom, { projectId: 'a', panelId: panel.id })).toBe(false)
    expect(store.get(workbenchAtom).layoutsByProject.a!.auxiliary).toHaveLength(1)
  })
  it('round-trips a desktop layout in Web and closes its Notion panel without a native guest', async () => {
    const saved: PersistedWorkbenchLayoutDocument = {
      version: 1,
      layoutsByProject: { a: {
        primary: { id: 'chat', kind: 'session', sessionId: 'chat-a', widthRatio: 0.5 },
        auxiliary: [{ id: 'notion', kind: 'notion-page', pageId: page, widthRatio: 0.5 }],
        focusedPanelId: 'notion', previewPanelId: null,
      } },
    }
    const store = createStore()
    globalThis.window = { electronAPI: { getRuntimeEnvironment: () => 'web' } } as unknown as Window & typeof globalThis
    store.set(workbenchAtom, { workspaceId: 'w', activeProjectId: 'a', layoutsByProject: hydrateWorkbenchLayouts(saved) })
    expect(serializeWorkbenchLayouts(store.get(workbenchAtom))).toEqual(saved)
    expect(await store.set(closeWorkbenchPanelAtom, { projectId: 'a', panelId: 'notion' })).toBe(true)
    expect(store.get(workbenchAtom).layoutsByProject.a!.auxiliary).toEqual([])
    expect(store.get(workbenchAtom).layoutsByProject.a!.focusedPanelId).toBe('chat')
  })
  it('removes the original panel if Project selection changes while its close is pending', async () => {
    const store = createStore()
    let finishClose!: (value: boolean) => void
    const pending = new Promise<boolean>(resolve => { finishClose = resolve })
    globalThis.window = { electronAPI: { notionView: async (request: { action: string }) => request.action === 'close' ? pending : { pageId: page } } } as unknown as Window & typeof globalThis
    store.set(workbenchAtom, { workspaceId: 'w', activeProjectId: 'a', layoutsByProject: { a: createEmptyProjectWorkbench(), b: createEmptyProjectWorkbench() } })
    await store.set(openNotionPageAtom, { projectId: 'a', pageId: page })
    const panel = store.get(workbenchAtom).layoutsByProject.a!.auxiliary[0]!
    const closing = store.set(closeWorkbenchPanelAtom, { projectId: 'a', panelId: panel.id })
    store.set(workbenchAtom, { ...store.get(workbenchAtom), activeProjectId: 'b' })
    finishClose(true)
    expect(await closing).toBe(true)
    expect(store.get(workbenchAtom).activeProjectId).toBe('b')
    expect(store.get(workbenchAtom).layoutsByProject.a!.auxiliary).toHaveLength(0)
  })

})
