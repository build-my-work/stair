import { atom, type Getter, type Setter } from 'jotai'
import {
  createEmptyProjectWorkbench,
  getWorkbenchPanels,
  workbenchAtom,
  workbenchPanelRevealRevisionAtom,
  type ProjectWorkbench,
  type SessionWorkbenchPanel,
  type WindowWorkbench,
} from './workbench-state'

let nextPanelId = 0

function createSessionPanel(sessionId: string, projectId: string): SessionWorkbenchPanel {
  nextPanelId += 1
  return {
    id: `session-panel-${nextPanelId}`,
    kind: 'session',
    sessionId,
    projectId,
  }
}

function validId(value: string): boolean {
  return value.trim().length > 0
}

function activeLayout(state: WindowWorkbench, projectId: string): ProjectWorkbench | null {
  if (state.activeProjectId !== projectId) return null
  return state.layoutsByProject[projectId] ?? null
}

function withActiveLayout(
  state: WindowWorkbench,
  projectId: string,
  layout: ProjectWorkbench,
): WindowWorkbench {
  return {
    ...state,
    layoutsByProject: {
      ...state.layoutsByProject,
      [projectId]: layout,
    },
  }
}

export const initializeWorkbenchAtom = atom(
  null,
  (get, set, input: { workspaceId: string; defaultProjectId: string }): boolean => {
    if (!validId(input.workspaceId) || !validId(input.defaultProjectId)) return false
    const current = get(workbenchAtom)
    if (current.workspaceId === input.workspaceId) {
      if (current.activeProjectId) return true
      set(workbenchAtom, {
        ...current,
        activeProjectId: input.defaultProjectId,
        layoutsByProject: {
          ...current.layoutsByProject,
          [input.defaultProjectId]: current.layoutsByProject[input.defaultProjectId]
            ?? createEmptyProjectWorkbench(),
        },
      })
      return true
    }

    set(workbenchAtom, {
      workspaceId: input.workspaceId,
      activeProjectId: input.defaultProjectId,
      layoutsByProject: {
        [input.defaultProjectId]: createEmptyProjectWorkbench(),
      },
    })
    return true
  },
)

export const switchWorkbenchProjectAtom = atom(
  null,
  (get, set, input: { projectId: string }): boolean => {
    if (!validId(input.projectId)) return false
    const current = get(workbenchAtom)
    if (!current.workspaceId || !current.activeProjectId) return false
    if (current.activeProjectId === input.projectId) return true

    set(workbenchAtom, {
      ...current,
      activeProjectId: input.projectId,
      layoutsByProject: {
        ...current.layoutsByProject,
        [input.projectId]: current.layoutsByProject[input.projectId]
          ?? createEmptyProjectWorkbench(),
      },
    })
    return true
  },
)

export const selectSessionFromNavigatorAtom = atom(
  null,
  (get, set, input: { sessionId: string; projectId: string }): boolean => {
    if (!validId(input.sessionId) || !validId(input.projectId)) return false
    const current = get(workbenchAtom)
    if (!current.workspaceId || !current.activeProjectId) return false

    const layout = current.layoutsByProject[input.projectId] ?? createEmptyProjectWorkbench()
    const visible = getWorkbenchPanels(layout).find(panel => panel.sessionId === input.sessionId)
    let nextLayout: ProjectWorkbench
    if (visible) {
      nextLayout = { ...layout, focusedPanelId: visible.id }
    } else {
      const primary = createSessionPanel(input.sessionId, input.projectId)
      nextLayout = { ...layout, primary, focusedPanelId: primary.id }
    }

    set(workbenchAtom, {
      ...current,
      activeProjectId: input.projectId,
      layoutsByProject: {
        ...current.layoutsByProject,
        [input.projectId]: nextLayout,
      },
    })
    set(workbenchPanelRevealRevisionAtom, get(workbenchPanelRevealRevisionAtom) + 1)
    return true
  },
)

export const showSessionInPrimaryAtom = atom(
  null,
  (get, set, input: { sessionId: string; projectId: string }): boolean => {
    if (!validId(input.sessionId) || !validId(input.projectId)) return false
    const current = get(workbenchAtom)
    const layout = activeLayout(current, input.projectId)
    if (!layout) return false

    const visible = getWorkbenchPanels(layout).find(panel => panel.sessionId === input.sessionId)
    if (visible) {
      set(workbenchAtom, withActiveLayout(current, input.projectId, {
        ...layout,
        focusedPanelId: visible.id,
      }))
      return true
    }

    const primary = createSessionPanel(input.sessionId, input.projectId)
    set(workbenchAtom, withActiveLayout(current, input.projectId, {
      ...layout,
      primary,
      focusedPanelId: primary.id,
    }))
    return true
  },
)

export const openSessionInNewPanelAtom = atom(
  null,
  (get, set, input: {
    sessionId: string
    projectId: string
    afterSessionId?: string
  }): boolean => {
    if (!validId(input.sessionId) || !validId(input.projectId)) return false
    const current = get(workbenchAtom)
    const layout = activeLayout(current, input.projectId)
    if (!layout) return false

    const panels = getWorkbenchPanels(layout)
    const visible = panels.find(panel => panel.sessionId === input.sessionId)
    if (visible) {
      set(workbenchAtom, withActiveLayout(current, input.projectId, {
        ...layout,
        focusedPanelId: visible.id,
      }))
      return true
    }

    const insertionSource = input.afterSessionId
      ? panels.find(panel => panel.sessionId === input.afterSessionId)
      : panels.find(panel => panel.id === layout.focusedPanelId)
    if (input.afterSessionId && !insertionSource) return false

    let insertAt = 0
    if (insertionSource && insertionSource.id !== layout.primary?.id) {
      const sourceIndex = layout.auxiliary.findIndex(panel => panel.id === insertionSource.id)
      if (sourceIndex >= 0) insertAt = sourceIndex + 1
    }

    const panel = createSessionPanel(input.sessionId, input.projectId)
    const auxiliary = [
      ...layout.auxiliary.slice(0, insertAt),
      panel,
      ...layout.auxiliary.slice(insertAt),
    ]
    set(workbenchAtom, withActiveLayout(current, input.projectId, {
      ...layout,
      auxiliary,
      focusedPanelId: panel.id,
    }))
    return true
  },
)

export const focusWorkbenchPanelAtom = atom(
  null,
  (get, set, input: { projectId: string; panelId: string }): boolean => {
    const current = get(workbenchAtom)
    const layout = activeLayout(current, input.projectId)
    if (!layout || !getWorkbenchPanels(layout).some(panel => panel.id === input.panelId)) {
      return false
    }
    if (layout.focusedPanelId === input.panelId) return true

    set(workbenchAtom, withActiveLayout(current, input.projectId, {
      ...layout,
      focusedPanelId: input.panelId,
    }))
    return true
  },
)

export const closeWorkbenchPanelAtom = atom(
  null,
  (get, set, input: { projectId: string; panelId: string }): boolean => {
    const current = get(workbenchAtom)
    const layout = activeLayout(current, input.projectId)
    if (!layout) return false

    if (layout.primary?.id === input.panelId) {
      set(workbenchAtom, withActiveLayout(current, input.projectId, {
        ...layout,
        primary: null,
        focusedPanelId: layout.focusedPanelId === input.panelId
          ? layout.auxiliary[0]?.id ?? null
          : layout.focusedPanelId,
      }))
      return true
    }

    const closingIndex = layout.auxiliary.findIndex(panel => panel.id === input.panelId)
    if (closingIndex < 0) return false
    const auxiliary = [
      ...layout.auxiliary.slice(0, closingIndex),
      ...layout.auxiliary.slice(closingIndex + 1),
    ]
    const focusedPanelId = layout.focusedPanelId === input.panelId
      ? auxiliary[closingIndex]?.id
        ?? auxiliary[closingIndex - 1]?.id
        ?? layout.primary?.id
        ?? null
      : layout.focusedPanelId

    set(workbenchAtom, withActiveLayout(current, input.projectId, {
      ...layout,
      auxiliary,
      focusedPanelId,
    }))
    return true
  },
)

function focusAdjacentPanel(
  get: Getter,
  set: Setter,
  direction: 1 | -1,
): boolean {
  const current = get(workbenchAtom)
  if (!current.activeProjectId) return false
  const layout = activeLayout(current, current.activeProjectId)
  if (!layout) return false
  const panels = getWorkbenchPanels(layout)
  if (panels.length <= 1) return false
  const currentIndex = panels.findIndex(panel => panel.id === layout.focusedPanelId)
  let nextIndex = (currentIndex + direction + panels.length) % panels.length
  if (currentIndex < 0) {
    nextIndex = direction === 1 ? 0 : panels.length - 1
  }
  set(workbenchAtom, withActiveLayout(current, current.activeProjectId, {
    ...layout,
    focusedPanelId: panels[nextIndex].id,
  }))
  return true
}

export const focusNextWorkbenchPanelAtom = atom(
  null,
  (get, set): boolean => focusAdjacentPanel(get, set, 1),
)

export const focusPreviousWorkbenchPanelAtom = atom(
  null,
  (get, set): boolean => focusAdjacentPanel(get, set, -1),
)

/** Remove a deleted Session reference from active or parked Project layouts. */
export const removeSessionFromWorkbenchAtom = atom(
  null,
  (get, set, sessionId: string): boolean => {
    if (!validId(sessionId)) return false
    const current = get(workbenchAtom)
    let changed = false
    const layoutsByProject: Record<string, ProjectWorkbench> = {}

    for (const [projectId, layout] of Object.entries(current.layoutsByProject)) {
      if (layout.primary?.sessionId === sessionId) {
        changed = true
        layoutsByProject[projectId] = {
          ...layout,
          primary: null,
          focusedPanelId: layout.focusedPanelId === layout.primary.id
            ? layout.auxiliary[0]?.id ?? null
            : layout.focusedPanelId,
        }
        continue
      }

      const closingIndex = layout.auxiliary.findIndex(panel => panel.sessionId === sessionId)
      if (closingIndex < 0) {
        layoutsByProject[projectId] = layout
        continue
      }
      changed = true
      const auxiliary = [
        ...layout.auxiliary.slice(0, closingIndex),
        ...layout.auxiliary.slice(closingIndex + 1),
      ]
      layoutsByProject[projectId] = {
        ...layout,
        auxiliary,
        focusedPanelId: layout.focusedPanelId === layout.auxiliary[closingIndex].id
          ? auxiliary[closingIndex]?.id
            ?? auxiliary[closingIndex - 1]?.id
            ?? layout.primary?.id
            ?? null
          : layout.focusedPanelId,
      }
    }

    if (changed) set(workbenchAtom, { ...current, layoutsByProject })
    return changed
  },
)
