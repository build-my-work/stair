import {
  WORKBENCH_LAYOUT_VERSION,
  type PersistedProjectWorkbench,
  type PersistedWorkbenchLayoutDocument,
  type PersistedWorkbenchPanel,
} from '@craft-agent/shared/workbench-layout'
import { atom } from 'jotai'
import type {
  ProjectWorkbench,
  WindowWorkbench,
  WorkbenchPanel,
} from './workbench-state'
import {
  createEmptyProjectWorkbench,
  workbenchAtom,
  workbenchPersistenceReadyAtom,
} from './workbench-state'

export interface WorkbenchPersistenceOperations {
  read(): Promise<PersistedWorkbenchLayoutDocument>
}

export const workbenchPersistenceOperationsAtom = atom<WorkbenchPersistenceOperations>({
  read: () => window.electronAPI.readWorkbenchLayout(),
})

const RESTORE_READ_ATTEMPTS = 3
let restoreGeneration = 0

function serializePanel(panel: WorkbenchPanel): PersistedWorkbenchPanel {
  switch (panel.kind) {
    case 'session':
      return {
        id: panel.id,
        kind: panel.kind,
        sessionId: panel.sessionId,
        widthRatio: panel.widthRatio,
      }
    case 'project-file':
      return {
        id: panel.id,
        kind: panel.kind,
        relativePath: panel.relativePath,
        presentation: panel.presentation,
        chatTargetSessionId: panel.chatTargetSessionId,
        widthRatio: panel.widthRatio,
      }
  }
}

function hydratePanel(projectId: string, panel: PersistedWorkbenchPanel): WorkbenchPanel {
  switch (panel.kind) {
    case 'session':
      return { ...panel, projectId }
    case 'project-file':
      return {
        ...panel,
        projectId,
        openIntent: undefined,
        openIntentRevision: 0,
      }
  }
}

export function serializeWorkbenchLayouts(
  state: WindowWorkbench,
): PersistedWorkbenchLayoutDocument {
  const layoutsByProject = Object.fromEntries(
    Object.entries(state.layoutsByProject).map(([projectId, layout]) => [
      projectId,
      {
        primary: layout.primary ? {
          id: layout.primary.id,
          kind: layout.primary.kind,
          sessionId: layout.primary.sessionId,
          widthRatio: layout.primary.widthRatio,
        } : null,
        auxiliary: layout.auxiliary.map(serializePanel),
        previewPanelId: layout.previewPanelId,
        focusedPanelId: layout.focusedPanelId,
      } satisfies PersistedProjectWorkbench,
    ]),
  )
  return { version: WORKBENCH_LAYOUT_VERSION, layoutsByProject }
}

export function hydrateWorkbenchLayouts(
  document: PersistedWorkbenchLayoutDocument,
): Record<string, ProjectWorkbench> {
  return Object.fromEntries(
    Object.entries(document.layoutsByProject).map(([projectId, layout]) => [
      projectId,
      {
        primary: layout.primary
          ? hydratePanel(projectId, layout.primary) as ProjectWorkbench['primary']
          : null,
        auxiliary: layout.auxiliary.map(panel => hydratePanel(projectId, panel)),
        previewPanelId: layout.previewPanelId,
        focusedPanelId: layout.focusedPanelId,
      },
    ]),
  )
}

export const restoreWorkbenchLayoutsAtom = atom(
  null,
  async (get, set, input: {
    workspaceId: string
    defaultProjectId: string
    /** Per-window context from the saved URL, checked against Workspace layouts. */
    activeProjectId?: string
  }): Promise<boolean> => {
    if (get(workbenchPersistenceReadyAtom)) return true
    const generation = ++restoreGeneration
    const current = get(workbenchAtom)
    if (
      current.workspaceId !== input.workspaceId
      || !current.activeProjectId
    ) return false

    const operations = get(workbenchPersistenceOperationsAtom)
    let document: PersistedWorkbenchLayoutDocument | null = null
    for (let attempt = 0; attempt < RESTORE_READ_ATTEMPTS; attempt += 1) {
      if (
        generation !== restoreGeneration
        || get(workbenchAtom).workspaceId !== input.workspaceId
      ) return false
      try {
        document = await operations.read()
        break
      } catch {
        if (attempt === RESTORE_READ_ATTEMPTS - 1) return false
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
    if (!document || generation !== restoreGeneration) return false

    const latest = get(workbenchAtom)
    if (latest.workspaceId !== input.workspaceId) return false
    const restoredLayouts = hydrateWorkbenchLayouts(document)
    let layoutsByProject: Record<string, ProjectWorkbench>

    if (latest === current) {
      layoutsByProject = restoredLayouts
    } else {
      layoutsByProject = { ...restoredLayouts }
      for (const [projectId, latestLayout] of Object.entries(latest.layoutsByProject)) {
        const initialLayout = current.layoutsByProject[projectId]
        const restoredLayout = restoredLayouts[projectId]
        if (!initialLayout || !restoredLayout) {
          layoutsByProject[projectId] = latestLayout
          continue
        }
        layoutsByProject[projectId] = {
          primary: latestLayout.primary === initialLayout.primary
            ? restoredLayout.primary
            : latestLayout.primary,
          auxiliary: latestLayout.auxiliary === initialLayout.auxiliary
            ? restoredLayout.auxiliary
            : latestLayout.auxiliary,
          previewPanelId: latestLayout.previewPanelId === initialLayout.previewPanelId
            ? restoredLayout.previewPanelId
            : latestLayout.previewPanelId,
          focusedPanelId: latestLayout.focusedPanelId === initialLayout.focusedPanelId
            ? restoredLayout.focusedPanelId
            : latestLayout.focusedPanelId,
        }
      }
    }

    set(workbenchAtom, {
      ...latest,
      activeProjectId: latest === current && current.activeProjectId === input.defaultProjectId
        && input.activeProjectId && Object.hasOwn(restoredLayouts, input.activeProjectId)
        ? input.activeProjectId
        : latest.activeProjectId,
      layoutsByProject: {
        ...layoutsByProject,
        [input.defaultProjectId]: layoutsByProject[input.defaultProjectId]
          ?? createEmptyProjectWorkbench(),
      },
    })
    set(workbenchPersistenceReadyAtom, true)
    return true
  },
)

let pendingDocument: PersistedWorkbenchLayoutDocument | null = null
let persistenceTimer: ReturnType<typeof setTimeout> | null = null
let activeFlush: Promise<void> | null = null

async function drainPendingDocument(): Promise<void> {
  while (pendingDocument) {
    const document = pendingDocument
    pendingDocument = null
    try {
      await window.electronAPI.writeWorkbenchLayout(document)
    } catch (error) {
      pendingDocument ??= document
      throw error
    }
  }
}

export function scheduleWorkbenchLayoutPersistence(
  document: PersistedWorkbenchLayoutDocument,
): void {
  pendingDocument = document
  if (persistenceTimer) clearTimeout(persistenceTimer)
  persistenceTimer = setTimeout(() => {
    persistenceTimer = null
    void flushWorkbenchLayoutPersistence().catch(error => {
      console.warn('[Workbench] Failed to persist layout:', error)
    })
  }, 150)
}

export async function flushWorkbenchLayoutPersistence(): Promise<void> {
  if (persistenceTimer) {
    clearTimeout(persistenceTimer)
    persistenceTimer = null
  }
  if (!activeFlush) {
    activeFlush = drainPendingDocument().finally(() => {
      activeFlush = null
    })
  }
  await activeFlush
  if (pendingDocument) await flushWorkbenchLayoutPersistence()
}
