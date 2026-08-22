import { atom } from 'jotai'
import type { ProjectFileOpenIntent } from '@craft-agent/shared/project-files'
import { DEFAULT_WORKBENCH_PANEL_RATIO } from '@craft-agent/shared/workbench-layout'

interface WorkbenchPanelLayout {
  widthRatio: number
}

export interface SessionWorkbenchPanel extends WorkbenchPanelLayout {
  id: string
  kind: 'session'
  sessionId: string
  projectId: string
}

export interface ProjectFileWorkbenchPanel extends WorkbenchPanelLayout {
  id: string
  kind: 'project-file'
  projectId: string
  relativePath: string
  presentation: 'preview' | 'explicit'
  /** Panel-local target used by Add Chat/Add Note; never drives presentation. */
  chatTargetSessionId: string | null
  /** Latest semantic reveal intent for this Project File reader. */
  openIntent?: ProjectFileOpenIntent
  /** Increments for every explicit reveal, including repeated clicks of one locator. */
  openIntentRevision: number
}

export interface BrowserWorkbenchPanel extends WorkbenchPanelLayout {
  id: string
  kind: 'browser'
  projectId: string
  runtimeId: string | null
  url: string
  title: string
  chatTargetSessionId: string | null
  /** Transient marker set only when a persisted Browser descriptor needs a new runtime. */
  restoreOnActivation: boolean
}

export type WorkbenchPanel =
  | SessionWorkbenchPanel
  | ProjectFileWorkbenchPanel
  | BrowserWorkbenchPanel

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
export const workbenchKeyboardFocusRevisionAtom = atom(0)
export const workbenchPersistenceReadyAtom = atom(false)
/** Stable shell-width basis; Shell Pane toggles never write this atom. */
export const workbenchPanelLayoutWidthAtom = atom(
  typeof document === 'undefined' ? 0 : document.documentElement.clientWidth,
)

export { DEFAULT_WORKBENCH_PANEL_RATIO }

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
