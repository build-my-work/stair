/**
 * Preload script for browser toolbar windows.
 *
 * Exposes a minimal API for the React BrowserControls component
 * to send navigation actions and receive state updates from the
 * main process BrowserPaneManager.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  BrowserBookmark,
  ToggleBrowserBookmarkResult,
} from '@craft-agent/shared/browser-bookmarks'

const CHANNELS = {
  NAVIGATE: 'browser-toolbar:navigate',
  GO_BACK: 'browser-toolbar:go-back',
  GO_FORWARD: 'browser-toolbar:go-forward',
  RELOAD: 'browser-toolbar:reload',
  STOP: 'browser-toolbar:stop',
  LIST_BOOKMARKS: 'browser-toolbar:list-bookmarks',
  TOGGLE_BOOKMARK: 'browser-toolbar:toggle-bookmark',
  BOOKMARKS_CHANGED: 'browser-toolbar:bookmarks-changed',
  SHOW_MENU: 'browser-toolbar:show-menu',
  OPEN_TARGET_CHAT: 'browser-toolbar:open-target-chat',
  REQUEST_STATE: 'browser-toolbar:request-state',
  STATE_UPDATE: 'browser-toolbar:state-update',
  THEME_COLOR: 'browser-toolbar:theme-color',
} as const

// Instance ID is passed via query parameter by BrowserPaneManager
const instanceId = new URLSearchParams(location.search).get('instanceId') || ''

contextBridge.exposeInMainWorld('browserToolbar', {
  instanceId,
  navigate: (url: string) => ipcRenderer.invoke(CHANNELS.NAVIGATE, instanceId, url),
  goBack: () => ipcRenderer.invoke(CHANNELS.GO_BACK, instanceId),
  goForward: () => ipcRenderer.invoke(CHANNELS.GO_FORWARD, instanceId),
  reload: () => ipcRenderer.invoke(CHANNELS.RELOAD, instanceId),
  stop: () => ipcRenderer.invoke(CHANNELS.STOP, instanceId),
  listBookmarks: (): Promise<BrowserBookmark[]> =>
    ipcRenderer.invoke(CHANNELS.LIST_BOOKMARKS, instanceId),
  toggleBookmark: (): Promise<ToggleBrowserBookmarkResult> =>
    ipcRenderer.invoke(CHANNELS.TOGGLE_BOOKMARK, instanceId),
  showMenu: (kind: 'bookmarks' | 'projects' | 'chats' | 'window') =>
    ipcRenderer.invoke(CHANNELS.SHOW_MENU, instanceId, kind),
  openTargetChat: () => ipcRenderer.invoke(CHANNELS.OPEN_TARGET_CHAT, instanceId),
  onStateUpdate: (callback: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on(CHANNELS.STATE_UPDATE, handler)
    ipcRenderer.send(CHANNELS.REQUEST_STATE, instanceId)
    return () => { ipcRenderer.removeListener(CHANNELS.STATE_UPDATE, handler) }
  },
  onThemeColor: (callback: (color: string | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, color: string | null) => callback(color)
    ipcRenderer.on(CHANNELS.THEME_COLOR, handler)
    return () => { ipcRenderer.removeListener(CHANNELS.THEME_COLOR, handler) }
  },
  onBookmarksChanged: (callback: (bookmarks: BrowserBookmark[]) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      bookmarks: BrowserBookmark[],
    ) => callback(bookmarks)
    ipcRenderer.on(CHANNELS.BOOKMARKS_CHANGED, handler)
    return () => { ipcRenderer.removeListener(CHANNELS.BOOKMARKS_CHANGED, handler) }
  },
})
