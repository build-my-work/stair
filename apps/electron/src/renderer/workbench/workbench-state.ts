import { atom } from 'jotai'

export interface SessionWorkbenchPanel {
  id: string
  kind: 'session'
  sessionId: string
  projectId: string
}

export interface ProjectWorkbench {
  primary: SessionWorkbenchPanel | null
  auxiliary: SessionWorkbenchPanel[]
  focusedPanelId: string | null
}

export interface WindowWorkbench {
  workspaceId: string | null
  activeProjectId: string | null
  layoutsByProject: Record<string, ProjectWorkbench>
}

export const createEmptyProjectWorkbench = (): ProjectWorkbench => ({
  primary: null,
  auxiliary: [],
  focusedPanelId: null,
})

export const workbenchAtom = atom<WindowWorkbench>({
  workspaceId: null,
  activeProjectId: null,
  layoutsByProject: {},
})

export const workbenchPanelRevealRevisionAtom = atom(0)

export function getWorkbenchPanels(layout: ProjectWorkbench): SessionWorkbenchPanel[] {
  return layout.primary ? [layout.primary, ...layout.auxiliary] : layout.auxiliary
}

export const activeProjectWorkbenchAtom = atom((get) => {
  const state = get(workbenchAtom)
  return state.activeProjectId ? state.layoutsByProject[state.activeProjectId] ?? null : null
})

export const workbenchPanelsAtom = atom((get) => {
  const layout = get(activeProjectWorkbenchAtom)
  return layout ? getWorkbenchPanels(layout) : []
})

export const focusedWorkbenchPanelIdAtom = atom((get) => (
  get(activeProjectWorkbenchAtom)?.focusedPanelId ?? null
))

export const focusedWorkbenchSessionIdAtom = atom((get) => {
  const layout = get(activeProjectWorkbenchAtom)
  if (!layout?.focusedPanelId) return null
  return getWorkbenchPanels(layout).find(panel => panel.id === layout.focusedPanelId)?.sessionId ?? null
})

export const visibleWorkbenchSessionIdsAtom = atom((get) => (
  new Set(get(workbenchPanelsAtom).map(panel => panel.sessionId))
))

export const workbenchPanelCountAtom = atom((get) => get(workbenchPanelsAtom).length)
