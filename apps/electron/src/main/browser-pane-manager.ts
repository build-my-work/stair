/**
 * BrowserPaneManager
 *
 * Owns independent browser windows. Each instance keeps one native view tree
 * for its entire lifetime; it is never reparented into the application window.
 */

import { join, parse as parsePath } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import {
  BrowserWindow,
  Menu,
  View,
  WebContentsView,
  app,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
  type HandlerDetails,
  type MenuItemConstructorOptions,
  type Session as ElectronSession,
} from 'electron'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'
import { BrowserCDP, type AccessibilitySnapshot, type ElementGeometry } from './browser-cdp'
import {
  SECURITY_CHALLENGE_CONFIRM_DELAY_MS,
  SECURITY_CHALLENGE_PAGE_SCRIPT,
  classifySecurityChallenge,
  countActionableAxNodes,
  noSecurityChallenge,
  type BrowserSecurityChallenge,
  type SecurityChallengeFacts,
} from './security-challenge'
import {
  type BrowserEmptyStateLaunchPayload,
  type BrowserEmptyStateLaunchResult,
  type BrowserInstanceInfo,
  type BrowserPaneReconcileInput,
  type BrowserSelectionRevealResult,
} from '../shared/types'
import type { WebSelectionReferenceV1 } from '@craft-agent/core/types'
import {
  DEFAULT_THEME,
  getAllowRemoteEvaluate,
  getWorkspaces,
  loadAppTheme,
} from '@craft-agent/shared/config'
import {
  loadBrowserBookmarks,
  removeBrowserBookmark,
  toggleBrowserBookmark,
  type BrowserBookmark,
} from '@craft-agent/shared/browser-bookmarks'
import { CodedError } from '@craft-agent/shared/protocol'
import { i18n } from '@craft-agent/shared/i18n'
import { getBrowserLiveFxCornerRadii } from '../shared/browser-live-fx'
import {
  BROWSER_OVERLAY_ACTION_CHANNEL,
  BROWSER_PAGE_SELECTION_CHANNEL,
  buildWebSelectionRevealExpression,
  calculateBrowserSelectionOverlayBounds,
  createBrowserSelectionSource,
  isBrowserSelectionAction,
  sanitizeBrowserSelectionCapture,
  sanitizeWebSelectionReference,
  type BrowserSelectionAction,
  type BrowserSelectionCapturePayload,
  type BrowserSelectionSource,
} from '../shared/browser-selection'
import type {
  IBrowserPaneManager,
  BrowserInstanceSnapshot,
  BrowserClickResult,
} from '@craft-agent/server-core/handlers'
import type {
  BrowserApplicationProjectTarget,
  BrowserCapabilityRequest,
  ScreenshotResultWire,
} from '@craft-agent/server-core/transport'

export type { BrowserInstanceInfo }

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const TOOLBAR_LOAD_MAX_RETRIES = 4
const TOOLBAR_LOAD_RETRY_DELAY_MS = 500
const TOOLBAR_HEIGHT = 48
const MAX_CONSOLE_LOG_ENTRIES = 500
const MAX_NETWORK_LOG_ENTRIES = 500
const MAX_DOWNLOAD_LOG_ENTRIES = 200
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const DEFAULT_WAIT_POLL_MS = 100
const SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS = 3
const SCREENSHOT_RETRY_DELAY_MS = 120
/** How long a capture waits for the page to paint (two animation frames) before calling it stale. */
const SCREENSHOT_FRAME_TIMEOUT_MS = 400
const SCREENSHOT_RESCUE_FRAME_TIMEOUT_MS = 1_000
const STALE_FRAME_WARNING = 'The page did not paint a new frame, so this capture may show an older one.'
const SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS = 1_000
const SCREENSHOT_NETWORK_IDLE_MS = 300
const THEME_COLOR_SIGNAL_PREFIX = '__craft_theme_color__:'
const THEME_COLOR_NULL_SENTINEL = '__NULL__'
const THEME_OBSERVER_MIN_INTERVAL_MS = 120
const EARLY_THEME_EXTRACTION_DELAY_MS = 100
const BROWSER_EMPTY_STATE_PAGE = 'browser-empty-state.html'

const CRAFT_DEEPLINK_SCHEME_PREFIX = `${process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents'}://`

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
const POPUP_WINDOW_FEATURES = new Set([
  'popup',
  'width',
  'height',
  'left',
  'top',
  'screenx',
  'screeny',
])
const RESERVED_WINDOW_NAMES = new Set([
  '_blank',
  '_self',
  '_parent',
  '_top',
])

export type BrowserWindowOpenTarget =
  | 'current-page'
  | 'native-popup'
  | 'deny'

function hasExplicitPopupFeatures(features: string): boolean {
  return features
    .split(',')
    .some((feature) => {
      const [name] = feature.trim().toLowerCase().split('=')
      return POPUP_WINDOW_FEATURES.has(name)
    })
}

export function classifyWindowOpen(
  details: HandlerDetails,
): BrowserWindowOpenTarget {
  if (details.url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) {
    return 'deny'
  }

  let parsed: URL
  try {
    parsed = new URL(details.url)
  } catch {
    return 'deny'
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'deny'
  }

  if (
    details.disposition === 'new-window'
    || details.disposition === 'other'
    || details.postBody
  ) {
    return 'native-popup'
  }

  if (hasExplicitPopupFeatures(details.features ?? '')) {
    return 'native-popup'
  }

  const frameName = (details.frameName ?? '').trim().toLowerCase()
  if (frameName && !RESERVED_WINDOW_NAMES.has(frameName)) {
    return 'native-popup'
  }

  return 'current-page'
}

/** A URL's origin ("null" for opaque ones such as about:blank and file:). */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'null'
  }
}

const SIGN_IN_HOSTS = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|github\.com|auth0\.com|okta\.com|onelogin\.com|amazoncognito\.com|slack\.com)$/i
const SIGN_IN_PATH = /(^|\/)(__\/auth|oauth2?|auth|authorize|login|signin|sign-in|sso)(\/|$)/i

/** Whether a popup URL looks like a sign-in window (an identity provider, or an auth/login path). */
export function isSignInPopupUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return SIGN_IN_HOSTS.test(parsed.hostname) || SIGN_IN_PATH.test(parsed.pathname)
  } catch {
    return false
  }
}

const THEME_COLOR_EXTRACTOR_FN = String.raw`
() => {
  const toHex = (r, g, b) => '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');

  const parseColor = (str) => {
    if (!str) return null;
    str = str.trim();
    const hm = /^#([0-9a-f]{3,8})$/i.exec(str);
    if (hm) {
      const h = hm[1];
      let r, g, b;
      if (h.length === 3) { r = parseInt(h[0]+h[0],16); g = parseInt(h[1]+h[1],16); b = parseInt(h[2]+h[2],16); }
      else if (h.length >= 6) { r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16); }
      else return null;
      return toHex(r, g, b);
    }
    const rm = str.match(/rgba?[\(]\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (rm) return toHex(+rm[1], +rm[2], +rm[3]);
    return null;
  };

  const parseBg = (el) => {
    if (!el) return null;
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return null;
    return parseColor(bg);
  };

  // 1. theme-color meta — respect media attribute for light/dark
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  for (const m of metas) {
    const media = m.getAttribute('media');
    if (media && !window.matchMedia(media).matches) continue;
    const c = parseColor(m.content);
    if (c) return c;
  }

  // 2. Safari-like approach: sample fixed/sticky elements at viewport top-center
  const els = document.elementsFromPoint(window.innerWidth / 2, 4);
  for (const el of els) {
    if (el === document.documentElement || el === document.body) continue;
    const style = getComputedStyle(el);
    const pos = style.position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.8) continue;
    const c = parseBg(el);
    if (c) return c;
  }

  // 3. Fallback: body then html
  return parseBg(document.body) || parseBg(document.documentElement) || null;
}
`

/** IPC channels for the browser toolbar preload */
const TOOLBAR_CHANNELS = {
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
export const BROWSER_PANE_SESSION_PARTITION = 'persist:browser-pane'
const SESSION_PARTITION = BROWSER_PANE_SESSION_PARTITION

interface AgentControlState {
  active: boolean
  sessionId: string
  displayName?: string
  intent?: string
}

interface AgentControlLockState {
  active: boolean
  previousResizable: boolean
}

interface BrowserInstance {
  id: string
  window: BrowserWindow
  rootView: View
  toolbarView: WebContentsView
  pageView: WebContentsView
  /**
   * `pageView.webContents.id`, captured at creation. Lookups and teardown use
   * this copy because reading `webContents` on a destroyed view throws
   * "Object has been destroyed" (OSS #1059).
   */
  pageWebContentsId: number
  nativeOverlayView: WebContentsView
  cdp: BrowserCDP
  currentUrl: string
  title: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  targetSessionId: string | null
  targetChat: BrowserChatTarget | null
  targetRefreshToken: number
  targetSwitchToken: number
  projectRefreshToken: number
  projectSwitchToken: number
  targetMetadataFresh: boolean
  boundSessionId: string | null
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  /** Project scope stamped when the independent Browser window is created. */
  workspaceId: string | null
  projectId: string | null
  projectTitle: string | null
  originWebContentsId: number | null
  isVisible: boolean
  isHiding: boolean
  keepAliveOnWindowClose: boolean
  toolbarReady: boolean
  toolbarMenuOpen: boolean
  toolbarMenu: Menu | null
  toolbarMenuRequestToken: number
  showOnCreate: boolean
  pendingShowOnReady: boolean
  pendingShowToken: number
  lastAction: LastBrowserAction | null
  agentControl: AgentControlState | null
  lockState: AgentControlLockState
  nativeOverlayReady: boolean
  nativeOverlayStateVersion: number
  pendingSelection: {
    requestId: string
    capture: BrowserSelectionCapturePayload
    source: BrowserSelectionSource
  } | null
  selectionActionPending: boolean
  openTargetSessionPending: boolean
  selectionFeedback: {
    kind: 'success' | 'error'
    message: string
  } | null
  selectionFeedbackTimer: ReturnType<typeof setTimeout> | null
  themeColor: string | null
  inPageThemeTimer: ReturnType<typeof setTimeout> | null
  themeObserverToken: string | null
  consoleLogs: BrowserConsoleEntry[]
  networkLogs: BrowserNetworkEntry[]
  downloads: BrowserDownloadEntry[]
  lastLaunchToken: string | null
  /** Background throttling is off: the hidden page keeps painting (agent control, or a capture). */
  rendersWhileHidden: boolean
  /**
   * The page shows (or is loading) the app's own empty-state page, whose requests (the Vite dev
   * server in development) and console output are not the site's and are never logged.
   */
  onInternalPage: boolean
  /** Origin and start time of the main-frame navigation in progress, for scoping logs to one site. */
  pendingNavigation: { origin: string; startedAt: number } | null
  /** Origin of the committed page the console and network logs belong to. */
  logOrigin: string | null
  /** When the navigation to that site started: requests started earlier belong to the previous site. */
  logScopeStartedAt: number
  /** Popups the page opened, or was refused because another window's sign-in was open (newest last). */
  popupEvents: PopupEvent[]
}

interface PopupEvent {
  seq: number
  kind: 'opened' | 'joined'
  url: string
  /** For `joined`: the browser window whose sign-in popup is already open. */
  ownerInstanceId?: string
}

const MAX_POPUP_EVENTS = 20

interface CreateBrowserInstanceOptions {
  show?: boolean
  ownerType?: 'session' | 'manual'
  ownerSessionId?: string
  workspaceId?: string | null
  projectId?: string | null
  targetSessionId?: string | null
  originWebContentsId?: number | null
}

export interface BrowserChatTarget {
  id: string
  title: string
  noteTargetPath: string | null
}

export type BrowserProjectTarget = BrowserApplicationProjectTarget

export type BrowserSelectionActionResult =
  | { cancelled: true }
  | {
      cancelled?: false
      sessionId: string | null
      targetTitle: string | null
      noteTargetPath: string | null
    }

export interface BrowserApplicationService {
  listProjectTargets(scope: {
    workspaceId: string
    originWebContentsId?: number | null
  }): Promise<BrowserProjectTarget[]>
  listChatTargets(scope: {
    workspaceId: string
    projectId: string
    originWebContentsId?: number | null
    includeOwnerSessionId?: string
  }): Promise<BrowserChatTarget[]>
  openChat(target: {
    workspaceId: string
    projectId: string
    sessionId: string
    originWebContentsId?: number | null
  }): Promise<void>
  applySelection(input: {
    requestId: string
    action: BrowserSelectionAction
    workspaceId: string
    projectId: string
    sessionId: string | null
    source: BrowserSelectionSource
    originWebContentsId?: number | null
  }): Promise<BrowserSelectionActionResult>
}

export interface BrowserScreenshotOptions {
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  /** Annotate screenshot with @eN labels on all interactive elements from accessibility tree */
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserConsoleEntry {
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
}

export interface BrowserConsoleOptions {
  level?: 'all' | BrowserConsoleEntry['level']
  limit?: number
}

export interface BrowserScreenshotRegionTarget {
  x?: number
  y?: number
  width?: number
  height?: number
  ref?: string
  selector?: string
  padding?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserNetworkEntry {
  timestamp: number
  method: string
  url: string
  status: number
  resourceType: string
  ok: boolean
}

export interface BrowserNetworkOptions {
  limit?: number
  status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx'
  method?: string
  resourceType?: string
}

export interface BrowserWaitArgs {
  kind: 'selector' | 'text' | 'url' | 'network-idle'
  value?: string
  timeoutMs?: number
  pollMs?: number
  idleMs?: number
}

export interface BrowserWaitResult {
  ok: true
  kind: BrowserWaitArgs['kind']
  elapsedMs: number
  detail: string
}

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadEntry {
  id: string
  timestamp: number
  url: string
  filename: string
  state: 'started' | 'completed' | 'interrupted' | 'cancelled'
  bytesReceived: number
  totalBytes: number
  mimeType: string
  savePath?: string
}

export interface BrowserDownloadOptions {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: {
    mode: 'raw' | 'agent'
    viewport?: {
      width: number
      height: number
      dpr: number
      scrollX: number
      scrollY: number
    }
    targets?: Array<{
      ref: string
      role?: string
      name?: string
      box: { x: number; y: number; width: number; height: number }
      clickPoint: { x: number; y: number }
    }>
    action?: {
      tool: string
      ref?: string
      status: 'succeeded' | 'failed'
      timestamp: number
    }
    annotationPartial?: boolean
    warnings?: string[]
    region?: {
      x: number
      y: number
      width: number
      height: number
    }
    targetMode?: 'coords' | 'ref' | 'selector'
  }
}

interface LastBrowserAction {
  tool: string
  ref?: string
  status: 'succeeded' | 'failed'
  geometry?: ElementGeometry
  timestamp: number
}

export class BrowserPaneManager implements IBrowserPaneManager {
  private instances: Map<string, BrowserInstance> = new Map()
  private destroyingIds: Set<string> = new Set()
  private projectDeletionStates = new Map<string, 'deleting' | 'deleted'>()
  private stateChangeCallback: ((info: BrowserInstanceInfo) => void) | null = null
  private removedCallback: ((id: string) => void) | null = null
  private interactedCallback: ((id: string) => void) | null = null
  private applicationService: BrowserApplicationService | null = null
  private partitionPermissionsInitialized = false
  private partitionObserversInitialized = false
  private inFlightRequestsByWebContentsId = new Map<number, number>()
  /** Requests started by the internal empty-state page; they complete (or abort) unlogged. */
  private internalRequestIds = new Set<number>()
  /** When each in-flight page request started, and the start time behind each logged entry. */
  private requestStartedAt = new Map<number, number>()
  private networkEntryStartedAt = new WeakMap<BrowserNetworkEntry, number>()
  private lastNetworkActivityByWebContentsId = new Map<number, number>()
  private popupWindowsByParentInstanceId = new Map<string, Set<BrowserWindow>>()
  private popupParentByWebContentsId = new Map<number, string>()
  /** Origin of the URL each popup was opened with (e.g. a Firebase auth handler before its redirect). */
  private popupOpenedOriginByWebContentsId = new Map<number, string>()
  private popupEventSeq = 0
  // Popup webContents ids captured at registration: a closed popup's `webContents`
  // getter throws, so cleanup must never read it (OSS #1059).
  private popupWebContentsIdByWindow = new WeakMap<BrowserWindow, number>()
  private windowManager: WindowManager | null = null
  private capabilityRemoteWorkspaceId: string | null = null
  private sessionPathResolver: ((sessionId: string) => string | null) | null = null

  setWindowManager(windowManager: WindowManager): void {
    this.windowManager = windowManager
  }

  setCapabilityRemoteWorkspaceId(workspaceId: string | null): void {
    this.capabilityRemoteWorkspaceId = workspaceId
  }

  setSessionPathResolver(fn: (sessionId: string) => string | null): void {
    this.sessionPathResolver = fn
  }

  setApplicationService(service: BrowserApplicationService): void {
    this.applicationService = service
    for (const instance of this.instances.values()) {
      void this.refreshProjectTarget(instance)
      void this.refreshTargetChat(instance)
    }
  }

  private resolveBookmarkWorkspaceRoot(instance: BrowserInstance): string {
    const workspaces = getWorkspaces()
    const findWorkspace = (workspaceId: string | null) => {
      if (!workspaceId) return undefined
      return workspaces.find(workspace => (
        workspace.id === workspaceId
        || workspace.remoteServer?.remoteWorkspaceId === workspaceId
      ))
    }

    let workspace = findWorkspace(instance.workspaceId)
      ?? findWorkspace(this.resolveLaunchWorkspaceId())
    if (!workspace && workspaces.length === 1) {
      workspace = workspaces[0]
    }
    if (!workspace) {
      throw new Error('BROWSER_BOOKMARKS_NO_WORKSPACE: Browser Workspace is unavailable')
    }

    if (!instance.workspaceId) {
      instance.workspaceId = workspace.id
      this.emitStateChange(instance)
    }
    return workspace.rootPath
  }

  private pushBookmarksForWorkspace(
    sourceInstance: BrowserInstance,
    workspaceRootPath: string,
    bookmarks: BrowserBookmark[],
  ): void {
    if (!sourceInstance.workspaceId) return

    const matchingWorkspaceIds = new Set<string>([sourceInstance.workspaceId])
    for (const workspace of getWorkspaces()) {
      if (workspace.rootPath !== workspaceRootPath) continue
      matchingWorkspaceIds.add(workspace.id)
      if (workspace.remoteServer?.remoteWorkspaceId) {
        matchingWorkspaceIds.add(workspace.remoteServer.remoteWorkspaceId)
      }
    }

    for (const instance of this.instances.values()) {
      if (
        instance.window.isDestroyed()
        || instance.toolbarView.webContents.isDestroyed()
        || !instance.workspaceId
        || !matchingWorkspaceIds.has(instance.workspaceId)
      ) {
        continue
      }
      instance.toolbarView.webContents.send(
        TOOLBAR_CHANNELS.BOOKMARKS_CHANGED,
        bookmarks,
      )
    }
  }

  onStateChange(callback: (info: BrowserInstanceInfo) => void): void {
    this.stateChangeCallback = callback
  }

  onRemoved(callback: (id: string) => void): void {
    this.removedCallback = callback
  }

  onInteracted(callback: (id: string) => void): void {
    this.interactedCallback = callback
  }

  createInstance(id?: string, options?: CreateBrowserInstanceOptions): string {
    const instanceId = id || randomUUID()
    const shouldShow = options?.show ?? false
    const ownerType = options?.ownerType ?? 'manual'
    const ownerSessionId = ownerType === 'session'
      ? (options?.ownerSessionId ?? null)
      : null
    const workspaceId = options?.workspaceId ?? null
    const projectId = options?.projectId ?? null
    const targetSessionId = options?.targetSessionId ?? ownerSessionId
    const originWebContentsId = options?.originWebContentsId ?? null

    if (this.instances.has(instanceId)) {
      throw new Error(`Browser instance already exists: ${instanceId}`)
    }
    if (workspaceId && projectId) {
      const deletionState = this.projectDeletionStates.get(`${workspaceId}\0${projectId}`)
      if (deletionState === 'deleting') {
        throw new Error('Browser Project is being deleted')
      }
      if (deletionState === 'deleted') {
        throw new Error('Browser Project is unavailable')
      }
    }

    const ses = session.fromPartition(SESSION_PARTITION)
    this.setupSessionPermissions(ses)
    this.setupSessionObservers(ses)

    // Match background to current OS theme to prevent black/white flash on open
    const bgColor = nativeTheme.shouldUseDarkColors ? '#2b292e' : '#fafafb'

    const window = new BrowserWindow({
      width: 1200,
      height: 900,
      minWidth: 700,
      minHeight: 500,
      show: false, // Always hidden until toolbar is painted (ready-to-show)
      backgroundColor: bgColor,
      // Fully chromeless — toolbar is rendered in a dedicated WebContentsView
      frame: false,
      webPreferences: {
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    const rootView = new View()
    const toolbarView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'browser-toolbar-preload.cjs'),
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    const pageView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'browser-page-preload.cjs'),
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    const nativeOverlayView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'browser-overlay-preload.cjs'),
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        transparent: true,
      },
    })

    // Set native view backgrounds to match theme so about:blank doesn't flash white
    const toolbarWcWithBg = toolbarView.webContents as typeof toolbarView.webContents & { setBackgroundColor?: (color: string) => void }
    toolbarWcWithBg.setBackgroundColor?.('#00000000')
    const pageWcWithBg = pageView.webContents as typeof pageView.webContents & { setBackgroundColor?: (color: string) => void }
    pageWcWithBg.setBackgroundColor?.(bgColor)
    const overlayWcWithBg = nativeOverlayView.webContents as typeof nativeOverlayView.webContents & { setBackgroundColor?: (color: string) => void }
    overlayWcWithBg.setBackgroundColor?.('#00000000')
    nativeOverlayView.setBackgroundColor('#00000000')

    const cdp = new BrowserCDP(pageView.webContents)

    const instance: BrowserInstance = {
      id: instanceId,
      window,
      rootView,
      toolbarView,
      pageView,
      nativeOverlayView,
      cdp,
      currentUrl: 'about:blank',
      title: 'New Tab',
      favicon: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      targetSessionId,
      targetChat: null,
      targetRefreshToken: 0,
      targetSwitchToken: 0,
      projectRefreshToken: 0,
      projectSwitchToken: 0,
      targetMetadataFresh: false,
      boundSessionId: ownerSessionId,
      ownerType,
      ownerSessionId,
      workspaceId,
      projectId,
      projectTitle: null,
      originWebContentsId,
      isVisible: false,
      isHiding: false,
      keepAliveOnWindowClose: true,
      toolbarReady: false,
      toolbarMenuOpen: false,
      toolbarMenu: null,
      toolbarMenuRequestToken: 0,
      showOnCreate: shouldShow,
      pendingShowOnReady: false,
      pendingShowToken: 0,
      lastAction: null,
      agentControl: null,
      lockState: {
        active: false,
        previousResizable: this.getWindowResizable(window),
      },
      nativeOverlayReady: false,
      nativeOverlayStateVersion: 0,
      pendingSelection: null,
      selectionActionPending: false,
      openTargetSessionPending: false,
      selectionFeedback: null,
      selectionFeedbackTimer: null,
      themeColor: null,
      inPageThemeTimer: null,
      themeObserverToken: null,
      consoleLogs: [],
      networkLogs: [],
      downloads: [],
      lastLaunchToken: null,
      pageWebContentsId: pageView.webContents.id,
      rendersWhileHidden: false,
      onInternalPage: true, // the empty-state page loads first
      pendingNavigation: null,
      logOrigin: null,
      logScopeStartedAt: 0,
      popupEvents: [],
    }

    const defaultUa = pageView.webContents.userAgent || ''
    const sanitizedUa = defaultUa.replace(/\sElectron\/[^\s]+/g, '')
    if (sanitizedUa && sanitizedUa !== defaultUa) {
      pageView.webContents.setUserAgent(sanitizedUa)
    }

    rootView.addChildView(pageView)
    rootView.addChildView(nativeOverlayView)
    rootView.addChildView(toolbarView)
    window.contentView.addChildView(rootView)
    void this.loadNativeOverlayPage(instance)

    this.layoutAllViews(instance)

    this.setupWindowListeners(instance)
    this.instances.set(instanceId, instance)
    void this.refreshProjectTarget(instance)
    void this.refreshTargetChat(instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] toolbar version: v4-react-chromeless`)
    mainLog.info(`[browser-pane] Created instance: ${instanceId} (show=${shouldShow}, ownerType=${ownerType}, ownerSessionId=${ownerSessionId ?? 'none'})`)

    void this.loadToolbarPage(instance)
      .finally(() => {
        // Safety net: if Electron never fires ready-to-show, still unblock focus/show behavior.
        if (!instance.toolbarReady) {
          this.markToolbarReady(instance, 'toolbar-load-finalized')
        }
      })
    void this.loadEmptyStatePage(instance).catch((error) => {
      const errorCode = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : ''
      if (errorCode === 'ERR_ABORTED') {
        mainLog.debug(`[browser-pane] empty-state load superseded id=${instance.id}`)
        return
      }
      mainLog.warn(`[browser-pane] empty-state load failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
      void pageView.webContents.loadURL('about:blank')
    })

    return instanceId
  }

  destroyInstance(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) {
      mainLog.info(`[browser-pane] destroy requested for missing instance id=${id}`)
      return
    }

    const destroyedBefore = instance.window.isDestroyed()
    mainLog.info(`[browser-pane] destroy requested id=${id} destroyedBefore=${destroyedBefore} keepAlive=${instance.keepAliveOnWindowClose}`)

    // Clear pending timers before destroying the window
    if (instance.inPageThemeTimer) {
      clearTimeout(instance.inPageThemeTimer)
      instance.inPageThemeTimer = null
    }
    if (instance.selectionFeedbackTimer) {
      clearTimeout(instance.selectionFeedbackTimer)
      instance.selectionFeedbackTimer = null
    }
    instance.themeObserverToken = null
    instance.pendingShowOnReady = false
    instance.pendingShowToken += 1

    // Clean up in-flight network tracking for this instance's webContents
    const wcId = instance.pageWebContentsId
    this.inFlightRequestsByWebContentsId.delete(wcId)
    this.lastNetworkActivityByWebContentsId.delete(wcId)

    this.runCleanupStep(id, 'closePopupsForParent', () => this.closePopupsForParent(instance.id, 'parent_destroy'))
    this.runCleanupStep(id, 'forceCloseToolbarMenu', () => this.forceCloseToolbarMenu(instance, 'instance-destroy'))
    this.runCleanupStep(id, 'applyAgentControlLock', () => this.applyAgentControlLock(instance, false))
    this.runCleanupStep(id, 'updateNativeOverlayState', () => this.updateNativeOverlayState(instance))
    try {
      if (!instance.window.isDestroyed()) {
        this.destroyingIds.add(id)
        instance.window.destroy()
      }
    } catch (error) {
      mainLog.warn(`[browser-pane] destroy failed id=${id} error=${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // Finalize synchronously in case closed does not fire (or fires later).
      this.finalizeDestroyedInstance(instance, 'destroy')
      mainLog.info(`[browser-pane] destroy completed id=${id} removed=${!this.instances.has(id)}`)
    }
  }

  getInstance(id: string): BrowserInstance | undefined {
    return this.instances.get(id)
  }

  private cleanupDestroyedInstance(instance: BrowserInstance, reason: string): void {
    this.finalizeDestroyedInstance(instance, 'closed')
    mainLog.info(`[browser-pane] cleaned up stale instance ${instance.id}: ${reason}`)
  }

  /**
   * Get an instance that is confirmed alive (window not destroyed).
   * Throws a clear error if the instance is missing or its window was closed.
   * Automatically cleans up stale entries from the instance map.
   */
  private requireAliveInstance(id: string): BrowserInstance {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Browser instance not found: ${id}`)
    if (instance.window.isDestroyed()) {
      this.cleanupDestroyedInstance(instance, `lookup by id ${id}`)
      throw new Error(`Browser window was closed (instance: ${id})`)
    }
    return instance
  }

  async handleEmptyStateLaunchFromRenderer(
    senderWebContentsId: number,
    payload: BrowserEmptyStateLaunchPayload,
  ): Promise<BrowserEmptyStateLaunchResult> {
    const instance = this.findInstanceByPageWebContentsId(senderWebContentsId)
    if (!instance) {
      mainLog.warn(`[browser-pane] empty-state launch ignored: sender not mapped senderWebContentsId=${senderWebContentsId}`)
      return { ok: false, handled: false, reason: 'instance_not_found' }
    }

    const route = payload.route?.trim()
    if (!route) {
      mainLog.warn(`[browser-pane] empty-state launch missing route id=${instance.id}`)
      return { ok: false, handled: false, reason: 'missing_route' }
    }

    const token = payload.token ?? null
    const handled = await this.triggerEmptyStateRouteLaunch(instance, route, token, 'ipc')
    return {
      ok: true,
      handled,
      reason: handled ? undefined : 'duplicate',
    }
  }

  private findInstanceByPageWebContentsId(senderWebContentsId: number): BrowserInstance | undefined {
    for (const instance of this.instances.values()) {
      if (instance.pageWebContentsId === senderWebContentsId) {
        return instance
      }
    }
    return undefined
  }

  private findInstanceByOverlayWebContentsId(senderWebContentsId: number): BrowserInstance | undefined {
    for (const instance of this.instances.values()) {
      if (instance.nativeOverlayView.webContents.id === senderWebContentsId) {
        return instance
      }
    }
    return undefined
  }

  private clearPendingSelection(instance: BrowserInstance): void {
    if (!instance.pendingSelection) return
    instance.pendingSelection = null
    this.updateNativeOverlayState(instance)
  }

  private handleSelectionCapture(
    instance: BrowserInstance,
    value: unknown,
  ): void {
    const capture = sanitizeBrowserSelectionCapture(value)
    if (
      !capture
      || instance.agentControl?.active
      || instance.toolbarMenuOpen
    ) {
      this.clearPendingSelection(instance)
      return
    }

    const source = createBrowserSelectionSource(
      capture,
      instance.currentUrl,
      instance.title,
    )
    if (!source) {
      this.clearPendingSelection(instance)
      return
    }

    instance.pendingSelection = { requestId: randomUUID(), capture, source }
    this.updateNativeOverlayState(instance)
    void this.refreshTargetChat(instance)
  }

  private async handleSelectionAction(
    instance: BrowserInstance,
    action: unknown,
  ): Promise<void> {
    if (!isBrowserSelectionAction(action)) return

    const pendingSelection = instance.pendingSelection
    if (!pendingSelection || instance.selectionActionPending) return
    const targetSessionId = this.getPublicSessionId(instance.targetSessionId)
    if (action === 'add-chat' && !targetSessionId) {
      await this.showChatTargetMenu(instance, { action, pendingSelection })
      return
    }
    instance.toolbarMenuRequestToken += 1
    instance.targetSwitchToken += 1
    this.forceCloseToolbarMenu(instance, 'selection-action')
    instance.selectionActionPending = true
    this.updateNativeOverlayState(instance)
    const isAlive = () => (
      this.instances.get(instance.id) === instance
      && !instance.window.isDestroyed()
    )
    const isNoteAction = action === 'add-note' || action === 'choose-note-target'
    let feedback: NonNullable<BrowserInstance['selectionFeedback']>
    try {
      const workspaceId = instance.workspaceId
      const projectId = instance.projectId
      const sessionId = targetSessionId
      if (!workspaceId || !projectId || !this.applicationService) {
        throw new Error('Browser has no valid Project scope')
      }
      const deletionState = this.projectDeletionStates.get(`${workspaceId}\0${projectId}`)
      if (deletionState === 'deleting') {
        throw new Error('Browser Project is being deleted')
      }
      if (deletionState === 'deleted') {
        throw new Error('Browser Project is unavailable')
      }
      const result = await this.applicationService.applySelection({
        requestId: pendingSelection.requestId,
        action,
        workspaceId,
        projectId,
        sessionId,
        source: pendingSelection.source,
        originWebContentsId: instance.originWebContentsId,
      })
      if (!isAlive()) return
      if (result.cancelled) {
        instance.selectionActionPending = false
        this.updateNativeOverlayState(instance)
        return
      }
      if (action === 'new-chat' && instance.ownerType === 'manual') {
        if (!result.sessionId || !result.targetTitle) {
          throw new Error('Browser New Chat returned no target Chat')
        }
        instance.targetRefreshToken += 1
        instance.targetSwitchToken += 1
        instance.targetSessionId = result.sessionId
        instance.targetChat = {
          id: result.sessionId,
          title: result.targetTitle,
          noteTargetPath: result.noteTargetPath,
        }
        instance.targetMetadataFresh = true
        this.pushToolbarState(instance)
        this.emitStateChange(instance)
      }
      if (isNoteAction && !result.noteTargetPath) {
        throw new Error('Browser Add Note returned no Project note file')
      }
      const noteTargetTitle = result.targetTitle
        ?? (instance.targetChat?.id === result.sessionId ? instance.targetChat.title : null)
      if (
        isNoteAction
        && result.sessionId
        && noteTargetTitle
        && this.getPublicSessionId(instance.targetSessionId) === result.sessionId
      ) {
        instance.targetRefreshToken += 1
        instance.targetChat = {
          id: result.sessionId,
          title: noteTargetTitle,
          noteTargetPath: result.noteTargetPath,
        }
        instance.targetMetadataFresh = true
        this.pushToolbarState(instance)
        this.emitStateChange(instance)
      }
      if (instance.pendingSelection !== pendingSelection) {
        instance.selectionActionPending = false
        this.updateNativeOverlayState(instance)
        return
      }
      this.clearPendingSelection(instance)
      let successMessage = i18n.t('browser.addedToTarget', { target: result.targetTitle })
      if (isNoteAction) {
        successMessage = i18n.t('browser.addedToTarget', { target: result.noteTargetPath })
      } else if (action === 'new-chat') {
        successMessage = i18n.t('browser.createdTarget', { target: result.targetTitle })
      }
      feedback = {
        kind: 'success',
        message: successMessage,
      }
    } catch (error) {
      if (!isAlive()) return
      const message = error instanceof Error ? error.message : String(error)
      mainLog.warn(`[browser-pane] Selection action failed id=${instance.id}: ${message}`)
      feedback = {
        kind: 'error',
        message: i18n.t(isNoteAction ? 'reference.couldNotAddNote' : 'reference.couldNotAdd'),
      }
    } finally {
      if (isNoteAction && isAlive() && instance.isVisible) {
        this.focus(instance.id, { preserveTargetMetadata: true })
      }
    }

    if (!isAlive()) return
    instance.selectionActionPending = false
    this.updateNativeOverlayState(instance)
    if (instance.selectionFeedbackTimer) clearTimeout(instance.selectionFeedbackTimer)
    instance.selectionFeedback = feedback
    this.pushToolbarState(instance)
    instance.selectionFeedbackTimer = setTimeout(() => {
      if (!isAlive()) return
      instance.selectionFeedback = null
      instance.selectionFeedbackTimer = null
      this.pushToolbarState(instance)
    }, 4_000)
    instance.selectionFeedbackTimer.unref?.()
  }

  private resolveLaunchWorkspaceId(): string | null {
    if (!this.windowManager) return null

    const focusedWindow = this.windowManager.getFocusedWindow()
    if (focusedWindow) {
      const focusedWorkspaceId = this.windowManager.getWorkspaceForWindow(focusedWindow.webContents.id)
      if (focusedWorkspaceId) {
        return focusedWorkspaceId
      }
    }

    const managedWindows = this.windowManager.getAllWindows()
    return managedWindows[0]?.workspaceId ?? null
  }

  private buildDeepLinkFromRoute(route: string): string {
    const queryStart = route.indexOf('?')
    const routePath = queryStart >= 0 ? route.slice(0, queryStart) : route
    const routeQuery = queryStart >= 0 ? route.slice(queryStart + 1) : ''
    let normalizedPath = routePath.replace(/^\/+/, '')

    const workspaceId = this.resolveLaunchWorkspaceId()
    if (workspaceId && !normalizedPath.startsWith('workspace/')) {
      normalizedPath = `workspace/${encodeURIComponent(workspaceId)}/${normalizedPath}`
    }

    return `${CRAFT_DEEPLINK_SCHEME_PREFIX}${normalizedPath}${routeQuery ? `?${routeQuery}` : ''}`
  }

  private async triggerEmptyStateRouteLaunch(
    instance: BrowserInstance,
    route: string,
    token: string | null,
    source: 'hash' | 'ipc',
  ): Promise<boolean> {
    const dedupeToken = token ?? route
    if (dedupeToken && instance.lastLaunchToken === dedupeToken) {
      mainLog.info(`[browser-pane] ignoring duplicate empty-state launch id=${instance.id} source=${source} token=${dedupeToken}`)
      return false
    }

    instance.lastLaunchToken = dedupeToken
    const deepLink = this.buildDeepLinkFromRoute(route)
    mainLog.info(`[browser-pane] handling empty-state launch id=${instance.id} source=${source} route=${route} deepLink=${deepLink}`)

    await this.handleDeepLinkUrl(deepLink)
    return true
  }

  listInstances(): BrowserInstanceInfo[] {
    const infos: BrowserInstanceInfo[] = []
    for (const instance of this.instances.values()) {
      if (instance.window.isDestroyed()) {
        this.cleanupDestroyedInstance(instance, 'listInstances')
        continue
      }
      infos.push(this.toInfo(instance))
    }
    return infos
  }

  async listInstancesAsync(): Promise<BrowserInstanceInfo[]> {
    return this.listInstances()
  }

  private requireProjectScope(instance: BrowserInstance): {
    workspaceId: string
    projectId: string
    originWebContentsId: number | null
  } {
    if (!instance.workspaceId || !instance.projectId) {
      throw new Error('Browser window is not associated with a Project')
    }
    return {
      workspaceId: instance.workspaceId,
      projectId: instance.projectId,
      originWebContentsId: instance.originWebContentsId,
    }
  }

  async listChatTargets(id: string): Promise<BrowserChatTarget[]> {
    const instance = this.requireAliveInstance(id)
    if (!this.applicationService) return []
    return this.applicationService.listChatTargets(this.requireProjectScope(instance))
  }

  async listProjectTargets(id: string): Promise<BrowserProjectTarget[]> {
    const instance = this.requireAliveInstance(id)
    if (!this.applicationService || !instance.workspaceId) return []
    return this.applicationService.listProjectTargets({
      workspaceId: instance.workspaceId,
      originWebContentsId: instance.originWebContentsId,
    })
  }

  private async showChatTargetMenu(
    instance: BrowserInstance,
    resume?: {
      action: 'add-chat'
      pendingSelection: NonNullable<BrowserInstance['pendingSelection']>
    },
  ): Promise<void> {
    if (!resume && instance.selectionActionPending) return
    const menuRequestToken = ++instance.toolbarMenuRequestToken
    const workspaceId = instance.workspaceId
    const projectId = instance.projectId
    if (!resume) this.clearPendingSelection(instance)
    const pendingSelection = instance.pendingSelection
    let template: MenuItemConstructorOptions[]
    try {
      const targets = await this.listChatTargets(instance.id)
      const currentTarget = this.getPublicSessionId(instance.targetSessionId)
      if (instance.ownerType === 'session') {
        template = [{
          label: targets.find(target => target.id === currentTarget)?.title
            ?? currentTarget
            ?? i18n.t('browser.noTargetChat'),
          type: 'radio',
          checked: true,
          enabled: false,
        }]
      } else {
        const selectTarget = (sessionId: string | null) => {
          const shouldResume = !!(
            sessionId
            && resume
            && this.instances.get(instance.id) === instance
            && instance.pendingSelection === resume.pendingSelection
            && !instance.selectionActionPending
          )
          if (resume && !shouldResume) return
          const targetChange = this.setTargetSession(instance.id, sessionId)
          if (shouldResume) {
            instance.selectionActionPending = true
            this.updateNativeOverlayState(instance)
          }
          void targetChange
            .then(() => {
              if (!shouldResume || !resume || this.instances.get(instance.id) !== instance) return
              instance.selectionActionPending = false
              if (instance.pendingSelection === resume.pendingSelection) {
                void this.handleSelectionAction(instance, resume.action)
              } else {
                this.updateNativeOverlayState(instance)
              }
            })
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error)
              mainLog.warn(`[browser-pane] failed to change target Chat id=${instance.id}: ${message}`)
              if (!shouldResume || !resume || this.instances.get(instance.id) !== instance) return
              instance.selectionActionPending = false
              this.updateNativeOverlayState(instance)
              if (message === 'Target Chat selection was superseded') return
              if (instance.selectionFeedbackTimer) clearTimeout(instance.selectionFeedbackTimer)
              instance.selectionFeedback = {
                kind: 'error',
                message: i18n.t('reference.couldNotAdd'),
              }
              this.pushToolbarState(instance)
              instance.selectionFeedbackTimer = setTimeout(() => {
                if (this.instances.get(instance.id) !== instance) return
                instance.selectionFeedback = null
                instance.selectionFeedbackTimer = null
                this.pushToolbarState(instance)
              }, 4_000)
              instance.selectionFeedbackTimer.unref?.()
            })
        }
        template = [
          {
            label: i18n.t('browser.noTargetChat'),
            type: 'radio',
            checked: currentTarget === null,
            enabled: !resume,
            click: () => selectTarget(null),
          },
          { type: 'separator' },
          ...targets.map(target => ({
            label: target.title,
            type: 'radio' as const,
            checked: target.id === currentTarget,
            click: () => selectTarget(target.id),
          })),
        ]
      }
    } catch (error) {
      mainLog.warn(`[browser-pane] Chat target menu unavailable id=${instance.id} error=${error instanceof Error ? error.message : String(error)}`)
      template = [{ label: i18n.t('browser.chatTargetsUnavailable'), enabled: false }]
    }

    if (
      this.instances.get(instance.id) !== instance
      || instance.window.isDestroyed()
      || instance.toolbarView.webContents.isDestroyed()
      || instance.toolbarMenuRequestToken !== menuRequestToken
      || instance.workspaceId !== workspaceId
      || instance.projectId !== projectId
      || (resume && instance.pendingSelection !== resume.pendingSelection)
      || (!resume && instance.pendingSelection !== pendingSelection)
    ) return

    this.forceCloseToolbarMenu(instance, 'replace')
    const menu = Menu.buildFromTemplate(template)
    instance.toolbarMenuOpen = true
    instance.toolbarMenu = menu
    menu.popup({
      ...(!instance.window.isDestroyed() ? { window: instance.window } : {}),
      callback: () => {
        if (instance.toolbarMenu !== menu) return
        instance.toolbarMenuOpen = false
        instance.toolbarMenu = null
      },
    })
  }

  private async refreshProjectTarget(instance: BrowserInstance): Promise<void> {
    const refreshToken = ++instance.projectRefreshToken
    const projectId = instance.projectId
    if (!this.applicationService || !instance.workspaceId || !projectId) {
      instance.projectTitle = null
      this.pushToolbarState(instance)
      return
    }

    try {
      const targets = await this.applicationService.listProjectTargets({
        workspaceId: instance.workspaceId,
        originWebContentsId: instance.originWebContentsId,
      })
      if (
        this.instances.get(instance.id) !== instance
        || instance.projectId !== projectId
        || instance.projectRefreshToken !== refreshToken
      ) return
      instance.projectTitle = targets.find(target => target.id === projectId)?.title ?? null
      this.pushToolbarState(instance)
    } catch (error) {
      if (
        this.instances.get(instance.id) !== instance
        || instance.projectRefreshToken !== refreshToken
      ) return
      mainLog.warn(`[browser-pane] Project metadata unavailable id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async setProject(id: string, projectId: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    if (instance.ownerType !== 'manual') {
      throw new Error('Session-created Browser is fixed to its owning Project')
    }
    if (instance.selectionActionPending) {
      throw new Error('Cannot change Project while a selection action is pending')
    }
    if (instance.openTargetSessionPending) {
      throw new Error('Cannot change Project while opening target Chat')
    }
    if (!instance.workspaceId) {
      throw new Error('Browser window is not associated with a Workspace')
    }
    const workspaceId = instance.workspaceId
    const previousProjectId = instance.projectId
    const switchToken = ++instance.projectSwitchToken

    const targets = await this.listProjectTargets(id)

    const current = this.requireAliveInstance(id)
    if (current !== instance) {
      throw new Error('Browser window scope changed while choosing a Project')
    }
    if (current.projectSwitchToken !== switchToken) {
      throw new Error('Project selection was superseded')
    }
    if (
      current.ownerType !== 'manual'
      || current.workspaceId !== workspaceId
      || current.projectId !== previousProjectId
    ) {
      throw new Error('Browser window scope changed while choosing a Project')
    }
    if (instance.selectionActionPending) {
      throw new Error('Cannot change Project while a selection action is pending')
    }
    if (instance.openTargetSessionPending) {
      throw new Error('Cannot change Project while opening target Chat')
    }
    if (
      previousProjectId
      && this.projectDeletionStates.has(`${workspaceId}\0${previousProjectId}`)
    ) {
      throw new Error('Current Project is unavailable')
    }
    if (
      previousProjectId
      && !targets.some(target => target.id === previousProjectId)
    ) {
      this.destroyInstance(instance.id)
      throw new Error('Current Project is unavailable')
    }
    const project = targets.find(target => target.id === projectId)
    if (!project) throw new Error('Target Project is not available in this Workspace')
    if (instance.projectId === project.id) {
      instance.projectRefreshToken += 1
      instance.projectTitle = project.title
      this.pushToolbarState(instance)
      return
    }
    const deletionState = this.projectDeletionStates.get(`${workspaceId}\0${project.id}`)
    if (deletionState) throw new Error('Target Project is unavailable')

    instance.targetRefreshToken += 1
    instance.targetSwitchToken += 1
    instance.projectRefreshToken += 1
    instance.projectId = project.id
    instance.projectTitle = project.title
    instance.targetSessionId = null
    instance.targetChat = null
    instance.targetMetadataFresh = true
    if (instance.selectionFeedbackTimer) clearTimeout(instance.selectionFeedbackTimer)
    instance.selectionFeedback = null
    instance.selectionFeedbackTimer = null
    this.clearPendingSelection(instance)
    this.pushToolbarState(instance)
    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)
  }

  private async refreshTargetChat(instance: BrowserInstance): Promise<void> {
    const refreshToken = ++instance.targetRefreshToken
    const sessionId = this.getPublicSessionId(instance.targetSessionId)
    instance.targetMetadataFresh = false
    if (!this.applicationService || !instance.workspaceId || !instance.projectId) {
      this.pushToolbarState(instance)
      return
    }

    try {
      const targets = await this.applicationService.listChatTargets({
        workspaceId: instance.workspaceId,
        projectId: instance.projectId,
        originWebContentsId: instance.originWebContentsId,
        // An owning Session can be alive without being a selectable Chat.
        ...(instance.ownerType === 'session' && sessionId
          ? { includeOwnerSessionId: sessionId }
          : {}),
      })
      if (
        !this.instances.has(instance.id)
        || instance.targetRefreshToken !== refreshToken
        || this.getPublicSessionId(instance.targetSessionId) !== sessionId
      ) return
      if (!sessionId) {
        instance.targetChat = null
        instance.targetMetadataFresh = true
        this.pushToolbarState(instance)
        return
      }
      const targetChat = targets.find(target => target.id === sessionId) ?? null
      if (!targetChat) {
        if (instance.ownerType === 'session') {
          this.destroyInstance(instance.id)
          return
        }
        instance.targetSessionId = null
        instance.targetChat = null
        instance.targetMetadataFresh = true
        this.pushToolbarState(instance)
        this.updateNativeOverlayState(instance)
        this.emitStateChange(instance)
        return
      }
      instance.targetChat = targetChat
      instance.targetMetadataFresh = true
      this.pushToolbarState(instance)
      this.updateNativeOverlayState(instance)
    } catch (error) {
      if (
        !this.instances.has(instance.id)
        || instance.targetRefreshToken !== refreshToken
        || this.getPublicSessionId(instance.targetSessionId) !== sessionId
      ) return
      if (error instanceof Error && error.message === 'Browser Project is unavailable') {
        this.destroyInstance(instance.id)
        return
      }
      mainLog.warn(`[browser-pane] Target Chat metadata unavailable id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async setTargetSession(id: string, sessionId: string | null): Promise<void> {
    const instance = this.requireAliveInstance(id)
    if (instance.ownerType !== 'manual') {
      throw new Error('Session-created Browser target is fixed to its owning Chat')
    }
    if (instance.selectionActionPending) {
      throw new Error('Cannot change target Chat while a selection action is pending')
    }
    const targetChangeToken = ++instance.targetSwitchToken
    let targetChat: BrowserChatTarget | null = null
    if (sessionId !== null) {
      const workspaceId = instance.workspaceId
      const projectId = instance.projectId
      const targets = await this.listChatTargets(id)
      targetChat = targets.find(target => target.id === sessionId) ?? null
      if (!targetChat) {
        throw new Error('Target Chat is not available in this Project')
      }
      const current = this.requireAliveInstance(id)
      if (
        current !== instance
        || current.ownerType !== 'manual'
        || current.workspaceId !== workspaceId
        || current.projectId !== projectId
      ) {
        throw new Error('Browser window scope changed while choosing a target Chat')
      }
      if (current.targetSwitchToken !== targetChangeToken) {
        throw new Error('Target Chat selection was superseded')
      }
    }
    instance.targetRefreshToken += 1
    instance.targetSessionId = sessionId
    instance.targetChat = targetChat
    instance.targetMetadataFresh = true
    this.pushToolbarState(instance)
    this.emitStateChange(instance)
  }

  async openTargetSession(id: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    if (instance.openTargetSessionPending) {
      throw new Error('Target Chat is already opening')
    }
    const sessionId = this.getPublicSessionId(instance.targetSessionId)
    if (!sessionId || !this.applicationService) {
      throw new Error('Browser window has no target Chat')
    }
    instance.openTargetSessionPending = true
    try {
      await this.applicationService.openChat({
        ...this.requireProjectScope(instance),
        sessionId,
      })
    } finally {
      if (this.instances.get(instance.id) === instance) {
        instance.openTargetSessionPending = false
      }
    }
  }

  async getInstanceAsync(id: string): Promise<BrowserInstanceSnapshot | undefined> {
    return this.getInstance(id)
  }

  async createForSessionAsync(
    sessionId: string,
    options?: { show?: boolean; workspaceId?: string | null; projectId?: string | null },
  ): Promise<string> {
    return this.createForSession(sessionId, options)
  }

  async getOrCreateForSessionAsync(
    sessionId: string,
    options?: { workspaceId?: string | null; projectId?: string | null },
  ): Promise<string> {
    return this.getOrCreateForSession(sessionId, options)
  }

  async focusBoundForSessionAsync(
    sessionId: string,
    options?: { workspaceId?: string | null; projectId?: string | null },
  ): Promise<string> {
    return this.focusBoundForSession(sessionId, options)
  }

  getWindowCount(): number {
    return this.instances.size
  }

  getBrowserWindows(): BrowserWindow[] {
    return Array.from(this.instances.values())
      .map((instance) => instance.window)
      .filter((win) => !win.isDestroyed())
  }

  async navigate(id: string, url: string): Promise<{ url: string; title: string }> {
    const instance = this.requireAliveInstance(id)
    this.clearPendingSelection(instance)

    let normalizedUrl = url.trim()
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedUrl)
    const isAbout = normalizedUrl.startsWith('about:')
    if (!hasScheme && !isAbout) {
      const looksLikeHost = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i.test(normalizedUrl)
      if (looksLikeHost) {
        normalizedUrl = `https://${normalizedUrl}`
      } else {
        normalizedUrl = `https://duckduckgo.com/?q=${encodeURIComponent(normalizedUrl)}`
      }
    }

    const timeoutMs = 30_000
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    try {
      const loaded = instance.pageView.webContents.loadURL(normalizedUrl)
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Navigation to "${normalizedUrl}" timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      })
      await Promise.race([loaded, timeout])
      this.pushToolbarState(instance)

      return { url: instance.currentUrl, title: instance.title }
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }
  }

  async revealSelection(
    value: WebSelectionReferenceV1,
    options?: { workspaceId?: string | null; browserId?: string },
  ): Promise<BrowserSelectionRevealResult> {
    if (!options?.workspaceId) {
      throw new Error('Browser selection reveal requires an owning Workspace')
    }
    const reference = sanitizeWebSelectionReference(value)
    if (!reference) {
      return { ok: false, reason: 'invalid_reference' }
    }

    let instance = options?.browserId
      ? this.requireAliveInstance(options.browserId)
      : undefined
    if (
      instance?.workspaceId
      && options?.workspaceId
      && instance.workspaceId !== options.workspaceId
    ) {
      throw new Error('Browser instance belongs to a different workspace')
    }
    if (instance?.projectId && instance.projectId !== reference.projectId) {
      throw new Error('Browser instance belongs to a different project')
    }

    const created = instance === undefined
    if (!instance) {
      const browserId = this.createInstance(undefined, {
        show: false,
        ownerType: 'manual',
        workspaceId: options.workspaceId,
        projectId: reference.projectId,
      })
      instance = this.requireAliveInstance(browserId)
    }

    try {
      if (instance.currentUrl !== reference.url) {
        await this.navigate(instance.id, reference.url)
      }
    } catch (error) {
      mainLog.warn(
        `[browser-pane] failed to navigate while revealing selection id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
      if (created) this.destroyInstance(instance.id)
      return {
        ok: false,
        found: false,
        reason: 'navigation_failed',
      }
    }

    let found = false
    try {
      found = await instance.pageView.webContents.executeJavaScript(
        buildWebSelectionRevealExpression(reference),
      ) === true
    } catch (error) {
      mainLog.warn(
        `[browser-pane] failed to reveal selection id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (!found) {
      this.focus(instance.id)
      return {
        ok: true,
        browserId: instance.id,
        created,
        found: false,
        reason: 'selection_not_found',
      }
    }
    this.focus(instance.id)
    return {
      ok: true,
      browserId: instance.id,
      created,
      found: true,
    }
  }

  async goBack(id: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    if (instance.pageView.webContents.canGoBack()) {
      this.clearPendingSelection(instance)
      instance.pageView.webContents.goBack()
    }
  }

  async goForward(id: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    if (instance.pageView.webContents.canGoForward()) {
      this.clearPendingSelection(instance)
      instance.pageView.webContents.goForward()
    }
  }

  reload(id: string): void {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return
    this.clearPendingSelection(instance)
    instance.pageView.webContents.reload()
  }

  stop(id: string): void {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return
    instance.pageView.webContents.stop()
  }

  focus(id: string, options?: { preserveTargetMetadata?: boolean }): void {
    const instance = this.instances.get(id)
    if (!instance) return

    const win = instance.window
    if (win.isDestroyed()) return
    if (!options?.preserveTargetMetadata) {
      void this.refreshProjectTarget(instance)
      void this.refreshTargetChat(instance)
    }

    // If toolbar hasn't painted yet, defer showing until markToolbarReady runs.
    // Token guard prevents stale deferred focus from showing after hide/destroy.
    if (!instance.toolbarReady) {
      if (instance.pendingShowOnReady) return
      instance.pendingShowOnReady = true
      const token = ++instance.pendingShowToken
      mainLog.info(`[browser-pane] focus deferred until ready id=${instance.id} token=${token}`)
      return
    }

    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()

    instance.isVisible = true
    this.emitStateChange(instance)
  }

  hide(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) return
    this.clearPendingSelection(instance)

    // Re-entrancy guard: bail if a hide is already in progress. Prevents the
    // 'close' listener from re-entering hide() during teardown, which can crash
    // Chromium's compositor when the native page view is mid-load.
    if (instance.isHiding) return

    const win = instance.window
    if (win.isDestroyed()) return

    instance.isHiding = true
    instance.targetRefreshToken += 1
    instance.targetMetadataFresh = false
    instance.toolbarMenuRequestToken += 1

    // Cancel any deferred show request queued before toolbar was ready.
    if (instance.pendingShowOnReady) {
      instance.pendingShowOnReady = false
      instance.pendingShowToken += 1
    }

    this.forceCloseToolbarMenu(instance, 'window-hide')

    // Cancel an in-flight page load before hiding. Hiding the window while the
    // native page view is still loading can trigger a Chromium compositor assertion
    // and kill the main process.
    if (instance.isLoading) {
      try {
        const pageWc = instance.pageView.webContents
        if (!pageWc.isDestroyed()) pageWc.stop()
      } catch (error) {
        mainLog.warn(`[browser-pane] failed to stop page load before hide id=${id}: ${(error as Error)?.message ?? error}`)
      }
    }

    win.hide()

    instance.isVisible = false

    // Defer the state-change callback so native window teardown completes before
    // listeners (which may touch native view/Chromium internals) run.
    queueMicrotask(() => {
      instance.isHiding = false
      this.emitStateChange(instance)
    })
  }

  async getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot> {
    const instance = this.requireAliveInstance(id)
    return instance.cdp.getAccessibilitySnapshot()
  }

  async clickAtCoordinates(id: string, x: number, y: number): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await instance.cdp.clickAtCoordinates(x, y)
      instance.lastAction = {
        tool: 'browser_click_at',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_click_at',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await instance.cdp.drag(x1, y1, x2, y2)
      instance.lastAction = {
        tool: 'browser_drag',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_drag',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async typeText(id: string, text: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await instance.cdp.typeText(text)
      instance.lastAction = {
        tool: 'browser_type',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_type',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async setClipboard(id: string, text: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    await instance.cdp.setClipboard(text)
  }

  async getClipboard(id: string): Promise<string> {
    const instance = this.requireAliveInstance(id)
    return instance.cdp.getClipboard()
  }

  async clickElement(
    id: string,
    ref: string,
    options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }
  ): Promise<BrowserClickResult> {
    const instance = this.requireAliveInstance(id)
    // window.open runs inside the click handler, so popups it opens (or that were refused) are recorded by the time the click returns.
    const popupMark = this.popupEventSeq
    const waitFor = options?.waitFor ?? 'none'
    let navigationObserved = false
    let resolveNavigation: (() => void) | undefined
    let navigationTimer: ReturnType<typeof setTimeout> | undefined
    const onNavigation = () => {
      navigationObserved = true
      resolveNavigation?.()
    }
    if (waitFor === 'navigation') {
      instance.pageView.webContents.once('did-navigate', onNavigation)
      instance.pageView.webContents.once('did-navigate-in-page', onNavigation)
    }

    try {
      const { via, note, point: _point, ...geometry } = await instance.cdp.clickElement(ref)
      instance.lastAction = {
        tool: 'browser_click',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }

      if (waitFor === 'navigation' && !navigationObserved) {
        const timeoutMs = Math.max(100, options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
        await new Promise<void>((resolve, reject) => {
          resolveNavigation = resolve
          navigationTimer = setTimeout(() => reject(new Error(
            `Click navigation wait timed out after ${timeoutMs}ms (no navigation event observed). `
            + `Tip: retry with "click ${ref}" (no navigation wait), then use "wait url <pattern>" or "wait network-idle".`
          )), timeoutMs)
        })
      } else if (waitFor === 'network-idle') {
        await this.waitFor(id, { kind: 'network-idle', timeoutMs: options?.timeoutMs })
      }
      const popup = this.describePopupEvents(instance, popupMark)
      return { via, ...(note ? { note } : {}), ...(popup ? { popup } : {}) }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_click',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    } finally {
      if (navigationTimer) clearTimeout(navigationTimer)
      if (waitFor === 'navigation') {
        instance.pageView.webContents.removeListener('did-navigate', onNavigation)
        instance.pageView.webContents.removeListener('did-navigate-in-page', onNavigation)
      }
    }
  }

  async fillElement(id: string, ref: string, value: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const geometry = await instance.cdp.fillElement(ref, value)
      instance.lastAction = {
        tool: 'browser_fill',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_fill',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async selectOption(id: string, ref: string, value: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const geometry = await instance.cdp.selectOption(ref, value)
      instance.lastAction = {
        tool: 'browser_select',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_select',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  private suspendOverlayForCapture(instance: BrowserInstance): boolean {
    const shouldSuspend = !!instance.agentControl?.active
      && instance.nativeOverlayReady

    if (!shouldSuspend) return false

    instance.nativeOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    return true
  }

  private restoreOverlayAfterCapture(instance: BrowserInstance, suspended: boolean): void {
    if (!suspended) return
    this.updateNativeOverlayState(instance)
  }

  async screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    const instance = this.requireAliveInstance(id)

    // Hide native agent overlay so it doesn't appear in captures
    const suspendedOverlay = this.suspendOverlayForCapture(instance)

    try {
      // When annotating, force agent mode and gather refs from accessibility tree
      const annotate = !!options?.annotate
      const mode = (annotate || options?.mode === 'agent') ? 'agent' : 'raw'

      if (mode === 'raw') {
        const viewport = await instance.cdp.getViewportMetrics()
        const captured = await this.capturePageWithRecovery(instance, {
          mode,
          errorPrefix: 'screenshot',
          dpr: viewport.dpr,
          format: options?.format,
          jpegQuality: options?.jpegQuality,
        })

        // Warnings (a stale frame, a reveal) always reach the agent, metadata or not.
        return {
          imageBuffer: captured.imageBuffer,
          imageFormat: captured.imageFormat,
          metadata: options?.includeMetadata || captured.warnings.length > 0
            ? {
              mode: 'raw',
              warnings: captured.warnings.length > 0 ? captured.warnings : undefined,
            }
            : undefined,
        }
      }

      const warnings: string[] = []
      const geometries: ElementGeometry[] = []

      const MAX_ANNOTATED_REFS = 100
      let refs = options?.refs ?? []

      if (annotate) {
        try {
          const snapshot = await instance.cdp.getAccessibilitySnapshot()
          refs = snapshot.nodes.map((node) => node.ref)
        } catch (error) {
          warnings.push(`Accessibility snapshot for annotation failed: ${error instanceof Error ? error.message : String(error)}`)
          refs = []
        }
      }

      const settled = await Promise.allSettled(
        refs.map((ref) => instance.cdp.getElementGeometry(ref)),
      )

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]!
        if (result.status === 'fulfilled') {
          geometries.push(result.value)
        } else if (!annotate) {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
          warnings.push(`Could not resolve ref ${refs[i]}: ${reason}`)
        }
      }

      if (annotate) {
        // The snapshot lists the whole page in document order; label what the image shows.
        const viewport = await instance.cdp.getViewportMetrics()
        const onScreen = geometries.filter(({ box }) => box.width > 0 && box.height > 0
          && box.x < viewport.width && box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0)
        if (onScreen.length > MAX_ANNOTATED_REFS) {
          warnings.push(`Annotation capped at ${MAX_ANNOTATED_REFS} of ${onScreen.length} on-screen elements`)
        }
        geometries.splice(0, geometries.length, ...onScreen.slice(0, MAX_ANNOTATED_REFS))
      }

      if (options?.includeLastAction && instance.lastAction?.geometry) {
        geometries.push(instance.lastAction.geometry)
      }

      const metadataText = instance.lastAction
        ? `${instance.lastAction.tool} • ${instance.lastAction.status} • ${new Date(instance.lastAction.timestamp).toISOString()}`
        : `browser_screenshot • ${new Date().toISOString()}`

      let annotationPartial = false

      try {
        if (geometries.length > 0 || options?.includeMetadata) {
          await instance.cdp.renderTemporaryOverlay({
            geometries,
            includeMetadata: !!options?.includeMetadata,
            metadataText,
            includeClickPoints: true,
          })
        }
      } catch (error) {
        annotationPartial = true
        warnings.push(`Annotation overlay failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      try {
        const viewport = await instance.cdp.getViewportMetrics()
        const captured = await this.capturePageWithRecovery(instance, {
          mode,
          errorPrefix: 'screenshot',
          dpr: viewport.dpr,
          format: options?.format,
          jpegQuality: options?.jpegQuality,
        })

        if (captured.warnings.length > 0) {
          warnings.push(...captured.warnings)
        }

        return {
          imageBuffer: captured.imageBuffer,
          imageFormat: captured.imageFormat,
          metadata: {
            mode: 'agent',
            viewport,
            targets: geometries.map((g) => ({
              ref: g.ref,
              role: g.role,
              name: g.name,
              box: g.box,
              clickPoint: g.clickPoint,
            })),
            action: instance.lastAction
              ? {
                tool: instance.lastAction.tool,
                ref: instance.lastAction.ref,
                status: instance.lastAction.status,
                timestamp: instance.lastAction.timestamp,
              }
              : undefined,
            annotationPartial,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
        }
      } finally {
        try {
          await instance.cdp.clearTemporaryOverlay()
        } catch {
          // ignore cleanup errors
        }
      }
    } finally {
      this.restoreOverlayAfterCapture(instance, suspendedOverlay)
    }
  }

  async screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Browser instance not found: ${id}`)

    const hasCoords = [target.x, target.y, target.width, target.height].every((v) => typeof v === 'number')
    const hasRef = typeof target.ref === 'string' && target.ref.length > 0
    const hasSelector = typeof target.selector === 'string' && target.selector.length > 0

    const modeCount = [hasCoords, hasRef, hasSelector].filter(Boolean).length
    if (modeCount === 0) {
      throw new Error('Region screenshot requires either coordinates, ref, or selector')
    }
    if (modeCount > 1) {
      throw new Error('Region screenshot target is ambiguous. Provide only one of coordinates, ref, or selector')
    }

    const suspendedOverlay = this.suspendOverlayForCapture(instance)

    try {
      let box: { x: number; y: number; width: number; height: number }

      if (hasRef) {
        const geometry = await instance.cdp.getElementGeometry(String(target.ref))
        box = { ...geometry.box }
      } else if (hasSelector) {
        const geometry = await instance.cdp.getElementGeometryBySelector(String(target.selector))
        box = { ...geometry.box }
      } else {
        box = {
          x: Number(target.x),
          y: Number(target.y),
          width: Number(target.width),
          height: Number(target.height),
        }
      }

      const padding = Math.max(0, Number(target.padding ?? 0))
      box = {
        x: box.x - padding,
        y: box.y - padding,
        width: box.width + padding * 2,
        height: box.height + padding * 2,
      }

      const viewport = await instance.cdp.getViewportMetrics()

      const clippedX = Math.max(0, Math.floor(box.x))
      const clippedY = Math.max(0, Math.floor(box.y))
      const maxWidth = Math.max(0, Math.floor(viewport.width - clippedX))
      const maxHeight = Math.max(0, Math.floor(viewport.height - clippedY))
      const clippedWidth = Math.min(Math.max(1, Math.floor(box.width)), maxWidth)
      const clippedHeight = Math.min(Math.max(1, Math.floor(box.height)), maxHeight)

      if (maxWidth <= 0 || maxHeight <= 0 || clippedWidth <= 0 || clippedHeight <= 0) {
        throw new Error('Resolved screenshot region is outside the current viewport')
      }

      const captured = await this.capturePageWithRecovery(instance, {
        mode: 'region',
        errorPrefix: 'region screenshot',
        rect: {
          x: clippedX,
          y: clippedY,
          width: clippedWidth,
          height: clippedHeight,
        },
        dpr: viewport.dpr,
        format: target.format,
        jpegQuality: target.jpegQuality,
      })

      return {
        imageBuffer: captured.imageBuffer,
        imageFormat: captured.imageFormat,
        metadata: {
          mode: 'raw',
          viewport,
          region: {
            x: clippedX,
            y: clippedY,
            width: clippedWidth,
            height: clippedHeight,
          },
          targetMode: hasRef ? 'ref' : hasSelector ? 'selector' : 'coords',
          warnings: captured.warnings.length > 0 ? captured.warnings : undefined,
        },
      }
    } finally {
      this.restoreOverlayAfterCapture(instance, suspendedOverlay)
    }
  }

  private async capturePageWithRecovery(
    instance: BrowserInstance,
    options: {
      mode: 'raw' | 'agent' | 'region'
      errorPrefix: 'screenshot' | 'region screenshot'
      rect?: { x: number; y: number; width: number; height: number }
      dpr?: number
      format?: 'png' | 'jpeg'
      jpegQuality?: number
    },
  ): Promise<{ imageBuffer: Buffer; imageFormat: 'png' | 'jpeg'; warnings: string[] }> {
    // A hidden page stops painting. Captured while its surface lingers, it gave its last frame,
    // which agents took for the current page (found 2026-10-11); later the surface is gone and
    // capturePage fails. Unthrottled it keeps painting while it can; hidden captures are used only
    // once it has painted, otherwise the window is shown invisibly for the capture.
    const unthrottledForCapture = !instance.rendersWhileHidden
    if (unthrottledForCapture) this.setRendersWhileHidden(instance, true)
    try {
      return await this.capturePageWhenPainted(instance, options)
    } finally {
      if (unthrottledForCapture && !instance.agentControl?.active) this.setRendersWhileHidden(instance, false)
    }
  }

  private async capturePageWhenPainted(
    instance: BrowserInstance,
    options: {
      mode: 'raw' | 'agent' | 'region'
      errorPrefix: 'screenshot' | 'region screenshot'
      rect?: { x: number; y: number; width: number; height: number }
      dpr?: number
      format?: 'png' | 'jpeg'
      jpegQuality?: number
    },
  ): Promise<{ imageBuffer: Buffer; imageFormat: 'png' | 'jpeg'; warnings: string[] }> {
    let rescueUsed = false
    let sawDisplaySurfaceUnavailable = false
    const warnings: string[] = []
    const imageOpts = { dpr: options.dpr, format: options.format, jpegQuality: options.jpegQuality }

    const painting = await this.pageIsPainting(instance, SCREENSHOT_FRAME_TIMEOUT_MS)
    if (!painting) {
      mainLog.warn(`[browser-pane] ${options.errorPrefix} page not painting instance=${instance.id} visible=${instance.isVisible} url=${instance.currentUrl}`)
    }

    for (let attempt = 1; painting && attempt <= SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS; attempt += 1) {
      let result: { buffer: Buffer; format: 'png' | 'jpeg' } | null = null
      try {
        result = await this.capturePageImage(instance, {
          rect: options.rect,
          useHiddenCaptureOptions: true,
          ...imageOpts,
        })
      } catch (error) {
        if (this.isDisplaySurfaceUnavailableError(error)) {
          sawDisplaySurfaceUnavailable = true
          mainLog.warn(
            `[browser-pane] ${options.errorPrefix} display surface unavailable instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS} visible=${instance.isVisible} url=${instance.currentUrl}`,
          )
        } else {
          throw error
        }
      }

      if (result) {
        if (attempt > 1) {
          warnings.push(`Capture recovered after ${attempt} hidden attempt${attempt === 1 ? '' : 's'}.`)
        }
        return { imageBuffer: result.buffer, imageFormat: result.format, warnings }
      }

      mainLog.warn(
        `[browser-pane] ${options.errorPrefix} empty capture attempt instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS} visible=${instance.isVisible} isLoading=${instance.isLoading} url=${instance.currentUrl}`,
      )

      if (attempt < SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS) {
        await this.waitForScreenshotReadiness(instance.id)
      }
    }

    const window = instance.window
    const wasVisible = instance.isVisible

    if (!window.isDestroyed()) {
      let undoReveal: (() => void) | null = null
      try {
        if (!wasVisible) {
          if (window.isMinimized()) {
            window.restore()
          }
          // A hidden page has no surface to copy, so it must be on screen for a moment.
          undoReveal = this.revealInvisiblyForCapture(window)
          instance.isVisible = true
          this.emitStateChange(instance)
          rescueUsed = true
          await this.waitForScreenshotReadiness(instance.id)
        }
        // Covered by other windows the page may still not paint: say so rather than pass an old frame off as current.
        const paintedForRescue = await this.pageIsPainting(instance, SCREENSHOT_RESCUE_FRAME_TIMEOUT_MS)

        let rescueResult: { buffer: Buffer; format: 'png' | 'jpeg' } | null = null
        try {
          rescueResult = await this.capturePageImage(instance, {
            rect: options.rect,
            useHiddenCaptureOptions: false,
            ...imageOpts,
          })
        } catch (error) {
          if (this.isDisplaySurfaceUnavailableError(error)) {
            sawDisplaySurfaceUnavailable = true
            mainLog.warn(
              `[browser-pane] ${options.errorPrefix} display surface unavailable during rescue instance=${instance.id} mode=${options.mode} visible=${instance.isVisible} url=${instance.currentUrl}`,
            )
          } else {
            throw error
          }
        }

        if (rescueResult) {
          if (rescueUsed) {
            warnings.push('The hidden window was shown invisibly for a moment to render this capture.')
          }
          if (!paintedForRescue) warnings.push(STALE_FRAME_WARNING)
          return { imageBuffer: rescueResult.buffer, imageFormat: rescueResult.format, warnings }
        }
      } finally {
        if (!wasVisible && !window.isDestroyed()) {
          if (undoReveal) undoReveal()
          else window.hide()
          instance.isVisible = false
          this.emitStateChange(instance)
        }
      }
    }

    mainLog.warn(
      `[browser-pane] ${options.errorPrefix} capture failed after recovery instance=${instance.id} mode=${options.mode} visible=${instance.isVisible} isLoading=${instance.isLoading} url=${instance.currentUrl} rescueUsed=${rescueUsed}`,
    )

    if (sawDisplaySurfaceUnavailable) {
      throw new Error(
        `Failed to capture ${options.errorPrefix}: current display surface is unavailable. `
        + `Try focusing the browser window first ("focus ${instance.id}" or "open --foreground") and retry.`
      )
    }

    throw new Error(`Failed to capture ${options.errorPrefix}: empty image buffer`)
  }

  /**
   * Show a hidden window for a capture without the user seeing it, click-through either way.
   * macOS and Windows: transparent and floating above other apps' windows (a plain showInactive
   * left it behind the frontmost app, and covered windows are not painted). Linux has no window
   * opacity, so the window is parked beyond every display instead (no taskbar entry); Wayland
   * ignores positions, so there it still shows briefly. Returns the undo, which hides it again.
   */
  private revealInvisiblyForCapture(window: BrowserWindow): () => void {
    window.setIgnoreMouseEvents(true)
    if (process.platform === 'linux') {
      const bounds = window.getBounds()
      const beyondDisplays = Math.max(...screen.getAllDisplays().map(({ bounds: display }) => display.x + display.width)) + 100
      window.setSkipTaskbar(true)
      window.setPosition(beyondDisplays, bounds.y)
      window.showInactive()
      return () => {
        window.hide()
        window.setBounds(bounds)
        window.setSkipTaskbar(false)
        window.setIgnoreMouseEvents(false)
      }
    }
    const opacity = window.getOpacity()
    window.setOpacity(0)
    window.setAlwaysOnTop(true, 'floating')
    window.showInactive()
    return () => {
      window.hide()
      window.setAlwaysOnTop(false)
      window.setIgnoreMouseEvents(false)
      window.setOpacity(opacity)
    }
  }

  /**
   * Whether the page renders frames right now: two animation frames within the timeout. A page
   * that isn't painting would be captured from its last composited frame.
   */
  private async pageIsPainting(instance: BrowserInstance, timeoutMs: number): Promise<boolean> {
    const webContents = instance.pageView.webContents
    if (webContents.isDestroyed()) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const painted = await Promise.race([
        webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
      ])
      return painted === true
    } catch {
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Turn background throttling off (or back on) for the page. Off, a window that was just hidden or
   * is covered keeps drawing frames, and timers and animations run at full speed: wanted while an
   * agent drives the page, not for idle windows.
   */
  private setRendersWhileHidden(instance: BrowserInstance, renders: boolean): void {
    if (instance.rendersWhileHidden === renders) return
    const webContents = instance.pageView.webContents
    if (webContents.isDestroyed()) return
    webContents.setBackgroundThrottling(!renders)
    instance.rendersWhileHidden = renders
  }

  private isDisplaySurfaceUnavailableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.message.toLowerCase().includes('current display surface not available for capture')
  }

  private async capturePageImage(
    instance: BrowserInstance,
    options: {
      rect?: { x: number; y: number; width: number; height: number }
      useHiddenCaptureOptions: boolean
      dpr?: number
      format?: 'png' | 'jpeg'
      jpegQuality?: number
    },
  ): Promise<{ buffer: Buffer; format: 'png' | 'jpeg' } | null> {
    const captureOpts = options.useHiddenCaptureOptions
      ? { stayHidden: true, stayAwake: true }
      : undefined

    let image = options.rect
      ? await instance.pageView.webContents.capturePage(options.rect, captureOpts)
      : await instance.pageView.webContents.capturePage(undefined, captureOpts)

    if (image.isEmpty()) {
      return null
    }

    // Downscale from device pixels to CSS pixels so screenshot coordinates
    // match click-at viewport coordinates (uses Skia Lanczos via 'best')
    const dpr = options.dpr ?? 1
    if (dpr > 1) {
      const size = image.getSize()
      image = image.resize({
        width: Math.round(size.width / dpr),
        height: Math.round(size.height / dpr),
        quality: 'best',
      })
    }

    const fmt = options.format ?? 'png'
    const encoded = fmt === 'jpeg'
      ? image.toJPEG(options.jpegQuality ?? 80)
      : image.toPNG()

    if (!encoded || encoded.length === 0) {
      return null
    }

    return { buffer: encoded, format: fmt }
  }

  private async waitForScreenshotReadiness(instanceId: string): Promise<void> {
    try {
      await this.waitFor(instanceId, {
        kind: 'network-idle',
        timeoutMs: SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS,
        idleMs: SCREENSHOT_NETWORK_IDLE_MS,
      })
    } catch {
      // network-idle can fail on continuously active pages; still proceed after bounded delay
    }

    await this.sleep(SCREENSHOT_RETRY_DELAY_MS)
  }

  getConsoleLogs(id: string, options?: BrowserConsoleOptions): BrowserConsoleEntry[] {
    const instance = this.requireAliveInstance(id)

    const level = options?.level ?? 'all'
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)))

    const filtered = level === 'all'
      ? instance.consoleLogs
      : instance.consoleLogs.filter((entry) => entry.level === level)

    return filtered.slice(-limit)
  }

  getNetworkLogs(id: string, options?: BrowserNetworkOptions): BrowserNetworkEntry[] {
    const instance = this.requireAliveInstance(id)

    const statusFilter = options?.status ?? 'all'
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)))
    const method = options?.method?.toUpperCase()
    const resourceType = options?.resourceType?.toLowerCase()

    const filtered = instance.networkLogs.filter((entry) => {
      if (method && entry.method !== method) return false
      if (resourceType && entry.resourceType.toLowerCase() !== resourceType) return false

      if (statusFilter === 'all') return true
      if (statusFilter === 'failed') return !entry.ok
      if (statusFilter === '2xx') return entry.status >= 200 && entry.status < 300
      if (statusFilter === '3xx') return entry.status >= 300 && entry.status < 400
      if (statusFilter === '4xx') return entry.status >= 400 && entry.status < 500
      if (statusFilter === '5xx') return entry.status >= 500 && entry.status < 600
      return true
    })

    return filtered.slice(-limit)
  }

  async waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult> {
    const instance = this.requireAliveInstance(id)

    const timeoutMs = Math.max(100, args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    const pollMs = Math.max(25, args.pollMs ?? DEFAULT_WAIT_POLL_MS)
    const idleMs = Math.max(100, args.idleMs ?? 700)
    const started = Date.now()

    const until = async (predicate: () => Promise<boolean>, detail: string): Promise<BrowserWaitResult> => {
      while (Date.now() - started <= timeoutMs) {
        if (await predicate()) {
          return {
            ok: true,
            kind: args.kind,
            elapsedMs: Date.now() - started,
            detail,
          }
        }
        await this.sleep(pollMs)
      }
      throw new Error(`Wait timed out after ${timeoutMs}ms (${args.kind})`)
    }

    if (args.kind === 'selector') {
      const selector = args.value?.trim()
      if (!selector) throw new Error('browser_wait selector requires value')
      return until(async () => {
        const exists = await instance.pageView.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        )
        return Boolean(exists)
      }, `selector matched: ${selector}`)
    }

    if (args.kind === 'text') {
      const text = args.value?.trim()
      if (!text) throw new Error('browser_wait text requires value')
      return until(async () => {
        const found = await instance.pageView.webContents.executeJavaScript(
          `document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(text)})`
        )
        return Boolean(found)
      }, `text found: ${text}`)
    }

    if (args.kind === 'url') {
      const needle = args.value?.trim()
      if (!needle) throw new Error('browser_wait url requires value')
      return until(async () => {
        return instance.currentUrl.includes(needle)
      }, `url matched: ${needle}`)
    }

    if (args.kind === 'network-idle') {
      const wcId = instance.pageWebContentsId
      return until(async () => {
        const inflight = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
        const last = this.lastNetworkActivityByWebContentsId.get(wcId) ?? started
        return inflight === 0 && (Date.now() - last) >= idleMs
      }, `network idle for ${idleMs}ms`)
    }

    throw new Error(`Unknown wait kind: ${args.kind}`)
  }

  async sendKey(id: string, args: BrowserKeyArgs): Promise<void> {
    const instance = this.requireAliveInstance(id)

    const key = args.key?.trim()
    if (!key) throw new Error('browser_key requires key')

    const modifiers = (args.modifiers ?? []) as Array<'shift' | 'control' | 'alt' | 'meta'>

    // CDP needs no window focus (agent windows are usually hidden); unknown keys and Ctrl/Cmd
    // shortcuts stay on the native path.
    if (await instance.cdp.pressKey(key, modifiers)) return

    instance.pageView.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: key,
      modifiers,
    } as any)
    instance.pageView.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: key,
      modifiers,
    } as any)
  }

  async getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> {
    const instance = this.requireAliveInstance(id)

    const action = options?.action ?? 'list'
    const limit = Math.max(1, Math.min(200, Number(options?.limit ?? 20)))

    if (action === 'wait') {
      const timeoutMs = Math.max(100, Number(options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS))
      const started = Date.now()
      while (Date.now() - started <= timeoutMs) {
        const hasTerminal = instance.downloads.some((d) => d.state === 'completed' || d.state === 'interrupted' || d.state === 'cancelled')
        if (hasTerminal) break
        await this.sleep(100)
      }
    }

    return instance.downloads.slice(-limit)
  }

  // validateUploadFilePath removed — uses shared validateFilePath from @craft-agent/server-core/handlers

  async uploadFile(id: string, ref: string, filePaths: string[]): Promise<ElementGeometry> {
    const instance = this.requireAliveInstance(id)

    const safePaths: string[] = []
    for (const p of filePaths) {
      const workspaceId = this.resolveLaunchWorkspaceId()
      const safePath = await validateFilePath(p, getWorkspaceAllowedDirs(workspaceId))
      if (!existsSync(safePath)) throw new Error(`File not found: ${p}`)
      safePaths.push(safePath)
    }

    return instance.cdp.setFileInputFiles(ref, safePaths)
  }

  windowResize(id: string, width: number, height: number): { width: number; height: number } {
    const instance = this.requireAliveInstance(id)

    const requestedViewportWidth = Math.max(320, Math.floor(width))
    const requestedViewportHeight = Math.max(240, Math.floor(height))
    instance.cdp.clearViewportSize()
    instance.window.setContentSize(requestedViewportWidth, requestedViewportHeight + TOOLBAR_HEIGHT)

    this.layoutAllViews(instance)

    // Return effective viewport dimensions after OS/window min-size constraints are applied.
    const [appliedContentWidth, appliedContentHeight] = instance.window.getContentSize()
    return {
      width: Math.max(0, Math.floor(appliedContentWidth)),
      height: Math.max(0, Math.floor(appliedContentHeight - TOOLBAR_HEIGHT)),
    }
  }

  async evaluate(id: string, expression: string): Promise<unknown> {
    const instance = this.requireAliveInstance(id)
    return instance.pageView.webContents.executeJavaScript(expression)
  }

  /**
   * Classifies the page (see security-challenge.ts). `detected` means the user has to
   * solve a challenge; it is only reported once a second look confirms it.
   */
  async detectSecurityChallenge(id: string): Promise<BrowserSecurityChallenge> {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return noSecurityChallenge()

    const first = await this.checkSecurityChallenge(instance)
    let verdict = first
    if (first.detected) {
      await this.sleep(SECURITY_CHALLENGE_CONFIRM_DELAY_MS)
      verdict = instance.window.isDestroyed() ? noSecurityChallenge() : await this.checkSecurityChallenge(instance)
    }

    if (verdict.detected || verdict.suspected) {
      mainLog.info(`[browser-pane] security challenge ${verdict.detected ? 'detected' : 'suspected'} id=${id} provider=${verdict.provider} signals=[${verdict.signals.join(', ')}]`)
    } else if (first.detected) {
      mainLog.info(`[browser-pane] security challenge not confirmed on re-check id=${id} provider=${first.provider} signals=[${first.signals.join(', ')}]`)
    }

    return verdict
  }

  /** One look at the page: a page-script round trip plus accessibility counts, then the classifier. */
  private async checkSecurityChallenge(instance: BrowserInstance): Promise<BrowserSecurityChallenge> {
    const pageWc = instance.pageView.webContents
    const url = instance.currentUrl
    const facts: SecurityChallengeFacts = { url, loading: pageWc.isLoading(), urlChanged: false, page: null, ax: null }

    // Mid-navigation there is no verdict to give, and executeJavaScript would wait for the load.
    if (!facts.loading) {
      try {
        facts.page = await pageWc.executeJavaScript(SECURITY_CHALLENGE_PAGE_SCRIPT)
      } catch {
        // JS evaluation can fail if the page is in a weird state; without facts there is no verdict.
      }
      if (facts.page) {
        try {
          const snapshot = await instance.cdp.getAccessibilitySnapshot()
          facts.ax = { nodes: snapshot.nodes.length, actionable: countActionableAxNodes(snapshot.nodes) }
        } catch {
          // AX snapshot can fail transiently during navigation; it is context only.
        }
      }
      facts.urlChanged = instance.currentUrl !== url
    }

    try {
      return classifySecurityChallenge(facts)
    } catch {
      // A page that patches DOM built-ins can hand back malformed facts; never fail the calling command.
      return noSecurityChallenge()
    }
  }

  async scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount = 500): Promise<void> {
    const instance = this.requireAliveInstance(id)
    this.clearPendingSelection(instance)

    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0

    await instance.pageView.webContents.executeJavaScript(`window.scrollBy(${deltaX}, ${deltaY})`)
  }

  bindSession(
    id: string,
    sessionId: string,
    options?: { workspaceId?: string | null; projectId?: string | null },
  ): void {
    const instance = this.instances.get(id)
    if (!instance) return

    instance.boundSessionId = sessionId
    instance.ownerType = 'session'
    instance.ownerSessionId = sessionId
    if (options?.workspaceId !== undefined) {
      instance.workspaceId = options.workspaceId
    }
    if (options?.projectId !== undefined) {
      instance.projectId = options.projectId
    }
    instance.targetRefreshToken += 1
    instance.targetSessionId = sessionId
    this.emitStateChange(instance)
  }

  unbindSession(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) return
    instance.boundSessionId = null
    this.emitStateChange(instance)
  }

  /** Release active agent control without changing the window's Chat owner. */
  unbindAllForSession(sessionId: string): void {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId) {
        instance.boundSessionId = null
        this.emitStateChange(instance)
        mainLog.info(`[browser-pane] Released active control for instance ${instance.id} session=${sessionId}`)
      }
    }
  }

  getBoundForSession(
    sessionId: string,
    scope?: { workspaceId: string | null; projectId: string | null },
  ): string | null {
    for (const instance of this.instances.values()) {
      if (
        instance.ownerType === 'session'
        && instance.ownerSessionId === sessionId
        && (!scope || (
          instance.workspaceId === scope.workspaceId
          && instance.projectId === scope.projectId
        ))
      ) {
        if (instance.window.isDestroyed()) {
          this.cleanupDestroyedInstance(instance, `getBoundForSession(${sessionId})`)
          continue
        }
        return instance.id
      }
    }
    return null
  }

  createForSession(
    sessionId: string,
    options?: {
      show?: boolean
      workspaceId?: string | null
      projectId?: string | null
      originWebContentsId?: number | null
    },
  ): string {
    const workspaceId = options?.workspaceId ?? null
    const projectId = options?.projectId ?? null
    const existing = this.getBoundForSession(sessionId, { workspaceId, projectId })
    if (existing) {
      const instance = this.instances.get(existing)
      if (instance) {
        if (
          options?.workspaceId !== undefined
          && instance.workspaceId !== null
          && instance.workspaceId !== options.workspaceId
        ) {
          throw new Error('Browser window belongs to another Workspace')
        }
        if (
          options?.projectId !== undefined
          && instance.projectId !== null
          && instance.projectId !== options.projectId
        ) {
          throw new Error('Browser window belongs to another Project')
        }
        if (options?.workspaceId !== undefined) instance.workspaceId = options.workspaceId
        if (options?.projectId !== undefined) instance.projectId = options.projectId
        if (options?.originWebContentsId !== undefined) {
          instance.originWebContentsId = options.originWebContentsId
        }
        instance.boundSessionId = sessionId
        instance.ownerType = 'session'
        instance.targetRefreshToken += 1
        instance.targetSessionId = sessionId
        instance.targetMetadataFresh = false
        this.emitStateChange(instance)
      }
      if (options?.show) {
        this.focus(existing)
      }
      return existing
    }

    return this.createInstance(undefined, {
      show: options?.show ?? false,
      ownerType: 'session',
      ownerSessionId: sessionId,
      workspaceId,
      projectId,
      targetSessionId: sessionId,
      originWebContentsId: options?.originWebContentsId,
    })
  }

  focusBoundForSession(
    sessionId: string,
    options?: { workspaceId?: string | null; projectId?: string | null },
  ): string {
    const id = this.createForSession(sessionId, {
      show: true,
      workspaceId: options?.workspaceId,
      projectId: options?.projectId,
    })
    this.focus(id)
    return id
  }

  getOrCreateForSession(
    sessionId: string,
    options?: { workspaceId?: string | null; projectId?: string | null },
  ): string {
    return this.createForSession(sessionId, {
      show: false,
      workspaceId: options?.workspaceId,
      projectId: options?.projectId,
    })
  }

  destroyForSession(sessionId: string, workspaceId?: string): void {
    const remoteOwner = this.parseOwnerKey(sessionId)
    const targetWorkspaceId = workspaceId ?? remoteOwner?.workspaceId
    const publicSessionId = this.getPublicSessionId(sessionId)
    for (const [id, instance] of this.instances) {
      if (
        (!targetWorkspaceId || instance.workspaceId === targetWorkspaceId)
        && (
          instance.boundSessionId === sessionId
          || instance.ownerSessionId === sessionId
        )
      ) {
        this.destroyInstance(id)
        continue
      }
      if (
        (!targetWorkspaceId || instance.workspaceId === targetWorkspaceId)
        && this.getPublicSessionId(instance.targetSessionId) === publicSessionId
      ) {
        instance.targetRefreshToken += 1
        instance.targetSessionId = null
        instance.targetChat = null
        instance.targetMetadataFresh = true
        this.pushToolbarState(instance)
        this.emitStateChange(instance)
      }
    }
  }

  destroyForProject(workspaceId: string, projectId: string): void {
    for (const [id, instance] of this.instances) {
      if (instance.workspaceId === workspaceId && instance.projectId === projectId) {
        this.destroyInstance(id)
      }
    }
  }

  beginProjectDeletion(workspaceId: string, projectId: string): void {
    this.projectDeletionStates.set(`${workspaceId}\0${projectId}`, 'deleting')
  }

  finishProjectDeletion(workspaceId: string, projectId: string, deleted: boolean): void {
    const key = `${workspaceId}\0${projectId}`
    if (deleted) {
      this.destroyForProject(workspaceId, projectId)
      this.projectDeletionStates.set(key, 'deleted')
    } else {
      this.projectDeletionStates.delete(key)
    }
  }

  reconcileWorkspace(
    workspaceId: string,
    input: Omit<BrowserPaneReconcileInput, 'workspaceId'>,
  ): void {
    const projectIds = input.projectIds ? new Set(input.projectIds) : null
    const sessions = input.sessions
      ? new Map(input.sessions.map(session => [session.id, session]))
      : null

    if (projectIds) {
      const keyPrefix = `${workspaceId}\0`
      for (const [key, state] of this.projectDeletionStates) {
        if (!key.startsWith(keyPrefix) || state !== 'deleting') continue
        const projectId = key.slice(keyPrefix.length)
        if (projectIds.has(projectId)) {
          this.projectDeletionStates.delete(key)
        } else {
          this.projectDeletionStates.set(key, 'deleted')
        }
      }
    }

    for (const [id, instance] of this.instances) {
      if (instance.workspaceId !== workspaceId) continue

      if (projectIds && (!instance.projectId || !projectIds.has(instance.projectId))) {
        this.destroyInstance(id)
        continue
      }

      if (!sessions) continue
      if (instance.ownerType === 'session') {
        const ownerSessionId = this.getPublicSessionId(instance.ownerSessionId)
        const ownerSession = ownerSessionId ? sessions.get(ownerSessionId) : null
        if (!ownerSession || ownerSession.projectId !== instance.projectId) {
          this.destroyInstance(id)
        }
        continue
      }

      const targetSessionId = this.getPublicSessionId(instance.targetSessionId)
      if (!targetSessionId) continue
      const targetSession = sessions.get(targetSessionId)
      if (targetSession && targetSession.projectId === instance.projectId) continue

      instance.targetRefreshToken += 1
      instance.targetSessionId = null
      instance.targetChat = null
      instance.targetMetadataFresh = true
      this.pushToolbarState(instance)
      this.emitStateChange(instance)
    }
  }

  async clearVisualsForSession(sessionId: string): Promise<void> {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId) {
        instance.agentControl = null
        this.applyAgentControlLock(instance, false)
        this.updateNativeOverlayState(instance)
        this.emitStateChange(instance)
      }
    }
  }

  private getAgentControlLabel(agentControl: Pick<AgentControlState, 'displayName' | 'intent'> | null | undefined): string {
    if (agentControl?.intent) {
      return `${agentControl.displayName ?? 'Agent'} — ${agentControl.intent}`
    }

    return agentControl?.displayName ?? 'Agent is working…'
  }

  private reapplyAgentControlVisual(instance: BrowserInstance): void {
    const active = !!instance.agentControl?.active
    this.applyAgentControlLock(instance, active)
    this.updateNativeOverlayState(instance)
  }

  /** Resolve the app's current accent color as a concrete CSS value (not a var reference). */
  private getResolvedAccentColor(): string {
    const isDark = nativeTheme.shouldUseDarkColors
    const userTheme = loadAppTheme()
    const accent = isDark
      ? (userTheme?.dark?.accent ?? userTheme?.accent ?? DEFAULT_THEME.dark!.accent!)
      : (userTheme?.accent ?? DEFAULT_THEME.accent!)
    return accent
  }

  private async loadNativeOverlayPage(instance: BrowserInstance): Promise<void> {
    const liveFxPlatform: Parameters<typeof getBrowserLiveFxCornerRadii>[0] =
      process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
        ? process.platform
        : 'other'
    const cornerRadii = getBrowserLiveFxCornerRadii(liveFxPlatform)
    const selectionLabels = {
      addChat: i18n.t('reference.addChat'),
      addNote: i18n.t('reference.addNote'),
      chooseNote: i18n.t('projectNoteTarget.chooseFile'),
      newChat: i18n.t('reference.newChat'),
    }

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #overlay {
        position: fixed;
        inset: 0;
        border: 2px solid transparent;
        border-top-left-radius: ${cornerRadii.topLeft};
        border-top-right-radius: ${cornerRadii.topRight};
        border-bottom-left-radius: ${cornerRadii.bottomLeft};
        border-bottom-right-radius: ${cornerRadii.bottomRight};
        box-sizing: border-box;
        pointer-events: none;
      }
      #chip {
        position: fixed;
        top: 8px;
        right: 8px;
        padding: 4px 8px;
        border-radius: 7px;
        background: rgba(2, 6, 23, 0.82);
        color: rgba(236, 254, 255, 0.95);
        font-size: 11px;
        line-height: 1.2;
        backdrop-filter: blur(4px);
        max-width: calc(100vw - 16px);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #shield {
        position: fixed;
        inset: 0;
        pointer-events: none;
        cursor: default;
      }
      #selection-actions {
        display: none;
        align-items: center;
        gap: 2px;
        width: 100%;
        height: 100%;
        padding: 4px;
        box-sizing: border-box;
        border: 0;
        border-radius: 8px;
        background: oklch(0.98 0.003 265);
        color: oklch(0.185 0.01 270);
        box-shadow:
          rgba(38, 36, 42, 0.06) 0 0 0 1px inset,
          rgba(0, 0, 0, 0.04) 0 1px 1px -0.5px,
          rgba(0, 0, 0, 0.04) 0 3px 3px,
          rgba(0, 0, 0, 0.02) 0 6px 6px;
        pointer-events: auto;
      }
      #selection-actions button {
        display: flex;
        flex: 0 0 auto;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-width: 0;
        height: 32px;
        border: 0;
        border-radius: 8px;
        padding: 0 10px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 150ms ease;
      }
      #selection-actions button svg {
        width: 16px;
        height: 16px;
        flex: none;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      #selection-actions button:hover {
        background: rgba(38, 36, 42, 0.03);
      }
      #selection-actions button:disabled {
        cursor: not-allowed;
        opacity: 0.38;
      }
      #selection-actions button:focus-visible {
        outline: 1px solid rgba(38, 36, 42, 0.25);
        outline-offset: -1px;
      }
      #selection-actions .note-action-group {
        display: flex;
        flex: 0 0 auto;
        height: 32px;
      }
      #selection-actions .note-action {
        flex: 0 0 auto;
        min-width: 0;
        border-radius: 8px 0 0 8px;
        padding: 0 8px;
      }
      #selection-actions .note-target-action {
        flex: 0 0 28px;
        min-width: 28px;
        border-left: 1px solid rgba(38, 36, 42, 0.1);
        border-radius: 0 8px 8px 0;
        padding: 0;
      }
      #selection-actions .note-target-action svg {
        width: 12px;
        height: 12px;
      }
      @media (prefers-color-scheme: dark) {
        #selection-actions {
          background: oklch(0.145 0.015 270);
          color: oklch(0.95 0.01 270);
          box-shadow:
            rgba(242, 241, 245, 0.06) 0 0 0 1px inset,
            rgba(0, 0, 0, 0.08) 0 1px 1px -0.5px,
            rgba(0, 0, 0, 0.08) 0 3px 3px,
            rgba(0, 0, 0, 0.04) 0 6px 6px;
        }
        #selection-actions button:hover {
          background: rgba(242, 241, 245, 0.03);
        }
        #selection-actions button:focus-visible {
          outline-color: rgba(242, 241, 245, 0.25);
        }
      }
    </style>
  </head>
  <body>
    <div id="overlay">
      <div id="shield"></div>
      <div id="chip">Agent is working…</div>
    </div>
    <div id="selection-actions">
      <div class="note-action-group">
        <button
          type="button"
          class="note-action"
          title="${escapeHtml(selectionLabels.addNote)}"
          data-browser-selection-action="add-note"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.5z" />
            <path d="M13 2v7h7" />
            <path d="M12 18v-6" />
            <path d="M9 15h6" />
          </svg>
          <span data-browser-selection-label>${escapeHtml(selectionLabels.addNote)}</span>
        </button>
        <button
          type="button"
          class="note-target-action"
          title="${escapeHtml(selectionLabels.chooseNote)}"
          aria-label="${escapeHtml(selectionLabels.chooseNote)}"
          data-browser-selection-action="choose-note-target"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        title="${escapeHtml(selectionLabels.addChat)}"
        data-browser-selection-action="add-chat"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
          <path d="M12 7v6" />
          <path d="M9 10h6" />
        </svg>
        <span data-browser-selection-label>${escapeHtml(selectionLabels.addChat)}</span>
      </button>
      <button
        type="button"
        title="${escapeHtml(selectionLabels.newChat)}"
        data-browser-selection-action="new-chat"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h6" />
          <path d="M18 2v6" />
          <path d="M15 5h6" />
        </svg>
        <span data-browser-selection-label>${escapeHtml(selectionLabels.newChat)}</span>
      </button>
    </div>
  </body>
</html>`

    try {
      await instance.nativeOverlayView.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
      instance.nativeOverlayReady = true
      mainLog.info(`[browser-pane] native overlay ready id=${instance.id} platform=${liveFxPlatform} corners=${cornerRadii.bottomLeft}/${cornerRadii.bottomRight}`)
      this.updateNativeOverlayState(instance)
    } catch (error) {
      instance.nativeOverlayReady = false
      mainLog.warn(`[browser-pane] native overlay load failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private getPublicSessionId(sessionId: string | null): string | null {
    if (!sessionId) return null
    return this.isRemoteOwnerKey(sessionId)
      ? this.parseOwnerKey(sessionId)?.sessionId ?? null
      : sessionId
  }

  private getContentBounds(
    instance: BrowserInstance,
  ): { x: number; y: number; width: number; height: number } {
    const [width, height] = instance.window.getContentSize()
    return { x: 0, y: 0, width, height }
  }

  private layoutToolbarView(instance: BrowserInstance): void {
    const { x, y, width } = this.getContentBounds(instance)
    instance.toolbarView.setBounds({ x, y, width, height: TOOLBAR_HEIGHT })
  }

  private updateNativeOverlayState(instance: BrowserInstance): void {
    if (instance.window.isDestroyed()) return
    const stateVersion = ++instance.nativeOverlayStateVersion
    const control = instance.agentControl
    const agentActive = !!control?.active
    const shouldShow = agentActive || !!instance.pendingSelection

    if (!shouldShow || !instance.nativeOverlayReady) {
      instance.nativeOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      instance.rootView.addChildView(instance.toolbarView)
      return
    }

    const { x, y, width, height } = this.getContentBounds(instance)
    const pageHeight = Math.max(100, height - TOOLBAR_HEIGHT)
    let overlayStateUpdate: Promise<unknown>

    if (!agentActive && instance.pendingSelection) {
      const targetChatTitle = instance.targetChat?.title ?? null
      const targetNotePath = instance.targetChat?.noteTargetPath ?? null
      const selectionActionPending = instance.selectionActionPending
      const addChatTitle = targetChatTitle
        ? `${i18n.t('reference.addChat')}: ${targetChatTitle}`
        : i18n.t('reference.chooseChatTarget')
      const addNoteTitle = targetNotePath
        ? `${i18n.t('reference.addNote')}: ${targetNotePath}`
        : i18n.t('projectNoteTarget.chooseFile')
      const chooseNoteTitle = targetNotePath
        ? `${i18n.t('projectNoteTarget.chooseFile')}: ${targetNotePath}`
        : i18n.t('projectNoteTarget.chooseFile')
      const zoomFactor = instance.pageView.webContents.getZoomFactor()
      const overlayBounds = calculateBrowserSelectionOverlayBounds(
        instance.pendingSelection.capture.rect,
        width,
        pageHeight,
        TOOLBAR_HEIGHT,
        zoomFactor,
      )
      instance.nativeOverlayView.setBounds({
        ...overlayBounds,
        x: x + overlayBounds.x,
        y: y + overlayBounds.y,
      })
      instance.rootView.addChildView(instance.nativeOverlayView)
      instance.rootView.addChildView(instance.toolbarView)

      overlayStateUpdate = instance.nativeOverlayView.webContents.executeJavaScript(`(() => {
        const overlay = document.getElementById('overlay');
        const selectionActions = document.getElementById('selection-actions');
        const addChat = document.querySelector('[data-browser-selection-action="add-chat"]');
        const newChat = document.querySelector('[data-browser-selection-action="new-chat"]');
        const addNote = document.querySelector('[data-browser-selection-action="add-note"]');
        const chooseNoteTarget = document.querySelector('[data-browser-selection-action="choose-note-target"]');
        const targetChatTitle = ${JSON.stringify(targetChatTitle)};
        const targetNotePath = ${JSON.stringify(targetNotePath)};
        const selectionActionPending = ${JSON.stringify(selectionActionPending)};
        const stateVersion = ${JSON.stringify(stateVersion)};
        const appliedStateVersion = Number(selectionActions?.dataset.browserOverlayStateVersion ?? -1);
        if (stateVersion < appliedStateVersion) return;
        if (selectionActions) selectionActions.dataset.browserOverlayStateVersion = String(stateVersion);
        if (overlay) overlay.style.display = 'none';
        if (selectionActions) selectionActions.style.display = 'flex';
        if (addChat instanceof HTMLButtonElement) {
          addChat.disabled = selectionActionPending;
          addChat.title = ${JSON.stringify(addChatTitle)};
        }
        if (newChat instanceof HTMLButtonElement) newChat.disabled = selectionActionPending;
        if (addNote instanceof HTMLButtonElement) {
          addNote.disabled = selectionActionPending;
          addNote.title = ${JSON.stringify(addNoteTitle)};
        }
        if (chooseNoteTarget instanceof HTMLButtonElement) {
          chooseNoteTarget.disabled = selectionActionPending;
          chooseNoteTarget.title = ${JSON.stringify(chooseNoteTitle)};
        }
      })()`)
    } else {
      instance.nativeOverlayView.setBounds({
        x,
        y: y + TOOLBAR_HEIGHT,
        width,
        height: pageHeight,
      })
      instance.rootView.addChildView(instance.nativeOverlayView)
      instance.rootView.addChildView(instance.toolbarView)

      const label = this.getAgentControlLabel(control)
      const accent = this.getResolvedAccentColor()

      overlayStateUpdate = instance.nativeOverlayView.webContents.executeJavaScript(`(() => {
        const overlay = document.getElementById('overlay');
        const chip = document.getElementById('chip');
        const shield = document.getElementById('shield');
        const selectionActions = document.getElementById('selection-actions');
        if (!overlay || !chip || !shield || !selectionActions) return;

        const stateVersion = ${JSON.stringify(stateVersion)};
        const appliedStateVersion = Number(selectionActions.dataset.browserOverlayStateVersion ?? -1);
        if (stateVersion < appliedStateVersion) return;
        selectionActions.dataset.browserOverlayStateVersion = String(stateVersion);

        overlay.style.display = 'block';
        selectionActions.style.display = 'none';
        overlay.style.borderColor = ${JSON.stringify(accent)};
        overlay.style.boxShadow = 'inset 0 0 0 1px color-mix(in oklab, ' + ${JSON.stringify(accent)} + ' 45%, transparent), inset 0 0 24px color-mix(in oklab, ' + ${JSON.stringify(accent)} + ' 28%, transparent)';
        chip.textContent = ${JSON.stringify(label)};
        chip.style.display = 'inline-flex';
        shield.style.pointerEvents = 'auto';
        shield.style.cursor = 'not-allowed';
        shield.style.background = 'rgba(2, 6, 23, 0.03)';
      })()`)
    }

    void overlayStateUpdate.catch(() => {})
  }

  private getWindowResizable(window: BrowserWindow): boolean {
    return typeof window.isResizable === 'function' ? window.isResizable() : true
  }

  private setWindowResizable(window: BrowserWindow, value: boolean): void {
    if (typeof window.setResizable === 'function') {
      window.setResizable(value)
    }
  }

  private applyAgentControlLock(instance: BrowserInstance, active: boolean): void {
    const wantsLock = active && !!instance.agentControl?.active
    this.setRendersWhileHidden(instance, wantsLock)

    if (wantsLock && !instance.lockState.active) {
      instance.lockState.previousResizable = this.getWindowResizable(instance.window)
      this.setWindowResizable(instance.window, false)
      instance.lockState.active = true
      mainLog.info(`[browser-pane] interaction lock enabled id=${instance.id}`)
      return
    }

    if (!wantsLock && instance.lockState.active) {
      this.setWindowResizable(instance.window, instance.lockState.previousResizable)
      instance.lockState.active = false
      mainLog.info(`[browser-pane] interaction lock released id=${instance.id}`)
    }
  }

  destroyAll(): void {
    for (const id of [...this.instances.keys()]) {
      this.destroyInstance(id)
    }
  }

  /** Run one teardown step; a failing step is logged and never blocks the rest. */
  private runCleanupStep(id: string, label: string, action: () => void): void {
    try {
      action()
    } catch (error) {
      mainLog.warn(`[browser-pane] destroy cleanup failed id=${id} step=${label} error=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private finalizeDestroyedInstance(instance: BrowserInstance, source: 'destroy' | 'closed'): void {
    if (!this.instances.has(instance.id)) {
      return
    }

    // Every step is guarded. The window and its popups may already be destroyed
    // here; an exception used to escape before `instances.delete`, leaving a dead
    // instance registered so every later browser_tool call failed with
    // "Object has been destroyed" until the app restarted (OSS #1059).
    this.destroyingIds.delete(instance.id)
    this.runCleanupStep(instance.id, 'closePopupsForParent', () => this.closePopupsForParent(instance.id, 'parent_destroy'))
    this.runCleanupStep(instance.id, 'applyAgentControlLock', () => this.applyAgentControlLock(instance, false))
    this.runCleanupStep(instance.id, 'updateNativeOverlayState', () => this.updateNativeOverlayState(instance))
    this.runCleanupStep(instance.id, 'cdp.detach', () => instance.cdp.detach())
    this.instances.delete(instance.id)
    this.runCleanupStep(instance.id, 'removedCallback', () => this.removedCallback?.(instance.id))
    mainLog.info(`[browser-pane] Destroyed instance: ${instance.id} (${source})`)
  }

  private layoutPageView(instance: BrowserInstance): void {
    const { x, y, width, height } = this.getContentBounds(instance)
    instance.pageView.setBounds({
      x,
      y: y + TOOLBAR_HEIGHT,
      width,
      height: Math.max(100, height - TOOLBAR_HEIGHT),
    })
    this.updateNativeOverlayState(instance)
  }

  private layoutAllViews(instance: BrowserInstance): void {
    const [width, height] = instance.window.getContentSize()
    instance.rootView.setBounds({ x: 0, y: 0, width, height })
    instance.rootView.setBorderRadius(0)
    instance.rootView.setVisible(true)
    this.layoutToolbarView(instance)
    this.layoutPageView(instance)
    instance.rootView.addChildView(instance.toolbarView)
  }

  private forceCloseToolbarMenu(instance: BrowserInstance, reason: string): void {
    const menu = instance.toolbarMenu
    if (!menu) return

    instance.toolbarMenuOpen = false
    instance.toolbarMenu = null

    menu.closePopup(instance.window.isDestroyed() ? undefined : instance.window)

    mainLog.info(`[browser-pane] toolbar menu closed id=${instance.id} reason=${reason}`)
  }

  private isBrowserEmptyStateUrl(url: string): boolean {
    if (!url) return false
    return url.includes(`/${BROWSER_EMPTY_STATE_PAGE}`) || url.includes(`\\${BROWSER_EMPTY_STATE_PAGE}`)
  }

  private normalizePageState(url: string, title: string): { url: string; title: string } {
    if (this.isBrowserEmptyStateUrl(url)) {
      return { url: 'about:blank', title: 'New Tab' }
    }
    return { url, title }
  }

  private async loadEmptyStatePage(instance: BrowserInstance): Promise<void> {
    if (VITE_DEV_SERVER_URL) {
      await instance.pageView.webContents.loadURL(`${VITE_DEV_SERVER_URL}/${BROWSER_EMPTY_STATE_PAGE}`)
      return
    }

    await instance.pageView.webContents.loadFile(join(__dirname, `renderer/${BROWSER_EMPTY_STATE_PAGE}`))
  }

  private async handleDeepLinkUrl(url: string): Promise<void> {
    if (!url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) return

    try {
      if (!this.windowManager) {
        mainLog.warn('[browser-pane] window manager unavailable for deep-link handling, falling back to shell.openExternal')
        await shell.openExternal(url)
        return
      }

      const { handleDeepLink } = await import('./deep-link')
      const sink = this.windowManager.getRpcEventSink() ?? undefined
      const resolver = (wcId: number) => this.windowManager?.getClientIdForWindow(wcId)
      const result = await handleDeepLink(url, this.windowManager, sink, resolver)
      if (!result.success) {
        mainLog.warn(`[browser-pane] deep-link handling failed: ${result.error ?? 'unknown error'} url=${url}`)
      }
    } catch (error) {
      mainLog.warn(`[browser-pane] deep-link handling threw, falling back to shell.openExternal: ${error instanceof Error ? error.message : String(error)}`)
      await shell.openExternal(url)
    }
  }

  private async maybeHandleEmptyStateLaunch(instance: BrowserInstance, url: string): Promise<boolean> {
    if (!this.isBrowserEmptyStateUrl(url) || !url.includes('#launch=')) {
      return false
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }

    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
    const launchPayload = hash.startsWith('launch=') ? hash.slice('launch='.length) : hash
    if (!launchPayload) return false

    const params = new URLSearchParams(launchPayload)
    const route = params.get('route')
    const token = params.get('ts') ?? route ?? null

    if (!route) {
      mainLog.warn(`[browser-pane] empty-state launch missing route id=${instance.id}`)
      return false
    }

    const handled = await this.triggerEmptyStateRouteLaunch(instance, route, token, 'hash')

    try {
      await instance.pageView.webContents.executeJavaScript(
        "if (window.location.hash.includes('launch=')) history.replaceState(null, '', window.location.pathname + window.location.search);",
      )
    } catch {
      // Best effort cleanup only
    }

    return handled
  }

  private async loadToolbarPage(instance: BrowserInstance): Promise<void> {
    const query = `instanceId=${encodeURIComponent(instance.id)}`
    let lastError: unknown = null

    for (let attempt = 0; attempt <= TOOLBAR_LOAD_MAX_RETRIES; attempt++) {
      try {
        if (VITE_DEV_SERVER_URL) {
          await instance.toolbarView.webContents.loadURL(`${VITE_DEV_SERVER_URL}/browser-toolbar.html?${query}`)
        } else {
          await instance.toolbarView.webContents.loadFile(
            join(__dirname, 'renderer/browser-toolbar.html'),
            { query: { instanceId: instance.id } },
          )
        }

        if (attempt > 0) {
          mainLog.info(`[browser-pane] toolbar load recovered id=${instance.id} attempt=${attempt + 1}`)
        }
        return
      } catch (error) {
        lastError = error
        const retrying = attempt < TOOLBAR_LOAD_MAX_RETRIES
        mainLog.warn(
          `[browser-pane] toolbar load failed id=${instance.id} attempt=${attempt + 1}/${TOOLBAR_LOAD_MAX_RETRIES + 1}: ${error instanceof Error ? error.message : String(error)}${retrying ? ' (retrying)' : ''}`,
        )

        if (retrying) {
          await this.sleep(TOOLBAR_LOAD_RETRY_DELAY_MS)
        }
      }
    }

    const errorText = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')
    await this.loadToolbarFallback(instance, errorText)
  }

  private async loadToolbarFallback(instance: BrowserInstance, reason: string): Promise<void> {
    const safeReason = reason.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch] || ch))
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser Toolbar Error</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fafafb; color: #1f2937; }
      @media (prefers-color-scheme: dark) { html, body { background: #2b292e; color: #e5e7eb; } }
      .wrap { height: 100%; display: flex; align-items: center; justify-content: center; }
      .card { max-width: 640px; margin: 0 20px; padding: 14px 16px; border-radius: 10px; background: rgba(127,127,127,0.12); font-size: 12px; line-height: 1.45; }
      .title { font-weight: 600; margin-bottom: 6px; }
      .muted { opacity: 0.8; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="title">Browser toolbar failed to load</div>
        <div class="muted">The page area still works, but toolbar UI is unavailable. Try reopening the browser window.</div>
        <div class="muted" style="margin-top: 8px; word-break: break-word;">Reason: ${safeReason}</div>
      </div>
    </div>
  </body>
</html>`

    try {
      await instance.toolbarView.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
      mainLog.warn(`[browser-pane] Loaded toolbar fallback id=${instance.id}`)
    } catch (error) {
      mainLog.error(`[browser-pane] Failed to load toolbar fallback id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private pushToolbarState(instance: BrowserInstance): void {
    if (instance.window.isDestroyed() || instance.toolbarView.webContents.isDestroyed()) return
    const state = {
      url: instance.currentUrl,
      title: instance.title,
      isLoading: instance.isLoading,
      canGoBack: instance.canGoBack,
      canGoForward: instance.canGoForward,
      themeColor: instance.themeColor,
      targetSessionId: this.getPublicSessionId(instance.targetSessionId),
      targetChatTitle: instance.targetChat?.title ?? null,
      targetNotePath: instance.targetChat?.noteTargetPath ?? null,
      selectionFeedback: instance.selectionFeedback,
      canChooseTargetChat: instance.ownerType === 'manual',
      projectId: instance.projectId,
      projectTitle: instance.projectTitle,
      canChooseProject: instance.ownerType === 'manual',
    }
    instance.toolbarView.webContents.send(TOOLBAR_CHANNELS.STATE_UPDATE, state)
  }

  /** Register IPC handlers for toolbar actions. Call once at app startup. */
  registerToolbarIpc(): void {
    const findInstance = (instanceId: string): BrowserInstance | undefined => {
      return this.instances.get(instanceId)
    }

    ipcMain.on(BROWSER_PAGE_SELECTION_CHANNEL, (event, payload: unknown) => {
      const instance = this.findInstanceByPageWebContentsId(event.sender.id)
      if (instance) this.handleSelectionCapture(instance, payload)
    })

    ipcMain.on(BROWSER_OVERLAY_ACTION_CHANNEL, (event, action: unknown) => {
      const instance = this.findInstanceByOverlayWebContentsId(event.sender.id)
      if (instance) void this.handleSelectionAction(instance, action)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.NAVIGATE, async (_event, instanceId: string, url: string) => {
      const inst = findInstance(instanceId)
      if (inst) await this.navigate(inst.id, url)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.GO_BACK, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst) await this.goBack(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.GO_FORWARD, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst) await this.goForward(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.RELOAD, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst) this.reload(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.STOP, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst) this.stop(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.OPEN_TARGET_CHAT, async (event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (!inst || event.sender.id !== inst.toolbarView.webContents.id) return
      await this.openTargetSession(instanceId)
    })

    ipcMain.on(TOOLBAR_CHANNELS.REQUEST_STATE, (event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst && event.sender.id === inst.toolbarView.webContents.id) {
        this.pushToolbarState(inst)
      }
    })

    ipcMain.handle(TOOLBAR_CHANNELS.LIST_BOOKMARKS, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (!inst) return []
      return loadBrowserBookmarks(this.resolveBookmarkWorkspaceRoot(inst))
    })

    ipcMain.handle(TOOLBAR_CHANNELS.TOGGLE_BOOKMARK, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (!inst) throw new Error('Browser instance is unavailable')
      const workspaceRootPath = this.resolveBookmarkWorkspaceRoot(inst)
      const result = toggleBrowserBookmark(workspaceRootPath, {
        url: inst.currentUrl,
        title: inst.title,
      })
      this.pushBookmarksForWorkspace(inst, workspaceRootPath, result.bookmarks)
      return result
    })

    ipcMain.handle(TOOLBAR_CHANNELS.SHOW_MENU, async (
      event,
      instanceId: string,
      kind: 'bookmarks' | 'projects' | 'chats' | 'window',
    ) => {
      const inst = findInstance(instanceId)
      if (
        !inst
        || event.sender.id !== inst.toolbarView.webContents.id
      ) return
      if (
        kind !== 'bookmarks'
        && kind !== 'projects'
        && kind !== 'chats'
        && kind !== 'window'
      ) return
      if (kind === 'chats') {
        await this.showChatTargetMenu(inst)
        return
      }
      const menuRequestToken = ++inst.toolbarMenuRequestToken

      let template: MenuItemConstructorOptions[]
      if (kind === 'bookmarks') {
        try {
          const workspaceRootPath = this.resolveBookmarkWorkspaceRoot(inst)
          const bookmarks = loadBrowserBookmarks(workspaceRootPath)
          template = bookmarks.length === 0
            ? [{ label: i18n.t('browser.noBookmarks'), enabled: false }]
            : [
                ...bookmarks.map(bookmark => ({
                  label: bookmark.title,
                  sublabel: new URL(bookmark.url).hostname,
                  click: () => { void this.navigate(inst.id, bookmark.url) },
                })),
                { type: 'separator' },
                {
                  label: i18n.t('browser.removeCurrentBookmark'),
                  submenu: bookmarks.map(bookmark => ({
                    label: bookmark.title,
                    click: () => {
                      const nextBookmarks = removeBrowserBookmark(workspaceRootPath, bookmark.id)
                      this.pushBookmarksForWorkspace(inst, workspaceRootPath, nextBookmarks)
                    },
                  })),
                },
              ]
        } catch (error) {
          mainLog.warn(`[browser-pane] bookmarks menu unavailable id=${inst.id} error=${error instanceof Error ? error.message : String(error)}`)
          template = [{
            label: i18n.t('browser.bookmarksUnavailable'),
            enabled: false,
          }]
        }
      } else if (kind === 'projects') {
        try {
          const targets = await this.listProjectTargets(inst.id)
          const currentProject = targets.find(target => target.id === inst.projectId)
          if (inst.ownerType === 'session') {
            template = [{
              label: currentProject?.title ?? inst.projectTitle ?? inst.projectId ?? i18n.t('reference.projectUnavailable'),
              type: 'radio',
              checked: true,
              enabled: false,
            }]
          } else if (targets.length === 0) {
            template = [{ label: i18n.t('projectsList.empty'), enabled: false }]
          } else {
            template = targets.map(target => ({
              label: target.title,
              type: 'radio' as const,
              checked: target.id === inst.projectId,
              click: () => {
                void this.setProject(inst.id, target.id).catch((error) => {
                  mainLog.warn(`[browser-pane] failed to change Project id=${inst.id}: ${error instanceof Error ? error.message : String(error)}`)
                })
              },
            }))
          }
        } catch (error) {
          mainLog.warn(`[browser-pane] Project target menu unavailable id=${inst.id} error=${error instanceof Error ? error.message : String(error)}`)
          template = [{ label: i18n.t('reference.projectUnavailable'), enabled: false }]
        }
      } else {
        template = [
          {
            label: i18n.t('browser.hideWindow'),
            click: () => this.hide(inst.id),
          },
          { type: 'separator' },
          {
            label: i18n.t('browser.closeWindowEntirely'),
            click: () => this.destroyInstance(inst.id),
          },
        ]
      }

      if (
        this.instances.get(inst.id) !== inst
        || inst.window.isDestroyed()
        || inst.toolbarView.webContents.isDestroyed()
        || inst.toolbarMenuRequestToken !== menuRequestToken
      ) return

      this.forceCloseToolbarMenu(inst, 'replace')
      this.clearPendingSelection(inst)
      const menu = Menu.buildFromTemplate(template)
      inst.toolbarMenuOpen = true
      inst.toolbarMenu = menu

      menu.popup({
        ...(!inst.window.isDestroyed() ? { window: inst.window } : {}),
        callback: () => {
          if (inst.toolbarMenu !== menu) return
          inst.toolbarMenuOpen = false
          inst.toolbarMenu = null
        },
      })
    })

    mainLog.info('[browser-pane] Toolbar IPC handlers registered')
  }

  // ---------------------------------------------------------------------------
  // Capability IPC — dispatcher for the `client:browser:invoke` WS capability.
  //
  // Sits between the preload bridge (which receives the WS request from the
  // remote server) and the real BrowserPaneManager. It rewrites session IDs to
  // an owner-key namespace, refuses any instance ID not owned by the calling
  // (workspaceId, sessionId), and blocks unsafe methods like `uploadFile` or
  // (optionally) `evaluate`.
  // ---------------------------------------------------------------------------

  /** Register the `__browser:invoke` IPC handler. Call once at app startup. */
  registerCapabilityIpc(): void {
    ipcMain.handle('__browser:invoke', async (event, req: BrowserCapabilityRequest) => {
      return await this.dispatchCapability(req, event.sender.id)
    })
    mainLog.info('[browser-pane] Capability IPC handler registered')
  }

  /** Owner-key namespacing: remote sessions can't collide with local sessions. */
  private toOwnerKey(workspaceId: string, sessionId: string): string {
    return `remote:${workspaceId}:${sessionId}`
  }

  private isRemoteOwnerKey(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.startsWith('remote:')
  }

  private parseOwnerKey(value: string): { workspaceId: string; sessionId: string } | null {
    if (!this.isRemoteOwnerKey(value)) return null
    const rest = value.slice('remote:'.length)
    const colon = rest.indexOf(':')
    if (colon === -1) return null
    return { workspaceId: rest.slice(0, colon), sessionId: rest.slice(colon + 1) }
  }

  /**
   * Throws `BROWSER_INSTANCE_NOT_OWNED` unless the instance belongs to `ownerKey`.
   * Called by every dispatcher branch that accepts an instanceId — including read-only ones.
   */
  private requireOwnedInstance(instanceId: string, ownerKey: string): void {
    const instance = this.instances.get(instanceId)
    if (!instance || instance.window.isDestroyed()) {
      throw new CodedError('BROWSER_INSTANCE_NOT_OWNED', `Browser instance "${instanceId}" not found.`)
    }
    const owned = instance.boundSessionId === ownerKey || instance.ownerSessionId === ownerKey
    if (!owned) {
      throw new CodedError('BROWSER_INSTANCE_NOT_OWNED',
        `Browser instance "${instanceId}" is not owned by this session.`)
    }
  }

  /** Session-scoped listInstances — never returns workspace-wide windows to a remote agent. */
  private listInstancesForOwner(ownerKey: string): BrowserInstanceInfo[] {
    const infos: BrowserInstanceInfo[] = []
    for (const instance of this.instances.values()) {
      if (instance.window.isDestroyed()) {
        this.cleanupDestroyedInstance(instance, 'listInstancesForOwner')
        continue
      }
      const owned = instance.boundSessionId === ownerKey || instance.ownerSessionId === ownerKey
      if (!owned) continue
      infos.push(this.toInfo(instance))
    }
    return infos
  }

  /**
   * Extract a plain {@link BrowserInstanceSnapshot} from a live `BrowserInstance`.
   *
   * `this.getInstance(id)` returns the full instance, which has non-cloneable
   * Electron native references (`window: BrowserWindow`, `pageView: WebContentsView`,
   * `toolbarView`, ...). When we ship the result back over the `__browser:invoke`
   * IPC channel, Electron's structured-clone serializer throws
   * "An object could not be cloned" — see the user-reported bug on the remote
   * bridge path. Always pass the live instance through this helper before
   * returning over IPC.
   */
  private toSnapshot(instance: BrowserInstance): BrowserInstanceSnapshot {
    return {
      ownerType: instance.ownerType,
      ownerSessionId: this.getPublicSessionId(instance.ownerSessionId),
      isVisible: instance.isVisible,
      title: instance.title,
      currentUrl: instance.currentUrl,
    }
  }

  private toScreenshotWire(result: BrowserScreenshotResult): ScreenshotResultWire {
    const buf = result.imageBuffer
    return {
      imageFormat: result.imageFormat,
      imageBytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      metadata: result.metadata,
    }
  }

  /** Main dispatcher. Strongly-typed `switch` over `IBrowserPaneManager` methods. */
  private async dispatchCapability(
    req: BrowserCapabilityRequest,
    originWebContentsId?: number,
  ): Promise<unknown> {
    if (!req || req.v !== 1) {
      throw new CodedError('HANDLER_ERROR',
        `Unsupported browser capability request shape (v=${(req as { v?: unknown })?.v}).`)
    }
    const workspaces = getWorkspaces()
    const senderWorkspaceId = originWebContentsId == null
      ? null
      : this.windowManager?.getWorkspaceForWindow(originWebContentsId) ?? null
    const senderWorkspace = senderWorkspaceId
      ? workspaces.find(candidate => candidate.id === senderWorkspaceId)
      : null
    const senderMatchesRequest = !!senderWorkspaceId && (
      this.capabilityRemoteWorkspaceId === req.workspaceId
      || senderWorkspace?.id === req.workspaceId
      || senderWorkspace?.remoteServer?.remoteWorkspaceId === req.workspaceId
    )
    if (senderWorkspaceId && !senderMatchesRequest) {
      throw new CodedError(
        'BROWSER_INSTANCE_NOT_OWNED',
        `Browser Workspace "${req.workspaceId}" does not belong to the sender window.`,
      )
    }
    const matchingWorkspaces = senderWorkspaceId
      ? []
      : workspaces.filter(candidate => (
          candidate.id === req.workspaceId
          || candidate.remoteServer?.remoteWorkspaceId === req.workspaceId
        ))
    if (!senderWorkspaceId && matchingWorkspaces.length !== 1) {
      throw new CodedError(
        'BROWSER_INSTANCE_NOT_OWNED',
        matchingWorkspaces.length === 0
          ? `Browser Workspace "${req.workspaceId}" is not hosted by this client.`
          : `Browser Workspace "${req.workspaceId}" is not uniquely hosted by this client.`,
      )
    }
    const localWorkspaceId = senderWorkspaceId ?? matchingWorkspaces[0].id
    const ownerKey = this.toOwnerKey(localWorkspaceId, req.sessionId)
    const args = req.args ?? []

    switch (req.method) {
      // -- Session-scoped (no instanceId arg, takes a sessionId) ----------------
      case 'createForSession': {
        const [, options] = args as [
          string,
          { show?: boolean; projectId?: string | null } | undefined,
        ]
        return this.createForSession(ownerKey, {
          show: options?.show ?? false,
          workspaceId: localWorkspaceId,
          projectId: options?.projectId,
          originWebContentsId,
        })
      }
      case 'getOrCreateForSession': {
        const [, options] = args as [
          string,
          { projectId?: string | null } | undefined,
        ]
        return this.createForSession(ownerKey, {
          show: false,
          workspaceId: localWorkspaceId,
          projectId: options?.projectId,
          originWebContentsId,
        })
      }
      case 'focusBoundForSession': {
        const [, options] = args as [
          string,
          { projectId?: string | null } | undefined,
        ]
        const id = this.createForSession(ownerKey, {
          show: true,
          workspaceId: localWorkspaceId,
          projectId: options?.projectId,
          originWebContentsId,
        })
        this.focus(id)
        return id
      }
      case 'destroyForSession':
        this.destroyForSession(ownerKey, localWorkspaceId)
        return undefined
      case 'beginProjectDeletion': {
        const [workspaceId, projectId] = args as [string, string]
        if (workspaceId !== req.workspaceId) {
          throw new Error('Cannot delete a Browser Project outside the owning Workspace')
        }
        this.beginProjectDeletion(localWorkspaceId, projectId)
        return undefined
      }
      case 'finishProjectDeletion': {
        const [workspaceId, projectId, deleted] = args as [string, string, boolean]
        if (workspaceId !== req.workspaceId) {
          throw new Error('Cannot finish Browser Project deletion outside the owning Workspace')
        }
        this.finishProjectDeletion(localWorkspaceId, projectId, deleted)
        return undefined
      }
      case 'clearVisualsForSession':
        await this.clearVisualsForSession(ownerKey)
        return undefined
      case 'unbindAllForSession':
        this.unbindAllForSession(ownerKey)
        return undefined
      case 'setAgentControl': {
        const [, meta] = args as [string, { displayName?: string; intent?: string }]
        this.setAgentControl(ownerKey, meta)
        return undefined
      }
      case 'clearAgentControl':
        this.clearAgentControl(ownerKey)
        return undefined

      // -- Mixed (instanceId + optional sessionId) ----------------------------
      case 'clearAgentControlForInstance': {
        const [instanceId, sessionId] = args as [string, string | undefined]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.clearAgentControlForInstance(
          instanceId,
          sessionId !== undefined ? ownerKey : undefined,
        )
      }

      // -- Instance-id only ----------------------------------------------------
      case 'getInstance': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        const live = this.getInstance(instanceId)
        if (!live) return undefined
        // `getInstance` returns the live BrowserInstance (which embeds non-
        // cloneable Electron native objects). Project to a plain snapshot
        // before crossing the IPC boundary.
        return this.toSnapshot(live)
      }
      case 'listInstances':
        return this.listInstancesForOwner(ownerKey)
      case 'bindSession': {
        const [instanceId, , options] = args as [
          string,
          string,
          { projectId?: string | null } | undefined,
        ]
        this.requireOwnedInstance(instanceId, ownerKey)
        this.bindSession(instanceId, ownerKey, {
          workspaceId: localWorkspaceId,
          projectId: options?.projectId,
        })
        return undefined
      }
      case 'focus': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        this.focus(instanceId)
        return undefined
      }
      case 'hide': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        this.hide(instanceId)
        return undefined
      }
      case 'destroyInstance': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        this.destroyInstance(instanceId)
        return undefined
      }

      // -- Navigation ----------------------------------------------------------
      case 'navigate': {
        const [instanceId, url] = args as [string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.navigate(instanceId, url)
      }
      case 'goBack': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.goBack(instanceId)
      }
      case 'goForward': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.goForward(instanceId)
      }

      // -- Interaction ---------------------------------------------------------
      case 'getAccessibilitySnapshot': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.getAccessibilitySnapshot(instanceId)
      }
      case 'clickElement': {
        const [instanceId, ref, options] = args as [
          string, string,
          { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number } | undefined,
        ]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.clickElement(instanceId, ref, options)
      }
      case 'clickAtCoordinates': {
        const [instanceId, x, y] = args as [string, number, number]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.clickAtCoordinates(instanceId, x, y)
      }
      case 'drag': {
        const [instanceId, x1, y1, x2, y2] = args as [string, number, number, number, number]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.drag(instanceId, x1, y1, x2, y2)
      }
      case 'fillElement': {
        const [instanceId, ref, value] = args as [string, string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.fillElement(instanceId, ref, value)
      }
      case 'typeText': {
        const [instanceId, text] = args as [string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.typeText(instanceId, text)
      }
      case 'selectOption': {
        const [instanceId, ref, value] = args as [string, string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.selectOption(instanceId, ref, value)
      }
      case 'sendKey': {
        const [instanceId, keyArgs] = args as [string, BrowserKeyArgs]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.sendKey(instanceId, keyArgs)
      }
      case 'scroll': {
        const [instanceId, direction, amount] = args as [
          string, 'up' | 'down' | 'left' | 'right', number | undefined,
        ]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.scroll(instanceId, direction, amount)
      }
      case 'waitFor': {
        const [instanceId, waitArgs] = args as [string, BrowserWaitArgs]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.waitFor(instanceId, waitArgs)
      }
      case 'evaluate': {
        const [instanceId, expression] = args as [string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        if (!getAllowRemoteEvaluate()) {
          throw new CodedError('BROWSER_REMOTE_EVALUATE_BLOCKED',
            'JavaScript evaluation from remote agents is disabled in this client.')
        }
        return this.evaluate(instanceId, expression)
      }

      // -- Clipboard -----------------------------------------------------------
      case 'setClipboard': {
        const [instanceId, text] = args as [string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.setClipboard(instanceId, text)
      }
      case 'getClipboard': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.getClipboard(instanceId)
      }

      // -- Capture / introspection --------------------------------------------
      case 'screenshot': {
        const [instanceId, options] = args as [string, BrowserScreenshotOptions | undefined]
        this.requireOwnedInstance(instanceId, ownerKey)
        const result = await this.screenshot(instanceId, options)
        return this.toScreenshotWire(result)
      }
      case 'screenshotRegion': {
        const [instanceId, target] = args as [string, BrowserScreenshotRegionTarget]
        this.requireOwnedInstance(instanceId, ownerKey)
        const result = await this.screenshotRegion(instanceId, target)
        return this.toScreenshotWire(result)
      }
      case 'getConsoleLogs': {
        const [instanceId, options] = args as [string, BrowserConsoleOptions | undefined]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.getConsoleLogs(instanceId, options)
      }
      case 'getNetworkLogs': {
        const [instanceId, options] = args as [string, BrowserNetworkOptions | undefined]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.getNetworkLogs(instanceId, options)
      }
      case 'windowResize': {
        const [instanceId, width, height] = args as [string, number, number]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.windowResize(instanceId, width, height)
      }
      case 'getDownloads': {
        const [instanceId, options] = args as [string, BrowserDownloadOptions | undefined]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.getDownloads(instanceId, options)
      }
      case 'uploadFile':
        throw new CodedError('BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
          'File upload from a remote agent is not supported yet. Ask the user to attach the file to the session.')
      case 'detectSecurityChallenge': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.detectSecurityChallenge(instanceId)
      }

      default: {
        const method = (req as { method?: unknown }).method
        throw new CodedError('HANDLER_ERROR', `Unknown browser capability method: ${String(method)}`)
      }
    }
  }

  private markToolbarReady(instance: BrowserInstance, reason: string): void {
    if (instance.toolbarReady || instance.window.isDestroyed()) return

    instance.toolbarReady = true
    mainLog.info(`[browser-pane] toolbar ready id=${instance.id} reason=${reason}`)

    const shouldShowNow = instance.showOnCreate || instance.pendingShowOnReady
    if (!shouldShowNow) return

    const tokenAtReady = instance.pendingShowToken
    instance.pendingShowOnReady = false

    if (instance.window.isDestroyed()) return
    if (instance.pendingShowToken !== tokenAtReady) return

    instance.window.show()
    instance.window.focus()
    instance.isVisible = true
    this.emitStateChange(instance)

  }

  // ---------------------------------------------------------------------------
  // Agent Control — persistent overlay while agent is using the browser
  // ---------------------------------------------------------------------------

  /**
   * Activate or update the agent control overlay on the browser instance
   * bound to the given session. Called from sessions.ts on browser_* tool_start events.
   */
  setAgentControl(
    sessionId: string,
    meta: { displayName?: string; intent?: string },
  ): void {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId) {
        this.clearPendingSelection(instance)
        instance.agentControl = {
          active: true,
          sessionId,
          displayName: meta.displayName,
          intent: meta.intent,
        }

        const label = this.getAgentControlLabel(instance.agentControl)

        this.reapplyAgentControlVisual(instance)
        this.emitStateChange(instance)

        mainLog.info(`[browser-pane] agent control activated session=${sessionId} label=${label}`)
        return
      }
    }
  }

  /**
   * Clear the agent control overlay for the given session.
   * Called on explicit browser_tool release and session/window teardown.
   */
  clearAgentControl(sessionId: string): void {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId && instance.agentControl?.active) {
        instance.agentControl = null
        this.applyAgentControlLock(instance, false)
        this.updateNativeOverlayState(instance)
        this.emitStateChange(instance)
        mainLog.info(`[browser-pane] agent control released session=${sessionId}`)
      }
    }
  }

  clearAgentControlForInstance(instanceId: string, sessionId?: string): { released: boolean; reason?: string } {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      return { released: false, reason: `Browser window "${instanceId}" not found.` }
    }

    if (sessionId) {
      if (instance.boundSessionId && instance.boundSessionId !== sessionId) {
        return { released: false, reason: `Browser window "${instanceId}" is locked to session ${instance.boundSessionId}.` }
      }

      if (!instance.boundSessionId && instance.ownerSessionId && instance.ownerSessionId !== sessionId) {
        return { released: false, reason: `Browser window "${instanceId}" is currently owned by session ${instance.ownerSessionId}.` }
      }
    }

    if (!instance.agentControl?.active) {
      return { released: false, reason: 'No active agent overlay on the target window.' }
    }

    instance.agentControl = null
    this.applyAgentControlLock(instance, false)
    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] agent control released instance=${instanceId}${sessionId ? ` session=${sessionId}` : ''}`)

    return { released: true }
  }

  /**
   * Extract a theme color from the page using Safari 26-style heuristics.
   * Priority: media-aware theme-color meta → elementsFromPoint (fixed/sticky headers) → body/html bg.
   * All colors pass through (including white/black) — contrast is handled by the renderer.
   * Guards against stale extraction (URL change during async executeJavaScript).
   */
  private async extractThemeColor(instance: BrowserInstance): Promise<void> {
    if (instance.themeColor) return // already set by did-change-theme-color or observer
    const urlAtStart = instance.currentUrl
    try {
      const color = await instance.pageView.webContents.executeJavaScript(`(${THEME_COLOR_EXTRACTOR_FN})()`)
      // Guard: if user navigated away during extraction, discard stale result
      if (instance.currentUrl !== urlAtStart) return
      if (typeof color === 'string' && color.length > 0) {
        this.applyThemeColor(instance, color)
      }
    } catch {
      // page destroyed or JS error — ignore
    }
  }

  private applyThemeColor(instance: BrowserInstance, color: string | null): void {
    if (instance.themeColor === color) return
    instance.themeColor = color
    if (!instance.window.isDestroyed() && !instance.toolbarView.webContents.isDestroyed()) {
      instance.toolbarView.webContents.send(TOOLBAR_CHANNELS.THEME_COLOR, color)
    }
    this.emitStateChange(instance)
  }

  private installThemeObserver(instance: BrowserInstance, allowRetry = true): void {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const urlAtInstall = instance.currentUrl
    instance.themeObserverToken = token

    void instance.pageView.webContents.executeJavaScript(`
      (() => {
        const token = ${JSON.stringify(token)};
        const prefix = ${JSON.stringify(THEME_COLOR_SIGNAL_PREFIX)} + token + ':';
        const nullSentinel = ${JSON.stringify(THEME_COLOR_NULL_SENTINEL)};
        const extractThemeColor = ${THEME_COLOR_EXTRACTOR_FN};

        const w = window;
        const previousCleanup = w.__CRAFT_THEME_OBSERVER_CLEANUP__;
        if (typeof previousCleanup === 'function') {
          try { previousCleanup(); } catch {}
        }

        let lastColor = '__unset__';
        let rafId = 0;
        let timerId = 0;
        let lastRunAt = 0;
        const minIntervalMs = ${THEME_OBSERVER_MIN_INTERVAL_MS};

        const clearScheduled = () => {
          if (timerId) {
            clearTimeout(timerId);
            timerId = 0;
          }
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
          }
        };

        const emit = (color) => {
          const normalized = typeof color === 'string' && color.length > 0 ? color : null;
          if (normalized === lastColor) return;
          lastColor = normalized;
          console.info(prefix + (normalized ?? nullSentinel));
        };

        const run = () => {
          rafId = 0;
          lastRunAt = Date.now();
          try {
            emit(extractThemeColor());
          } catch {}
        };

        const schedule = () => {
          if (rafId || timerId) return;
          const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastRunAt));
          if (waitMs > 0) {
            timerId = setTimeout(() => {
              timerId = 0;
              rafId = requestAnimationFrame(run);
            }, waitMs);
            return;
          }
          rafId = requestAnimationFrame(run);
        };

        const onScroll = () => schedule();
        const onResize = () => schedule();
        const onMutation = () => schedule();

        const headObserver = new MutationObserver(onMutation);
        if (document.head) {
          headObserver.observe(document.head, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['name', 'content', 'media'],
          });
        }

        const rootObserver = new MutationObserver(onMutation);
        if (document.documentElement) {
          rootObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style'],
          });
        }
        if (document.body) {
          rootObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style'],
          });
        }

        w.addEventListener('scroll', onScroll, { passive: true });
        w.addEventListener('resize', onResize, { passive: true });

        const mql = w.matchMedia('(prefers-color-scheme: dark)');
        const onSchemeChange = () => schedule();
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSchemeChange);
        else if (typeof mql.addListener === 'function') mql.addListener(onSchemeChange);

        w.__CRAFT_THEME_OBSERVER_CLEANUP__ = () => {
          headObserver.disconnect();
          rootObserver.disconnect();
          w.removeEventListener('scroll', onScroll);
          w.removeEventListener('resize', onResize);
          if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onSchemeChange);
          else if (typeof mql.removeListener === 'function') mql.removeListener(onSchemeChange);
          clearScheduled();
        };

        // Fast first color for initial toolbar paint and after SPA route changes
        schedule();
      })()
    `).catch(() => {
      if (!allowRetry) return
      setTimeout(() => {
        if (!this.instances.has(instance.id)) return
        if (instance.currentUrl !== urlAtInstall) return
        if (instance.themeObserverToken !== token) return
        this.installThemeObserver(instance, false)
      }, 120)
    })
  }

  private scheduleEarlyThemeExtraction(instance: BrowserInstance, urlAtSchedule: string): void {
    setTimeout(() => {
      if (!this.instances.has(instance.id)) return
      if (instance.currentUrl !== urlAtSchedule) return
      void this.extractThemeColor(instance)
    }, EARLY_THEME_EXTRACTION_DELAY_MS)
  }

  private registerPopupWindow(parentInstance: BrowserInstance, popupWindow: BrowserWindow, sourceUrl?: string): void {
    const popupWcId = popupWindow.webContents.id
    this.popupWebContentsIdByWindow.set(popupWindow, popupWcId)
    const existingParent = this.popupParentByWebContentsId.get(popupWcId)
    if (existingParent && existingParent !== parentInstance.id) {
      this.unregisterPopupWindow(popupWindow, 'reparented')
    }

    let popups = this.popupWindowsByParentInstanceId.get(parentInstance.id)
    if (!popups) {
      popups = new Set<BrowserWindow>()
      this.popupWindowsByParentInstanceId.set(parentInstance.id, popups)
    }

    popups.add(popupWindow)
    this.popupParentByWebContentsId.set(popupWcId, parentInstance.id)

    const initialUrl = sourceUrl || popupWindow.webContents.getURL?.() || 'about:blank'
    this.popupOpenedOriginByWebContentsId.set(popupWcId, originOf(initialUrl))
    this.recordPopupEvent(parentInstance, { kind: 'opened', url: initialUrl })
    mainLog.info(`[browser-pane] popup created parent=${parentInstance.id} popupWebContentsId=${popupWcId} url=${initialUrl}`)

    popupWindow.webContents.on('did-navigate', (_event, urlFromEvent) => {
      const popupUrl = typeof popupWindow.webContents.getURL === 'function'
        ? popupWindow.webContents.getURL()
        : (urlFromEvent || initialUrl)
      mainLog.info(`[browser-pane] popup did-navigate parent=${parentInstance.id} popupWebContentsId=${popupWcId} url=${popupUrl}`)
    })

    popupWindow.webContents.on('did-redirect-navigation', (_event, popupUrl, isInPlace, isMainFrame) => {
      mainLog.info(
        `[browser-pane] popup redirect parent=${parentInstance.id} popupWebContentsId=${popupWcId} url=${popupUrl} inPlace=${isInPlace} mainFrame=${isMainFrame}`,
      )
    })

    popupWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      mainLog.warn(
        `[browser-pane] popup did-fail-load parent=${parentInstance.id} popupWebContentsId=${popupWcId} code=${errorCode} url=${validatedURL} error=${errorDescription}`,
      )
    })

    popupWindow.on('closed', () => {
      this.unregisterPopupWindow(popupWindow, 'closed')
    })
  }

  private unregisterPopupWindow(popupWindow: BrowserWindow, reason: 'closed' | 'parent_destroy' | 'reparented'): void {
    // The popup is usually already destroyed here (`closed` fired), and reading
    // `popupWindow.webContents` would throw; use the id captured at registration.
    const popupWcId = this.popupWebContentsIdByWindow.get(popupWindow)
    if (popupWcId === undefined) return
    const parentId = this.popupParentByWebContentsId.get(popupWcId)
    if (!parentId) return

    this.popupParentByWebContentsId.delete(popupWcId)
    if (reason !== 'reparented') {
      this.popupWebContentsIdByWindow.delete(popupWindow)
      this.popupOpenedOriginByWebContentsId.delete(popupWcId)
    }

    const popups = this.popupWindowsByParentInstanceId.get(parentId)
    if (popups) {
      popups.delete(popupWindow)
      if (popups.size === 0) {
        this.popupWindowsByParentInstanceId.delete(parentId)
      }
    }

    mainLog.info(`[browser-pane] popup closed parent=${parentId} popupWebContentsId=${popupWcId} reason=${reason}`)
  }

  private recordPopupEvent(instance: BrowserInstance, event: Omit<PopupEvent, 'seq'>): void {
    instance.popupEvents.push({ ...event, seq: ++this.popupEventSeq })
    if (instance.popupEvents.length > MAX_POPUP_EVENTS) {
      instance.popupEvents.splice(0, instance.popupEvents.length - MAX_POPUP_EVENTS)
    }
  }

  /**
   * A sign-in popup another browser window already has open for the same origin. Every window
   * shares one cookie partition, so one sign-in serves them all; parallel sessions each opened
   * their own Google account chooser (found 2026-10-11).
   */
  private findOpenSignInPopup(url: string, requesterId: string): { window: BrowserWindow; ownerInstanceId: string } | null {
    if (!isSignInPopupUrl(url)) return null
    const origin = originOf(url)
    for (const [ownerInstanceId, popups] of this.popupWindowsByParentInstanceId) {
      if (ownerInstanceId === requesterId) continue
      for (const popupWindow of popups) {
        if (popupWindow.isDestroyed()) continue
        const popupWcId = this.popupWebContentsIdByWindow.get(popupWindow)
        const openedOrigin = popupWcId === undefined ? undefined : this.popupOpenedOriginByWebContentsId.get(popupWcId)
        let currentOrigin: string | undefined
        try {
          currentOrigin = originOf(popupWindow.webContents.getURL())
        } catch {
          // closing
        }
        if (openedOrigin === origin || currentOrigin === origin) return { window: popupWindow, ownerInstanceId }
      }
    }
    return null
  }

  /** What the agent should know about popups since `afterSeq`: they are invisible to browser_tool. */
  private describePopupEvents(instance: BrowserInstance, afterSeq: number): string | undefined {
    const events = instance.popupEvents.filter((event) => event.seq > afterSeq)
    const lines = events.map((event) => event.kind === 'opened'
      ? `The page opened a popup window (${event.url}). The user sees it; browser_tool cannot control it. Wait for it to close (e.g. after a sign-in) before reloading or navigating this page.`
      : `The page tried to open a sign-in window, but one for ${originOf(event.url)} is already open from another browser window (${event.ownerInstanceId}). All browser windows share cookies: once that sign-in finishes, reload this page instead of starting another.`)
    return lines.length > 0 ? [...new Set(lines)].join('\n') : undefined
  }

  private closePopupsForParent(parentId: string, reason: 'parent_destroy'): void {
    const popups = this.popupWindowsByParentInstanceId.get(parentId)
    if (!popups || popups.size === 0) return

    for (const popupWindow of Array.from(popups)) {
      const popupWcId = this.popupWebContentsIdByWindow.get(popupWindow)
      this.unregisterPopupWindow(popupWindow, reason)
      try {
        if (!popupWindow.isDestroyed()) {
          popupWindow.destroy()
        }
      } catch (error) {
        mainLog.warn(
          `[browser-pane] popup destroy failed parent=${parentId} popupWebContentsId=${popupWcId} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * When a page from another site commits, drop the console and network entries from before its
   * navigation started: an agent reading `console` or `network` on the new site got the previous
   * site's entries (and the app's own dev-server requests). Same-site page changes keep them.
   */
  private scopeLogsToCommittedPage(instance: BrowserInstance, url: string): void {
    const origin = originOf(url)
    const startedAt = instance.pendingNavigation?.origin === origin ? instance.pendingNavigation.startedAt : Date.now()
    instance.pendingNavigation = null
    if (instance.logOrigin !== origin) {
      // The new site's requests started with its navigation; until it committed only the old page ran scripts.
      instance.logScopeStartedAt = startedAt
      instance.networkLogs = instance.networkLogs.filter((entry) => (this.networkEntryStartedAt.get(entry) ?? entry.timestamp) >= startedAt)
      instance.consoleLogs = []
    }
    instance.logOrigin = origin
    instance.onInternalPage = this.isBrowserEmptyStateUrl(url)
  }

  private pushNetworkLog(instance: BrowserInstance, requestId: number, entry: BrowserNetworkEntry): void {
    const startedAt = this.requestStartedAt.get(requestId) ?? entry.timestamp
    this.requestStartedAt.delete(requestId)
    // A request of the previous site that finished after the new one committed.
    if (startedAt < instance.logScopeStartedAt) return
    this.networkEntryStartedAt.set(entry, startedAt)
    instance.networkLogs.push(entry)
    if (instance.networkLogs.length > MAX_NETWORK_LOG_ENTRIES) {
      instance.networkLogs.splice(0, instance.networkLogs.length - MAX_NETWORK_LOG_ENTRIES)
    }
  }

  private pushDownloadLog(instance: BrowserInstance, entry: BrowserDownloadEntry): void {
    instance.downloads.push(entry)
    if (instance.downloads.length > MAX_DOWNLOAD_LOG_ENTRIES) {
      instance.downloads.splice(0, instance.downloads.length - MAX_DOWNLOAD_LOG_ENTRIES)
    }
  }

  private resolveDownloadsDir(instance: BrowserInstance): string {
    const sessionId = instance.boundSessionId ?? instance.ownerSessionId
    if (sessionId && this.sessionPathResolver) {
      const sessionPath = this.sessionPathResolver(sessionId)
      if (sessionPath) {
        const dir = join(sessionPath, 'downloads')
        mkdirSync(dir, { recursive: true })
        return dir
      }
    }
    // Fallback: OS downloads folder for manual/unbound windows
    return app.getPath('downloads')
  }

  private uniqueFilename(dir: string, filename: string): string {
    if (!existsSync(join(dir, filename))) return filename
    const { name, ext } = parsePath(filename)
    let counter = 1
    while (existsSync(join(dir, `${name}_${counter}${ext}`))) {
      counter++
    }
    return `${name}_${counter}${ext}`
  }

  private setupSessionObservers(ses: ElectronSession): void {
    if (this.partitionObserversInitialized) return
    this.partitionObserversInitialized = true

    ses.webRequest.onBeforeRequest((details, callback) => {
      const wcId = details.webContentsId
      if (typeof wcId === 'number' && wcId > 0) {
        const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
        this.inFlightRequestsByWebContentsId.set(wcId, current + 1)
        this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())
        const instance = this.findInstanceByPageWebContentsId(wcId)
        if (instance?.onInternalPage) this.internalRequestIds.add(details.id)
        else if (instance) this.requestStartedAt.set(details.id, Date.now())
      }
      callback({})
    })

    ses.webRequest.onCompleted((details) => {
      const wcId = details.webContentsId
      if (typeof wcId !== 'number' || wcId <= 0) return

      const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
      this.inFlightRequestsByWebContentsId.set(wcId, Math.max(0, current - 1))
      this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())

      const instance = this.findInstanceByPageWebContentsId(wcId)
      if (!instance || this.internalRequestIds.delete(details.id)) return

      this.pushNetworkLog(instance, details.id, {
        timestamp: Date.now(),
        method: details.method ?? 'GET',
        url: details.url ?? '',
        status: details.statusCode ?? 0,
        resourceType: String(details.resourceType ?? 'unknown'),
        ok: (details.statusCode ?? 0) >= 200 && (details.statusCode ?? 0) < 400,
      })
    })

    ses.webRequest.onErrorOccurred((details) => {
      const wcId = details.webContentsId
      if (typeof wcId !== 'number' || wcId <= 0) return

      const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
      this.inFlightRequestsByWebContentsId.set(wcId, Math.max(0, current - 1))
      this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())

      const instance = this.findInstanceByPageWebContentsId(wcId)
      if (!instance || this.internalRequestIds.delete(details.id)) return

      this.pushNetworkLog(instance, details.id, {
        timestamp: Date.now(),
        method: details.method ?? 'GET',
        url: details.url ?? '',
        status: 0,
        resourceType: String(details.resourceType ?? 'unknown'),
        ok: false,
      })
    })

    ses.on('will-download', (_event, item, webContents) => {
      const wcId = webContents?.id
      if (typeof wcId !== 'number') return
      const instance = this.findInstanceByPageWebContentsId(wcId)
      if (!instance) return

      // Auto-save: set a deterministic path so Electron doesn't show a native dialog
      const downloadsDir = this.resolveDownloadsDir(instance)
      const filename = this.uniqueFilename(downloadsDir, item.getFilename())
      const savePath = join(downloadsDir, filename)
      item.setSavePath(savePath)

      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const started: BrowserDownloadEntry = {
        id: downloadId,
        timestamp: Date.now(),
        url: item.getURL(),
        filename,
        state: 'started',
        bytesReceived: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        mimeType: item.getMimeType() || 'application/octet-stream',
        savePath,
      }
      this.pushDownloadLog(instance, started)

      const onUpdated = (_e: Electron.Event, state: string) => {
        const latest = instance.downloads.find((d) => d.id === downloadId)
        if (!latest) return
        latest.bytesReceived = item.getReceivedBytes()
        latest.totalBytes = item.getTotalBytes()
        if (state === 'interrupted') latest.state = 'interrupted'
      }

      item.on('updated', onUpdated)

      item.once('done', (_e, state) => {
        item.removeListener('updated', onUpdated)
        const latest = instance.downloads.find((d) => d.id === downloadId)
        if (!latest) return
        latest.bytesReceived = item.getReceivedBytes()
        latest.totalBytes = item.getTotalBytes()
        latest.savePath = item.getSavePath()
        latest.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      })
    })
  }

  private logPermissionDecision(kind: 'check' | 'request', permission: string, origin: string): void {
    const isNonBlockingNoise = permission === 'background-sync'
    const suffix = isNonBlockingNoise ? ' (non-blocking)' : ''
    const message = `[browser-pane] permission denied (${kind}): ${permission} origin=${origin}${suffix}`
    if (isNonBlockingNoise) {
      mainLog.info(message)
      return
    }
    mainLog.warn(message)
  }

  private setupSessionPermissions(ses: ElectronSession): void {
    if (this.partitionPermissionsInitialized) return
    this.partitionPermissionsInitialized = true

    const allow = new Set([
      'fullscreen',
      'pointerLock',
      'window-management',
      'notifications',
      'geolocation',
      'media',
      'clipboard-read',
      'clipboard-sanitized-write',
      'idle-detection',
    ])

    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler((_webContents, permission: string, requestingOrigin: string, _details: any) => {
        const allowed = allow.has(permission)
        if (!allowed) {
          this.logPermissionDecision('check', permission, requestingOrigin)
        }
        return allowed
      })
    }

    if (typeof ses.setPermissionRequestHandler === 'function') {
      ses.setPermissionRequestHandler((_webContents, permission: string, callback: (allow: boolean) => void, details: any) => {
        const allowed = allow.has(permission)
        if (!allowed) {
          this.logPermissionDecision('request', permission, details?.requestingOrigin ?? 'unknown')
        }
        callback(allowed)
      })
    }
  }

  private isToolbarUiDocumentUrl(url: string): boolean {
    if (!url) return false
    if (url.startsWith('data:text/html')) return true

    try {
      const parsed = new URL(url)
      return parsed.pathname.toLowerCase().endsWith('/browser-toolbar.html')
    } catch {
      return /browser-toolbar\.html(?:$|[?#])/i.test(url)
    }
  }

  private setupWindowListeners(instance: BrowserInstance): void {
    const pageWc = instance.pageView.webContents
    const toolbarWc = instance.toolbarView.webContents

    instance.window.on('close', (event) => {
      const explicitDestroy = this.destroyingIds.has(instance.id)
      const interceptToHide = !explicitDestroy && instance.keepAliveOnWindowClose
      mainLog.info(`[browser-pane] window close requested id=${instance.id} explicitDestroy=${explicitDestroy} keepAlive=${instance.keepAliveOnWindowClose} interceptToHide=${interceptToHide}`)

      if (interceptToHide) {
        event.preventDefault()
        // Skip if a hide is already in flight — hide() guards against re-entry
        // itself, but bailing here also avoids redundant log noise during the
        // teardown race that triggered issue #695.
        if (!instance.isHiding) {
          this.hide(instance.id)
        }
      }
    })

    instance.window.on('resize', () => {
      this.layoutAllViews(instance)
    })

    toolbarWc.on('did-finish-load', () => {
      const loadedUrl = typeof toolbarWc.getURL === 'function' ? toolbarWc.getURL() : ''
      if (!this.isToolbarUiDocumentUrl(loadedUrl)) {
        mainLog.info(`[browser-pane] toolbar did-finish-load ignored id=${instance.id} url=${loadedUrl || 'unknown'}`)
        this.pushToolbarState(instance)
        return
      }

      this.markToolbarReady(instance, 'did-finish-load')
      this.pushToolbarState(instance)
    })

    toolbarWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      mainLog.warn(`[browser-pane] toolbar did-fail-load id=${instance.id} code=${errorCode} url=${validatedURL} error=${errorDescription}`)
    })

    pageWc.on('did-start-loading', () => {
      this.clearPendingSelection(instance)
      instance.isLoading = true
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
    })

    pageWc.on('did-stop-loading', () => {
      instance.isLoading = false
      instance.canGoBack = pageWc.canGoBack()
      instance.canGoForward = pageWc.canGoForward()
      // Drain in-flight count — all pending requests are settled once loading stops
      this.inFlightRequestsByWebContentsId.set(pageWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(pageWc.id, Date.now())
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
      void this.extractThemeColor(instance)
      this.reapplyAgentControlVisual(instance)
    })

    pageWc.on('dom-ready', () => {
      this.installThemeObserver(instance)
      void this.extractThemeColor(instance)
    })

    pageWc.on('before-input-event', (_event, _input) => {
      this.interactedCallback?.(instance.id)
      if (instance.lockState.active) {
        _event.preventDefault()
      }
    })

    toolbarWc.on('before-input-event', (event) => {
      this.interactedCallback?.(instance.id)
      if (instance.lockState.active) {
        event.preventDefault()
      }
    })

    pageWc.on('before-mouse-event', (event, mouse) => {
      if (mouse.type !== 'mouseDown') return

      this.interactedCallback?.(instance.id)
      if (instance.toolbarMenuOpen) event.preventDefault()
    })

    toolbarWc.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown') this.interactedCallback?.(instance.id)
    })

    pageWc.on('did-start-navigation', (details, urlFromEvent, isInPlace, isMainFrame) => {
      const url = details?.url ?? urlFromEvent
      if (!(details?.isMainFrame ?? isMainFrame) || (details?.isSameDocument ?? isInPlace) || !url) return
      instance.onInternalPage = this.isBrowserEmptyStateUrl(url)
      instance.pendingNavigation = { origin: originOf(url), startedAt: Date.now() }
    })

    pageWc.on('did-navigate', (_event, urlFromEvent) => {
      this.clearPendingSelection(instance)
      const url = typeof pageWc.getURL === 'function' ? pageWc.getURL() : (urlFromEvent || instance.currentUrl)
      this.scopeLogsToCommittedPage(instance, url)
      const previousUrl = instance.currentUrl
      if (instance.inPageThemeTimer) {
        clearTimeout(instance.inPageThemeTimer)
        instance.inPageThemeTimer = null
      }
      instance.themeObserverToken = null
      instance.themeColor = null // reset for new page (batched with state push below)
      const normalized = this.normalizePageState(url, pageWc.getTitle())
      instance.currentUrl = normalized.url
      instance.title = normalized.title
      mainLog.info(`[browser-pane] did-navigate id=${instance.id} from=${previousUrl} to=${instance.currentUrl}`)
      instance.canGoBack = pageWc.canGoBack()
      instance.canGoForward = pageWc.canGoForward()
      // Drain in-flight count — prior page's requests are cancelled on navigation
      this.inFlightRequestsByWebContentsId.set(pageWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(pageWc.id, Date.now())
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
      this.scheduleEarlyThemeExtraction(instance, url)
      this.reapplyAgentControlVisual(instance)
    })

    pageWc.on('did-redirect-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      mainLog.info(`[browser-pane] did-redirect-navigation id=${instance.id} url=${url} inPlace=${isInPlace}`)
    })

    pageWc.on('did-navigate-in-page', (_event, urlFromEvent) => {
      this.clearPendingSelection(instance)
      const url = typeof pageWc.getURL === 'function' ? pageWc.getURL() : (urlFromEvent || instance.currentUrl)
      const normalized = this.normalizePageState(url, instance.title)
      instance.currentUrl = normalized.url
      instance.title = normalized.title
      instance.canGoBack = pageWc.canGoBack()
      instance.canGoForward = pageWc.canGoForward()

      void this.maybeHandleEmptyStateLaunch(instance, url).then((handled) => {
        if (handled) {
          this.emitStateChange(instance)
          void this.pushToolbarState(instance)
          return
        }

        // SPA route change — re-extract theme color (debounced)
        if (instance.inPageThemeTimer) clearTimeout(instance.inPageThemeTimer)
        instance.themeObserverToken = null
        instance.themeColor = null
        this.emitStateChange(instance)
        void this.pushToolbarState(instance)
        this.installThemeObserver(instance)
        instance.inPageThemeTimer = setTimeout(() => { void this.extractThemeColor(instance) }, 300)
        this.reapplyAgentControlVisual(instance)
      }).catch((error) => {
        mainLog.warn(`[browser-pane] empty-state launch handling failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    pageWc.on('page-title-updated', (_event, title) => {
      const normalized = this.normalizePageState(pageWc.getURL(), title)
      instance.title = normalized.title
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
    })

    pageWc.on('page-favicon-updated', (_event, favicons) => {
      instance.favicon = favicons[0] || null
      this.emitStateChange(instance)
    })

    pageWc.on('did-change-theme-color', (_event, color) => {
      this.applyThemeColor(instance, color ?? null)
    })

    pageWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      mainLog.warn(`[browser-pane] did-fail-load id=${instance.id} code=${errorCode} url=${validatedURL} error=${errorDescription}`)
    })

    pageWc.on('console-message', (_event, level, message) => {
      if (message.startsWith(THEME_COLOR_SIGNAL_PREFIX)) {
        const payload = message.slice(THEME_COLOR_SIGNAL_PREFIX.length)
        const delimiterIdx = payload.indexOf(':')
        if (delimiterIdx > 0) {
          const token = payload.slice(0, delimiterIdx)
          const value = payload.slice(delimiterIdx + 1).trim()
          if (token === instance.themeObserverToken) {
            if (value === THEME_COLOR_NULL_SENTINEL) {
              this.applyThemeColor(instance, null)
            } else if (value.length > 0) {
              this.applyThemeColor(instance, value)
            }
          }
        }
        return
      }

      if (instance.onInternalPage) return
      const mappedLevel: BrowserConsoleEntry['level'] = level >= 3 ? 'error' : level === 2 ? 'warn' : level === 1 ? 'info' : 'log'
      instance.consoleLogs.push({
        timestamp: Date.now(),
        level: mappedLevel,
        message,
      })
      if (instance.consoleLogs.length > MAX_CONSOLE_LOG_ENTRIES) {
        instance.consoleLogs.splice(0, instance.consoleLogs.length - MAX_CONSOLE_LOG_ENTRIES)
      }

      if (level >= 2) {
        mainLog.warn(`[browser-pane] console id=${instance.id} level=${level}: ${message}`)
      }
    })

    pageWc.on('will-navigate', (event, url) => {
      if (url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) {
        event.preventDefault()
        void this.handleDeepLinkUrl(url)
      }
    })

    pageWc.on('did-create-window', (popupWindow, details) => {
      const popupUrl = details?.url || popupWindow.webContents.getURL?.() || 'about:blank'
      this.registerPopupWindow(instance, popupWindow, popupUrl)
    })

    pageWc.setWindowOpenHandler((details) => {
      mainLog.info(
        `[browser-pane] window-open requested id=${instance.id} url=${details.url} disposition=${details.disposition ?? 'unknown'} frameName=${details.frameName || 'none'}`,
      )

      const target = classifyWindowOpen(details)
      if (target === 'deny') {
        if (details.url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) {
          void this.handleDeepLinkUrl(details.url)
          return { action: 'deny' }
        }

        try {
          const parsed = new URL(details.url)
          mainLog.warn(`[browser-pane] window-open denied id=${instance.id} reason=unsupported_protocol protocol=${parsed.protocol} url=${details.url}`)
        } catch {
          mainLog.warn(`[browser-pane] window-open denied id=${instance.id} reason=invalid_url url=${details.url}`)
        }
        return { action: 'deny' }
      }

      if (target === 'current-page') {
        void this.navigate(instance.id, details.url).catch((error) => {
          mainLog.warn(
            `[browser-pane] same-page navigation failed id=${instance.id} url=${details.url}: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        return { action: 'deny' }
      }

      const openSignIn = this.findOpenSignInPopup(details.url, instance.id)
      if (openSignIn) {
        mainLog.info(`[browser-pane] window-open denied id=${instance.id} reason=sign_in_open_elsewhere owner=${openSignIn.ownerInstanceId} url=${details.url}`)
        this.recordPopupEvent(instance, { kind: 'joined', url: details.url, ownerInstanceId: openSignIn.ownerInstanceId })
        try {
          openSignIn.window.moveTop() // in front for the user, without stealing focus
        } catch {
          // closing
        }
        return { action: 'deny' }
      }

      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          minWidth: 420,
          minHeight: 520,
          show: true,
          autoHideMenuBar: true,
          parent: instance.window,
          modal: false,
          webPreferences: {
            partition: SESSION_PARTITION,
            session: pageWc.session,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      }
    })

    pageWc.on('focus', () => {
      this.interactedCallback?.(instance.id)
    })

    instance.window.on('focus', () => {
      this.interactedCallback?.(instance.id)
      if (!instance.targetMetadataFresh) {
        void this.refreshProjectTarget(instance)
        void this.refreshTargetChat(instance)
      }
    })

    instance.window.on('blur', () => {
      instance.targetMetadataFresh = false
    })

    instance.window.on('show', () => {
      instance.isVisible = true
      this.emitStateChange(instance)
      this.reapplyAgentControlVisual(instance)
      this.pushToolbarState(instance)
      this.updateNativeOverlayState(instance)
      void this.refreshProjectTarget(instance)
      void this.refreshTargetChat(instance)
      if (!instance.themeColor) {
        void this.extractThemeColor(instance)
      }
    })

    instance.window.on('hide', () => {
      instance.toolbarMenuRequestToken += 1
      this.forceCloseToolbarMenu(instance, 'window-hide-event')
      instance.isVisible = false
      instance.targetMetadataFresh = false
      this.emitStateChange(instance)
      this.updateNativeOverlayState(instance)
    })

    instance.window.on('closed', () => {
      this.finalizeDestroyedInstance(instance, 'closed')
    })
  }

  private toInfo(instance: BrowserInstance): BrowserInstanceInfo {
    return {
      id: instance.id,
      url: instance.currentUrl,
      title: instance.title,
      favicon: instance.favicon,
      isLoading: instance.isLoading,
      canGoBack: instance.canGoBack,
      canGoForward: instance.canGoForward,
      targetSessionId: this.getPublicSessionId(instance.targetSessionId),
      boundSessionId: this.getPublicSessionId(instance.boundSessionId),
      ownerType: instance.ownerType,
      ownerSessionId: this.getPublicSessionId(instance.ownerSessionId),
      isVisible: instance.isVisible,
      agentControlActive: !!instance.agentControl?.active,
      themeColor: instance.themeColor,
      workspaceId: instance.workspaceId,
      projectId: instance.projectId,
    }
  }

  private emitStateChange(instance: BrowserInstance): void {
    if (!this.instances.has(instance.id)) {
      return
    }
    this.stateChangeCallback?.(this.toInfo(instance))
  }
}
