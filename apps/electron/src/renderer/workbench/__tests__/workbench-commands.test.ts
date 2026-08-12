import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  activeProjectWorkbenchAtom,
  workbenchAtom,
  workbenchPanelRevealRevisionAtom,
  workbenchPanelsAtom,
} from '../workbench-state'
import {
  closeWorkbenchPanelAtom,
  focusNextWorkbenchPanelAtom,
  focusPreviousWorkbenchPanelAtom,
  focusWorkbenchPanelAtom,
  initializeWorkbenchAtom,
  openSessionInNewPanelAtom,
  removeSessionFromWorkbenchAtom,
  selectSessionFromNavigatorAtom,
  showSessionInPrimaryAtom,
  switchWorkbenchProjectAtom,
} from '../workbench-commands'

function initializedStore() {
  const store = createStore()
  expect(store.set(initializeWorkbenchAtom, {
    workspaceId: 'workspace-a',
    defaultProjectId: 'project-a',
  })).toBe(true)
  return store
}

function sessionIds(store: ReturnType<typeof createStore>) {
  const layout = store.get(activeProjectWorkbenchAtom)
  return {
    primary: layout?.primary?.sessionId ?? null,
    auxiliary: layout?.auxiliary.map(panel => panel.sessionId) ?? [],
    focusedPanelId: layout?.focusedPanelId ?? null,
  }
}

describe('Session-only Workbench commands', () => {
  it('initializes one empty default-Project layout', () => {
    const store = initializedStore()

    expect(store.get(workbenchAtom)).toEqual({
      workspaceId: 'workspace-a',
      activeProjectId: 'project-a',
      layoutsByProject: {
        'project-a': {
          primary: null,
          auxiliary: [],
          focusedPanelId: null,
        },
      },
    })
  })

  it('ordinary selection replaces Primary and never grows Auxiliary', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })

    const beforeAuxiliary = store.get(activeProjectWorkbenchAtom)!.auxiliary.length
    expect(store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-c',
      projectId: 'project-a',
    })).toBe(true)

    expect(sessionIds(store)).toMatchObject({
      primary: 'session-c',
      auxiliary: ['session-b'],
    })
    expect(store.get(activeProjectWorkbenchAtom)!.auxiliary.length).toBe(beforeAuxiliary)
  })

  it('ordinary selection focuses an already-visible Session without duplication', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const before = store.get(workbenchPanelsAtom)
    const target = before.find(panel => panel.sessionId === 'session-a')!

    expect(store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-a',
      projectId: 'project-a',
    })).toBe(true)

    expect(store.get(workbenchPanelsAtom)).toEqual(before)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(target.id)
  })

  it('requests reveal every time Navigator selects an already-visible Session', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const target = store.get(workbenchPanelsAtom).find(panel => panel.sessionId === 'session-b')!
    const before = store.get(workbenchPanelRevealRevisionAtom)

    expect(store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(target.id)
    expect(store.get(workbenchPanelRevealRevisionAtom)).toBe(before + 1)

    expect(store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(true)
    expect(store.get(workbenchPanelRevealRevisionAtom)).toBe(before + 2)
  })

  it('cross-Project ordinary selection parks the current layout and restores it later', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const projectASnapshot = structuredClone(store.get(activeProjectWorkbenchAtom))

    expect(store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-c',
      projectId: 'project-b',
    })).toBe(true)
    expect(store.get(workbenchAtom).activeProjectId).toBe('project-b')
    expect(sessionIds(store)).toMatchObject({ primary: 'session-c', auxiliary: [] })

    expect(store.set(switchWorkbenchProjectAtom, { projectId: 'project-a' })).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)).toEqual(projectASnapshot)
  })

  it('Primary creation commits only into the active Project and keeps Aux delta zero', () => {
    const store = initializedStore()
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-a', projectId: 'project-a' })
    const before = structuredClone(store.get(workbenchAtom))

    expect(store.set(showSessionInPrimaryAtom, {
      sessionId: 'wrong-project',
      projectId: 'project-b',
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)

    expect(store.set(showSessionInPrimaryAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(true)
    expect(sessionIds(store)).toMatchObject({ primary: 'session-b', auxiliary: ['session-a'] })
  })

  it('explicit new Panel inserts after focus and grows Auxiliary exactly once', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const source = store.get(workbenchPanelsAtom).find(panel => panel.sessionId === 'session-b')!
    store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId: source.id })

    const beforeCount = store.get(activeProjectWorkbenchAtom)!.auxiliary.length
    expect(store.set(openSessionInNewPanelAtom, {
      sessionId: 'session-c',
      projectId: 'project-a',
    })).toBe(true)

    expect(sessionIds(store)).toMatchObject({
      primary: 'session-a',
      auxiliary: ['session-b', 'session-c'],
    })
    expect(store.get(activeProjectWorkbenchAtom)!.auxiliary.length).toBe(beforeCount + 1)
  })

  it('explicit new Panel with no focus starts at Auxiliary index zero', () => {
    const store = initializedStore()

    expect(store.set(openSessionInNewPanelAtom, {
      sessionId: 'session-a',
      projectId: 'project-a',
    })).toBe(true)
    expect(sessionIds(store)).toMatchObject({ primary: null, auxiliary: ['session-a'] })
  })

  it('branch placement inserts after its visible source and preserves the source', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'source-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'source-b', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'tail', projectId: 'project-a' })

    expect(store.set(openSessionInNewPanelAtom, {
      sessionId: 'branch',
      projectId: 'project-a',
      afterSessionId: 'source-b',
    })).toBe(true)
    expect(sessionIds(store)).toMatchObject({
      primary: 'source-a',
      auxiliary: ['source-b', 'branch', 'tail'],
    })
  })

  it('rejects focus and explicit Panel mutation against a parked Project', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    const panelId = store.get(workbenchPanelsAtom)[0].id
    store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })
    const before = structuredClone(store.get(workbenchAtom))

    expect(store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId })).toBe(false)
    expect(store.set(openSessionInNewPanelAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)
  })

  it('closing Primary leaves it null and focuses the Panel to its right', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-b', projectId: 'project-a' })
    const primary = store.get(workbenchPanelsAtom)[0]
    store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId: primary.id })

    expect(store.set(closeWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: primary.id,
    })).toBe(true)
    const layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.primary).toBeNull()
    expect(layout.auxiliary.map(panel => panel.sessionId)).toEqual(['aux-a', 'aux-b'])
    expect(layout.focusedPanelId).toBe(layout.auxiliary[0].id)
  })

  it('closing focused Auxiliary falls back right, then left, then Primary', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-b', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-c', projectId: 'project-a' })

    let layout = store.get(activeProjectWorkbenchAtom)!
    store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[1].id })
    store.set(closeWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[1].id })
    layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.auxiliary.map(panel => panel.sessionId)).toEqual(['aux-a', 'aux-c'])
    expect(layout.focusedPanelId).toBe(layout.auxiliary[1].id)

    store.set(closeWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[1].id })
    layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.focusedPanelId).toBe(layout.auxiliary[0].id)

    store.set(closeWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[0].id })
    layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.focusedPanelId).toBe(layout.primary?.id ?? null)
  })

  it('cycles focus forward and backward through Primary and ordered Auxiliary panels', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-b', projectId: 'project-a' })
    const panels = store.get(workbenchPanelsAtom)
    store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId: panels[0].id })

    expect(store.set(focusNextWorkbenchPanelAtom)).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(panels[1].id)
    expect(store.set(focusPreviousWorkbenchPanelAtom)).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(panels[0].id)
    expect(store.set(focusPreviousWorkbenchPanelAtom)).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(panels[2].id)
  })

  it('removes a deleted Session from its parked Project without switching Project', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })

    expect(store.set(removeSessionFromWorkbenchAtom, 'session-a')).toBe(true)
    expect(store.get(workbenchAtom).activeProjectId).toBe('project-b')
    expect(store.get(workbenchAtom).layoutsByProject['project-a'].primary).toBeNull()
    expect(store.get(workbenchAtom).layoutsByProject['project-a'].auxiliary[0].sessionId).toBe('session-b')
  })
})
