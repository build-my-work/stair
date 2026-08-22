import { describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'
import {
  activeProjectWorkbenchAtom,
  workbenchAtom,
} from '../workbench-state'
import {
  closeWorkbenchPanelAtom,
  focusWorkbenchPanelAtom,
  initializeWorkbenchAtom,
  markBrowserRuntimeUnavailableAtom,
  openSessionFromBrowserAtom,
  openSessionInNewPanelAtom,
  presentBrowserAtom,
  restoreActiveBrowserRuntimesAtom,
  setBrowserChatTargetAtom,
  showSessionInPrimaryAtom,
  switchWorkbenchProjectAtom,
  updateBrowserDescriptorAtom,
} from '../workbench-commands'
import {
  browserRuntimeOperationsAtom,
  type BrowserRuntimeOperations,
} from '../browser-runtime'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function initializedStore(overrides: Partial<BrowserRuntimeOperations> = {}) {
  const store = createStore()
  store.set(initializeWorkbenchAtom, {
    workspaceId: 'workspace-a',
    defaultProjectId: 'project-a',
  })
  const operations: BrowserRuntimeOperations = {
    create: mock(async () => 'runtime-created'),
    destroy: mock(async () => {}),
    park: mock(async () => {}),
    ...overrides,
  }
  store.set(browserRuntimeOperationsAtom, operations)
  return { store, operations }
}

function browserPanel(store: ReturnType<typeof createStore>) {
  const panel = store.get(activeProjectWorkbenchAtom)?.auxiliary.find(candidate => (
    candidate.kind === 'browser'
  ))
  expect(panel?.kind).toBe('browser')
  return panel as Extract<NonNullable<typeof panel>, { kind: 'browser' }>
}

describe('Browser Workbench commands', () => {
  it('recreates only persisted Browser descriptors when their Project becomes active', async () => {
    const create = mock(async () => 'runtime-restored')
    const { store } = initializedStore({ create })
    store.set(workbenchAtom, {
      workspaceId: 'workspace-a',
      activeProjectId: 'project-a',
      layoutsByProject: {
        'project-a': {
          primary: null,
          auxiliary: [{
            id: 'persisted-browser',
            kind: 'browser',
            projectId: 'project-a',
            runtimeId: null,
            url: 'https://example.com/',
            title: 'Example',
            chatTargetSessionId: null,
            restoreOnActivation: true,
            widthRatio: 1,
          }, {
            id: 'unavailable-browser',
            kind: 'browser',
            projectId: 'project-a',
            runtimeId: null,
            url: 'https://unavailable.example/',
            title: 'Unavailable',
            chatTargetSessionId: null,
            restoreOnActivation: false,
            widthRatio: 1,
          }],
          previewPanelId: null,
          focusedPanelId: 'persisted-browser',
        },
      },
    })

    expect(await store.set(restoreActiveBrowserRuntimesAtom, {
      projectId: 'project-a',
    })).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({
      projectId: 'project-a',
      url: 'https://example.com/',
    })
    expect(store.get(activeProjectWorkbenchAtom)?.auxiliary).toMatchObject([{
      id: 'persisted-browser',
      runtimeId: 'runtime-restored',
      restoreOnActivation: false,
    }, {
      id: 'unavailable-browser',
      runtimeId: null,
      restoreOnActivation: false,
    }])
  })

  it('captures the source Panel before async runtime creation and keeps Panel/runtime identities separate', async () => {
    const creation = deferred<string>()
    const { store } = initializedStore({ create: mock(() => creation.promise) })
    store.set(showSessionInPrimaryAtom, {
      sessionId: 'source',
      projectId: 'project-a',
    })
    store.set(openSessionInNewPanelAtom, {
      sessionId: 'other',
      projectId: 'project-a',
    })
    const layout = store.get(activeProjectWorkbenchAtom)!
    store.set(focusWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: layout.primary!.id,
    })

    const presenting = store.set(presentBrowserAtom, {
      projectId: 'project-a',
      url: 'https://example.com',
    })
    store.set(focusWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: layout.auxiliary[0].id,
    })
    creation.resolve('runtime-a')

    expect(await presenting).toBe(true)
    const next = store.get(activeProjectWorkbenchAtom)!
    expect(next.auxiliary.map(panel => panel.kind)).toEqual(['browser', 'session'])
    const browser = browserPanel(store)
    expect(browser.runtimeId).toBe('runtime-a')
    expect(browser.id).not.toBe(browser.runtimeId)
    expect(next.focusedPanelId).toBe(browser.id)
  })

  it('uses an explicit source Panel captured before an async link preference lookup', async () => {
    const { store } = initializedStore()
    store.set(showSessionInPrimaryAtom, {
      sessionId: 'source',
      projectId: 'project-a',
    })
    store.set(openSessionInNewPanelAtom, {
      sessionId: 'other',
      projectId: 'project-a',
    })
    const layout = store.get(activeProjectWorkbenchAtom)!
    const sourcePanelId = layout.primary!.id
    store.set(focusWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: layout.auxiliary[0].id,
    })

    expect(await store.set(presentBrowserAtom, {
      projectId: 'project-a',
      sourcePanelId,
      runtimeId: 'runtime-a',
      url: 'https://example.com',
    })).toBe(true)

    expect(store.get(activeProjectWorkbenchAtom)?.auxiliary.map(panel => panel.kind))
      .toEqual(['browser', 'session'])
  })

  it('destroys a newly-created orphan if the Project changes while creation is pending', async () => {
    const creation = deferred<string>()
    const destroy = mock(async () => {})
    const { store } = initializedStore({
      create: mock(() => creation.promise),
      destroy,
    })

    const presenting = store.set(presentBrowserAtom, {
      projectId: 'project-a',
      url: 'https://example.com',
    })
    expect(await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })).toBe(true)
    creation.resolve('orphan-runtime')

    expect(await presenting).toBe(false)
    expect(destroy).toHaveBeenCalledWith('orphan-runtime')
    expect(store.get(workbenchAtom).layoutsByProject['project-a'].auxiliary).toEqual([])
    expect(store.get(workbenchAtom).layoutsByProject['project-b'].auxiliary).toEqual([])
  })

  it('parks current Browser runtimes before switching and restores the parked Project layout in memory', async () => {
    const park = mock(async () => {})
    const { store } = initializedStore({ park })
    expect(await store.set(presentBrowserAtom, {
      projectId: 'project-a',
      runtimeId: 'runtime-a',
      url: 'https://a.example',
    })).toBe(true)
    const projectALayout = structuredClone(store.get(activeProjectWorkbenchAtom))

    expect(await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })).toBe(true)
    expect(park).toHaveBeenCalledWith(['runtime-a'])
    expect(await store.set(switchWorkbenchProjectAtom, { projectId: 'project-a' })).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)).toEqual(projectALayout)
  })

  it('completes a Project switch when park emits a Browser state update before resolving', async () => {
    const { store, operations } = initializedStore()
    await store.set(presentBrowserAtom, {
      projectId: 'project-a',
      runtimeId: 'runtime-a',
      url: 'https://a.example',
      title: 'Before',
    })
    operations.park = mock(async () => {
      store.set(updateBrowserDescriptorAtom, {
        runtimeId: 'runtime-a',
        url: 'https://a.example/updated',
        title: 'After',
      })
    })

    expect(await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })).toBe(true)
    expect(store.get(workbenchAtom).activeProjectId).toBe('project-b')
    expect(store.get(workbenchAtom).layoutsByProject['project-a'].auxiliary[0])
      .toMatchObject({ url: 'https://a.example/updated', title: 'After' })
  })

  it('keeps the current Project and layout when parking fails', async () => {
    const { store } = initializedStore({
      park: mock(async () => { throw new Error('park failed') }),
    })
    await store.set(presentBrowserAtom, {
      projectId: 'project-a',
      runtimeId: 'runtime-a',
    })
    const before = structuredClone(store.get(workbenchAtom))

    expect(await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)
  })

  it('destroys the runtime before removing a Browser Panel and vetoes on lifecycle failure', async () => {
    const destroy = mock(async () => { throw new Error('destroy failed') })
    const { store, operations } = initializedStore({ destroy })
    await store.set(presentBrowserAtom, {
      projectId: 'project-a',
      runtimeId: 'runtime-a',
    })
    const panel = browserPanel(store)
    const before = structuredClone(store.get(workbenchAtom))

    expect(await store.set(closeWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: panel.id,
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)

    operations.destroy = mock(async () => {})
    expect(await store.set(closeWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: panel.id,
    })).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.auxiliary).toEqual([])
  })

  it('removes a Browser Panel when destroy emits REMOVED before resolving', async () => {
    const { store, operations } = initializedStore()
    await store.set(presentBrowserAtom, {
      projectId: 'project-a',
      runtimeId: 'runtime-a',
    })
    const panel = browserPanel(store)
    operations.destroy = mock(async (runtimeId) => {
      store.set(markBrowserRuntimeUnavailableAtom, runtimeId)
    })

    expect(await store.set(closeWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: panel.id,
    })).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.auxiliary).toEqual([])
  })

  it('atomically targets and inserts a new Session after the originating Browser Panel', async () => {
    const { store } = initializedStore()
    await store.set(presentBrowserAtom, {
      projectId: 'project-a',
      runtimeId: 'runtime-a',
    })
    const source = browserPanel(store)

    expect(store.set(openSessionFromBrowserAtom, {
      sessionId: 'new-session',
      sessionProjectId: 'project-a',
      source: {
        panelId: source.id,
        projectId: source.projectId,
        runtimeId: 'runtime-a',
      },
    })).toBe(true)

    const layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.auxiliary.map(panel => panel.kind)).toEqual(['browser', 'session'])
    expect(layout.auxiliary[0]).toMatchObject({ chatTargetSessionId: 'new-session' })
    expect(layout.focusedPanelId).toBe(layout.auxiliary[1].id)
  })

  it('rejects stale Browser targets without changing the layout', async () => {
    const { store } = initializedStore()
    await store.set(presentBrowserAtom, {
      projectId: 'project-a',
      runtimeId: 'runtime-a',
    })
    const source = browserPanel(store)
    const before = structuredClone(store.get(workbenchAtom))

    expect(store.set(setBrowserChatTargetAtom, {
      panelId: source.id,
      projectId: 'project-a',
      sessionId: 'cross-project',
      sessionProjectId: 'project-b',
    })).toBe(false)
    expect(store.set(openSessionFromBrowserAtom, {
      sessionId: 'new-session',
      sessionProjectId: 'project-a',
      source: {
        panelId: source.id,
        projectId: source.projectId,
        runtimeId: 'stale-runtime',
      },
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)
  })

  it('background state and removal events never change Project, Primary, Auxiliary count, or Focus', async () => {
    const { store } = initializedStore()
    store.set(showSessionInPrimaryAtom, {
      sessionId: 'primary',
      projectId: 'project-a',
    })
    await store.set(presentBrowserAtom, {
      projectId: 'project-a',
      runtimeId: 'runtime-a',
    })
    const before = store.get(activeProjectWorkbenchAtom)!

    expect(store.set(updateBrowserDescriptorAtom, {
      runtimeId: 'runtime-a',
      url: 'https://example.com/article',
      title: 'Article',
    })).toBe(true)
    expect(store.set(markBrowserRuntimeUnavailableAtom, 'runtime-a')).toBe(true)

    const after = store.get(activeProjectWorkbenchAtom)!
    expect(store.get(workbenchAtom).activeProjectId).toBe('project-a')
    expect(after.primary).toEqual(before.primary)
    expect(after.auxiliary).toHaveLength(before.auxiliary.length)
    expect(after.focusedPanelId).toBe(before.focusedPanelId)
    expect(browserPanel(store)).toMatchObject({
      runtimeId: null,
      url: 'https://example.com/article',
      title: 'Article',
    })
  })
})
