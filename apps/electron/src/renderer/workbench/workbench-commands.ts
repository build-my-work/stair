import { atom, type Getter, type Setter } from 'jotai'
import {
  isCanonicalProjectRelativePath,
  type ProjectFileOpenIntent,
} from '@craft-agent/shared/project-files'
import {
  flushOpenProjectFile,
  flushOpenProjectFilesForProject,
} from '@/components/project-files/project-file-document-registry'
import {
  createEmptyProjectWorkbench,
  getWorkbenchPanels,
  workbenchKeyboardFocusRevisionAtom,
  workbenchAtom,
  workbenchPanelLayoutWidthAtom,
  workbenchPersistenceReadyAtom,
  workbenchPanelRevealRevisionAtom,
  type ProjectWorkbench,
  type ProjectFileWorkbenchPanel,
  type SessionWorkbenchPanel,
  type WindowWorkbench,
} from './workbench-state'
import { getDefaultWorkbenchPanelRatio } from './panel-sizing'

function createSessionPanel(
  sessionId: string,
  projectId: string,
  panelLayoutWidth: number,
): SessionWorkbenchPanel {
  return {
    id: `session-panel-${crypto.randomUUID()}`,
    kind: 'session',
    sessionId,
    projectId,
    widthRatio: getDefaultWorkbenchPanelRatio(panelLayoutWidth, 'session'),
  }
}

function createProjectFilePanel(
  projectId: string,
  relativePath: string,
  presentation: ProjectFileWorkbenchPanel['presentation'],
  panelLayoutWidth: number,
  openIntent?: ProjectFileOpenIntent,
): ProjectFileWorkbenchPanel {
  return {
    id: `project-file-panel-${crypto.randomUUID()}`,
    kind: 'project-file',
    projectId,
    relativePath,
    presentation,
    chatTargetSessionId: null,
    widthRatio: getDefaultWorkbenchPanelRatio(panelLayoutWidth, 'project-file'),
    openIntentRevision: openIntent ? 1 : 0,
    ...(openIntent ? { openIntent } : {}),
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
    set(workbenchPersistenceReadyAtom, false)
    return true
  },
)

export const switchWorkbenchProjectAtom = atom(
  null,
  async (get, set, input: { projectId: string }): Promise<boolean> => {
    if (!validId(input.projectId)) return false
    let current = get(workbenchAtom)
    if (!current.workspaceId || !current.activeProjectId) return false
    if (current.activeProjectId === input.projectId) return true
    const sourceProjectId = current.activeProjectId

    try {
      await flushOpenProjectFilesForProject(sourceProjectId)
    } catch {
      return false
    }
    const afterFlush = get(workbenchAtom)
    if (
      afterFlush.workspaceId !== current.workspaceId
      || afterFlush.activeProjectId !== sourceProjectId
    ) return false
    current = afterFlush

    const latest = get(workbenchAtom)
    if (
      latest.workspaceId !== current.workspaceId
      || latest.activeProjectId !== sourceProjectId
    ) return false

    set(workbenchAtom, {
      ...latest,
      activeProjectId: input.projectId,
      layoutsByProject: {
        ...latest.layoutsByProject,
        [input.projectId]: latest.layoutsByProject[input.projectId]
          ?? createEmptyProjectWorkbench(),
      },
    })
    return true
  },
)

export const selectSessionFromNavigatorAtom = atom(
  null,
  async (get, set, input: { sessionId: string; projectId: string }): Promise<boolean> => {
    if (!validId(input.sessionId) || !validId(input.projectId)) return false
    const current = get(workbenchAtom)
    if (!current.workspaceId || !current.activeProjectId) return false

    if (current.activeProjectId !== input.projectId) {
      const switched = await set(switchWorkbenchProjectAtom, { projectId: input.projectId })
      if (!switched) return false
    }

    const active = get(workbenchAtom)
    const layout = active.layoutsByProject[input.projectId] ?? createEmptyProjectWorkbench()
    const visible = getWorkbenchPanels(layout).find(panel => (
      panel.kind === 'session' && panel.sessionId === input.sessionId
    ))
    let nextLayout: ProjectWorkbench
    if (visible) {
      nextLayout = { ...layout, focusedPanelId: visible.id }
    } else {
      const primary = createSessionPanel(
        input.sessionId,
        input.projectId,
        get(workbenchPanelLayoutWidthAtom),
      )
      nextLayout = { ...layout, primary, focusedPanelId: primary.id }
    }

    set(workbenchAtom, {
      ...active,
      activeProjectId: input.projectId,
      layoutsByProject: {
        ...active.layoutsByProject,
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

    const visible = getWorkbenchPanels(layout).find(panel => (
      panel.kind === 'session' && panel.sessionId === input.sessionId
    ))
    if (visible) {
      set(workbenchAtom, withActiveLayout(current, input.projectId, {
        ...layout,
        focusedPanelId: visible.id,
      }))
      return true
    }

    const primary = createSessionPanel(
      input.sessionId,
      input.projectId,
      get(workbenchPanelLayoutWidthAtom),
    )
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
    const visible = panels.find(panel => (
      panel.kind === 'session' && panel.sessionId === input.sessionId
    ))
    if (visible) {
      set(workbenchAtom, withActiveLayout(current, input.projectId, {
        ...layout,
        focusedPanelId: visible.id,
      }))
      return true
    }

    const insertionSource = input.afterSessionId
      ? panels.find(panel => panel.kind === 'session' && panel.sessionId === input.afterSessionId)
      : panels.find(panel => panel.id === layout.focusedPanelId)
    if (input.afterSessionId && !insertionSource) return false

    let insertAt = input.afterSessionId ? 0 : auxiliaryInsertionIndex(layout)
    if (insertionSource && insertionSource.id !== layout.primary?.id) {
      const sourceIndex = layout.auxiliary.findIndex(panel => panel.id === insertionSource.id)
      if (sourceIndex >= 0) insertAt = sourceIndex + 1
    }

    const panel = createSessionPanel(
      input.sessionId,
      input.projectId,
      get(workbenchPanelLayoutWidthAtom),
    )
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

export const openSessionFromProjectFileAtom = atom(
  null,
  (get, set, input: {
    sessionId: string
    sessionProjectId: string
    source: {
      panelId: string
      projectId: string
      relativePath: string
    }
  }): boolean => {
    if (
      !validId(input.sessionId)
      || !validId(input.sessionProjectId)
      || !validId(input.source.panelId)
      || !validId(input.source.projectId)
      || !isCanonicalProjectRelativePath(input.source.relativePath)
      || input.sessionProjectId !== input.source.projectId
    ) return false

    const current = get(workbenchAtom)
    const layout = activeLayout(current, input.source.projectId)
    if (!layout) return false
    if (getWorkbenchPanels(layout).some(panel => (
      panel.kind === 'session' && panel.sessionId === input.sessionId
    ))) return false

    const sourceIndex = layout.auxiliary.findIndex(panel => (
      panel.id === input.source.panelId
      && panel.kind === 'project-file'
      && panel.projectId === input.source.projectId
      && panel.relativePath === input.source.relativePath
    ))
    if (sourceIndex < 0) return false

    const source = layout.auxiliary[sourceIndex] as ProjectFileWorkbenchPanel
    const panel = createSessionPanel(
      input.sessionId,
      input.sessionProjectId,
      get(workbenchPanelLayoutWidthAtom),
    )
    const auxiliary = [
      ...layout.auxiliary.slice(0, sourceIndex),
      { ...source, chatTargetSessionId: input.sessionId },
      panel,
      ...layout.auxiliary.slice(sourceIndex + 1),
    ]
    set(workbenchAtom, withActiveLayout(current, input.source.projectId, {
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

export const resizeWorkbenchPanelAtom = atom(
  null,
  (get, set, input: {
    projectId: string
    panelId: string
    widthRatio: number
  }): boolean => {
    if (!Number.isFinite(input.widthRatio) || input.widthRatio <= 0) return false
    const current = get(workbenchAtom)
    const layout = activeLayout(current, input.projectId)
    if (!layout) return false
    if (!getWorkbenchPanels(layout).some(panel => panel.id === input.panelId)) return false
    const primary = layout.primary?.id === input.panelId
      ? { ...layout.primary, widthRatio: input.widthRatio }
      : layout.primary
    const auxiliary = layout.auxiliary.map(panel => (
      panel.id === input.panelId
        ? { ...panel, widthRatio: input.widthRatio }
        : panel
    ))
    set(workbenchAtom, withActiveLayout(current, input.projectId, {
      ...layout,
      primary,
      auxiliary,
    }))
    return true
  },
)

export const reorderAuxiliaryPanelAtom = atom(
  null,
  (get, set, input: {
    projectId: string
    panelId: string
    toIndex: number
  }): boolean => {
    const current = get(workbenchAtom)
    const layout = activeLayout(current, input.projectId)
    if (
      !layout
      || !Number.isInteger(input.toIndex)
      || input.toIndex < 0
      || input.toIndex >= layout.auxiliary.length
    ) return false
    const fromIndex = layout.auxiliary.findIndex(panel => panel.id === input.panelId)
    if (fromIndex < 0) return false
    if (fromIndex === input.toIndex) return true

    const auxiliary = [...layout.auxiliary]
    const [panel] = auxiliary.splice(fromIndex, 1)
    auxiliary.splice(input.toIndex, 0, panel)
    set(workbenchAtom, withActiveLayout(current, input.projectId, {
      ...layout,
      auxiliary,
    }))
    return true
  },
)

function auxiliaryInsertionIndex(layout: ProjectWorkbench): number {
  if (!layout.focusedPanelId || layout.focusedPanelId === layout.primary?.id) return 0
  const focusedIndex = layout.auxiliary.findIndex(panel => panel.id === layout.focusedPanelId)
  return focusedIndex < 0 ? layout.auxiliary.length : focusedIndex + 1
}

export const openProjectFilePreviewAtom = atom(
  null,
  async (get, set, input: {
    projectId: string
    relativePath: string
    openIntent?: ProjectFileOpenIntent
  }): Promise<boolean> => {
    if (!validId(input.projectId) || !isCanonicalProjectRelativePath(input.relativePath)) {
      return false
    }
    const current = get(workbenchAtom)
    const layout = activeLayout(current, input.projectId)
    if (!layout) return false

    const explicit = layout.auxiliary.find((panel): panel is ProjectFileWorkbenchPanel => (
      panel.kind === 'project-file'
      && panel.presentation === 'explicit'
      && panel.relativePath === input.relativePath
    ))
    if (explicit) {
      const nextExplicit = {
        ...explicit,
        openIntent: input.openIntent,
        openIntentRevision: (explicit.openIntentRevision ?? 0) + Number(Boolean(input.openIntent)),
      }
      const auxiliary = layout.auxiliary.map(panel => (
        panel.id === explicit.id ? nextExplicit : panel
      ))
      set(workbenchAtom, withActiveLayout(current, input.projectId, {
        ...layout,
        auxiliary,
        focusedPanelId: explicit.id,
      }))
      set(workbenchPanelRevealRevisionAtom, get(workbenchPanelRevealRevisionAtom) + 1)
      return true
    }

    const previewIndex = layout.previewPanelId
      ? layout.auxiliary.findIndex(panel => panel.id === layout.previewPanelId)
      : -1
    const preview = previewIndex >= 0 ? layout.auxiliary[previewIndex] : undefined
    if (
      preview?.kind === 'project-file'
      && preview.relativePath === input.relativePath
    ) {
      const nextPreview = {
        ...preview,
        openIntent: input.openIntent,
        openIntentRevision: (preview.openIntentRevision ?? 0) + Number(Boolean(input.openIntent)),
      }
      const auxiliary = layout.auxiliary.map(panel => (
        panel.id === preview.id ? nextPreview : panel
      ))
      set(workbenchAtom, withActiveLayout(current, input.projectId, {
        ...layout,
        auxiliary,
        focusedPanelId: preview.id,
      }))
      set(workbenchPanelRevealRevisionAtom, get(workbenchPanelRevealRevisionAtom) + 1)
      return true
    }

    if (preview?.kind === 'project-file') {
      try {
        await flushOpenProjectFile(preview.projectId, preview.relativePath)
      } catch {
        return false
      }
      const latest = get(workbenchAtom)
      if (
        latest.workspaceId !== current.workspaceId
        || latest.activeProjectId !== input.projectId
      ) return false
      const latestLayout = activeLayout(latest, input.projectId)
      const latestPreviewIndex = latestLayout?.auxiliary.findIndex(panel => panel.id === preview.id) ?? -1
      const latestPreview = latestPreviewIndex >= 0
        ? latestLayout?.auxiliary[latestPreviewIndex]
        : undefined
      if (
        latestPreview?.kind !== 'project-file'
        || latestPreview.relativePath !== preview.relativePath
        || latestLayout?.previewPanelId !== preview.id
      ) return false

      const replacement: ProjectFileWorkbenchPanel = {
        ...latestPreview,
        relativePath: input.relativePath,
        presentation: 'preview',
        chatTargetSessionId: null,
        openIntent: input.openIntent,
        openIntentRevision: input.openIntent ? (latestPreview.openIntentRevision ?? 0) + 1 : 0,
      }
      const auxiliary = [...latestLayout.auxiliary]
      auxiliary[latestPreviewIndex] = replacement
      set(workbenchAtom, withActiveLayout(latest, input.projectId, {
        ...latestLayout,
        auxiliary,
        previewPanelId: replacement.id,
        focusedPanelId: replacement.id,
      }))
    } else {
      const panel = createProjectFilePanel(
        input.projectId,
        input.relativePath,
        'preview',
        get(workbenchPanelLayoutWidthAtom),
        input.openIntent,
      )
      const insertAt = auxiliaryInsertionIndex(layout)
      const auxiliary = [
        ...layout.auxiliary.slice(0, insertAt),
        panel,
        ...layout.auxiliary.slice(insertAt),
      ]
      set(workbenchAtom, withActiveLayout(current, input.projectId, {
        ...layout,
        auxiliary,
        previewPanelId: panel.id,
        focusedPanelId: panel.id,
      }))
    }
    set(workbenchPanelRevealRevisionAtom, get(workbenchPanelRevealRevisionAtom) + 1)
    return true
  },
)

export const setProjectFileChatTargetAtom = atom(
  null,
  (get, set, input: {
    panelId: string
    projectId: string
    sessionId: string | null
    sessionProjectId: string
  }): boolean => {
    if (
      !validId(input.panelId)
      || !validId(input.projectId)
      || !validId(input.sessionProjectId)
      || (input.sessionId !== null && !validId(input.sessionId))
      || input.sessionProjectId !== input.projectId
    ) return false

    const current = get(workbenchAtom)
    const layout = activeLayout(current, input.projectId)
    if (!layout) return false
    const targetIndex = layout.auxiliary.findIndex(panel => (
      panel.id === input.panelId && panel.kind === 'project-file'
    ))
    if (targetIndex < 0) return false

    const auxiliary = [...layout.auxiliary]
    auxiliary[targetIndex] = {
      ...auxiliary[targetIndex] as ProjectFileWorkbenchPanel,
      chatTargetSessionId: input.sessionId,
    }
    set(workbenchAtom, withActiveLayout(current, input.projectId, {
      ...layout,
      auxiliary,
    }))
    return true
  },
)

export const openProjectFileInPanelAtom = atom(
  null,
  (get, set, input: { projectId: string; relativePath: string }): boolean => {
    if (!validId(input.projectId) || !isCanonicalProjectRelativePath(input.relativePath)) {
      return false
    }
    const current = get(workbenchAtom)
    const layout = activeLayout(current, input.projectId)
    if (!layout) return false

    const existing = layout.auxiliary.find(panel => (
      panel.kind === 'project-file'
      && panel.presentation === 'explicit'
      && panel.relativePath === input.relativePath
    ))
    if (existing) {
      set(workbenchAtom, withActiveLayout(current, input.projectId, {
        ...layout,
        focusedPanelId: existing.id,
      }))
      set(workbenchPanelRevealRevisionAtom, get(workbenchPanelRevealRevisionAtom) + 1)
      return true
    }

    const panel = createProjectFilePanel(
      input.projectId,
      input.relativePath,
      'explicit',
      get(workbenchPanelLayoutWidthAtom),
    )
    const insertAt = auxiliaryInsertionIndex(layout)
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
    set(workbenchPanelRevealRevisionAtom, get(workbenchPanelRevealRevisionAtom) + 1)
    return true
  },
)

export const closeWorkbenchPanelAtom = atom(
  null,
  async (get, set, input: { projectId: string; panelId: string }): Promise<boolean> => {
    let current = get(workbenchAtom)
    let layout = activeLayout(current, input.projectId)
    if (!layout) return false

    const closingPanel = getWorkbenchPanels(layout).find(panel => panel.id === input.panelId)
    if (!closingPanel) return false
    if (closingPanel.kind === 'project-file') {
      try {
        await flushOpenProjectFile(closingPanel.projectId, closingPanel.relativePath)
      } catch {
        return false
      }
      const latest = get(workbenchAtom)
      if (
        latest.workspaceId !== current.workspaceId
        || latest.activeProjectId !== current.activeProjectId
      ) return false
      const latestLayout = activeLayout(latest, input.projectId)
      const latestPanel = latestLayout
        ? getWorkbenchPanels(latestLayout).find(panel => panel.id === input.panelId)
        : undefined
      if (
        latestPanel?.kind !== 'project-file'
        || latestPanel.relativePath !== closingPanel.relativePath
      ) return false
      current = latest
      layout = latestLayout!
    }
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
      previewPanelId: layout.previewPanelId === input.panelId ? null : layout.previewPanelId,
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
  set(
    workbenchKeyboardFocusRevisionAtom,
    get(workbenchKeyboardFocusRevisionAtom) + 1,
  )
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

      const closingIndex = layout.auxiliary.findIndex(panel => (
        panel.kind === 'session' && panel.sessionId === sessionId
      ))
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

/** Remove layouts for Projects no longer present in the authoritative Workspace list. */
export const reconcileWorkbenchProjectsAtom = atom(
  null,
  (get, set, input: { projectIds: string[]; defaultProjectId: string }): boolean => {
    if (!validId(input.defaultProjectId)) return false
    const current = get(workbenchAtom)
    if (!current.workspaceId) return false
    const available = new Set(input.projectIds)
    available.add(input.defaultProjectId)
    const layoutsByProject = Object.fromEntries(
      Object.entries(current.layoutsByProject).filter(([projectId]) => available.has(projectId)),
    )
    layoutsByProject[input.defaultProjectId] ??= createEmptyProjectWorkbench()
    const activeProjectId = current.activeProjectId && available.has(current.activeProjectId)
      ? current.activeProjectId
      : input.defaultProjectId
    if (
      activeProjectId === current.activeProjectId
      && Object.keys(layoutsByProject).length === Object.keys(current.layoutsByProject).length
    ) return false
    set(workbenchAtom, { ...current, activeProjectId, layoutsByProject })
    return true
  },
)
