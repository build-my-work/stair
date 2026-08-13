import { atom } from 'jotai'

export interface SessionWorkbenchPanel {
  id: string
  kind: 'session'
  sessionId: string
  projectId: string
}

export interface ProjectFileWorkbenchPanel {
  id: string
  kind: 'project-file'
  projectId: string
  relativePath: string
  presentation: 'preview' | 'explicit'
}

export type WorkbenchPanel = SessionWorkbenchPanel | ProjectFileWorkbenchPanel

export interface ProjectWorkbench {
  primary: SessionWorkbenchPanel | null
  auxiliary: WorkbenchPanel[]
  previewPanelId: string | null
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
  previewPanelId: null,
  focusedPanelId: null,
})

export const workbenchAtom = atom<WindowWorkbench>({
  workspaceId: null,
  activeProjectId: null,
  layoutsByProject: {},
})

export const workbenchPanelRevealRevisionAtom = atom(0)

export function getWorkbenchPanels(layout: ProjectWorkbench): WorkbenchPanel[] {
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
  const panel = getWorkbenchPanels(layout).find(candidate => candidate.id === layout.focusedPanelId)
  return panel?.kind === 'session' ? panel.sessionId : null
})

export const visibleWorkbenchSessionIdsAtom = atom((get) => (
  new Set(get(workbenchPanelsAtom).flatMap(panel => (
    panel.kind === 'session' ? [panel.sessionId] : []
  )))
))

export const workbenchPanelCountAtom = atom((get) => get(workbenchPanelsAtom).length)
