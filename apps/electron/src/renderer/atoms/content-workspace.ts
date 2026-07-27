import { atom, type Getter, type Setter } from 'jotai'
import { atomFamily } from 'jotai-family'
import type { FileReference } from '@craft-agent/core/types'

export const CONTENT_WORKSPACE_STATE_VERSION = 1
export const CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID = 'main-chat'

export interface ContentWorkspaceKey {
  workspaceId: string
  sessionId: string
}

export type ContentWorkspaceTab =
  | { id: typeof CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID; type: 'chat'; title: 'Main Chat' }
  | { id: string; type: 'file'; path: string; title: string }
  | { id: string; type: 'browser'; instanceId: string; title: string }

export interface ContentWorkspaceState {
  tabs: ContentWorkspaceTab[]
  activeTabId: string
}

export interface ContentWorkspaceFileNavigation {
  path: string
  locator: FileReference['locator']
  nonce: number
}

interface PersistedContentWorkspaceState extends ContentWorkspaceState {
  version: number
}

let nextTabId = 0
let nextNavigationNonce = 0

function makeTabId(type: 'file' | 'browser'): string {
  nextTabId += 1
  return `content-${type}-${Date.now()}-${nextTabId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasValidKey(key: ContentWorkspaceKey): boolean {
  return key.workspaceId.trim().length > 0 && key.sessionId.trim().length > 0
}

function sameKey(left: ContentWorkspaceKey, right: ContentWorkspaceKey): boolean {
  return left.workspaceId === right.workspaceId && left.sessionId === right.sessionId
}

function mainChatTab(): ContentWorkspaceTab {
  return {
    id: CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID,
    type: 'chat',
    title: 'Main Chat',
  }
}

export function normalizeContentWorkspaceRelativePath(path: string): string {
  const slashPath = path.trim().replaceAll('\\', '/')
  if (
    !slashPath
    || slashPath.startsWith('/')
    || /^[a-zA-Z]:\//.test(slashPath)
    || slashPath.includes('\0')
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
    return normalizeContentWorkspaceRelativePath(path)
  } catch {
    return null
  }
}

function fileTitle(path: string): string {
  return path.split('/').at(-1) ?? path
}

export function createDefaultContentWorkspaceState(): ContentWorkspaceState {
  return {
    tabs: [mainChatTab()],
    activeTabId: CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID,
  }
}

export function openFileInContentWorkspace(
  state: ContentWorkspaceState,
  rawPath: string,
  tabId = makeTabId('file'),
): ContentWorkspaceState {
  const path = normalizeContentWorkspaceRelativePath(rawPath)
  const existing = state.tabs.find(tab => tab.type === 'file' && tab.path === path)
  if (existing) return { ...state, activeTabId: existing.id }

  const tab: ContentWorkspaceTab = {
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

export function openBrowserInContentWorkspace(
  state: ContentWorkspaceState,
  input: { instanceId: string; title?: string },
  tabId = makeTabId('browser'),
): ContentWorkspaceState {
  const instanceId = input.instanceId.trim()
  if (!instanceId) throw new Error('A browser instance id is required')

  const existing = state.tabs.find(
    tab => tab.type === 'browser' && tab.instanceId === instanceId,
  )
  if (existing) {
    const title = input.title?.trim()
    if (!title || title === existing.title) {
      return { ...state, activeTabId: existing.id }
    }
    return {
      ...state,
      tabs: state.tabs.map(tab => (
        tab.type === 'browser' && tab.id === existing.id
          ? { ...tab, title }
          : tab
      )),
      activeTabId: existing.id,
    }
  }

  const tab: ContentWorkspaceTab = {
    id: tabId,
    type: 'browser',
    instanceId,
    title: input.title?.trim() || 'Browser',
  }
  return {
    ...state,
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
  }
}

export function renameBrowserInContentWorkspace(
  state: ContentWorkspaceState,
  instanceId: string,
  rawTitle: string,
): ContentWorkspaceState {
  const title = rawTitle.trim()
  if (!title) return state

  const existing = state.tabs.find(
    (tab): tab is Extract<ContentWorkspaceTab, { type: 'browser' }> => (
      tab.type === 'browser' && tab.instanceId === instanceId
    ),
  )
  if (!existing || existing.title === title) return state

  const tabs = state.tabs.map(tab => (
    tab.type === 'browser' && tab.id === existing.id
      ? { ...tab, title }
      : tab
  ))
  return { ...state, tabs }
}

export function closeContentWorkspaceTab(
  state: ContentWorkspaceState,
  tabId: string,
): ContentWorkspaceState {
  const index = state.tabs.findIndex(tab => tab.id === tabId)
  if (index === -1 || state.tabs[index].type === 'chat') return state

  const tabs = state.tabs.filter(tab => tab.id !== tabId)
  if (state.activeTabId !== tabId) return { ...state, tabs }

  const nextActive = tabs[Math.min(index, tabs.length - 1)] ?? tabs[0]
  return { ...state, tabs, activeTabId: nextActive.id }
}

function parsePersistedFileTab(value: unknown): Extract<ContentWorkspaceTab, { type: 'file' }> | null {
  if (
    !isRecord(value)
    || value.type !== 'file'
    || !isNonEmptyString(value.id)
  ) {
    return null
  }

  const path = tryNormalizeRelativePath(value.path)
  if (!path || value.id === CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID) return null
  return { id: value.id, type: 'file', path, title: fileTitle(path) }
}

export function parsePersistedContentWorkspaceState(value: unknown): ContentWorkspaceState {
  const fallback = createDefaultContentWorkspaceState()
  if (
    !isRecord(value)
    || value.version !== CONTENT_WORKSPACE_STATE_VERSION
    || !Array.isArray(value.tabs)
  ) {
    return fallback
  }

  const tabs: ContentWorkspaceTab[] = [mainChatTab()]
  const ids = new Set<string>([CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID])
  const filePaths = new Set<string>()

  for (const rawTab of value.tabs) {
    const tab = parsePersistedFileTab(rawTab)
    if (!tab || ids.has(tab.id)) continue
    if (filePaths.has(tab.path)) continue
    filePaths.add(tab.path)
    ids.add(tab.id)
    tabs.push(tab)
  }

  const activeTabId = isNonEmptyString(value.activeTabId) && ids.has(value.activeTabId)
    ? value.activeTabId
    : CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID

  return { tabs, activeTabId }
}

export function getContentWorkspaceStorageKey(key: ContentWorkspaceKey): string {
  return `stair-content-workspace:${encodeURIComponent(key.workspaceId)}:${encodeURIComponent(key.sessionId)}`
}

function readPersistedState(key: ContentWorkspaceKey): ContentWorkspaceState {
  if (!hasValidKey(key)) return createDefaultContentWorkspaceState()
  try {
    const raw = globalThis.localStorage?.getItem(getContentWorkspaceStorageKey(key))
    return raw ? parsePersistedContentWorkspaceState(JSON.parse(raw)) : createDefaultContentWorkspaceState()
  } catch {
    return createDefaultContentWorkspaceState()
  }
}

function persistState(key: ContentWorkspaceKey, state: ContentWorkspaceState): void {
  if (!hasValidKey(key)) return
  const tabs = state.tabs.filter(tab => tab.type !== 'browser')
  const activeTabId = tabs.some(tab => tab.id === state.activeTabId)
    ? state.activeTabId
    : CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID
  const payload: PersistedContentWorkspaceState = {
    version: CONTENT_WORKSPACE_STATE_VERSION,
    tabs,
    activeTabId,
  }
  try {
    globalThis.localStorage?.setItem(getContentWorkspaceStorageKey(key), JSON.stringify(payload))
  } catch (error) {
    console.warn('[ContentWorkspace] Failed to persist state:', error)
  }
}

export const contentWorkspaceStateAtomFamily = atomFamily(
  (key: ContentWorkspaceKey) => atom<ContentWorkspaceState>(readPersistedState(key)),
  sameKey,
)

export const contentWorkspaceFileNavigationAtomFamily = atomFamily(
  (_key: ContentWorkspaceKey) => atom<ContentWorkspaceFileNavigation | null>(null),
  sameKey,
)

function updateState(
  get: Getter,
  set: Setter,
  key: ContentWorkspaceKey,
  update: (state: ContentWorkspaceState) => ContentWorkspaceState,
): boolean {
  if (!hasValidKey(key)) return false
  const stateAtom = contentWorkspaceStateAtomFamily(key)
  const next = update(get(stateAtom))
  set(stateAtom, next)
  persistState(key, next)
  return true
}

export const setContentWorkspaceActiveTabAtom = atom(
  null,
  (get, set, input: ContentWorkspaceKey & { tabId: string }): boolean => (
    updateState(get, set, input, (state) => (
      state.tabs.some(tab => tab.id === input.tabId)
        ? { ...state, activeTabId: input.tabId }
        : state
    ))
  ),
)

export const openContentWorkspaceFileAtom = atom(
  null,
  (get, set, input: ContentWorkspaceKey & { path: string }): boolean => {
    try {
      const opened = updateState(
        get,
        set,
        input,
        state => openFileInContentWorkspace(state, input.path),
      )
      if (opened) set(contentWorkspaceFileNavigationAtomFamily(input), null)
      return opened
    } catch {
      return false
    }
  },
)

export const showContentWorkspaceReferenceAtom = atom(
  null,
  (
    get,
    set,
    input: ContentWorkspaceKey & { reference: FileReference },
  ): boolean => {
    try {
      const path = normalizeContentWorkspaceRelativePath(input.reference.path)
      const opened = updateState(
        get,
        set,
        input,
        state => openFileInContentWorkspace(state, path),
      )
      if (!opened) return false

      nextNavigationNonce += 1
      set(contentWorkspaceFileNavigationAtomFamily(input), {
        path,
        locator: { ...input.reference.locator },
        nonce: nextNavigationNonce,
      })
      return true
    } catch {
      return false
    }
  },
)

export const openContentWorkspaceBrowserAtom = atom(
  null,
  (
    get,
    set,
    input: ContentWorkspaceKey & { instanceId: string; title?: string },
  ): boolean => {
    try {
      return updateState(
        get,
        set,
        input,
        state => openBrowserInContentWorkspace(state, input),
      )
    } catch {
      return false
    }
  },
)

export const renameContentWorkspaceBrowserAtom = atom(
  null,
  (
    get,
    set,
    input: ContentWorkspaceKey & { instanceId: string; title: string },
  ): boolean => (
    updateState(
      get,
      set,
      input,
      state => renameBrowserInContentWorkspace(state, input.instanceId, input.title),
    )
  ),
)

export const closeContentWorkspaceTabAtom = atom(
  null,
  (get, set, input: ContentWorkspaceKey & { tabId: string }): boolean => {
    const state = get(contentWorkspaceStateAtomFamily(input))
    const closingTab = state.tabs.find(tab => tab.id === input.tabId)
    const closed = updateState(
      get,
      set,
      input,
      current => closeContentWorkspaceTab(current, input.tabId),
    )
    if (closed && closingTab?.type === 'file') {
      const navigationAtom = contentWorkspaceFileNavigationAtomFamily(input)
      if (get(navigationAtom)?.path === closingTab.path) set(navigationAtom, null)
    }
    return closed
  },
)
