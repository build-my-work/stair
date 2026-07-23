import { atom, type Getter, type Setter } from 'jotai'
import type { FileReference } from '@craft-agent/core/types'

export const RIGHT_WORKSPACE_STATE_VERSION = 1

export const RIGHT_WORKSPACE_DEFAULT_WIDTH = 440
export const RIGHT_WORKSPACE_MIN_WIDTH = 320
export const RIGHT_WORKSPACE_MAX_WIDTH = 760
export const RIGHT_WORKSPACE_DEFAULT_FILE_EXPLORER_WIDTH = 220
export const RIGHT_WORKSPACE_MIN_FILE_EXPLORER_WIDTH = 160
export const RIGHT_WORKSPACE_MAX_FILE_EXPLORER_WIDTH = 420

export type RightWorkspaceTab =
  | { id: string; type: 'new'; title: string }
  | { id: string; type: 'file'; path: string; title: string }
  | { id: string; type: 'sideChat'; sessionId: string; title: string }
  | { id: string; type: 'artifact'; artifactId: string; title: string }

export interface RightWorkspaceGlobalState {
  visible: boolean
  width: number
}

export interface RightWorkspaceSessionState {
  tabs: RightWorkspaceTab[]
  activeTabId: string
  fileExplorerVisible: boolean
  fileExplorerWidth: number
  expandedDirectories: string[]
  fileExplorerScrollTop: number
}

export interface RightWorkspaceState extends RightWorkspaceGlobalState, RightWorkspaceSessionState {}

interface RightWorkspaceContext {
  workspaceId: string | null
  sessionId: string | null
}

export interface RightWorkspaceFileNavigation {
  path: string
  locator: FileReference['locator']
  nonce: number
}

interface PersistedRightWorkspaceGlobal extends RightWorkspaceGlobalState {
  version: number
}

interface PersistedRightWorkspaceSession extends RightWorkspaceSessionState {
  version: number
}

let nextTabId = 0
let nextNavigationNonce = 0

function makeTabId(type: RightWorkspaceTab['type']): string {
  nextTabId += 1
  return `right-${type}-${Date.now()}-${nextTabId}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function normalizeRightWorkspaceRelativePath(path: string): string {
  const slashPath = path.trim().replaceAll('\\', '/')
  if (
    !slashPath ||
    slashPath.startsWith('/') ||
    /^[a-zA-Z]:\//.test(slashPath) ||
    slashPath.includes('\0')
  ) {
    throw new Error('A project-relative file path is required')
  }

  const segments: string[] = []
  for (const segment of slashPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error('File path escapes the project working directory')
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  if (segments.length === 0) {
    throw new Error('A file path is required')
  }
  return segments.join('/')
}

function tryNormalizeRelativePath(path: unknown): string | null {
  if (!isNonEmptyString(path)) return null
  try {
    return normalizeRightWorkspaceRelativePath(path)
  } catch {
    return null
  }
}

function normalizeDirectoryPaths(paths: unknown[]): string[] {
  return [...new Set(
    paths
      .map(tryNormalizeRelativePath)
      .filter((path): path is string => path !== null),
  )]
}

function fileTitle(path: string): string {
  return path.split('/').at(-1) ?? path
}

export function createDefaultRightWorkspaceGlobal(): RightWorkspaceGlobalState {
  return {
    visible: false,
    width: RIGHT_WORKSPACE_DEFAULT_WIDTH,
  }
}

export function createDefaultRightWorkspaceSession(
  tabId = makeTabId('new'),
): RightWorkspaceSessionState {
  return {
    tabs: [{ id: tabId, type: 'new', title: 'New tab' }],
    activeTabId: tabId,
    fileExplorerVisible: false,
    fileExplorerWidth: RIGHT_WORKSPACE_DEFAULT_FILE_EXPLORER_WIDTH,
    expandedDirectories: [],
    fileExplorerScrollTop: 0,
  }
}

export function openFileInRightWorkspace(
  state: RightWorkspaceSessionState,
  rawPath: string,
  tabId = makeTabId('file'),
): RightWorkspaceSessionState {
  const path = normalizeRightWorkspaceRelativePath(rawPath)
  const existing = state.tabs.find((tab) => tab.type === 'file' && tab.path === path)
  if (existing) {
    return { ...state, activeTabId: existing.id }
  }

  const tab: RightWorkspaceTab = {
    id: tabId,
    type: 'file',
    path,
    title: fileTitle(path),
  }
  return {
    ...state,
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
  }
}

export function closeRightWorkspaceTab(
  state: RightWorkspaceSessionState,
  tabId: string,
  fallbackTabId = makeTabId('new'),
): RightWorkspaceSessionState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId)
  if (index === -1) return state

  const tabs = state.tabs.filter((tab) => tab.id !== tabId)
  if (tabs.length === 0) {
    const replacement: RightWorkspaceTab = {
      id: fallbackTabId,
      type: 'new',
      title: 'New tab',
    }
    return { ...state, tabs: [replacement], activeTabId: replacement.id }
  }

  if (state.activeTabId !== tabId) return { ...state, tabs }

  const nextActive = tabs[Math.min(index, tabs.length - 1)]
  return { ...state, tabs, activeTabId: nextActive.id }
}

export function renameArtifactInRightWorkspace(
  state: RightWorkspaceSessionState,
  artifactId: string,
  rawTitle: string,
): RightWorkspaceSessionState {
  const title = rawTitle.trim()
  if (!title) return state

  const index = state.tabs.findIndex(
    tab => tab.type === 'artifact' && tab.artifactId === artifactId,
  )
  if (index === -1 || state.tabs[index].title === title) return state

  const tabs = [...state.tabs]
  tabs[index] = { ...tabs[index], title }
  return { ...state, tabs }
}

export function updateRightWorkspaceFileExplorer(
  state: RightWorkspaceSessionState,
  update: {
    visible?: boolean
    width?: number
    expandedDirectories?: string[]
    scrollTop?: number
  },
): RightWorkspaceSessionState {
  const expandedDirectories = update.expandedDirectories === undefined
    ? state.expandedDirectories
    : normalizeDirectoryPaths(update.expandedDirectories)

  return {
    ...state,
    fileExplorerVisible: update.visible ?? state.fileExplorerVisible,
    fileExplorerWidth: update.width === undefined
      ? state.fileExplorerWidth
      : clamp(
        update.width,
        RIGHT_WORKSPACE_MIN_FILE_EXPLORER_WIDTH,
        RIGHT_WORKSPACE_MAX_FILE_EXPLORER_WIDTH,
      ),
    expandedDirectories,
    fileExplorerScrollTop: update.scrollTop === undefined
      ? state.fileExplorerScrollTop
      : Math.max(0, update.scrollTop),
  }
}

function parseTab(value: unknown): RightWorkspaceTab | null {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.type)) {
    return null
  }

  const title = isNonEmptyString(value.title) ? value.title : null
  switch (value.type) {
    case 'new':
      return { id: value.id, type: 'new', title: title ?? 'New tab' }
    case 'file': {
      const path = tryNormalizeRelativePath(value.path)
      if (!path) return null
      return { id: value.id, type: 'file', path, title: fileTitle(path) }
    }
    case 'sideChat':
      if (!isNonEmptyString(value.sessionId)) return null
      return {
        id: value.id,
        type: 'sideChat',
        sessionId: value.sessionId,
        title: title ?? 'Side chat',
      }
    case 'artifact':
      if (!isNonEmptyString(value.artifactId)) return null
      return {
        id: value.id,
        type: 'artifact',
        artifactId: value.artifactId,
        title: title ?? 'Artifact',
      }
    default:
      return null
  }
}

export function parsePersistedRightWorkspaceGlobal(value: unknown): RightWorkspaceGlobalState {
  const fallback = createDefaultRightWorkspaceGlobal()
  if (!isRecord(value) || value.version !== RIGHT_WORKSPACE_STATE_VERSION) return fallback
  if (typeof value.visible !== 'boolean' || typeof value.width !== 'number' || !Number.isFinite(value.width)) {
    return fallback
  }
  return {
    visible: value.visible,
    width: clamp(value.width, RIGHT_WORKSPACE_MIN_WIDTH, RIGHT_WORKSPACE_MAX_WIDTH),
  }
}

export function parsePersistedRightWorkspaceSession(value: unknown): RightWorkspaceSessionState {
  const fallback = createDefaultRightWorkspaceSession()
  if (!isRecord(value) || value.version !== RIGHT_WORKSPACE_STATE_VERSION || !Array.isArray(value.tabs)) {
    return fallback
  }

  const tabs: RightWorkspaceTab[] = []
  const ids = new Set<string>()
  const filePaths = new Set<string>()
  for (const rawTab of value.tabs) {
    const tab = parseTab(rawTab)
    if (!tab || ids.has(tab.id)) continue
    if (tab.type === 'file') {
      if (filePaths.has(tab.path)) continue
      filePaths.add(tab.path)
    }
    ids.add(tab.id)
    tabs.push(tab)
  }

  if (tabs.length === 0) return fallback

  const expandedDirectories = Array.isArray(value.expandedDirectories)
    ? normalizeDirectoryPaths(value.expandedDirectories)
    : []

  const activeTabId = isNonEmptyString(value.activeTabId) && ids.has(value.activeTabId)
    ? value.activeTabId
    : tabs[0].id

  return {
    tabs,
    activeTabId,
    fileExplorerVisible: value.fileExplorerVisible === true,
    fileExplorerWidth: typeof value.fileExplorerWidth === 'number' && Number.isFinite(value.fileExplorerWidth)
      ? clamp(
        value.fileExplorerWidth,
        RIGHT_WORKSPACE_MIN_FILE_EXPLORER_WIDTH,
        RIGHT_WORKSPACE_MAX_FILE_EXPLORER_WIDTH,
      )
      : RIGHT_WORKSPACE_DEFAULT_FILE_EXPLORER_WIDTH,
    expandedDirectories,
    fileExplorerScrollTop: typeof value.fileExplorerScrollTop === 'number' && Number.isFinite(value.fileExplorerScrollTop)
      ? Math.max(0, value.fileExplorerScrollTop)
      : 0,
  }
}

export function getRightWorkspaceGlobalStorageKey(workspaceId: string): string {
  return `craft-right-workspace:global:${encodeURIComponent(workspaceId)}`
}

export function getRightWorkspaceSessionStorageKey(workspaceId: string, sessionId: string): string {
  return `craft-right-workspace:session:${encodeURIComponent(workspaceId)}:${encodeURIComponent(sessionId)}`
}

function readPersistedValue(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (raw === null || raw === undefined) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function persistValue(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn('[RightWorkspace] Failed to persist state:', error)
  }
}

function persistGlobal(context: RightWorkspaceContext, state: RightWorkspaceGlobalState): void {
  if (!context.workspaceId) return
  const payload: PersistedRightWorkspaceGlobal = {
    version: RIGHT_WORKSPACE_STATE_VERSION,
    ...state,
  }
  persistValue(getRightWorkspaceGlobalStorageKey(context.workspaceId), payload)
}

function persistSession(context: RightWorkspaceContext, state: RightWorkspaceSessionState): void {
  if (!context.workspaceId || !context.sessionId) return
  const payload: PersistedRightWorkspaceSession = {
    version: RIGHT_WORKSPACE_STATE_VERSION,
    ...state,
  }
  persistValue(getRightWorkspaceSessionStorageKey(context.workspaceId, context.sessionId), payload)
}

export const rightWorkspaceContextAtom = atom<RightWorkspaceContext>({
  workspaceId: null,
  sessionId: null,
})
export const rightWorkspaceGlobalAtom = atom<RightWorkspaceGlobalState>(createDefaultRightWorkspaceGlobal())
export const rightWorkspaceSessionAtom = atom<RightWorkspaceSessionState>(createDefaultRightWorkspaceSession())
export const rightWorkspaceFileNavigationAtom = atom<RightWorkspaceFileNavigation | null>(null)

export const rightWorkspaceStateAtom = atom<RightWorkspaceState>((get) => ({
  ...get(rightWorkspaceGlobalAtom),
  ...get(rightWorkspaceSessionAtom),
}))

export const rightWorkspaceActiveTabAtom = atom<RightWorkspaceTab>((get) => {
  const state = get(rightWorkspaceSessionAtom)
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
})

export const hydrateRightWorkspaceAtom = atom(
  null,
  (_get, set, context: RightWorkspaceContext) => {
    set(rightWorkspaceContextAtom, context)
    set(rightWorkspaceFileNavigationAtom, null)
    set(
      rightWorkspaceGlobalAtom,
      context.workspaceId
        ? parsePersistedRightWorkspaceGlobal(
          readPersistedValue(getRightWorkspaceGlobalStorageKey(context.workspaceId)),
        )
        : createDefaultRightWorkspaceGlobal(),
    )
    set(
      rightWorkspaceSessionAtom,
      context.workspaceId && context.sessionId
        ? parsePersistedRightWorkspaceSession(
          readPersistedValue(getRightWorkspaceSessionStorageKey(context.workspaceId, context.sessionId)),
        )
        : createDefaultRightWorkspaceSession(),
    )
  },
)

export const setRightWorkspaceVisibleAtom = atom(
  null,
  (get, set, visible: boolean) => {
    const next = { ...get(rightWorkspaceGlobalAtom), visible }
    set(rightWorkspaceGlobalAtom, next)
    persistGlobal(get(rightWorkspaceContextAtom), next)
  },
)

export const toggleRightWorkspaceAtom = atom(null, (get, set) => {
  set(setRightWorkspaceVisibleAtom, !get(rightWorkspaceGlobalAtom).visible)
})

export const setRightWorkspaceWidthAtom = atom(null, (get, set, width: number) => {
  const next = {
    ...get(rightWorkspaceGlobalAtom),
    width: clamp(width, RIGHT_WORKSPACE_MIN_WIDTH, RIGHT_WORKSPACE_MAX_WIDTH),
  }
  set(rightWorkspaceGlobalAtom, next)
  persistGlobal(get(rightWorkspaceContextAtom), next)
})

function updateSessionAtom(
  get: Getter,
  set: Setter,
  update: (state: RightWorkspaceSessionState) => RightWorkspaceSessionState,
): void {
  const next = update(get(rightWorkspaceSessionAtom))
  set(rightWorkspaceSessionAtom, next)
  persistSession(get(rightWorkspaceContextAtom), next)
}

export const setRightWorkspaceActiveTabAtom = atom(null, (get, set, tabId: string) => {
  updateSessionAtom(get, set, (state) => {
    if (!state.tabs.some((tab) => tab.id === tabId)) return state
    return { ...state, activeTabId: tabId }
  })
})

export const openRightWorkspaceNewTabAtom = atom(null, (get, set) => {
  updateSessionAtom(get, set, (state) => {
    const tab: RightWorkspaceTab = { id: makeTabId('new'), type: 'new', title: 'New tab' }
    return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id }
  })
})

export const openRightWorkspaceFileTabAtom = atom(null, (get, set, path: string) => {
  updateSessionAtom(get, set, (state) => openFileInRightWorkspace(state, path))
})

/** Open a project-relative file and reveal the workspace when a focused session is hydrated. */
export const showRightWorkspaceFileAtom = atom(null, (get, set, path: string): boolean => {
  const context = get(rightWorkspaceContextAtom)
  if (!context.workspaceId || !context.sessionId) return false
  try {
    updateSessionAtom(get, set, (state) => openFileInRightWorkspace(state, path))
    set(setRightWorkspaceVisibleAtom, true)
    return true
  } catch {
    return false
  }
})

export const showRightWorkspaceReferenceAtom = atom(
  null,
  (get, set, reference: FileReference): boolean => {
    const context = get(rightWorkspaceContextAtom)
    if (!context.workspaceId || !context.sessionId) return false
    try {
      const path = normalizeRightWorkspaceRelativePath(reference.path)
      updateSessionAtom(get, set, state => openFileInRightWorkspace(state, path))
      nextNavigationNonce += 1
      set(rightWorkspaceFileNavigationAtom, {
        path,
        locator: { ...reference.locator },
        nonce: nextNavigationNonce,
      })
      set(setRightWorkspaceVisibleAtom, true)
      return true
    } catch {
      return false
    }
  },
)

export const openRightWorkspaceSideChatTabAtom = atom(
  null,
  (get, set, input: { sessionId: string; title?: string }) => {
    updateSessionAtom(get, set, (state) => {
      const existing = state.tabs.find(
        (tab) => tab.type === 'sideChat' && tab.sessionId === input.sessionId,
      )
      if (existing) return { ...state, activeTabId: existing.id }
      const tab: RightWorkspaceTab = {
        id: makeTabId('sideChat'),
        type: 'sideChat',
        sessionId: input.sessionId,
        title: input.title?.trim() || 'Side chat',
      }
      return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id }
    })
  },
)

export const openRightWorkspaceArtifactTabAtom = atom(
  null,
  (get, set, input: { artifactId: string; title?: string }) => {
    updateSessionAtom(get, set, (state) => {
      const existing = state.tabs.find(
        (tab) => tab.type === 'artifact' && tab.artifactId === input.artifactId,
      )
      if (existing) return { ...state, activeTabId: existing.id }
      const tab: RightWorkspaceTab = {
        id: makeTabId('artifact'),
        type: 'artifact',
        artifactId: input.artifactId,
        title: input.title?.trim() || 'Artifact',
      }
      return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id }
    })
  },
)

export const showRightWorkspaceArtifactAtom = atom(
  null,
  (get, set, input: { artifactId: string; title?: string }): boolean => {
    const context = get(rightWorkspaceContextAtom)
    if (!context.workspaceId || !context.sessionId || !input.artifactId.trim()) return false
    set(openRightWorkspaceArtifactTabAtom, input)
    set(setRightWorkspaceVisibleAtom, true)
    return true
  },
)

export const renameRightWorkspaceArtifactTabAtom = atom(
  null,
  (get, set, input: { artifactId: string; title: string }) => {
    updateSessionAtom(get, set, state => (
      renameArtifactInRightWorkspace(state, input.artifactId, input.title)
    ))
  },
)

export const closeRightWorkspaceTabAtom = atom(null, (get, set, tabId: string) => {
  updateSessionAtom(get, set, (state) => closeRightWorkspaceTab(state, tabId))
})

export const updateRightWorkspaceFileExplorerAtom = atom(
  null,
  (
    get,
    set,
    update: Parameters<typeof updateRightWorkspaceFileExplorer>[1],
  ) => {
    updateSessionAtom(get, set, (state) => updateRightWorkspaceFileExplorer(state, update))
  },
)
