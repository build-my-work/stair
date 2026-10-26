import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createRequire } from 'node:module'
import React, { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import type { FlipOnChangeProps } from '@craft-agent/ui/motion'
import type { DragStartEvent } from '@dnd-kit/core'
import { workbenchAtom } from '@/workbench/workbench-state'
import { focusWorkbenchPanelAtom } from '@/workbench/workbench-commands'

const domino = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createWindow(html: string): Window & typeof globalThis
}
const rendererPath = (path: string) => new URL(`../../../${path}`, import.meta.url).pathname
const Passthrough = ({ children }: { children?: ReactNode }) => children
let root: Root | null = null
let navigatorKind = 'sessions'
let flip: FlipOnChangeProps
let startDrag: (event: DragStartEvent) => void
let fileMounts = 0
const shellContext = { activeWorkspaceId: 'workspace-1' }

beforeAll(() => {
  const browserWindow = domino.createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    window: browserWindow, document: browserWindow.document, navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement, Node: browserWindow.Node, Event: browserWindow.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, right: 1200 }) as DOMRect
  HTMLElement.prototype.getClientRects = function () {
    for (let node: HTMLElement | null = this; node; node = node.parentElement) {
      if (node.style.display === 'none') return [] as unknown as DOMRectList
    }
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
  mock.module('@craft-agent/ui/motion', () => ({
    FlipOnChange: (props: FlipOnChangeProps) => { flip = props; return props.children },
  }))
  mock.module('@craft-agent/ui', () => ({ Spinner: () => null }))
  mock.module('sonner', () => ({ Toaster: () => null, toast: { error() {} } }))
  mock.module(rendererPath('context/ThemeContext.tsx'), () => ({ useTheme: () => ({ resolvedMode: 'light' }) }))
  mock.module('@dnd-kit/core', () => ({
    DndContext: ({ children, onDragStart }: { children?: ReactNode; onDragStart: typeof startDrag }) => {
      startDrag = onDragStart
      return children
    },
    KeyboardSensor: class {}, PointerSensor: class {}, closestCenter() {},
    useSensor: () => ({}), useSensors: () => [],
  }))
  mock.module('@dnd-kit/sortable', () => ({
    SortableContext: Passthrough, horizontalListSortingStrategy: {}, sortableKeyboardCoordinates() {},
    useSortable: () => ({
      setNodeRef() {}, setActivatorNodeRef() {}, attributes: {}, listeners: {},
      transform: { x: 17, y: 0, scaleX: 1, scaleY: 1 },
    }),
  }))
  mock.module(rendererPath('contexts/NavigationContext.tsx'), () => ({
    isSessionsNavigation: (state: { navigator: string }) => state.navigator === 'sessions',
    useNavigationState: () => ({ navigator: navigatorKind, details: { sessionId: 'chat-1' }, subpage: 'app' }),
  }))
  mock.module(rendererPath('hooks/useSession.ts'), () => ({ useIsMultiSelectActive: () => false }))
  mock.module(rendererPath('context/AppShellContext.tsx'), () => ({
    AppShellProvider: Passthrough, useAppShellContext: () => shellContext,
  }))
  mock.module(rendererPath('components/ui/PanelHeaderCenterButton.tsx'), () => ({
    PanelHeaderCenterButton: ({ onClick, tooltip }: { onClick(): void; tooltip: string }) => React.createElement('button', { onClick }, tooltip),
  }))
  mock.module(rendererPath('components/app-shell/MainContentPanel.tsx'), () => ({
    MainContentPanel: () => React.createElement('div', { 'data-session-content': true }, 'Session or shell'),
  }))
  mock.module(rendererPath('pages/ProjectFilePage.tsx'), () => ({
    default: () => {
      const [draft, setDraft] = useState(() => { fileMounts += 1; return 'Saved' })
      return React.createElement('textarea', {
        value: draft,
        onInput: (event: React.FormEvent<HTMLTextAreaElement>) => setDraft(event.currentTarget.value),
      })
    },
  }))
  mock.module(rendererPath('components/app-shell/PanelResizeSash.tsx'), () => ({ PanelResizeSash: () => null }))
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  navigatorKind = 'sessions'
  fileMounts = 0
  document.body.innerHTML = '<div id="root"></div>'
})

async function openWorkbench(withSession = true, withFile = true) {
  const store = createStore()
  store.set(workbenchAtom, {
    workspaceId: 'workspace-1', activeProjectId: 'project-1', layoutsByProject: { 'project-1': {
      primary: withSession ? { id: 'session-panel', kind: 'session', sessionId: 'chat-1', projectId: 'project-1', widthRatio: 560 / 1200 } : null,
      auxiliary: withFile ? [{ id: 'file-panel', kind: 'project-file', projectId: 'project-1', relativePath: 'canvas.drawnix', presentation: 'explicit', chatTargetSessionId: null, widthRatio: 840 / 1200, openIntentRevision: 0 }] : [],
      focusedPanelId: withFile ? 'file-panel' : withSession ? 'session-panel' : null, previewPanelId: null,
    } },
  })
  const { WorkbenchContainer } = await import('../WorkbenchContainer')
  root = createRoot(document.getElementById('root')!)
  let props = {
    shellWidth: 1200, sidebarSlot: null, sidebarWidth: 240,
    navigatorSlot: React.createElement('div', null, 'Navigator'), navigatorWidth: 300,
    isSidebarAndNavigatorHidden: false, isCompact: false, animateLayout: true, isResizing: false,
  }
  const render = async (changes: Partial<typeof props> = {}) => {
    props = { ...props, ...changes }
    await act(async () => root!.render(React.createElement(Provider, { store }, React.createElement(WorkbenchContainer, props))))
  }
  await render()
  return { store, render }
}

const content = (id: string) => document.querySelector<HTMLElement>(`[data-panel-role="content"][data-panel-id="${id}"]`)!
const material = (id: string) => content(id).querySelector<HTMLElement>('[data-panel-material]')!
const viewport = () => document.querySelector<HTMLElement>('[data-panel-scroll-viewport]')!
const navigatorPane = () => document.querySelector<HTMLElement>('[data-panel-role="navigator"]')!

function pendingAnimation() {
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  return { animation: { finished, cancel: mock(finish) } as unknown as Animation, finish }
}

describe('Workbench joined paper cards', () => {
  it('joins only the first content card and keeps independent panel widths and DnD frames', async () => {
    const { store } = await openWorkbench()
    expect(navigatorPane().style.borderTopRightRadius).toBe('0')
    expect(viewport().style.marginLeft).toBe('-6px')
    expect(viewport().contains(navigatorPane())).toBe(false)
    expect(material('session-panel').style.borderTopLeftRadius).toBe('0')
    expect(material('file-panel').style.borderTopLeftRadius).toBe('12px')
    expect(material('session-panel').className).toContain('bg-paper')
    expect(material('session-panel').className).toContain('shadow-elev-0')
    expect(material('file-panel').className).toContain('shadow-elev-2')
    const frames = document.querySelectorAll<HTMLElement>('[data-panel-frame]')
    expect(frames[0]!.style.width).toBe('560px')
    expect(frames[1]!.style.width).toBe('840px')
    expect(frames[1]!.style.transform).toContain('translate3d(17px')
    const targets = flip.getTargets()
    expect(targets.some(target => target.el.hasAttribute('data-panel-frame'))).toBe(false)
    expect(targets.filter(target => target.mode === 'scale').map(target => target.el)).toEqual([
      material('session-panel'), material('file-panel'),
    ])
    await act(async () => { store.set(focusWorkbenchPanelAtom, { projectId: 'project-1', panelId: 'session-panel' }) })
    expect(material('session-panel').className).toContain('shadow-elev-2')
    expect(material('file-panel').className).toContain('shadow-elev-0')
    expect(frames[1]!.style.transform).toContain('translate3d(17px')
  })

  it('preserves mounted editor state across navigator, compact and shell navigation changes', async () => {
    const { render } = await openWorkbench()
    const editor = document.querySelector('textarea')!
    await act(async () => {
      editor.value = 'Unsaved Canvas/editor state'
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await render({ navigatorWidth: 0 })
    expect(material('session-panel').style.borderTopLeftRadius).toBe('12px')
    expect(viewport().style.marginLeft).toBe('')
    await render({ navigatorWidth: 300, isCompact: true })
    expect(material('file-panel').style.borderTopLeftRadius).toBe('12px')
    expect(material('file-panel').style.borderBottomRightRadius).toBe('0')
    navigatorKind = 'settings'
    await render({ isCompact: false })
    const shell = document.querySelector<HTMLElement>('[data-panel-role="shell-content"]')!
    expect(shell.getAttribute('data-joined-to-navigator')).toBe('true')
    expect(shell.querySelector<HTMLElement>('[data-panel-material]')!.style.borderTopLeftRadius).toBe('0')
    expect(flip.getTargets().some(target => content('file-panel').contains(target.el))).toBe(false)
    navigatorKind = 'sessions'
    await render()
    expect(document.querySelector('textarea')).toBe(editor)
    expect(editor.value).toBe('Unsaved Canvas/editor state')
    expect(fileMounts).toBe(1)
  })

  it('joins a file-only first panel and leaves an empty navigator card rounded', async () => {
    const { store, render } = await openWorkbench(false)
    expect(material('file-panel').style.borderTopLeftRadius).toBe('0')
    const state = store.get(workbenchAtom)
    const layout = state.layoutsByProject['project-1']!
    await act(async () => { store.set(workbenchAtom, {
      ...state, layoutsByProject: { 'project-1': { ...layout, auxiliary: [], focusedPanelId: null } },
    }) })
    expect(navigatorPane().style.borderTopRightRadius).toBe('12px')
    expect(viewport().style.marginLeft).toBe('')
    expect(document.querySelector('[data-panel-role="empty-primary"]')).not.toBeNull()
    await render({ isCompact: true })
    expect(navigatorPane().style.borderBottomLeftRadius).toBe('0')
    expect(navigatorPane().style.borderBottomRightRadius).toBe('0')
  })

  it('anchors toasts inside the first paper pane and clears the anchor in compact mode', async () => {
    const { render } = await openWorkbench()
    const style = document.documentElement.style
    expect(style.getPropertyValue('--toast-anchor-left')).toBe('246px')
    expect(style.getPropertyValue('--toast-anchor-width')).toBe('300px')
    await render({ sidebarWidth: 0, navigatorWidth: 0 })
    expect(style.getPropertyValue('--toast-anchor-left')).toBe('6px')
    expect(style.getPropertyValue('--toast-anchor-width')).toBe('')
    await render({ isCompact: true })
    expect(style.getPropertyValue('--toast-anchor-left')).toBe('')
  })

  it('makes keyboard, resize, drag and compact transitions instant and cancels active motion', async () => {
    const { render } = await openWorkbench()
    expect(flip.enabled).toBe(true)
    const { animation } = pendingAnimation()
    await act(async () => { flip.onPlay!([animation], { from: '1:1:0', to: '0:1:0' }) })
    expect(viewport().style.overflowX).toBe('hidden')
    await render({ animateLayout: false, sidebarWidth: 0 })
    expect(flip.enabled).toBe(false)
    expect(animation.cancel).toHaveBeenCalledTimes(1)
    expect(viewport().style.overflowX).toBe('')
    await render({ animateLayout: true, isResizing: true })
    expect(flip.enabled).toBe(false)
    await render({ isResizing: false, isCompact: true })
    expect(flip.enabled).toBe(false)
    await render({ isCompact: false })
    await act(async () => { startDrag({ active: { id: 'file-panel' } } as DragStartEvent) })
    expect(flip.enabled).toBe(false)
  })

  it('cancels layout motion before a pointer interaction can resize or drag a panel', async () => {
    await openWorkbench()
    const { animation } = pendingAnimation()
    await act(async () => { flip.onPlay!([animation], { from: '1:1:0', to: '0:1:0' }) })
    await act(async () => {
      content('file-panel').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(animation.cancel).toHaveBeenCalledTimes(1)
    expect(viewport().style.overflowX).toBe('')
    expect(document.querySelector<HTMLElement>('[data-panel-frame][data-panel-id="file-panel"]')!.style.transform).toContain('translate3d(17px')
  })

  it('does not release the scroll hold for a newer animation when an older one finishes', async () => {
    await openWorkbench()
    const first = pendingAnimation()
    const second = pendingAnimation()
    await act(async () => { flip.onPlay!([first.animation], { from: '1:1:0', to: '0:1:0' }) })
    await act(async () => { flip.onPlay!([second.animation], { from: '0:1:0', to: '1:1:0' }) })
    expect(first.animation.cancel).toHaveBeenCalledTimes(1)
    expect(viewport().style.overflowX).toBe('hidden')
    await act(async () => { second.finish() })
    expect(viewport().style.overflowX).toBe('')
  })

  it('cancels owned motion when the workbench unmounts', async () => {
    await openWorkbench()
    const { animation } = pendingAnimation()
    await act(async () => { flip.onPlay!([animation], { from: '1:1:0', to: '0:1:0' }) })
    await act(async () => root!.unmount())
    root = null
    expect(animation.cancel).toHaveBeenCalledTimes(1)
    expect(document.documentElement.style.getPropertyValue('--toast-anchor-left')).toBe('')
  })
})
