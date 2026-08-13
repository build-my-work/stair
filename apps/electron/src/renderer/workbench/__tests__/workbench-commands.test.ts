import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  activeProjectWorkbenchAtom,
  workbenchAtom,
  workbenchPanelRevealRevisionAtom,
  workbenchPanelsAtom,
} from '../workbench-state'
import type { WorkbenchPanel } from '../workbench-state'
import {
  closeWorkbenchPanelAtom,
  focusNextWorkbenchPanelAtom,
  focusPreviousWorkbenchPanelAtom,
  focusWorkbenchPanelAtom,
  initializeWorkbenchAtom,
  openSessionInNewPanelAtom,
  openProjectFileInPanelAtom,
  openProjectFilePreviewAtom,
  removeSessionFromWorkbenchAtom,
  selectSessionFromNavigatorAtom,
  showSessionInPrimaryAtom,
  switchWorkbenchProjectAtom,
} from '../workbench-commands'
import {
  registerOpenProjectFileDocument,
} from '@/components/project-files/project-file-document-registry'

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
    auxiliary: layout?.auxiliary.flatMap(panel => panel.kind === 'session' ? [panel.sessionId] : []) ?? [],
    focusedPanelId: layout?.focusedPanelId ?? null,
  }
}

function isSessionPanel(panel: WorkbenchPanel): panel is Extract<WorkbenchPanel, { kind: 'session' }> {
  return panel.kind === 'session'
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
          previewPanelId: null,
          focusedPanelId: null,
        },
      },
    })
  })

  it('ordinary selection replaces Primary and never grows Auxiliary', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })

    const beforeAuxiliary = store.get(activeProjectWorkbenchAtom)!.auxiliary.length
    expect(await store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-c',
      projectId: 'project-a',
    })).toBe(true)

    expect(sessionIds(store)).toMatchObject({
      primary: 'session-c',
      auxiliary: ['session-b'],
    })
    expect(store.get(activeProjectWorkbenchAtom)!.auxiliary.length).toBe(beforeAuxiliary)
  })

  it('ordinary selection focuses an already-visible Session without duplication', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const before = store.get(workbenchPanelsAtom)
    const target = before.find(panel => isSessionPanel(panel) && panel.sessionId === 'session-a')!

    expect(await store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-a',
      projectId: 'project-a',
    })).toBe(true)

    expect(store.get(workbenchPanelsAtom)).toEqual(before)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(target.id)
  })

  it('requests reveal every time Navigator selects an already-visible Session', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const target = store.get(workbenchPanelsAtom).find(panel => (
      isSessionPanel(panel) && panel.sessionId === 'session-b'
    ))!
    const before = store.get(workbenchPanelRevealRevisionAtom)

    expect(await store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(target.id)
    expect(store.get(workbenchPanelRevealRevisionAtom)).toBe(before + 1)

    expect(await store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(true)
    expect(store.get(workbenchPanelRevealRevisionAtom)).toBe(before + 2)
  })

  it('cross-Project ordinary selection parks the current layout and restores it later', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const projectASnapshot = structuredClone(store.get(activeProjectWorkbenchAtom))

    expect(await store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-c',
      projectId: 'project-b',
    })).toBe(true)
    expect(store.get(workbenchAtom).activeProjectId).toBe('project-b')
    expect(sessionIds(store)).toMatchObject({ primary: 'session-c', auxiliary: [] })

    expect(await store.set(switchWorkbenchProjectAtom, { projectId: 'project-a' })).toBe(true)
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
    const source = store.get(workbenchPanelsAtom).find(panel => (
      isSessionPanel(panel) && panel.sessionId === 'session-b'
    ))!
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

  it('rejects focus and explicit Panel mutation against a parked Project', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    const panelId = store.get(workbenchPanelsAtom)[0].id
    await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })
    const before = structuredClone(store.get(workbenchAtom))

    expect(store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId })).toBe(false)
    expect(store.set(openSessionInNewPanelAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)
  })

  it('closing Primary leaves it null and focuses the Panel to its right', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-b', projectId: 'project-a' })
    const primary = store.get(workbenchPanelsAtom)[0]
    store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId: primary.id })

    expect(await store.set(closeWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: primary.id,
    })).toBe(true)
    const layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.primary).toBeNull()
    expect(layout.auxiliary.filter(isSessionPanel).map(panel => panel.sessionId)).toEqual(['aux-a', 'aux-b'])
    expect(layout.focusedPanelId).toBe(layout.auxiliary[0].id)
  })

  it('closing focused Auxiliary falls back right, then left, then Primary', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-b', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-c', projectId: 'project-a' })

    let layout = store.get(activeProjectWorkbenchAtom)!
    store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[1].id })
    await store.set(closeWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[1].id })
    layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.auxiliary.filter(isSessionPanel).map(panel => panel.sessionId)).toEqual(['aux-a', 'aux-c'])
    expect(layout.focusedPanelId).toBe(layout.auxiliary[1].id)

    await store.set(closeWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[1].id })
    layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.focusedPanelId).toBe(layout.auxiliary[0].id)

    await store.set(closeWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[0].id })
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

  it('removes a deleted Session from its parked Project without switching Project', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })

    expect(store.set(removeSessionFromWorkbenchAtom, 'session-a')).toBe(true)
    expect(store.get(workbenchAtom).activeProjectId).toBe('project-b')
    expect(store.get(workbenchAtom).layoutsByProject['project-a'].primary).toBeNull()
    const remaining = store.get(workbenchAtom).layoutsByProject['project-a'].auxiliary[0]
    expect(remaining.kind === 'session' ? remaining.sessionId : null).toBe('session-b')
  })
})

describe('Project File Workbench commands', () => {
  it('复用唯一 Preview，不修改 Primary 或显式 Auxiliary', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'explicit-session', projectId: 'project-a' })

    expect(await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/one.md',
    })).toBe(true)
    const first = structuredClone(store.get(activeProjectWorkbenchAtom)!)
    let flushCount = 0
    const unregister = registerOpenProjectFileDocument('project-a', 'docs/one.md', {
      flush: async () => { flushCount += 1 },
    })

    try {
      expect(await store.set(openProjectFilePreviewAtom, {
        projectId: 'project-a',
        relativePath: 'docs/two.md',
      })).toBe(true)
    } finally {
      unregister()
    }

    const next = store.get(activeProjectWorkbenchAtom)!
    expect(flushCount).toBe(1)
    expect(next.primary).toEqual(first.primary)
    expect(next.auxiliary).toHaveLength(first.auxiliary.length)
    expect(next.auxiliary.filter(panel => panel.kind === 'session'))
      .toEqual(first.auxiliary.filter(panel => panel.kind === 'session'))
    expect(next.auxiliary.filter(panel => panel.kind === 'project-file')).toEqual([
      expect.objectContaining({
        relativePath: 'docs/two.md',
        presentation: 'preview',
      }),
    ])
  })

  it('显式打开总是使用持久 Auxiliary，不占用 Preview', async () => {
    const store = initializedStore()
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/one.md',
    })
    const previewId = store.get(activeProjectWorkbenchAtom)!.previewPanelId

    expect(store.set(openProjectFileInPanelAtom, {
      projectId: 'project-a',
      relativePath: 'docs/one.md',
    })).toBe(true)
    const layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.previewPanelId).toBe(previewId)
    expect(layout.auxiliary.filter(panel => panel.kind === 'project-file')).toEqual([
      expect.objectContaining({ presentation: 'preview' }),
      expect.objectContaining({ presentation: 'explicit' }),
    ])
  })

  it('flush 失败时拒绝替换 Preview、关闭 Panel 和切换 Project', async () => {
    const store = initializedStore()
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/dirty.md',
    })
    const before = structuredClone(store.get(workbenchAtom))
    const previewId = store.get(activeProjectWorkbenchAtom)!.previewPanelId!
    const unregister = registerOpenProjectFileDocument('project-a', 'docs/dirty.md', {
      flush: async () => { throw new Error('save failed') },
    })

    try {
      expect(await store.set(openProjectFilePreviewAtom, {
        projectId: 'project-a',
        relativePath: 'docs/next.md',
      })).toBe(false)
      expect(store.get(workbenchAtom)).toEqual(before)

      expect(await store.set(closeWorkbenchPanelAtom, {
        projectId: 'project-a',
        panelId: previewId,
      })).toBe(false)
      expect(store.get(workbenchAtom)).toEqual(before)

      expect(await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })).toBe(false)
      expect(store.get(workbenchAtom)).toEqual(before)
    } finally {
      unregister()
    }
  })
})
