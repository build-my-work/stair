import { isCanonicalProjectRelativePath } from '../project-files/index.ts'

export const WORKBENCH_LAYOUT_VERSION = 1 as const
export const DEFAULT_WORKBENCH_PANEL_RATIO = 1

export interface PersistedSessionWorkbenchPanel {
  id: string
  kind: 'session'
  sessionId: string
  widthRatio: number
}

export interface PersistedProjectFileWorkbenchPanel {
  id: string
  kind: 'project-file'
  relativePath: string
  presentation: 'preview' | 'explicit'
  chatTargetSessionId: string | null
  widthRatio: number
}

export type PersistedWorkbenchPanel =
  | PersistedSessionWorkbenchPanel
  | PersistedProjectFileWorkbenchPanel

export interface PersistedProjectWorkbench {
  primary: PersistedSessionWorkbenchPanel | null
  auxiliary: PersistedWorkbenchPanel[]
  previewPanelId: string | null
  focusedPanelId: string | null
}

export interface PersistedWorkbenchLayoutDocument {
  version: typeof WORKBENCH_LAYOUT_VERSION
  layoutsByProject: Record<string, PersistedProjectWorkbench>
}

export interface WorkbenchLayoutValidation {
  isProjectAvailable(projectId: string): boolean
  isSessionAvailable(projectId: string, sessionId: string): boolean
}

const EMPTY_DOCUMENT: PersistedWorkbenchLayoutDocument = {
  version: WORKBENCH_LAYOUT_VERSION,
  layoutsByProject: {},
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !value.includes('\0')
    && !value.includes('/')
    && !value.includes('\\')
    && value.length <= 256
}

function normalizedRatio(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_WORKBENCH_PANEL_RATIO
}

function normalizedChatTarget(
  value: unknown,
  projectId: string,
  validation: WorkbenchLayoutValidation,
): string | null {
  return validIdentifier(value) && validation.isSessionAvailable(projectId, value)
    ? value
    : null
}

function normalizeSessionPanel(
  value: unknown,
  projectId: string,
  validation: WorkbenchLayoutValidation,
): PersistedSessionWorkbenchPanel | null {
  if (!isRecord(value)) return null
  const panel = value
  if (
    panel.kind !== 'session'
    || !validIdentifier(panel.id)
    || !validIdentifier(panel.sessionId)
    || !validation.isSessionAvailable(projectId, panel.sessionId)
  ) return null
  return {
    id: panel.id,
    kind: 'session',
    sessionId: panel.sessionId,
    widthRatio: normalizedRatio(panel.widthRatio),
  }
}

function normalizeAuxiliaryPanel(
  value: unknown,
  projectId: string,
  validation: WorkbenchLayoutValidation,
): PersistedWorkbenchPanel | null {
  const sessionPanel = normalizeSessionPanel(value, projectId, validation)
  if (sessionPanel) return sessionPanel
  if (!isRecord(value)) return null
  const panel = value
  if (!validIdentifier(panel.id)) return null

  if (panel.kind === 'project-file') {
    if (
      !isCanonicalProjectRelativePath(panel.relativePath)
      || (panel.presentation !== 'preview' && panel.presentation !== 'explicit')
    ) return null
    return {
      id: panel.id,
      kind: 'project-file',
      relativePath: panel.relativePath,
      presentation: panel.presentation,
      chatTargetSessionId: normalizedChatTarget(
        panel.chatTargetSessionId,
        projectId,
        validation,
      ),
      widthRatio: normalizedRatio(panel.widthRatio),
    }
  }

  return null
}

function normalizeProjectLayout(
  value: unknown,
  projectId: string,
  validation: WorkbenchLayoutValidation,
): PersistedProjectWorkbench | null {
  if (!isRecord(value)) return null
  const layout = value
  if (!Array.isArray(layout.auxiliary)) return null

  const primary = normalizeSessionPanel(layout.primary, projectId, validation)
  const usedPanelIds = new Set<string>()
  const usedSessionIds = new Set<string>()
  if (primary) {
    usedPanelIds.add(primary.id)
    usedSessionIds.add(primary.sessionId)
  }

  let hasPreview = false
  const auxiliary: PersistedWorkbenchPanel[] = []
  for (const rawPanel of layout.auxiliary) {
    const panel = normalizeAuxiliaryPanel(rawPanel, projectId, validation)
    if (
      !panel
      || usedPanelIds.has(panel.id)
      || (panel.kind === 'session' && usedSessionIds.has(panel.sessionId))
      || (panel.kind === 'project-file' && panel.presentation === 'preview' && hasPreview)
    ) continue
    usedPanelIds.add(panel.id)
    if (panel.kind === 'session') usedSessionIds.add(panel.sessionId)
    if (panel.kind === 'project-file' && panel.presentation === 'preview') hasPreview = true
    auxiliary.push(panel)
  }

  const panels = primary ? [primary, ...auxiliary] : auxiliary
  const fallbackPreviewPanelId = auxiliary.find(panel => (
    panel.kind === 'project-file' && panel.presentation === 'preview'
  ))?.id ?? null
  const previewPanelId = validIdentifier(layout.previewPanelId)
    && auxiliary.some(panel => (
      panel.id === layout.previewPanelId
      && panel.kind === 'project-file'
      && panel.presentation === 'preview'
    ))
    ? layout.previewPanelId
    : fallbackPreviewPanelId
  const focusedPanelId = validIdentifier(layout.focusedPanelId)
    && panels.some(panel => panel.id === layout.focusedPanelId)
    ? layout.focusedPanelId
    : panels[0]?.id ?? null

  return { primary, auxiliary, previewPanelId, focusedPanelId }
}

export function normalizeWorkbenchLayoutDocument(
  value: unknown,
  validation: WorkbenchLayoutValidation,
): PersistedWorkbenchLayoutDocument {
  if (!isRecord(value)) return EMPTY_DOCUMENT
  const document = value
  if (
    document.version !== WORKBENCH_LAYOUT_VERSION
    || !document.layoutsByProject
    || typeof document.layoutsByProject !== 'object'
    || Array.isArray(document.layoutsByProject)
  ) return EMPTY_DOCUMENT

  const layoutsByProject: Record<string, PersistedProjectWorkbench> = {}
  for (const [projectId, rawLayout] of Object.entries(document.layoutsByProject)) {
    if (!validIdentifier(projectId) || !validation.isProjectAvailable(projectId)) continue
    const layout = normalizeProjectLayout(rawLayout, projectId, validation)
    if (layout) layoutsByProject[projectId] = layout
  }
  return { version: WORKBENCH_LAYOUT_VERSION, layoutsByProject }
}
