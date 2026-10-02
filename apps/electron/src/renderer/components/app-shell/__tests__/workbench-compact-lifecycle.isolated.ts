import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createRequire } from 'node:module'
import React, { act, forwardRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore, atom } from 'jotai'
import { workbenchAtom } from '@/workbench/workbench-state'
import { closeWorkbenchPanelAtom, focusWorkbenchPanelAtom } from '@/workbench/workbench-commands'
import { flushOpenProjectFiles } from '@/components/project-files/project-file-document-registry'

const domino = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createWindow(html: string): Window & typeof globalThis
}
const rendererPath = (path: string) => new URL(`../../../${path}`, import.meta.url).pathname
let selectedSession: string | null = 'chat-1'
let navigatorKind: 'sessions' | 'settings' = 'sessions'
const translate = (key: string) => key
const shellContext = { activeWorkspaceId: 'workspace-1' }
const Passthrough = ({ children }: { children?: ReactNode }) => children
let root: Root | null = null

beforeAll(() => {
  const browserWindow = domino.createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    window: browserWindow,
    document: browserWindow.document,
    navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement,
    Node: browserWindow.Node,
    Event: browserWindow.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, right: 1200 }) as DOMRect

  // Keep the Workbench, Panel Frame, file page, atoms and document controller real.
  // Only unrelated shell surfaces and third-party rendering/browser adapters are replaced.
  mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
  mock.module('sonner', () => ({ toast: { error() {}, success() {} } }))
  mock.module('motion/react', () => ({
    motion: { div: forwardRef<HTMLDivElement, Record<string, unknown>>(
      ({ initial: _initial, animate, transition: _transition, style, ...props }, ref) => (
        React.createElement('div', { ...props, ref, style: { ...(style as object), ...(animate as object) } })
      ),
    ) },
    useReducedMotion: () => true,
  }))
  mock.module('@dnd-kit/core', () => ({
    DndContext: Passthrough,
    KeyboardSensor: class {}, PointerSensor: class {}, closestCenter() {},
    useSensor: () => ({}), useSensors: () => [],
  }))
  mock.module('@dnd-kit/sortable', () => ({
    SortableContext: Passthrough, horizontalListSortingStrategy: {}, sortableKeyboardCoordinates() {},
    useSortable: () => ({ setNodeRef() {}, setActivatorNodeRef() {}, attributes: {}, listeners: {} }),
  }))
  mock.module('@radix-ui/react-select', () => ({
    Root: Passthrough, Group: Passthrough, Value: Passthrough, Trigger: Passthrough,
    Content: () => null, Portal: Passthrough, Viewport: Passthrough, Item: Passthrough,
    ItemText: Passthrough, ItemIndicator: () => null, Icon: () => null, Label: Passthrough,
    Separator: () => null, ScrollUpButton: () => null, ScrollDownButton: () => null,
  }))
  mock.module('@craft-agent/ui', () => ({
    Markdown: ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
    ShikiCodeViewer: ({ code }: { code: string }) => React.createElement('div', null, code),
    getLanguageFromPath: () => 'text',
  }))
  mock.module(rendererPath('contexts/NavigationContext.tsx'), () => ({
    isSessionsNavigation: (state: { navigator: string }) => state.navigator === 'sessions',
    useNavigationState: () => navigatorKind === 'sessions'
      ? { navigator: 'sessions', details: selectedSession ? { sessionId: selectedSession } : null }
      : { navigator: 'settings', subpage: null },
    useNavigation: () => ({ openSessionInNewPanel: () => true }),
  }))
  mock.module(rendererPath('hooks/useSession.ts'), () => ({ useIsMultiSelectActive: () => false }))
  mock.module(rendererPath('context/AppShellContext.tsx'), () => ({
    AppShellProvider: Passthrough, useAppShellContext: () => shellContext,
  }))
  mock.module(rendererPath('context/ThemeContext.tsx'), () => ({
    useTheme: () => ({ resolvedMode: 'light', shikiTheme: 'github-light' }),
  }))
  mock.module(rendererPath('atoms/sessions.ts'), () => ({ sessionMetaMapAtom: atom(new Map()) }))
  mock.module(rendererPath('components/app-shell/PanelHeader.tsx'), () => ({
    PanelHeader: ({ title, actions }: { title: ReactNode; actions: ReactNode }) => React.createElement('header', null, title, actions),
  }))
  mock.module(rendererPath('components/ui/PanelHeaderCenterButton.tsx'), () => ({
    PanelHeaderCenterButton: ({ onClick, tooltip }: { onClick(): void; tooltip: string }) => React.createElement('button', { onClick }, tooltip),
  }))
  mock.module(rendererPath('components/shiki/ShikiCodeEditor.tsx'), () => ({
    ShikiCodeEditor: ({ value, onChange }: { value: string; onChange(value: string): void }) => (
      React.createElement('textarea', { value, onInput: (event: React.FormEvent<HTMLTextAreaElement>) => onChange(event.currentTarget.value) })
    ),
  }))
  mock.module(rendererPath('components/project-files/ProjectFileEpubReader.tsx'), () => ({ ProjectFileEpubReader: () => null }))
  mock.module(rendererPath('components/project-files/ProjectFilePdfReader.tsx'), () => ({ ProjectFilePdfReader: () => null }))
  mock.module(rendererPath('components/project-files/ProjectFileDrawnixCanvas.tsx'), () => ({ ProjectFileDrawnixCanvas: () => null }))
  mock.module(rendererPath('components/project-files/ProjectFileTextSelection.tsx'), () => ({ ProjectFileTextSelection: Passthrough }))
  mock.module(rendererPath('lib/save-text-file.ts'), () => ({ saveTextFile: async () => ({ saved: false }) }))
  mock.module(rendererPath('components/app-shell/SessionPanelSlot.tsx'), () => ({
    SessionPanelSlot: () => React.createElement('div', null, 'Chat'),
  }))
  mock.module(rendererPath('components/app-shell/MainContentPanel.tsx'), () => ({ MainContentPanel: () => null }))
  mock.module(rendererPath('components/app-shell/PanelResizeSash.tsx'), () => ({ PanelResizeSash: () => null }))
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  selectedSession = 'chat-1'
  navigatorKind = 'sessions'
  document.body.innerHTML = '<div id="root"></div>'
})

async function openWorkbench(compact: boolean, withSession = true) {
  selectedSession = withSession ? 'chat-1' : null
  Object.assign(window, { electronAPI: {
    readProjectTextFile: async () => ({ text: 'Saved on disk', sourceFingerprint: 'sha256:old', metadata: { projectId: 'project-1', relativePath: 'note.md', name: 'note.md', byteLength: 13 } }),
    saveProjectTextFile: async () => { throw new Error('PROJECT_FILE_CHANGED: conflict') },
    debugLog() {},
  } })
  const store = createStore()
  store.set(workbenchAtom, {
    workspaceId: 'workspace-1', activeProjectId: 'project-1', layoutsByProject: { 'project-1': {
      primary: withSession ? { id: 'session-panel', kind: 'session', sessionId: 'chat-1', projectId: 'project-1', widthRatio: 0.5 } : null,
      auxiliary: [{ id: 'file-panel', kind: 'project-file', projectId: 'project-1', relativePath: 'note.md', presentation: 'explicit', chatTargetSessionId: null, widthRatio: 0.5, openIntentRevision: 0 }],
      focusedPanelId: 'file-panel', previewPanelId: null,
    } },
  })
  const { WorkbenchContainer } = await import('../WorkbenchContainer')
  root = createRoot(document.getElementById('root')!)
  const render = async (isCompact: boolean) => {
    await act(async () => root!.render(React.createElement(Provider, { store }, React.createElement(WorkbenchContainer, {
      shellWidth: isCompact ? 600 : 1200, sidebarSlot: null, sidebarWidth: 0,
      navigatorSlot: React.createElement('div', null, 'Navigator'), navigatorWidth: 300,
      isSidebarAndNavigatorHidden: false, isCompact,
    }))))
  }
  await render(compact)
  return { store, render }
}

async function editAndFailSave() {
  const edit = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'projectFileEditor.edit')!
  await act(async () => edit.click())
  const editor = document.querySelector('textarea')!
  await act(async () => {
    editor.value = 'Unsaved local draft'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await expect(flushOpenProjectFiles()).rejects.toThrow('PROJECT_FILE_CHANGED') })
  expect(document.body.textContent).toContain('projectFileEditor.conflictTitle')
}

describe('Workbench compact document lifetime', () => {
  it('retains a failed draft when resizing into and out of Compact', async () => {
    const { render } = await openWorkbench(false)
    await editAndFailSave()
    await render(true)
    expect(document.querySelector('textarea')?.value).toBe('Unsaved local draft')
    await render(false)
    expect(document.querySelector('textarea')?.value).toBe('Unsaved local draft')
    await act(async () => { await expect(flushOpenProjectFiles()).rejects.toThrow('PROJECT_FILE_CHANGED') })
  })

  it('retains a failed draft while another Compact Panel has focus', async () => {
    const { store } = await openWorkbench(true)
    await editAndFailSave()
    await act(async () => { store.set(focusWorkbenchPanelAtom, { projectId: 'project-1', panelId: 'session-panel' }) })
    expect(document.querySelector<HTMLElement>('[data-panel-frame][data-panel-id="file-panel"]')?.style.display).toBe('none')
    await act(async () => { await expect(flushOpenProjectFiles()).rejects.toThrow('PROJECT_FILE_CHANGED') })
    await act(async () => { store.set(focusWorkbenchPanelAtom, { projectId: 'project-1', panelId: 'file-panel' }) })
    expect(document.querySelector('textarea')?.value).toBe('Unsaved local draft')
    await act(async () => { await expect(flushOpenProjectFiles()).rejects.toThrow('PROJECT_FILE_CHANGED') })
  })

  it('retains a failed draft while a different Navigator is shown', async () => {
    const { render } = await openWorkbench(true)
    await editAndFailSave()
    navigatorKind = 'settings'
    await render(true)
    expect(document.querySelector<HTMLElement>('[data-panel-role="navigator"]')?.style.display).not.toBe('none')
    await act(async () => { await expect(flushOpenProjectFiles()).rejects.toThrow('PROJECT_FILE_CHANGED') })
    navigatorKind = 'sessions'
    await render(true)
    expect(document.querySelector('textarea')?.value).toBe('Unsaved local draft')
  })

  it('shows a focused Project File without a selected Session in Compact', async () => {
    const { store } = await openWorkbench(true, false)
    expect(document.querySelector<HTMLElement>('[data-panel-scroll-viewport]')?.style.display).not.toBe('none')
    expect(document.querySelector<HTMLElement>('[data-panel-role="navigator"]')?.style.display).toBe('none')
    expect(document.querySelector('[data-project-file="note.md"]')?.textContent).toContain('Saved on disk')
    await act(async () => { await store.set(closeWorkbenchPanelAtom, { projectId: 'project-1', panelId: 'file-panel' }) })
    expect(document.querySelector<HTMLElement>('[data-panel-role="navigator"]')?.style.display).not.toBe('none')
    expect(document.querySelector('[data-project-file="note.md"]')).toBeFalsy()
  })
})
