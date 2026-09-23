import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createRequire } from 'node:module'
import React, { act, forwardRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const panelsAtom = Symbol('workbenchPanelsAtom')
const activeLayoutAtom = Symbol('activeProjectWorkbenchAtom')
const focusedPanelAtom = Symbol('focusedWorkbenchPanelIdAtom')
const revealRevisionAtom = Symbol('workbenchPanelRevealRevisionAtom')
const keyboardRevisionAtom = Symbol('workbenchKeyboardFocusRevisionAtom')
const layoutWidthAtom = Symbol('workbenchPanelLayoutWidthAtom')
const resizePanelAtom = Symbol('resizeWorkbenchPanelAtom')
const reorderPanelAtom = Symbol('reorderAuxiliaryPanelAtom')
const resizePanel = mock(() => {})
let focusedPanelId: string | null = null
let revealRevision = 0
const domino = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createWindow(html: string): Window & typeof globalThis
}

const sessionPanel = {
  id: 'session-panel',
  kind: 'session' as const,
  sessionId: 'chat-1',
  projectId: 'project-1',
  widthRatio: 560 / 1200,
}
const projectFilePanel = {
  id: 'project-file-panel',
  kind: 'project-file' as const,
  projectId: 'project-1',
  relativePath: 'notes/research.md',
  presentation: 'explicit' as const,
  chatTargetSessionId: 'chat-1',
  openIntentRevision: 0,
  widthRatio: 560 / 1200,
}
const panels = [sessionPanel, projectFilePanel]
const activeLayout = {
  primary: sessionPanel,
  auxiliary: [projectFilePanel],
  previewPanelId: null,
  focusedPanelId: projectFilePanel.id,
}

const componentPath = (name: string) => new URL(`../${name}.tsx`, import.meta.url).pathname

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

  mock.module('jotai', () => ({
    useAtomValue: (atom: symbol) => {
      if (atom === panelsAtom) return panels
      if (atom === activeLayoutAtom) return activeLayout
      if (atom === focusedPanelAtom) return focusedPanelId
      if (atom === revealRevisionAtom) return revealRevision
      if (atom === keyboardRevisionAtom) return 0
      if (atom === layoutWidthAtom) return 1200
      return null
    },
    useSetAtom: (atom: symbol) => {
      if (atom === resizePanelAtom) return resizePanel
      return () => {}
    },
  }))

  mock.module('@/workbench/workbench-state', () => ({
    workbenchPanelsAtom: panelsAtom,
    activeProjectWorkbenchAtom: activeLayoutAtom,
    focusedWorkbenchPanelIdAtom: focusedPanelAtom,
    workbenchPanelRevealRevisionAtom: revealRevisionAtom,
    workbenchKeyboardFocusRevisionAtom: keyboardRevisionAtom,
    workbenchPanelLayoutWidthAtom: layoutWidthAtom,
  }))
  mock.module('@/workbench/workbench-commands', () => ({
    resizeWorkbenchPanelAtom: resizePanelAtom,
    reorderAuxiliaryPanelAtom: reorderPanelAtom,
  }))
  mock.module('@/contexts/NavigationContext', () => ({
    isSessionsNavigation: () => true,
    useNavigationState: () => ({ viewMode: 'list' }),
  }))
  mock.module('@/hooks/useSession', () => ({ useIsMultiSelectActive: () => false }))
  mock.module('@/lib/nav-helpers', () => ({ isDetailNavState: () => false }))
  mock.module('@/lib/utils', () => ({
    cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  }))
  mock.module('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
  }))

  const motion = new Proxy({}, {
    get: (_target, tag: string) => forwardRef<HTMLElement, Record<string, unknown>>(
      ({ animate, initial: _initial, transition: _transition, style, ...props }, ref) => (
        React.createElement(tag, {
          ...props,
          ref,
          style: { ...(style as object), ...(animate as object) },
        })
      ),
    ),
  })
  mock.module('motion/react', () => ({ motion, useReducedMotion: () => true }))
  mock.module('@dnd-kit/core', () => ({
    DndContext: ({ children }: { children: React.ReactNode }) => children,
    KeyboardSensor: class {},
    PointerSensor: class {},
    closestCenter: () => null,
    useSensor: () => ({}),
    useSensors: () => [],
  }))
  mock.module('@dnd-kit/sortable', () => ({
    SortableContext: ({ children }: { children: React.ReactNode }) => children,
    horizontalListSortingStrategy: {},
    sortableKeyboardCoordinates: () => null,
  }))

  mock.module(componentPath('SessionPanelSlot'), () => ({
    SessionPanelSlot: () => React.createElement('div', { 'data-slot': 'session' }),
  }))
  mock.module(componentPath('ProjectFilePanelSlot'), () => ({
    ProjectFilePanelSlot: () => React.createElement('div', { 'data-slot': 'project-file' }),
  }))
  mock.module(componentPath('MainContentPanel'), () => ({
    MainContentPanel: () => React.createElement('div', { 'data-slot': 'main' }),
  }))
  mock.module(componentPath('WorkbenchPanelFrame'), () => ({
    WorkbenchPanelFrame: ({ panel, children }: { panel: { id: string }; children: React.ReactNode }) => (
      React.createElement('div', {
        'data-panel-frame': 'true',
        'data-panel-id': panel.id,
      }, children)
    ),
    SortableWorkbenchPanelFrame: ({
      panel,
      children,
    }: {
      panel: { id: string }
      children: (handle: React.ReactNode) => React.ReactNode
    }) => React.createElement('div', {
      'data-panel-frame': 'true',
      'data-panel-id': panel.id,
    }, children(null)),
  }))
})

let root: Root | null = null

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
    root = null
  }
  resizePanel.mockClear()
  focusedPanelId = null
  revealRevision = 0
  document.body.innerHTML = '<div id="root"></div>'
})

describe('Workbench desktop scroll layout', () => {
  it('keeps shell panes outside the Panel viewport after the rightmost sash resets', async () => {
    const { WorkbenchContainer } = await import('../WorkbenchContainer')
    const rootElement = document.getElementById('root')!
    root = createRoot(rootElement)

    await act(async () => {
      root!.render(React.createElement(WorkbenchContainer, {
        shellWidth: 1200,
        sidebarSlot: React.createElement('div', { 'data-testid': 'sidebar-content' }),
        sidebarWidth: 240,
        navigatorSlot: React.createElement('div', { 'data-testid': 'navigator-content' }),
        navigatorWidth: 300,
        isSidebarAndNavigatorHidden: false,
      }))
    })

    const sidebar = document.querySelector<HTMLElement>('[data-panel-role="sidebar"]')!
    const navigatorPane = document.querySelector<HTMLElement>('[data-panel-role="navigator"]')!
    const viewport = document.querySelector<HTMLElement>('[data-panel-scroll-viewport="true"]')!
    const sashes = document.querySelectorAll<HTMLElement>('[role="separator"]')

    expect(viewport.contains(sidebar)).toBe(false)
    expect(viewport.contains(navigatorPane)).toBe(false)
    expect(sashes).toHaveLength(2)

    await act(async () => {
      sashes[sashes.length - 1]!.dispatchEvent(new window.Event('dblclick', { bubbles: true }))
    })

    expect(resizePanel).toHaveBeenCalledWith({
      projectId: 'project-1',
      panelId: 'project-file-panel',
      widthRatio: 840 / 1200,
    })
    expect(document.querySelector('[data-panel-role="sidebar"]')).toBe(sidebar)
    expect(document.querySelector('[data-panel-role="navigator"]')).toBe(navigatorPane)
    expect(viewport.contains(sidebar)).toBe(false)
    expect(viewport.contains(navigatorPane)).toBe(false)
  })

  it('does not scroll when focus moves to a fully visible Panel', async () => {
    const { WorkbenchContainer } = await import('../WorkbenchContainer')
    const rootElement = document.getElementById('root')!
    root = createRoot(rootElement)
    focusedPanelId = projectFilePanel.id
    const elementPrototype = HTMLElement.prototype
    const offsetLeftDescriptor = Object.getOwnPropertyDescriptor(elementPrototype, 'offsetLeft')
    const scrollLeftDescriptor = Object.getOwnPropertyDescriptor(elementPrototype, 'scrollLeft')
    const originalGetBoundingClientRect = elementPrototype.getBoundingClientRect
    const scrollPositions = new WeakMap<HTMLElement, number>()
    const projectFileRect = { left: 600, right: 900 }
    Object.defineProperty(elementPrototype, 'offsetLeft', {
      configurable: true,
      get() {
        if (this.getAttribute('data-panel-scroll-viewport') === 'true') return 500
        if (this.getAttribute('data-panel-id') === projectFilePanel.id) return 700
        return 0
      },
    })
    Object.defineProperty(elementPrototype, 'scrollLeft', {
      configurable: true,
      get() {
        if (scrollPositions.has(this)) return scrollPositions.get(this)
        return this.getAttribute('data-panel-scroll-viewport') === 'true' ? 240 : 0
      },
      set(value: number) {
        scrollPositions.set(this, value)
      },
    })
    elementPrototype.getBoundingClientRect = function () {
      if (this.getAttribute('data-panel-scroll-viewport') === 'true') {
        return { left: 500, right: 1000 } as DOMRect
      }
      if (this.getAttribute('data-panel-id') === projectFilePanel.id) {
        return projectFileRect as DOMRect
      }
      return originalGetBoundingClientRect.call(this)
    }
    const props = {
      shellWidth: 1200,
      sidebarSlot: React.createElement('div'),
      sidebarWidth: 240,
      navigatorSlot: React.createElement('div'),
      navigatorWidth: 300,
      isSidebarAndNavigatorHidden: false,
    }

    try {
      await act(async () => root!.render(React.createElement(WorkbenchContainer, props)))
      const viewport = document.querySelector<HTMLElement>(
        '[data-panel-scroll-viewport="true"]',
      )!
      expect(viewport.scrollLeft).toBe(240)
    } finally {
      if (offsetLeftDescriptor) {
        Object.defineProperty(elementPrototype, 'offsetLeft', offsetLeftDescriptor)
      } else {
        delete (elementPrototype as { offsetLeft?: number }).offsetLeft
      }
      if (scrollLeftDescriptor) {
        Object.defineProperty(elementPrototype, 'scrollLeft', scrollLeftDescriptor)
      } else {
        delete (elementPrototype as { scrollLeft?: number }).scrollLeft
      }
      elementPrototype.getBoundingClientRect = originalGetBoundingClientRect
    }
  })
})
