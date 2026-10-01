/**
 * Tests for BrowserPaneManager.
 *
 * Mocks Electron BrowserWindow and session modules to validate lifecycle,
 * session binding, and navigation behavior.
 */

import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { i18n, setupI18n } from '@craft-agent/shared/i18n'
import * as config from '@craft-agent/shared/config'
import { RPC_CHANNELS, type Session } from '@craft-agent/shared/protocol'
import type { RpcClient, RpcServer } from '@craft-agent/server-core/transport'
import { createBrowserApplicationRouter } from '../browser-application-router'
import { handleBrowserApplicationCapability } from '../../preload/browser-application-capability'

let toolbarLoadFailuresRemaining = 0
let emptyStateLoadFailure: (Error & { code?: string }) | null = null
let webContentsViewOptions: any[] = []
let webContentsViews: Array<{ options: any; view: any }> = []
const mockShellOpenExternal = mock(async () => {})
const mockIpcMainHandle = mock(() => {})
const mockIpcMainOn = mock(() => {})
const mockMenuPopup = mock((_options?: unknown) => {})
const mockMenuClosePopup = mock((_window?: unknown) => {})
const mockMenuBuildFromTemplate = mock((template: unknown[]) => ({
  template,
  popup: mockMenuPopup,
  closePopup: mockMenuClosePopup,
}))

// Electron assigns every webContents a unique numeric id; the manager keys popup
// and page lookups on it, so the mock must too.
let nextMockWebContentsId = 1

function createMockWebContents(options?: {
  toolbar?: boolean
  session?: unknown
}) {
  const listeners: Record<string, Function[]> = {}
  let currentUrl = 'about:blank'
  return {
    id: nextMockWebContentsId++,
    userAgent: 'Mock Chrome Electron/99.0.0',
    session: options?.session ?? {},
    isDestroyed: mock(() => false),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    loadURL: mock(async (url: string) => {
      currentUrl = url
      const isToolbarUrl = typeof url === 'string' && url.includes('browser-toolbar.html')
      if (isToolbarUrl && toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    loadFile: mock(async (path: string, _opts?: unknown) => {
      if (path.includes('browser-empty-state.html') && emptyStateLoadFailure) {
        const error = emptyStateLoadFailure
        emptyStateLoadFailure = null
        throw error
      }
      if (options?.toolbar && toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    getTitle: mock(() => 'Test Page'),
    getURL: mock(() => currentUrl),
    canGoBack: mock(() => false),
    canGoForward: mock(() => false),
    goBack: mock(() => {}),
    goForward: mock(() => {}),
    reload: mock(() => {}),
    stop: mock(() => {}),
    setUserAgent: mock(() => {}),
    setBackgroundColor: mock(() => {}),
    capturePage: mock(async () => {
      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: (_opts: any) => img,
        toPNG: () => Buffer.from('fake-png'),
        toJPEG: (_quality: number) => Buffer.from('fake-jpeg'),
      }
      return img
    }),
    // The paint probe (two animation frames) resolves at once; tests that need a page that isn't
    // painting override it.
    executeJavaScript: mock(async (expr: string) => (expr.includes('requestAnimationFrame') ? true : eval(expr))),
    setBackgroundThrottling: mock((_allowed: boolean) => {}),
    focus: mock(() => {}),
    setWindowOpenHandler: mock((_handler: any) => {}),
    send: mock((_channel: string, _payload?: unknown) => {}),
    debugger: {
      attach: mock(() => {}),
      detach: mock(() => {}),
      sendCommand: mock(async () => ({ nodes: [] })),
      on: mock(() => {}),
    },
    getZoomFactor: mock(() => 1),
    _listeners: listeners,
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) {
        if (event === 'did-create-window') cb(...args)
        else cb({}, ...args)
      }
    },
  }
}

/**
 * Electron's `did-create-window` handler signature is `(window, details)` with no
 * leading event object, unlike most webContents events, so it cannot go through
 * the mock's `_emit` (which prepends one).
 */
function emitDidCreateWindow(webContents: any, popupWindow: any, details: { url?: string }): void {
  for (const cb of webContents._listeners['did-create-window'] || []) cb(popupWindow, details)
}

function createMockWebContentsView(options?: {
  toolbar?: boolean
  session?: unknown
}) {
  const webContents = createMockWebContents(options)
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  return {
    webContents,
    setBounds: mock((nextBounds: typeof bounds) => {
      bounds = nextBounds
    }),
    getBounds: mock(() => bounds),
    setVisible: mock(() => {}),
    setBackgroundColor: mock(() => {}),
    setBorderRadius: mock(() => {}),
    addChildView: mock(() => {}),
    removeChildView: mock(() => {}),
    children: [],
  }
}

function createMockView() {
  const children: any[] = []
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  return {
    children,
    addChildView: mock((view: any) => {
      const existing = children.indexOf(view)
      if (existing >= 0) children.splice(existing, 1)
      children.push(view)
    }),
    removeChildView: mock((view: any) => {
      const index = children.indexOf(view)
      if (index >= 0) children.splice(index, 1)
    }),
    setBounds: mock((nextBounds: typeof bounds) => {
      bounds = nextBounds
    }),
    getBounds: mock(() => bounds),
    setVisible: mock(() => {}),
    setBorderRadius: mock(() => {}),
  }
}

function createMockWindow(opts?: { width?: number; height?: number; minWidth?: number; minHeight?: number }) {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  let contentWidth = opts?.width ?? 1200
  let contentHeight = opts?.height ?? 900
  const minWidth = opts?.minWidth ?? 0
  const minHeight = opts?.minHeight ?? 0

  const win = {
    webContents,
    contentView: createMockView(),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    once: (event: string, cb: Function) => {
      const wrapped = (...args: any[]) => {
        listeners[event] = (listeners[event] || []).filter(fn => fn !== wrapped)
        cb(...args)
      }
      ;(wrapped as Function & { listener?: Function }).listener = cb
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(wrapped)
    },
    removeListener: (event: string, cb: Function) => {
      listeners[event] = (listeners[event] || []).filter(fn => (
        fn !== cb && (fn as Function & { listener?: Function }).listener !== cb
      ))
    },
    _listenerCount: (event: string) => listeners[event]?.length ?? 0,
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb(...args)
    },
    isDestroyed: mock(() => false),
    isMinimized: mock(() => false),
    restore: mock(() => {}),
    show: mock(() => {}),
    showInactive: mock(() => {}),
    moveTop: mock(() => {}),
    getOpacity: mock(() => 1),
    setOpacity: mock((_opacity: number) => {}),
    getBounds: mock(() => ({ x: 40, y: 60, width: contentWidth, height: contentHeight })),
    setBounds: mock((_bounds: { x: number; y: number; width: number; height: number }) => {}),
    setPosition: mock((_x: number, _y: number) => {}),
    setSkipTaskbar: mock((_skip: boolean) => {}),
    setIgnoreMouseEvents: mock((_ignore: boolean) => {}),
    setAlwaysOnTop: mock((_flag: boolean, _level?: string) => {}),
    setWindowButtonVisibility: mock((_visible: boolean) => {}),
    hide: mock(() => {
      win._emit('hide')
    }),
    focus: mock(() => {}),
    destroy: mock(() => {
      win._emit('closed')
    }),
    setBrowserView: mock((_view: any) => {}),
    addBrowserView: mock((_view: any) => {}),
    setTopBrowserView: mock((_view: any) => {}),
    getContentSize: mock(() => [contentWidth, contentHeight]),
    setContentSize: mock((width: number, height: number) => {
      contentWidth = Math.max(minWidth, Math.floor(width))
      contentHeight = Math.max(minHeight, Math.floor(height))
    }),
    loadURL: mock(async (_url: string) => {}),
  }
  return win
}

mock.module('electron', () => ({
  app: {
    getPath: mock((name: string) => name === 'downloads' ? '/tmp/mock-downloads' : `/tmp/mock-${name}`),
  },
  BrowserWindow: class MockBrowserWindow {
    webContents: any
    constructor(opts?: any) {
      const win = createMockWindow(opts)
      this.webContents = win.webContents
      Object.assign(this, win)
    }
  },
  View: class MockView {
    constructor() {
      Object.assign(this, createMockView())
    }
  },
  WebContentsView: class MockWebContentsView {
    webContents: any
    constructor(opts?: any) {
      webContentsViewOptions.push(opts)
      const view = createMockWebContentsView({
        toolbar: typeof opts?.webPreferences?.preload === 'string'
          && opts.webPreferences.preload.includes('browser-toolbar-preload'),
        session: opts?.webPreferences?.session,
      })
      this.webContents = view.webContents
      Object.assign(this, view)
      webContentsViews.push({ options: opts, view: this })
    }
  },
  ipcMain: {
    handle: mockIpcMainHandle,
    on: mockIpcMainOn,
  },
  Menu: {
    buildFromTemplate: mockMenuBuildFromTemplate,
  },
  nativeTheme: {
    shouldUseDarkColors: false,
  },
  screen: {
    getAllDisplays: mock(() => [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
    ]),
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  session: {
    fromPartition: mock(() => ({
      setPermissionCheckHandler: mock(() => {}),
      setPermissionRequestHandler: mock(() => {}),
      webRequest: {
        onBeforeRequest: mock((_cb: any) => {}),
        onCompleted: mock((_cb: any) => {}),
        onErrorOccurred: mock((_cb: any) => {}),
      },
      on: mock((_event: string, _cb: any) => {}),
    })),
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

mock.module('../browser-cdp', () => ({
  BrowserCDP: class MockBrowserCDP {
    detach = mock(() => {})
    getAccessibilitySnapshot = mock(async () => ({
      url: 'https://example.com',
      title: 'Example',
      nodes: [],
    }))
    clickElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    fillElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    selectOption = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    renderTemporaryOverlay = mock(async () => {})
    clearTemporaryOverlay = mock(async () => {})
    getViewportMetrics = mock(async () => ({ width: 1200, height: 900, dpr: 2, scrollX: 0, scrollY: 0 }))
    getElementGeometry = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    getElementGeometryBySelector = mock(async () => ({
      ref: 'selector:div.card',
      box: { x: 5, y: 5, width: 20, height: 20 },
      clickPoint: { x: 15, y: 15 },
    }))
    setViewportSize = mock(() => {})
    clearViewportSize = mock(() => {})
  },
}))

const {
  BrowserPaneManager,
  isSignInPopupUrl,
  classifyWindowOpen,
} = await import('../browser-pane-manager')

type BrowserChatTarget = import('../browser-pane-manager').BrowserChatTarget
type BrowserProjectTarget = import('../browser-pane-manager').BrowserProjectTarget
type BrowserSelectionActionResult = import('../browser-pane-manager').BrowserSelectionActionResult
type WindowOpenDetails = Parameters<typeof classifyWindowOpen>[0]

function createWindowOpenDetails(
  overrides: Partial<WindowOpenDetails> = {},
): WindowOpenDetails {
  return {
    url: 'https://example.com/child',
    frameName: '',
    features: '',
    disposition: 'default',
    referrer: {
      url: 'https://example.com/parent',
      policy: 'strict-origin-when-cross-origin',
    },
    ...overrides,
  }
}

describe('BrowserPaneManager', () => {
  let manager: InstanceType<typeof BrowserPaneManager>

  beforeEach(() => {
    setupI18n()
    toolbarLoadFailuresRemaining = 0
    emptyStateLoadFailure = null
    webContentsViewOptions = []
    webContentsViews = []
    mockShellOpenExternal.mockClear()
    mockIpcMainHandle.mockClear()
    mockIpcMainOn.mockClear()
    mockMenuBuildFromTemplate.mockClear()
    mockMenuPopup.mockClear()
    mockMenuClosePopup.mockClear()
    manager = new BrowserPaneManager()
  })

  it('creates and lists instances', () => {
    const id = manager.createInstance('test-1')
    const list = manager.listInstances()
    expect(id).toBe('test-1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('test-1')
    expect(list[0].agentControlActive).toBe(false)
  })

  it('maps thin-client capabilities through each sender window', async () => {
    manager.setWindowManager({
      getWorkspaceForWindow: (webContentsId: number) => (
        ({ 42: 'local-workspace-a', 43: 'local-workspace-b' } as Record<number, string>)[webContentsId] ?? null
      ),
    } as any)
    manager.setCapabilityRemoteWorkspaceId('remote-workspace')

    const firstId = await (manager as any).dispatchCapability({
      v: 1,
      method: 'createForSession',
      args: ['chat-a', { projectId: 'project-a' }],
      sessionId: 'chat-a',
      workspaceId: 'remote-workspace',
    }, 42)
    const secondId = await (manager as any).dispatchCapability({
      v: 1,
      method: 'createForSession',
      args: ['chat-b', { projectId: 'project-b' }],
      sessionId: 'chat-b',
      workspaceId: 'remote-workspace',
    }, 43)

    expect(manager.listInstances()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstId,
        workspaceId: 'local-workspace-a',
        projectId: 'project-a',
        ownerSessionId: 'chat-a',
      }),
      expect.objectContaining({
        id: secondId,
        workspaceId: 'local-workspace-b',
        projectId: 'project-b',
        ownerSessionId: 'chat-b',
      }),
    ]))
  })

  it('maps an ordinary remote Workspace capability through its exact sender window', async () => {
    const workspaces = spyOn(config, 'getWorkspaces').mockReturnValue([
      {
        id: 'local-workspace-a',
        remoteServer: { remoteWorkspaceId: 'remote-workspace' },
      },
      {
        id: 'local-workspace-b',
        remoteServer: { remoteWorkspaceId: 'remote-workspace' },
      },
    ] as never)
    manager.setWindowManager({
      getWorkspaceForWindow: (webContentsId: number) => (
        webContentsId === 43 ? 'local-workspace-b' : null
      ),
    } as any)

    try {
      const id = await (manager as any).dispatchCapability({
        v: 1,
        method: 'createForSession',
        args: ['chat-b', { projectId: 'project-b' }],
        sessionId: 'chat-b',
        workspaceId: 'remote-workspace',
      }, 43)

      expect(manager.listInstances()).toContainEqual(expect.objectContaining({
        id,
        workspaceId: 'local-workspace-b',
        projectId: 'project-b',
      }))
    } finally {
      workspaces.mockRestore()
    }
  })

  it('fails closed when a remote Workspace mapping is ambiguous without a sender window', async () => {
    const workspaces = spyOn(config, 'getWorkspaces').mockReturnValue([
      {
        id: 'local-workspace-a',
        remoteServer: { remoteWorkspaceId: 'remote-workspace' },
      },
      {
        id: 'local-workspace-b',
        remoteServer: { remoteWorkspaceId: 'remote-workspace' },
      },
    ] as never)

    try {
      await expect((manager as any).dispatchCapability({
        v: 1,
        method: 'createForSession',
        args: ['chat', { projectId: 'project' }],
        sessionId: 'chat',
        workspaceId: 'remote-workspace',
      })).rejects.toThrow('not uniquely hosted')
    } finally {
      workspaces.mockRestore()
    }
  })

  it('creates the native overlay with a transparent guest page', () => {
    manager.createInstance('transparent-overlay')

    const overlayOptions = webContentsViewOptions.find(options => (
      options?.webPreferences?.preload?.includes('browser-overlay-preload')
    ))
    const overlayView = webContentsViews.find(({ options }) => (
      options?.webPreferences?.preload?.includes('browser-overlay-preload')
    ))?.view
    expect(overlayOptions?.webPreferences?.transparent).toBe(true)
    expect(overlayView?.setBackgroundColor).toHaveBeenCalledWith('#00000000')
  })

  it('renders the same split Add Note actions as PDF and EPUB readers', () => {
    manager.createInstance('selection-actions')

    const overlayView = webContentsViews.find(({ options }) => (
      options?.webPreferences?.preload?.includes('browser-overlay-preload')
    ))?.view
    const loadedUrl = overlayView?.webContents.loadURL.mock.calls[0]?.[0] as string
    const html = decodeURIComponent(loadedUrl.slice(loadedUrl.indexOf(',') + 1))

    expect(html).toContain('data-browser-selection-action="add-chat"')
    expect(html).toContain('data-browser-selection-action="new-chat"')
    expect(html).toContain('data-browser-selection-action="add-note"')
    expect(html).toContain('data-browser-selection-action="choose-note-target"')
  })

  it('localizes the native selection actions with the main-process language', async () => {
    setupI18n()
    await i18n.changeLanguage('zh-Hans')
    try {
      manager.createInstance('localized-selection-actions')

      const overlayView = webContentsViews.find(({ options }) => (
        options?.webPreferences?.preload?.includes('browser-overlay-preload')
      ))?.view
      const loadedUrl = overlayView?.webContents.loadURL.mock.calls[0]?.[0] as string
      const html = decodeURIComponent(loadedUrl.slice(loadedUrl.indexOf(',') + 1))

      expect(html).toContain('添加到笔记')
      expect(html).toContain('选择笔记文件')
      expect(html).toContain('添加到聊天')
      expect(html).toContain('新聊天')
      expect(html).not.toContain('>Add Note<')
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('rejects an explicit duplicate ID instead of reusing a different scope', () => {
    expect(manager.createInstance('same-id')).toBe('same-id')
    expect(() => manager.createInstance('same-id')).toThrow('Browser instance already exists')
    expect(manager.listInstances()).toHaveLength(1)
  })

  describe('window.open classification', () => {
    it('routes ordinary tab dispositions to the current page', () => {
      expect(classifyWindowOpen(createWindowOpenDetails({
        disposition: 'foreground-tab',
      }))).toBe('current-page')
      expect(classifyWindowOpen(createWindowOpenDetails({
        disposition: 'background-tab',
      }))).toBe('current-page')
    })

    it('routes a default _blank without popup features to the current page', () => {
      expect(classifyWindowOpen(createWindowOpenDetails({
        disposition: 'default',
        frameName: '_blank',
        features: 'noopener,noreferrer',
      }))).toBe('current-page')
    })

    it('keeps explicit window dispositions as native popups', () => {
      expect(classifyWindowOpen(createWindowOpenDetails({
        disposition: 'new-window',
      }))).toBe('native-popup')
      expect(classifyWindowOpen(createWindowOpenDetails({
        disposition: 'other',
      }))).toBe('native-popup')
    })

    it('treats strong popup dimensions as native popup signals', () => {
      expect(classifyWindowOpen(createWindowOpenDetails({
        features: 'noopener,width=520,height=720',
      }))).toBe('native-popup')
    })

    it('keeps non-reserved named windows as native popups', () => {
      expect(classifyWindowOpen(createWindowOpenDetails({
        frameName: 'oauth-consent',
      }))).toBe('native-popup')
    })

    it('keeps target-blank form posts as native popups', () => {
      expect(classifyWindowOpen(createWindowOpenDetails({
        frameName: '_blank',
        postBody: {
          contentType: 'application/x-www-form-urlencoded',
          data: [],
        },
      }))).toBe('native-popup')
    })

    it('denies deep links and non-http protocols', () => {
      expect(classifyWindowOpen(createWindowOpenDetails({
        url: 'craftagents://settings',
      }))).toBe('deny')
      expect(classifyWindowOpen(createWindowOpenDetails({
        url: 'mailto:hello@example.com',
      }))).toBe('deny')
    })
  })

  it('navigates ordinary window.open requests in the existing browser instance', async () => {
    manager.createInstance('same-page-parent', {
      ownerType: 'session',
      ownerSessionId: 'session-1',
      workspaceId: 'workspace-1',
    })
    const parent = (manager as any).instances.get('same-page-parent')
    const openHandler = parent.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]
    parent.pageView.webContents.loadURL.mockClear()

    for (const disposition of [
      'foreground-tab',
      'background-tab',
      'default',
    ] as const) {
      const url = `https://example.com/${disposition}`
      const result = openHandler(createWindowOpenDetails({
        url,
        disposition,
        frameName: '_blank',
      }))

      expect(result).toEqual({ action: 'deny' })
      await Bun.sleep(0)
      expect(parent.pageView.webContents.loadURL).toHaveBeenLastCalledWith(url)
    }

    expect(manager.listInstances()).toHaveLength(1)
    expect(parent.boundSessionId).toBe('session-1')
    expect((manager as any).popupWindowsByParentInstanceId.has(parent.id))
      .toBe(false)
  })

  it('keeps new-window as a native popup with the shared browser partition', () => {
    manager.createInstance('popup-allow')
    const instance = (manager as any).instances.get('popup-allow')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler(createWindowOpenDetails({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      disposition: 'new-window',
      frameName: 'oauth-popup',
    }))

    expect(result.action).toBe('allow')
    expect(result.createWindow).toBeUndefined()
    expect(result.outlivesOpener).toBeUndefined()
    expect(result.overrideBrowserWindowOptions?.webPreferences?.partition).toBe('persist:browser-pane')
    expect(result.overrideBrowserWindowOptions?.webPreferences?.nodeIntegration).toBe(false)
    expect(result.overrideBrowserWindowOptions?.webPreferences?.contextIsolation).toBe(true)
  })

  it('denies app deep-link popups and forwards to deep-link handler', async () => {
    manager.createInstance('popup-deeplink')
    const instance = (manager as any).instances.get('popup-deeplink')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler(createWindowOpenDetails({
      url: 'craftagents://settings',
      disposition: 'new-window',
      frameName: '',
    }))

    expect(result).toEqual({ action: 'deny' })
    await Bun.sleep(0)
    expect(mockShellOpenExternal).toHaveBeenCalledWith('craftagents://settings')
  })

  it('denies non-http window.open requests', () => {
    manager.createInstance('popup-deny-protocol')
    const instance = (manager as any).instances.get('popup-deny-protocol')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    expect(openHandler(createWindowOpenDetails({
      url: 'file:///tmp/private.txt',
      disposition: 'default',
    }))).toEqual({ action: 'deny' })
  })

  it('destroys child popups when parent instance is destroyed', () => {
    manager.createInstance('popup-parent')
    const instance = (manager as any).instances.get('popup-parent')

    const popupWindow = createMockWindow({ width: 520, height: 720 })
    emitDidCreateWindow(instance.pageView.webContents, popupWindow, { url: 'https://accounts.google.com/signin' })

    expect((manager as any).popupWindowsByParentInstanceId.get('popup-parent')?.size).toBe(1)

    manager.destroyInstance('popup-parent')

    expect(popupWindow.destroy).toHaveBeenCalledTimes(1)
    expect((manager as any).popupWindowsByParentInstanceId.has('popup-parent')).toBe(false)
  })

  it('destroys instances', () => {
    manager.createInstance('d1')
    manager.destroyInstance('d1')
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('destroys only native runtimes owned by the deleted Project', () => {
    manager.createInstance('project-a', { workspaceId: 'workspace-1', projectId: 'project-a' })
    manager.createInstance('project-b', { workspaceId: 'workspace-1', projectId: 'project-b' })
    manager.createInstance('other-workspace', { workspaceId: 'workspace-2', projectId: 'project-a' })

    manager.destroyForProject('workspace-1', 'project-a')

    expect(manager.listInstances().map(instance => instance.id)).toEqual([
      'project-b',
      'other-workspace',
    ])
  })

  it('blocks Browser creation from the start of Project deletion until an aborted deletion is released', () => {
    manager.createInstance('preserved-after-abort', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })
    manager.beginProjectDeletion('workspace-1', 'project-a')

    expect(manager.listInstances().map(instance => instance.id))
      .toContain('preserved-after-abort')

    expect(() => manager.createInstance('blocked-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })).toThrow('Browser Project is being deleted')

    manager.finishProjectDeletion('workspace-1', 'project-a', false)
    expect(manager.listInstances().map(instance => instance.id))
      .toContain('preserved-after-abort')
    expect(manager.createInstance('released-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })).toBe('released-project')
  })

  it('keeps Browser creation blocked after Project deletion commits', () => {
    manager.createInstance('destroyed-after-commit', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })
    manager.beginProjectDeletion('workspace-1', 'project-a')
    expect(manager.listInstances().map(instance => instance.id))
      .toContain('destroyed-after-commit')
    manager.finishProjectDeletion('workspace-1', 'project-a', true)

    expect(manager.listInstances().map(instance => instance.id))
      .not.toContain('destroyed-after-commit')

    expect(() => manager.createInstance('deleted-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })).toThrow('Browser Project is unavailable')
  })

  it('does not let a Browser leave a Project while that Project is being deleted', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => [
        { id: 'project-a', title: 'Project A' },
        { id: 'project-b', title: 'Project B' },
      ]),
      listChatTargets: mock(async () => []),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'unused',
        targetTitle: 'Unused',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('deleting-project-switch', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })
    manager.beginProjectDeletion('workspace-1', 'project-a')

    await expect(manager.setProject('deleting-project-switch', 'project-b'))
      .rejects.toThrow('Current Project is unavailable')
    manager.finishProjectDeletion('workspace-1', 'project-a', true)

    expect(manager.listInstances().map(instance => instance.id))
      .not.toContain('deleting-project-switch')
  })

  it('destroys a stale Browser instead of moving it after its Project disappeared', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => [
        { id: 'project-b', title: 'Project B' },
      ]),
      listChatTargets: mock(async () => []),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'unused',
        targetTitle: 'Unused',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('stale-project-switch', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })

    const outcome = await manager.setProject('stale-project-switch', 'project-b').then(
      () => 'moved',
      error => error instanceof Error ? error.message : String(error),
    )
    manager.reconcileWorkspace('workspace-1', { projectIds: ['project-b'] })

    expect(outcome).toBe('Current Project is unavailable')
    expect(manager.listInstances().map(instance => instance.id))
      .not.toContain('stale-project-switch')
  })

  it('settles a disconnected Project deletion gate from the authoritative Project list', () => {
    manager.beginProjectDeletion('workspace-1', 'project-kept')
    manager.beginProjectDeletion('workspace-1', 'project-deleted')

    manager.reconcileWorkspace('workspace-1', {
      projectIds: ['project-kept'],
    })

    expect(manager.createInstance('restored-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-kept',
    })).toBe('restored-project')
    expect(() => manager.createInstance('removed-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-deleted',
    })).toThrow('Browser Project is unavailable')
  })

  it('destroys hidden Browser windows whose Project disappeared while disconnected', () => {
    manager.createInstance('kept-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-kept',
    })
    manager.createInstance('deleted-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-deleted',
    })
    manager.createInstance('other-workspace-project', {
      workspaceId: 'workspace-2',
      projectId: 'project-deleted',
    })

    manager.reconcileWorkspace('workspace-1', {
      projectIds: ['project-kept'],
    })

    expect(manager.listInstances().map(instance => instance.id)).toEqual([
      'kept-project',
      'other-workspace-project',
    ])
  })

  it('reconciles Chat ownership without destroying an otherwise valid manual Browser', () => {
    manager.createForSession('kept-chat', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })
    manager.createForSession('deleted-chat', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })
    manager.createInstance('manual-deleted-target', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
      targetSessionId: 'deleted-chat',
    })
    manager.createInstance('manual-kept-target', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
      targetSessionId: 'kept-chat',
    })

    manager.reconcileWorkspace('workspace-1', {
      sessions: [{ id: 'kept-chat', projectId: 'project-a' }],
    })

    expect(manager.listInstances()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerSessionId: 'kept-chat' }),
      expect.objectContaining({ id: 'manual-deleted-target', targetSessionId: null }),
      expect.objectContaining({ id: 'manual-kept-target', targetSessionId: 'kept-chat' }),
    ]))
    expect(manager.listInstances().some(instance => (
      instance.ownerSessionId === 'deleted-chat'
    ))).toBe(false)
  })

  it('rejects a reconciled Chat target that moved to another Project', () => {
    manager.createForSession('moved-owner', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })
    manager.createInstance('manual-moved-target', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
      targetSessionId: 'moved-target',
    })

    manager.reconcileWorkspace('workspace-1', {
      sessions: [
        { id: 'moved-owner', projectId: 'project-b' },
        { id: 'moved-target', projectId: 'project-b' },
      ],
    })

    expect(manager.listInstances()).toEqual([
      expect.objectContaining({ id: 'manual-moved-target', targetSessionId: null }),
    ])
  })

  it('clears a manual Browser target when its Chat is deleted', () => {
    manager.createInstance('manual-target', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
      targetSessionId: 'session-a',
    })

    manager.destroyForSession('session-a')

    expect(manager.listInstances()).toEqual([
      expect.objectContaining({ id: 'manual-target', targetSessionId: null }),
    ])
  })

  it('clears a manual Browser target when a remote Chat is deleted', () => {
    manager.createInstance('remote-manual-target', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
      targetSessionId: 'session-a',
    })

    manager.destroyForSession('remote:workspace-1:session-a')

    expect(manager.listInstances()).toEqual([
      expect.objectContaining({ id: 'remote-manual-target', targetSessionId: null }),
    ])
  })

  it('does not clear the same Chat id in another Workspace', () => {
    manager.createInstance('workspace-a-target', {
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      targetSessionId: 'shared-session-id',
    })
    manager.createInstance('workspace-b-target', {
      workspaceId: 'workspace-b',
      projectId: 'project-b',
      targetSessionId: 'shared-session-id',
    })

    manager.destroyForSession('shared-session-id', 'workspace-a')

    expect(manager.listInstances()).toEqual([
      expect.objectContaining({ id: 'workspace-a-target', targetSessionId: null }),
      expect.objectContaining({ id: 'workspace-b-target', targetSessionId: 'shared-session-id' }),
    ])
  })

  it('destroys an idle Chat-owned Browser when that Chat is deleted', () => {
    const id = manager.createForSession('session-a', {
      workspaceId: 'workspace-1',
      projectId: 'project-a',
    })
    manager.unbindAllForSession('session-a')

    manager.destroyForSession('session-a')

    expect(manager.listInstances().some(instance => instance.id === id)).toBe(false)
  })

  it('destroys instance from the native Browser window menu', async () => {
    manager.createInstance('d-ipc-destroy')
    manager.registerToolbarIpc()

    const showMenuRegistration = (
      mockIpcMainHandle.mock.calls as unknown as Array<[
        string,
        (_event: unknown, instanceId: string, kind: 'bookmarks' | 'window') => Promise<void>,
      ]>
    ).find(([channel]) => channel === 'browser-toolbar:show-menu')

    expect(showMenuRegistration).toBeTruthy()
    if (!showMenuRegistration) throw new Error('Expected browser-toolbar:show-menu IPC registration')

    const [, showMenu] = showMenuRegistration
    const instance = (manager as any).instances.get('d-ipc-destroy')
    await showMenu({ sender: instance.toolbarView.webContents }, 'd-ipc-destroy', 'window')
    const template = mockMenuBuildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
      label?: string
      click?: () => void
    }>
    template.at(-1)?.click?.()

    expect(manager.listInstances()).toHaveLength(0)
  })

  it('replays current state when the toolbar renderer subscribes', () => {
    manager.createInstance('toolbar-state-request')
    manager.registerToolbarIpc()

    const registration = (
      mockIpcMainOn.mock.calls as unknown as Array<[
        string,
        (event: { sender: { id: number } }, instanceId: string) => void,
      ]>
    ).find(([channel]) => channel === 'browser-toolbar:request-state')
    expect(registration).toBeTruthy()
    if (!registration) throw new Error('Expected browser-toolbar:request-state IPC registration')

    const instance = (manager as any).instances.get('toolbar-state-request')
    instance.currentUrl = 'https://example.com/restored'
    instance.title = 'Restored'
    instance.canGoBack = true

    const sendsBeforeRequest = instance.toolbarView.webContents.send.mock.calls.length
    registration[1]({ sender: instance.toolbarView.webContents }, 'toolbar-state-request')

    expect(instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeRequest)).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://example.com/restored',
        title: 'Restored',
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
        themeColor: null,
        targetSessionId: null,
        targetChatTitle: null,
        targetNotePath: null,
        selectionFeedback: null,
        canChooseTargetChat: true,
        projectId: null,
        projectTitle: null,
        canChooseProject: true,
      },
    ])
  })

  it('persists toolbar bookmarks and syncs browsers in the same Workspace', async () => {
    const workspaceA = mkdtempSync(join(tmpdir(), 'browser-bookmarks-a-'))
    const workspaceB = mkdtempSync(join(tmpdir(), 'browser-bookmarks-b-'))
    try {
      manager.createInstance('bookmark-current', { workspaceId: 'ws-a' })
      manager.createInstance('bookmark-peer', { workspaceId: 'ws-a' })
      manager.createInstance('bookmark-other-workspace', { workspaceId: 'ws-b' })
      manager.createInstance('bookmark-unbound')
      const testManager = manager as any
      testManager.resolveBookmarkWorkspaceRoot = (instance: { workspaceId: string | null }) => {
        if (!instance.workspaceId) instance.workspaceId = 'ws-a'
        return instance.workspaceId === 'ws-a' ? workspaceA : workspaceB
      }
      manager.registerToolbarIpc()

      const registrations = new Map(
        (mockIpcMainHandle.mock.calls as unknown as Array<[
          string,
          (...args: any[]) => Promise<any>,
        ]>),
      )
      const toggle = registrations.get('browser-toolbar:toggle-bookmark')
      const list = registrations.get('browser-toolbar:list-bookmarks')
      const showMenu = registrations.get('browser-toolbar:show-menu')
      expect(toggle).toBeTruthy()
      expect(list).toBeTruthy()
      expect(showMenu).toBeTruthy()
      if (!toggle || !list || !showMenu) {
        throw new Error('Expected browser bookmark IPC registrations')
      }

      const current = testManager.instances.get('bookmark-current')
      current.currentUrl = 'https://example.com/article'
      current.title = 'Example article'

      const toggled = await toggle({}, 'bookmark-current')
      expect(toggled.isBookmarked).toBe(true)
      expect(await list({}, 'bookmark-peer')).toEqual(toggled.bookmarks)

      const peer = testManager.instances.get('bookmark-peer')
      expect(peer.toolbarView.webContents.send).toHaveBeenCalledWith(
        'browser-toolbar:bookmarks-changed',
        toggled.bookmarks,
      )
      const otherWorkspace = testManager.instances.get('bookmark-other-workspace')
      expect(otherWorkspace.toolbarView.webContents.send).not.toHaveBeenCalledWith(
        'browser-toolbar:bookmarks-changed',
        toggled.bookmarks,
      )
      const unbound = testManager.instances.get('bookmark-unbound')
      expect(unbound.workspaceId).toBeNull()
      expect(unbound.toolbarView.webContents.send).not.toHaveBeenCalledWith(
        'browser-toolbar:bookmarks-changed',
        toggled.bookmarks,
      )

      await showMenu(
        { sender: current.toolbarView.webContents },
        'bookmark-current',
        'bookmarks',
      )
      const template = mockMenuBuildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
        label?: string
        submenu?: Array<{ click?: () => void }>
      }>
      const removeMenu = template.find(item => Array.isArray(item.submenu))
      removeMenu?.submenu?.[0].click?.()

      expect(await list({}, 'bookmark-current')).toEqual([])
    } finally {
      rmSync(workspaceA, { recursive: true, force: true })
      rmSync(workspaceB, { recursive: true, force: true })
    }
  })

  it('shows bookmarks in a native menu without expanding over the page', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'browser-native-menu-'))
    try {
      manager.createInstance('bookmark-menu')
      ;(manager as any).resolveBookmarkWorkspaceRoot = () => workspaceRoot
      manager.registerToolbarIpc()

      const registrations = new Map(
        mockIpcMainHandle.mock.calls as unknown as Array<[
          string,
          (...args: any[]) => Promise<any>,
        ]>,
      )
      const showMenu = registrations.get('browser-toolbar:show-menu')
      expect(showMenu).toBeTruthy()
      if (!showMenu) throw new Error('Expected browser toolbar native menu IPC registration')

      const instance = (manager as any).instances.get('bookmark-menu')
      await showMenu(
        { sender: instance.toolbarView.webContents },
        'bookmark-menu',
        'bookmarks',
      )

      expect(instance.toolbarMenuOpen).toBe(true)
      expect(instance.toolbarView.getBounds()).toEqual({
        x: 0,
        y: 0,
        width: 1200,
        height: 48,
      })
      expect(instance.nativeOverlayView.getBounds()).toEqual({ x: 0, y: 0, width: 0, height: 0 })
      expect(mockMenuPopup).toHaveBeenCalledTimes(1)

      const popupOptions = mockMenuPopup.mock.calls[0][0] as { callback: () => void }
      popupOptions.callback()
      expect(instance.toolbarMenuOpen).toBe(false)
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('switches a manual Browser Project from the native toolbar menu', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => [
        { id: 'project-1', title: 'Project 1' },
        { id: 'project-2', title: 'Project 2' },
      ]),
      listChatTargets: mock(async () => []),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'unused',
        targetTitle: 'Unused',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('project-menu', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    manager.registerToolbarIpc()

    const registrations = new Map(
      mockIpcMainHandle.mock.calls as unknown as Array<[
        string,
        (...args: any[]) => Promise<any>,
      ]>,
    )
    const showMenu = registrations.get('browser-toolbar:show-menu')
    expect(showMenu).toBeTruthy()
    if (!showMenu) throw new Error('Expected browser toolbar native menu IPC registration')

    const instance = (manager as any).instances.get('project-menu')
    await showMenu(
      { sender: instance.toolbarView.webContents },
      'project-menu',
      'projects',
    )
    const template = mockMenuBuildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
      label?: string
      checked?: boolean
      click?: () => void
    }>
    expect(template.map(item => ({ label: item.label, checked: item.checked }))).toEqual([
      { label: 'Project 1', checked: true },
      { label: 'Project 2', checked: false },
    ])

    template[1]?.click?.()
    await Bun.sleep(0)

    expect(manager.listInstances().find(item => item.id === 'project-menu'))
      .toMatchObject({ projectId: 'project-2', targetSessionId: null })
  })

  it('does not show a Project menu after its Browser is hidden or destroyed', async () => {
    let deferProjectTargets = false
    let finish: ((targets: BrowserProjectTarget[]) => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(() => deferProjectTargets
        ? new Promise<BrowserProjectTarget[]>(resolve => { finish = resolve })
        : Promise.resolve([{ id: 'project-1', title: 'Project 1' }])),
      listChatTargets: mock(async () => []),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'unused',
        targetTitle: 'Unused',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('destroyed-project-menu', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    manager.createInstance('hidden-project-menu', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    await Promise.resolve()
    manager.registerToolbarIpc()
    const registrations = new Map(
      mockIpcMainHandle.mock.calls as unknown as Array<[
        string,
        (...args: any[]) => Promise<any>,
      ]>,
    )
    const showMenu = registrations.get('browser-toolbar:show-menu')
    if (!showMenu) throw new Error('Expected browser toolbar native menu IPC registration')
    const instance = (manager as any).instances.get('destroyed-project-menu')
    deferProjectTargets = true
    mockMenuBuildFromTemplate.mockClear()
    mockMenuPopup.mockClear()

    const pending = showMenu(
      { sender: instance.toolbarView.webContents },
      instance.id,
      'projects',
    )
    manager.destroyInstance(instance.id)
    finish!([{ id: 'project-1', title: 'Project 1' }])
    await pending

    expect(mockMenuBuildFromTemplate).not.toHaveBeenCalled()
    expect(mockMenuPopup).not.toHaveBeenCalled()

    const hiddenInstance = (manager as any).instances.get('hidden-project-menu')
    mockMenuBuildFromTemplate.mockClear()
    mockMenuPopup.mockClear()
    const hiddenPending = showMenu(
      { sender: hiddenInstance.toolbarView.webContents },
      hiddenInstance.id,
      'projects',
    )
    hiddenInstance.window._emit('hide')
    finish!([{ id: 'project-1', title: 'Project 1' }])
    await hiddenPending

    expect(mockMenuBuildFromTemplate).not.toHaveBeenCalled()
    expect(mockMenuPopup).not.toHaveBeenCalled()
  })

  it('keeps the newest toolbar menu when an older Chat menu resolves later', async () => {
    let deferChatTargets = false
    let finishChats: ((targets: BrowserChatTarget[]) => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(async () => [
        { id: 'project-1', title: 'Project 1' },
        { id: 'project-2', title: 'Project 2' },
      ]),
      listChatTargets: mock(() => deferChatTargets
        ? new Promise<BrowserChatTarget[]>(resolve => { finishChats = resolve })
        : Promise.resolve([])),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'unused',
        targetTitle: 'Unused',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('latest-toolbar-menu', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    await Promise.resolve()
    manager.registerToolbarIpc()
    const registrations = new Map(
      mockIpcMainHandle.mock.calls as unknown as Array<[
        string,
        (...args: any[]) => Promise<any>,
      ]>,
    )
    const showMenu = registrations.get('browser-toolbar:show-menu')
    if (!showMenu) throw new Error('Expected browser toolbar native menu IPC registration')
    const instance = (manager as any).instances.get('latest-toolbar-menu')
    deferChatTargets = true
    mockMenuBuildFromTemplate.mockClear()
    mockMenuPopup.mockClear()

    const staleMenu = showMenu(
      { sender: instance.toolbarView.webContents },
      instance.id,
      'chats',
    )
    await showMenu(
      { sender: instance.toolbarView.webContents },
      instance.id,
      'projects',
    )
    finishChats!([{
      id: 'old-chat',
      title: 'Old Chat',
      noteTargetPath: null,
    }])
    await staleMenu

    expect(mockMenuBuildFromTemplate).toHaveBeenCalledTimes(1)
    expect(mockMenuBuildFromTemplate.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ label: 'Project 1', checked: true }),
      expect.objectContaining({ label: 'Project 2', checked: false }),
    ])
    expect(mockMenuPopup).toHaveBeenCalledTimes(1)
  })

  it('localizes native toolbar menus with the main-process language', async () => {
    setupI18n()
    await i18n.changeLanguage('zh-Hans')
    try {
      manager.createInstance('localized-menu')
      manager.registerToolbarIpc()

      const registrations = new Map(
        mockIpcMainHandle.mock.calls as unknown as Array<[
          string,
          (...args: any[]) => Promise<any>,
        ]>,
      )
      const showMenu = registrations.get('browser-toolbar:show-menu')
      expect(showMenu).toBeTruthy()
      if (!showMenu) throw new Error('Expected browser toolbar native menu IPC registration')

      const instance = (manager as any).instances.get('localized-menu')
      await showMenu(
        { sender: instance.toolbarView.webContents },
        'localized-menu',
        'window',
      )

      const template = mockMenuBuildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
        label?: string
      }>
      expect(template[0]?.label).toBe('隐藏窗口')
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('rejects native toolbar menu requests from another sender', async () => {
    manager.createInstance('owned-menu')
    manager.registerToolbarIpc()

    const registrations = new Map(
      mockIpcMainHandle.mock.calls as unknown as Array<[
        string,
        (...args: any[]) => Promise<any>,
      ]>,
    )
    const showMenu = registrations.get('browser-toolbar:show-menu')
    expect(showMenu).toBeTruthy()
    if (!showMenu) throw new Error('Expected browser toolbar native menu IPC registration')

    await showMenu({ sender: { id: 999 } }, 'owned-menu', 'window')

    expect(mockMenuBuildFromTemplate).not.toHaveBeenCalled()
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('shows a localized unavailable item when bookmark storage is invalid', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'browser-invalid-bookmarks-'))
    try {
      writeFileSync(
        join(workspaceRoot, 'browser-bookmarks.json'),
        '{"version":999,"bookmarks":[]}',
      )
      manager.createInstance('invalid-bookmarks-menu')
      ;(manager as any).resolveBookmarkWorkspaceRoot = () => workspaceRoot
      manager.registerToolbarIpc()

      const registrations = new Map(
        mockIpcMainHandle.mock.calls as unknown as Array<[
          string,
          (...args: any[]) => Promise<any>,
        ]>,
      )
      const showMenu = registrations.get('browser-toolbar:show-menu')
      expect(showMenu).toBeTruthy()
      if (!showMenu) throw new Error('Expected browser toolbar native menu IPC registration')

      const instance = (manager as any).instances.get('invalid-bookmarks-menu')
      await showMenu(
        { sender: instance.toolbarView.webContents },
        'invalid-bookmarks-menu',
        'bookmarks',
      )

      const template = mockMenuBuildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
        label?: string
        enabled?: boolean
      }>
      expect(template).toEqual([{
        label: i18n.t('browser.bookmarksUnavailable'),
        enabled: false,
      }])
      expect(mockMenuPopup).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('emits removed callback exactly once when destroy triggers closed', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))

    manager.createInstance('d-removed-once')
    manager.destroyInstance('d-removed-once')

    expect(removed).toEqual(['d-removed-once'])
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('ignores late state events after instance was removed', () => {
    const states: string[] = []
    manager.onStateChange((info) => states.push(info.id))

    manager.createInstance('d-late-state')
    const instance = (manager as any).instances.get('d-late-state')
    states.length = 0

    manager.destroyInstance('d-late-state')
    const countAfterDestroy = states.length

    instance.window._emit('hide')
    instance.window._emit('show')

    expect(states.length).toBe(countAfterDestroy)
  })

  it('binds and unbinds sessions', () => {
    manager.createInstance('b1')
    manager.bindSession('b1', 'session-abc')
    expect(manager.listInstances()[0].boundSessionId).toBe('session-abc')
    expect(manager.listInstances()[0].ownerType).toBe('session')

    manager.unbindSession('b1')
    expect(manager.listInstances()[0].boundSessionId).toBeNull()
    expect(manager.listInstances()[0].ownerType).toBe('session')
  })

  it('createForSession returns canonical bound instance', () => {
    const id1 = manager.createForSession('sess-1')
    const id2 = manager.createForSession('sess-1')
    const info = manager.listInstances()[0]

    expect(id1).toBe(id2)
    expect(info.ownerType).toBe('session')
    expect(info.ownerSessionId).toBe('sess-1')
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('records the owning Project and target Chat for a session-created Browser window', () => {
    const id = manager.createForSession('sess-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })

    expect(manager.listInstances().find(instance => instance.id === id)).toMatchObject({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'sess-project',
    })
  })

  it('lets a manual Browser choose only a Chat in its own Project', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => [{ id: 'project-1', title: 'Project 1' }]),
      listChatTargets: mock(async () => [{ id: 'session-1', title: 'Chat 1', noteTargetPath: null }]),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({ sessionId: 'session-1', targetTitle: 'Chat 1', noteTargetPath: null })),
    })
    manager.createInstance('manual-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })

    await manager.setTargetSession('manual-project', 'session-1')
    expect(manager.listInstances()[0].targetSessionId).toBe('session-1')
    await expect(manager.setTargetSession('manual-project', 'session-other'))
      .rejects.toThrow('not available in this Project')
  })

  it('moves a manual Browser to another Project without replacing its page and clears the old targets', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => [
        { id: 'project-1', title: 'Project 1' },
        { id: 'project-2', title: 'Project 2' },
      ]),
      listChatTargets: mock(async ({ projectId }) => projectId === 'project-1'
        ? [{ id: 'session-1', title: 'Chat 1', noteTargetPath: 'notes/research.md' }]
        : []),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Chat 1',
        noteTargetPath: 'notes/research.md',
      })),
    })
    manager.createInstance('manual-project-switch', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    await manager.setTargetSession('manual-project-switch', 'session-1')

    const before = (manager as any).instances.get('manual-project-switch')
    const pageView = before.pageView
    before.currentUrl = 'https://example.com/article'

    await manager.setProject('manual-project-switch', 'project-2')

    const after = (manager as any).instances.get('manual-project-switch')
    expect(after.pageView).toBe(pageView)
    expect(manager.listInstances().find(instance => instance.id === 'manual-project-switch'))
      .toMatchObject({
        url: 'https://example.com/article',
        projectId: 'project-2',
        targetSessionId: null,
      })
    expect(after.targetChat).toBeNull()
  })

  it('applies only the newest Project choice when lookups resolve out of order', async () => {
    const pending: Array<(targets: BrowserProjectTarget[]) => void> = []
    let deferProjectTargets = false
    manager.setApplicationService({
      listProjectTargets: mock(() => deferProjectTargets
        ? new Promise<BrowserProjectTarget[]>(resolve => { pending.push(resolve) })
        : Promise.resolve([
            { id: 'project-1', title: 'Project 1' },
            { id: 'project-2', title: 'Project 2' },
            { id: 'project-3', title: 'Project 3' },
          ])),
      listChatTargets: mock(async () => []),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'unused',
        targetTitle: 'Unused',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('latest-project-choice', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    await Promise.resolve()
    deferProjectTargets = true

    const firstOutcome = manager.setProject('latest-project-choice', 'project-2').then(
      () => 'applied',
      error => error instanceof Error ? error.message : String(error),
    )
    const secondOutcome = manager.setProject('latest-project-choice', 'project-3').then(
      () => 'applied',
      error => error instanceof Error ? error.message : String(error),
    )
    const targets = [
      { id: 'project-1', title: 'Project 1' },
      { id: 'project-2', title: 'Project 2' },
      { id: 'project-3', title: 'Project 3' },
    ]
    pending[0]?.(targets)
    await Promise.resolve()
    pending[1]?.(targets)

    expect(await firstOutcome).toBe('Project selection was superseded')
    expect(await secondOutcome).toBe('applied')
    expect(manager.listInstances().find(instance => instance.id === 'latest-project-choice'))
      .toMatchObject({ projectId: 'project-3' })
  })

  it('ignores a target Chat lookup that finishes after the Browser changes Project', async () => {
    let deferTargetLookup = false
    let finish: ((targets: BrowserChatTarget[]) => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(async () => [
        { id: 'project-1', title: 'Project 1' },
        { id: 'project-2', title: 'Project 2' },
      ]),
      listChatTargets: mock(() => deferTargetLookup
        ? new Promise<BrowserChatTarget[]>(resolve => { finish = resolve })
        : Promise.resolve([])),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Chat 1',
        noteTargetPath: 'notes/project-1.md',
      })),
    })
    manager.createInstance('late-target-project-switch', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    await Promise.resolve()
    deferTargetLookup = true

    const targetChange = manager.setTargetSession(
      'late-target-project-switch',
      'session-1',
    )
    await manager.setProject('late-target-project-switch', 'project-2')
    finish!([{
      id: 'session-1',
      title: 'Chat 1',
      noteTargetPath: 'notes/project-1.md',
    }])

    await expect(targetChange).rejects.toThrow(
      'scope changed while choosing a target Chat',
    )
    expect(manager.listInstances().find(instance => (
      instance.id === 'late-target-project-switch'
    ))).toMatchObject({ projectId: 'project-2', targetSessionId: null })
  })

  it('does not let a stale target Chat lookup override a newly created Chat', async () => {
    let finishTargetLookup: ((targets: BrowserChatTarget[]) => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(() => new Promise<BrowserChatTarget[]>(resolve => {
        finishTargetLookup = resolve
      })),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-new',
        targetTitle: 'New Chat',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('latest-target-chat', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    const instance = (manager as any).instances.get('latest-target-chat')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    ;(manager as any).handleSelectionCapture(instance, {
      quote: 'selected text',
      prefix: 'before',
      suffix: 'after',
      rect: { x: 100, y: 100, width: 80, height: 18 },
    })

    const staleTargetChange = manager.setTargetSession('latest-target-chat', 'session-old')
    await Promise.resolve()
    await (manager as any).handleSelectionAction(instance, 'new-chat')
    finishTargetLookup!([{
      id: 'session-old',
      title: 'Old Chat',
      noteTargetPath: null,
    }])

    await expect(staleTargetChange).rejects.toThrow('superseded')
    expect(manager.listInstances().find(candidate => candidate.id === instance.id))
      .toMatchObject({ targetSessionId: 'session-new' })
  })

  it('does not let an automatic target refresh supersede the user target choice', async () => {
    let deferTargetChoice = false
    let finishTargetChoice: ((targets: BrowserChatTarget[]) => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(() => {
        if (deferTargetChoice) {
          deferTargetChoice = false
          return new Promise<BrowserChatTarget[]>(resolve => { finishTargetChoice = resolve })
        }
        return Promise.resolve([{
          id: 'session-b',
          title: 'Chat B',
          noteTargetPath: null,
        }])
      }),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-b',
        targetTitle: 'Chat B',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('target-choice-during-refresh', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-b',
    })
    const instance = (manager as any).instances.get('target-choice-during-refresh')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    deferTargetChoice = true

    const targetChoice = manager.setTargetSession(
      'target-choice-during-refresh',
      'session-a',
    )
    ;(manager as any).handleSelectionCapture(instance, {
      quote: 'selected text',
      prefix: 'before',
      suffix: 'after',
      rect: { x: 100, y: 100, width: 80, height: 18 },
    })
    finishTargetChoice!([{
      id: 'session-a',
      title: 'Chat A',
      noteTargetPath: null,
    }])

    await expect(targetChoice).resolves.toBeUndefined()
    expect(manager.listInstances().find(candidate => candidate.id === instance.id))
      .toMatchObject({ targetSessionId: 'session-a' })
  })

  it('does not let an unfinished target choice cross a selection action', async () => {
    let deferTargetChoice = false
    let finishTargetChoice: ((targets: BrowserChatTarget[]) => void) | null = null
    let finishSelection: ((value: {
      sessionId: string
      targetTitle: string
      noteTargetPath: string | null
    }) => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(() => {
        if (deferTargetChoice) {
          deferTargetChoice = false
          return new Promise<BrowserChatTarget[]>(resolve => { finishTargetChoice = resolve })
        }
        return Promise.resolve([{
          id: 'session-a',
          title: 'Chat A',
          noteTargetPath: null,
        }])
      }),
      openChat: mock(async () => {}),
      applySelection: mock(() => new Promise<{
        sessionId: string
        targetTitle: string
        noteTargetPath: string | null
      }>(resolve => { finishSelection = resolve })),
    })
    manager.createInstance('target-choice-before-selection-action', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-a',
    })
    const instance = (manager as any).instances.get(
      'target-choice-before-selection-action',
    )
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    deferTargetChoice = true

    const targetChoice = manager.setTargetSession(
      'target-choice-before-selection-action',
      'session-b',
    )
    ;(manager as any).handleSelectionCapture(instance, {
      quote: 'selected text',
      prefix: 'before',
      suffix: 'after',
      rect: { x: 100, y: 100, width: 80, height: 18 },
    })
    const action = (manager as any).handleSelectionAction(instance, 'add-note')
    finishTargetChoice!([{
      id: 'session-b',
      title: 'Chat B',
      noteTargetPath: null,
    }])

    await expect(targetChoice).rejects.toThrow('superseded')
    finishSelection!({
      sessionId: 'session-a',
      targetTitle: 'Chat A',
      noteTargetPath: 'notes/chat-a.md',
    })
    await action

    expect(instance.targetSessionId).toBe('session-a')
    expect(instance.targetChat).toEqual({
      id: 'session-a',
      title: 'Chat A',
      noteTargetPath: 'notes/chat-a.md',
    })
  })

  it('does not switch Project while a selection action is writing to the current Project', async () => {
    let finish: ((value: {
      sessionId: string
      targetTitle: string
      noteTargetPath: string | null
    }) => void) | null = null
    const applySelection = mock(() => new Promise<{
      sessionId: string
      targetTitle: string
      noteTargetPath: string | null
    }>(resolve => { finish = resolve }))
    manager.setApplicationService({
      listProjectTargets: mock(async () => [
        { id: 'project-1', title: 'Project 1' },
        { id: 'project-2', title: 'Project 2' },
      ]),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Chat 1',
        noteTargetPath: 'notes/project-1.md',
      }]),
      openChat: mock(async () => {}),
      applySelection,
    })
    manager.createInstance('selection-project-switch', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get('selection-project-switch')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true

    ;(manager as any).handleSelectionCapture(instance, {
      quote: 'selected text',
      prefix: 'before',
      suffix: 'after',
      rect: { x: 100, y: 100, width: 80, height: 18 },
    })
    const action = (manager as any).handleSelectionAction(instance, 'add-note')
    const projectSwitch = manager.setProject(instance.id, 'project-2')
    finish!({
      sessionId: 'session-1',
      targetTitle: 'Chat 1',
      noteTargetPath: 'notes/project-1.md',
    })
    await action

    await expect(projectSwitch).rejects.toThrow('selection action is pending')
    expect(applySelection).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      sessionId: 'session-1',
    }))
    expect(manager.listInstances().find(candidate => candidate.id === instance.id))
      .toMatchObject({ projectId: 'project-1', targetSessionId: 'session-1' })
  })

  it('does not switch Project while the target Chat is opening', async () => {
    let finishOpen: (() => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(async () => [
        { id: 'project-1', title: 'Project 1' },
        { id: 'project-2', title: 'Project 2' },
      ]),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Chat 1',
        noteTargetPath: null,
      }]),
      openChat: mock(() => new Promise<void>(resolve => { finishOpen = resolve })),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Chat 1',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('open-chat-project-switch', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()

    const openChat = manager.openTargetSession('open-chat-project-switch')
    const switchOutcome = manager.setProject(
      'open-chat-project-switch',
      'project-2',
    ).then(
      () => 'moved',
      error => error instanceof Error ? error.message : String(error),
    )
    finishOpen!()
    await openChat

    expect(await switchOutcome).toBe('Cannot change Project while opening target Chat')
    expect(manager.listInstances().find(instance => (
      instance.id === 'open-chat-project-switch'
    ))).toMatchObject({ projectId: 'project-1', targetSessionId: 'session-1' })
  })

  it('does not let a session-created Browser leave its owning Project', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => [
        { id: 'project-1', title: 'Project 1' },
        { id: 'project-2', title: 'Project 2' },
      ]),
      listChatTargets: mock(async () => [{ id: 'owner-chat', title: 'Owner', noteTargetPath: null }]),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({ sessionId: 'owner-chat', targetTitle: 'Owner', noteTargetPath: null })),
    })
    const id = manager.createForSession('owner-chat', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    await Promise.resolve()

    const instance = (manager as any).instances.get(id)
    expect(instance.toolbarView.webContents.send).toHaveBeenCalledWith(
      'browser-toolbar:state-update',
      expect.objectContaining({
        projectId: 'project-1',
        projectTitle: 'Project 1',
        canChooseProject: false,
      }),
    )

    await expect(manager.setProject(id, 'project-2'))
      .rejects.toThrow('fixed to its owning Project')
    expect(manager.listInstances().find(instance => instance.id === id)?.projectId)
      .toBe('project-1')
  })

  it('keeps a session-created Browser permanently targeted to its owning Chat', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [
        { id: 'owner-chat', title: 'Owner', noteTargetPath: null },
        { id: 'other-chat', title: 'Other', noteTargetPath: null },
      ]),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({ sessionId: 'owner-chat', targetTitle: 'Owner', noteTargetPath: null })),
    })
    const id = manager.createForSession('owner-chat', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })

    await expect(manager.setTargetSession(id, 'other-chat'))
      .rejects.toThrow('fixed to its owning Chat')
    expect(manager.listInstances().find(instance => instance.id === id)?.targetSessionId)
      .toBe('owner-chat')
  })

  it('opens the target Chat through the Project-scoped application service', async () => {
    const openChat = mock(async () => {})
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => []),
      openChat,
      applySelection: mock(async () => ({ sessionId: 'session-1', targetTitle: 'Chat 1', noteTargetPath: null })),
    })
    manager.createInstance('open-target', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })

    await manager.openTargetSession('open-target')

    expect(openChat).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      originWebContentsId: null,
    })
  })

  it('exposes the target Chat and Note file in Browser toolbar state', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath: 'notes/research.md',
      }]),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Research Chat',
        noteTargetPath: 'notes/research.md',
      })),
    })
    manager.createInstance('toolbar-target', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()

    const toolbarView = webContentsViews.find(({ options }) => (
      options?.webPreferences?.preload?.includes('browser-toolbar-preload')
    ))?.view
    expect(toolbarView?.webContents.send).toHaveBeenCalledWith(
      'browser-toolbar:state-update',
      expect.objectContaining({
        targetSessionId: 'session-1',
        targetChatTitle: 'Research Chat',
        targetNotePath: 'notes/research.md',
      }),
    )
  })

  it('preserves Project and target Chat while hiding and restoring a window', () => {
    manager.createInstance('hide-restore-target', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })

    manager.hide('hide-restore-target')
    manager.focus('hide-restore-target')

    expect(manager.listInstances()[0]).toMatchObject({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
  })

  it('refreshes the target Chat and Note when a Browser window is shown again', async () => {
    let noteTargetPath = 'notes/first.md'
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath,
      }]),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Research Chat',
        noteTargetPath,
      })),
    })
    manager.createInstance('refresh-target-on-show', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get('refresh-target-on-show')
    expect(instance.targetChat.noteTargetPath).toBe('notes/first.md')

    noteTargetPath = 'notes/second.md'
    instance.window._emit('hide')
    instance.window._emit('show')
    await Promise.resolve()

    expect(instance.targetChat.noteTargetPath).toBe('notes/second.md')
    expect(instance.toolbarView.webContents.send).toHaveBeenCalledWith(
      'browser-toolbar:state-update',
      expect.objectContaining({ targetNotePath: 'notes/second.md' }),
    )
  })

  it('keeps the newest Project title when an older refresh finishes later', async () => {
    let finishOldRefresh: ((targets: BrowserProjectTarget[]) => void) | null = null
    let refreshCount = 0
    manager.setApplicationService({
      listProjectTargets: mock(() => {
        refreshCount += 1
        return refreshCount === 1
          ? new Promise<BrowserProjectTarget[]>(resolve => { finishOldRefresh = resolve })
          : Promise.resolve([{ id: 'project-1', title: 'Project After Rename' }])
      }),
      listChatTargets: mock(async () => []),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'unused',
        targetTitle: 'Unused',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('refresh-project-on-focus', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    const instance = (manager as any).instances.get('refresh-project-on-focus')

    manager.focus(instance.id)
    await Promise.resolve()
    expect(instance.projectTitle).toBe('Project After Rename')

    finishOldRefresh!([{
      id: 'project-1',
      title: 'Project Before Rename',
    }])
    await Promise.resolve()

    expect(instance.projectTitle).toBe('Project After Rename')
    expect(instance.toolbarView.webContents.send).toHaveBeenCalledWith(
      'browser-toolbar:state-update',
      expect.objectContaining({ projectTitle: 'Project After Rename' }),
    )
  })

  it('invalidates an older target refresh when the Browser is hidden', async () => {
    const pending: Array<(targets: BrowserChatTarget[]) => void> = []
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(() => new Promise<BrowserChatTarget[]>(resolve => {
        pending.push(resolve)
      })),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Research Chat',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('hide-invalidates-refresh', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    const instance = (manager as any).instances.get('hide-invalidates-refresh')
    instance.toolbarReady = true
    manager.focus('hide-invalidates-refresh')
    expect(pending).toHaveLength(2)

    manager.hide('hide-invalidates-refresh')
    pending[1]([{
      id: 'session-1',
      title: 'Stale Chat',
      noteTargetPath: 'notes/stale.md',
    }])
    await Promise.resolve()
    expect(instance.targetChat).toBeNull()
    expect(instance.targetMetadataFresh).toBe(false)

    manager.focus('hide-invalidates-refresh')
    const latest = pending.at(-1)!
    latest([{
      id: 'session-1',
      title: 'Current Chat',
      noteTargetPath: 'notes/current.md',
    }])
    await Promise.resolve()
    expect(instance.targetChat.noteTargetPath).toBe('notes/current.md')
  })

  it('refreshes the target Chat and Note when an already visible Browser is focused', async () => {
    let noteTargetPath = 'notes/first.md'
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath,
      }]),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Research Chat',
        noteTargetPath,
      })),
    })
    manager.createInstance('refresh-target-on-focus', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get('refresh-target-on-focus')
    instance.toolbarReady = true
    expect(instance.targetChat.noteTargetPath).toBe('notes/first.md')

    noteTargetPath = 'notes/second.md'
    manager.focus('refresh-target-on-focus')
    await Promise.resolve()

    expect(instance.targetChat.noteTargetPath).toBe('notes/second.md')
  })

  it('clears a manual Browser target when refresh finds that the Chat was deleted', async () => {
    let chatExists = true
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => chatExists
        ? [{ id: 'session-1', title: 'Research Chat', noteTargetPath: null }]
        : []),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Research Chat',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('refresh-deleted-manual-chat', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get('refresh-deleted-manual-chat')
    instance.toolbarReady = true

    chatExists = false
    manager.focus('refresh-deleted-manual-chat')
    await Promise.resolve()

    expect(manager.listInstances()[0].targetSessionId).toBeNull()
  })

  it('destroys an untargeted manual Browser when its Project is unavailable', async () => {
    let projectExists = true
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => {
        if (!projectExists) throw new Error('Browser Project is unavailable')
        return []
      }),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({ cancelled: true as const })),
    })
    manager.createInstance('manual-with-deleted-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    await Promise.resolve()

    projectExists = false
    manager.focus('manual-with-deleted-project')
    await Promise.resolve()

    expect(manager.listInstances()).toHaveLength(0)
  })

  for (const visibility of ['hidden', 'isArchived'] as const) {
    it(`keeps a ${visibility} Session Browser alive until its owner is deleted`, async () => {
      let sessions: Session[] = [{
        id: 'owner-chat', workspaceId: 'workspace-1', projectId: 'project-1',
        workspaceName: 'Workspace', lastMessageAt: 1, messages: [], isProcessing: false,
        name: 'Owner', [visibility]: true,
      }]
      const client = {
        invoke: async (channel: string) => {
          if (channel === RPC_CHANNELS.projects.GET_ONE) return { id: 'project-1' }
          if (channel === RPC_CHANNELS.projects.GET) return [{ config: { id: 'project-1', name: 'Project' } }]
          if (channel === RPC_CHANNELS.sessions.GET) return sessions
          throw new Error(`Unexpected RPC: ${channel}`)
        },
      } as RpcClient
      const server = {
        hasClientCapability: () => true,
        findClientsWithCapability: () => ['renderer'],
        invokeClient: async (_clientId: string, _channel: string, request: any) => (
          handleBrowserApplicationCapability(client, request)
        ),
      } as unknown as RpcServer
      const { service } = createBrowserApplicationRouter({
        server,
        resolveWorkspace: () => ({ id: 'workspace-1' }),
      })
      manager.setApplicationService(service)
      const id = manager.createForSession('owner-chat', {
        workspaceId: 'workspace-1', projectId: 'project-1',
      })
      await Bun.sleep(20)

      expect(manager.listInstances().map(instance => instance.id)).toContain(id)
      expect(await manager.listChatTargets(id)).toEqual([])

      sessions = []
      manager.focus(id)
      await Bun.sleep(20)
      expect(manager.listInstances()).toHaveLength(0)
    })
  }

  it('destroys a Chat-owned Browser when refresh finds that its Chat was deleted', async () => {
    let chatExists = true
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => chatExists
        ? [{ id: 'session-1', title: 'Research Chat', noteTargetPath: null }]
        : []),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Research Chat',
        noteTargetPath: null,
      })),
    })
    const id = manager.createForSession('session-1', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get(id)
    instance.toolbarReady = true

    chatExists = false
    manager.focus(id)
    await Promise.resolve()

    expect(manager.listInstances()).toHaveLength(0)
  })

  it('ignores an older target metadata refresh that resolves after a newer one', async () => {
    const pending: Array<(targets: BrowserChatTarget[]) => void> = []
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(() => new Promise<BrowserChatTarget[]>(resolve => {
        pending.push(resolve)
      })),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Research Chat',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('refresh-generation', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    const instance = (manager as any).instances.get('refresh-generation')
    instance.toolbarReady = true
    manager.focus('refresh-generation')
    expect(pending).toHaveLength(2)

    pending[1]([{ id: 'session-1', title: 'New title', noteTargetPath: 'notes/new.md' }])
    await Promise.resolve()
    pending[0]([{ id: 'session-1', title: 'Old title', noteTargetPath: 'notes/old.md' }])
    await Promise.resolve()

    expect(instance.targetChat).toEqual({
      id: 'session-1',
      title: 'New title',
      noteTargetPath: 'notes/new.md',
    })
  })

  it('getOrCreateForSession reuses existing instance', () => {
    const id1 = manager.getOrCreateForSession('sess-1')
    const id2 = manager.getOrCreateForSession('sess-1')
    expect(id1).toBe(id2)
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('createForSession never adopts a manually created Browser window', () => {
    manager.createInstance('manual-1', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })

    const id = manager.createForSession('sess-created', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })

    expect(id).not.toBe('manual-1')
    const info = manager.listInstances().find(instance => instance.id === id)!
    expect(info.ownerType).toBe('session')
    expect(info.ownerSessionId).toBe('sess-created')
    expect(info.boundSessionId).toBe('sess-created')
    expect(manager.listInstances()).toHaveLength(2)
  })

  describe('workspaceId stamping', () => {
    it('createForSession with workspaceId stamps the field on a new instance', () => {
      const id = manager.createForSession('sess-ws', { workspaceId: 'ws-alpha' })
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBe('ws-alpha')
    })

    it('manual createInstance accepts workspaceId option (TopBar manual open)', () => {
      // The browser-pane CREATE handler passes ctx.workspaceId so TopBar-
      // opened windows stay scoped to the workspace the user clicked from,
      // rather than being broadcast to every workspace.
      manager.createInstance('manual-scoped', {
        workspaceId: 'ws-toolbar',
        projectId: 'project-toolbar',
      })
      const info = manager.listInstances().find((i) => i.id === 'manual-scoped')
      expect(info?.workspaceId).toBe('ws-toolbar')
      expect(info?.projectId).toBe('project-toolbar')
    })

    it('bindSession with workspaceId overwrites the instance workspaceId', () => {
      manager.createInstance('bind-ws')
      manager.bindSession('bind-ws', 'sess-bound', { workspaceId: 'ws-gamma' })
      const info = manager.listInstances().find((i) => i.id === 'bind-ws')
      expect(info?.workspaceId).toBe('ws-gamma')
      expect(info?.boundSessionId).toBe('sess-bound')
    })

    it('toInfo emits workspaceId on the DTO', () => {
      manager.createForSession('sess-dto', { workspaceId: 'ws-epsilon' })
      const dto = manager.listInstances().find((i) => i.ownerSessionId === 'sess-dto')
      expect(dto).toBeDefined()
      expect(dto).toHaveProperty('workspaceId', 'ws-epsilon')
    })

    describe('cross-workspace reuse', () => {
      it('does NOT reuse an unbound session window from another workspace', () => {
        // Session in workspace A opens a window, then its turn ends — the
        // unbind path clears active control but preserves stable Chat ownership.
        // A session in workspace B asking for a window
        // must NOT pick it up; that would "move" the window across workspaces.
        const wsA = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a')

        // Sanity: instance is idle but retains its owner and Workspace.
        const after = manager.listInstances().find((i) => i.id === wsA)
        expect(after?.boundSessionId).toBeNull()
        expect(after?.ownerType).toBe('session')
        expect(after?.workspaceId).toBe('ws-a')

        const wsB = manager.createForSession('sess-b', { workspaceId: 'ws-b' })
        expect(wsB).not.toBe(wsA)
        expect(manager.listInstances()).toHaveLength(2)

        // Workspace-A's window still belongs to A.
        const stillA = manager.listInstances().find((i) => i.id === wsA)
        expect(stillA?.workspaceId).toBe('ws-a')
      })

      it('creates independent windows for the same Chat id in different Workspaces', () => {
        const wsA = manager.createForSession('same-chat-id', {
          workspaceId: 'ws-a',
          projectId: 'project-a',
        })
        const wsB = manager.createForSession('same-chat-id', {
          workspaceId: 'ws-b',
          projectId: 'project-b',
        })

        expect(wsB).not.toBe(wsA)
        expect(manager.listInstances()).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: wsA, workspaceId: 'ws-a', projectId: 'project-a' }),
          expect.objectContaining({ id: wsB, workspaceId: 'ws-b', projectId: 'project-b' }),
        ]))
      })

      it('restores the same Chat-owned window on that Chat\'s next turn', () => {
        const original = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a1')

        const reused = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })
        expect(reused).toBe(original)
        expect(manager.listInstances()[0].boundSessionId).toBe('sess-a1')
        expect(manager.listInstances()).toHaveLength(1)
      })

      it('does not let another Chat in the same Workspace take that window', () => {
        const original = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a1')

        const other = manager.createForSession('sess-a2', { workspaceId: 'ws-a' })
        expect(other).not.toBe(original)
        expect(manager.listInstances()).toHaveLength(2)
      })
    })
  })

  it('navigate normalizes hostnames to https', async () => {
    manager.createInstance('nav-1')
    await manager.navigate('nav-1', 'example.com')
    const instance = (manager as any).instances.get('nav-1')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith('https://example.com')
  })

  it('does not replace navigation when the empty-state load is superseded', async () => {
    emptyStateLoadFailure = Object.assign(new Error('navigation superseded'), {
      code: 'ERR_ABORTED',
    })
    manager.createInstance('nav-empty-state-race')

    await manager.navigate('nav-empty-state-race', 'https://example.com/article')
    await new Promise(resolve => setTimeout(resolve, 0))

    const instance = (manager as any).instances.get('nav-empty-state-race')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith('https://example.com/article')
    expect(instance.pageView.webContents.loadURL).not.toHaveBeenCalledWith('about:blank')
  })

  it('navigate treats plain text as search query', async () => {
    manager.createInstance('nav-2')
    await manager.navigate('nav-2', 'craft agents browser tools')
    const instance = (manager as any).instances.get('nav-2')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=craft%20agents%20browser%20tools'
    )
  })

  it('clears navigation timeout timer on success', async () => {
    manager.createInstance('nav-timeout')

    const originalClearTimeout = globalThis.clearTimeout
    const clearTimeoutSpy = mock((handle: Parameters<typeof clearTimeout>[0]) => originalClearTimeout(handle))
    ;(globalThis as any).clearTimeout = clearTimeoutSpy

    try {
      await manager.navigate('nav-timeout', 'https://example.com')
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      ;(globalThis as any).clearTimeout = originalClearTimeout
    }
  })

  it('focus brings the instance window to front once the toolbar is ready', async () => {
    manager.createInstance('f1')
    manager.focus('f1')

    const instance = (manager as any).instances.get('f1')
    await Bun.sleep(0)

    expect(instance.window.show).toHaveBeenCalled()
    expect(instance.window.focus).toHaveBeenCalled()
  })

  it('dedupes repeated focus calls before the toolbar is ready', async () => {
    manager.createInstance('f2')

    manager.focus('f2')
    manager.focus('f2')
    manager.focus('f2')

    const instance = (manager as any).instances.get('f2')
    await Bun.sleep(0)

    expect(instance.window.show.mock.calls.length).toBe(1)
    expect(instance.window.focus.mock.calls.length).toBe(1)
  })

  it('cancels deferred pre-ready focus when hide happens first', async () => {
    manager.createInstance('f-hide-race')

    manager.focus('f-hide-race')
    manager.hide('f-hide-race')

    const instance = (manager as any).instances.get('f-hide-race')
    const showCallsBeforeReady = instance.window.show.mock.calls.length
    const focusCallsBeforeReady = instance.window.focus.mock.calls.length

    await Bun.sleep(0)

    expect(instance.window.show.mock.calls.length).toBe(showCallsBeforeReady)
    expect(instance.window.focus.mock.calls.length).toBe(focusCallsBeforeReady)
  })

  it('user close hides window and keeps instance alive', () => {
    manager.createInstance('h1')
    const instance = (manager as any).instances.get('h1')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(manager.listInstances()).toHaveLength(1)
    expect(manager.listInstances()[0].isVisible).toBe(false)
  })

  it('does not intercept close when destroy is explicit', () => {
    manager.createInstance('h-explicit-destroy')
    const instance = (manager as any).instances.get('h-explicit-destroy')

    ;(manager as any).destroyingIds.add('h-explicit-destroy')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    expect(instance.window.hide).not.toHaveBeenCalled()
  })

  it('still destroys instance when cleanup throws', () => {
    manager.createInstance('destroy-cleanup-throw')
    const instance = (manager as any).instances.get('destroy-cleanup-throw')

    ;(manager as any).updateNativeOverlayState = () => {
      throw new Error('mock overlay cleanup failure')
    }

    expect(() => manager.destroyInstance('destroy-cleanup-throw')).not.toThrow()
    expect(instance.window.destroy).toHaveBeenCalledTimes(1)
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback when window closes', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))
    manager.createInstance('r1')

    const instance = (manager as any).instances.get('r1')
    instance.window._emit('closed')

    expect(removed).toEqual(['r1'])
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('retries toolbar load and recovers', async () => {
    toolbarLoadFailuresRemaining = 2
    manager.createInstance('retry-toolbar')

    await Bun.sleep(1400)

    const instance = (manager as any).instances.get('retry-toolbar')
    const toolbarWebContents = instance.toolbarView.webContents
    const fileAttempts = toolbarWebContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWebContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(3)
    expect(toolbarWebContents.loadURL).not.toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('loads toolbar fallback page after retry exhaustion', async () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('fallback-toolbar')

    await Bun.sleep(3200)

    const instance = (manager as any).instances.get('fallback-toolbar')
    const toolbarWebContents = instance.toolbarView.webContents
    const fileAttempts = toolbarWebContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWebContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(5)
    expect(toolbarWebContents.loadURL).toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('captures and filters console entries', () => {
    manager.createInstance('console-1')
    const instance = (manager as any).instances.get('console-1')
    // Off the app's empty-state page, whose console output is never logged
    instance.pageView.webContents._emit('did-start-navigation', 'https://example.com/', false, true)

    instance.pageView.webContents._emit('console-message', 2, 'warn message')
    instance.pageView.webContents._emit('console-message', 3, 'error message')

    const allEntries = manager.getConsoleLogs('console-1', { level: 'all', limit: 10 })
    expect(allEntries).toHaveLength(2)

    const warnEntries = manager.getConsoleLogs('console-1', { level: 'warn', limit: 10 })
    expect(warnEntries).toHaveLength(1)
    expect(warnEntries[0].message).toBe('warn message')
  })

  it('applies observer theme signal and skips regular console logging for it', () => {
    manager.createInstance('theme-signal')
    const instance = (manager as any).instances.get('theme-signal')
    instance.themeObserverToken = 'tok-1'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-1:#123456')

    expect(manager.listInstances().find(i => i.id === 'theme-signal')?.themeColor).toBe('#123456')
    expect(manager.getConsoleLogs('theme-signal', { level: 'all', limit: 10 })).toHaveLength(0)
  })

  it('dedupes repeated observer theme signals', () => {
    manager.createInstance('theme-dedupe')
    const instance = (manager as any).instances.get('theme-dedupe')
    instance.themeObserverToken = 'tok-2'

    const sendCallsBeforeSignal = instance.toolbarView.webContents.send.mock.calls.length
    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-2:#445566')
    const sendCallsAfterFirst = instance.toolbarView.webContents.send.mock.calls.length

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-2:#445566')
    const sendCallsAfterSecond = instance.toolbarView.webContents.send.mock.calls.length

    expect(sendCallsAfterFirst).toBe(sendCallsBeforeSignal + 1)
    expect(sendCallsAfterSecond).toBe(sendCallsAfterFirst)
  })

  it('ignores observer theme signals from stale token', () => {
    manager.createInstance('theme-stale-token')
    const instance = (manager as any).instances.get('theme-stale-token')
    instance.themeObserverToken = 'tok-current'
    instance.themeColor = '#aaaaaa'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-old:#bbccdd')

    expect(manager.listInstances().find(i => i.id === 'theme-stale-token')?.themeColor).toBe('#aaaaaa')
  })

  it('clears theme on explicit null sentinel signal', () => {
    manager.createInstance('theme-null')
    const instance = (manager as any).instances.get('theme-null')
    instance.themeObserverToken = 'tok-null'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-null:#223344')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBe('#223344')

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-null:__NULL__')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBeNull()
  })

  it('replays toolbar state with theme color when window is shown', () => {
    manager.createInstance('theme-show-replay')
    const instance = (manager as any).instances.get('theme-show-replay')

    instance.currentUrl = 'https://example.com'
    instance.title = 'Example'
    instance.canGoBack = true
    instance.canGoForward = false
    instance.themeColor = '#123456'

    const sendsBeforeShow = instance.toolbarView.webContents.send.mock.calls.length
    instance.window._emit('show')

    const sendCallsAfterShow = instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeShow)
    expect(sendCallsAfterShow).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://example.com',
        title: 'Example',
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
      themeColor: '#123456',
      targetSessionId: null,
      targetChatTitle: null,
      targetNotePath: null,
      selectionFeedback: null,
      canChooseTargetChat: true,
      projectId: null,
      projectTitle: null,
      canChooseProject: true,
      },
    ])
  })

  it('replays full toolbar state when toolbar renderer finishes loading', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-finish-load-replay')
    const instance = (manager as any).instances.get('toolbar-finish-load-replay')

    instance.currentUrl = 'https://craft.do'
    instance.title = 'Craft'
    instance.isLoading = true
    instance.canGoBack = true
    instance.canGoForward = true
    instance.themeColor = '#654321'

    instance.toolbarView.webContents.getURL = mock(() => 'http://localhost:5173/browser-toolbar.html?instanceId=toolbar-finish-load-replay')

    const sendsBeforeFinishLoad = instance.toolbarView.webContents.send.mock.calls.length
    instance.toolbarView.webContents._emit('did-finish-load')

    const sendCallsAfterFinishLoad = instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeFinishLoad)
    expect(sendCallsAfterFinishLoad).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://craft.do',
        title: 'Craft',
        isLoading: true,
        canGoBack: true,
        canGoForward: true,
      themeColor: '#654321',
      targetSessionId: null,
      targetChatTitle: null,
      targetNotePath: null,
      selectionFeedback: null,
      canChooseTargetChat: true,
      projectId: null,
      projectTitle: null,
      canChooseProject: true,
      },
    ])
  })

  it('does not mark toolbar ready for about:blank did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-ignore-about-blank')
    const instance = (manager as any).instances.get('toolbar-ignore-about-blank')

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(false)
  })

  it('marks toolbar ready for fallback data page did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-fallback-ready')
    const instance = (manager as any).instances.get('toolbar-fallback-ready')

    instance.toolbarView.webContents.getURL = mock(() => 'data:text/html;charset=UTF-8,%3Chtml%3E%3C%2Fhtml%3E')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
  })

  it('keeps focus deferred until a valid toolbar document loads', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-focus-guard')
    const instance = (manager as any).instances.get('toolbar-focus-guard')

    manager.focus('toolbar-focus-guard')
    expect(instance.pendingShowOnReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'file:///mock/renderer/browser-toolbar.html')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).toHaveBeenCalledTimes(1)
  })

  it('runs early theme extraction shortly after navigation', async () => {
    manager.createInstance('theme-early')
    const instance = (manager as any).instances.get('theme-early')
    instance.pageView.webContents.executeJavaScript = mock(async () => '#0f1e2d')

    instance.pageView.webContents._emit('did-navigate', 'https://example.com')

    await Bun.sleep(140)

    expect(manager.listInstances().find(i => i.id === 'theme-early')?.themeColor).toBe('#0f1e2d')
  })

  it('clears pending in-page theme timer on full navigation', async () => {
    manager.createInstance('theme-timer-clear')
    const instance = (manager as any).instances.get('theme-timer-clear')

    instance.pageView.webContents._emit('did-navigate-in-page', 'https://example.com/route-a')
    await Bun.sleep(0)
    expect(instance.inPageThemeTimer).not.toBeNull()

    instance.pageView.webContents._emit('did-navigate', 'https://example.com/full-nav')
    expect(instance.inPageThemeTimer).toBeNull()
  })

  it('throws when screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('screenshot-empty-image')
    const instance = (manager as any).instances.get('screenshot-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshot('screenshot-empty-image')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('throws when screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('screenshot-empty-png')
    const instance = (manager as any).instances.get('screenshot-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshot('screenshot-empty-png')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('recovers screenshot via non-disruptive inactive reveal and restores hidden state', async () => {
    manager.createInstance('screenshot-rescue-success')
    const instance = (manager as any).instances.get('screenshot-rescue-success')

    let captureCalls = 0
    instance.pageView.webContents.capturePage = mock(async () => {
      captureCalls += 1
      if (captureCalls <= 3) {
        return {
          isEmpty: () => true,
          getSize: () => ({ width: 0, height: 0 }),
          resize: function() { return this },
          toPNG: () => Buffer.alloc(0),
          toJPEG: () => Buffer.alloc(0),
        }
      }

      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: () => img,
        toPNG: () => Buffer.from('rescued-png'),
        toJPEG: (_q: number) => Buffer.from('rescued-jpeg'),
      }
      return img
    })

    const result = await manager.screenshot('screenshot-rescue-success', { includeMetadata: true })

    expect(result.imageBuffer.toString()).toBe('rescued-png')
    expect(instance.window.showInactive).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).not.toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(result.metadata?.warnings?.some((w: string) => w.includes('shown invisibly'))).toBe(true)
    // Invisible and click-through while shown, then restored
    expect(instance.window.setOpacity.mock.calls).toEqual([[0], [1]])
    expect(instance.window.setIgnoreMouseEvents.mock.calls).toEqual([[true], [false]])
    expect(instance.window.setAlwaysOnTop.mock.calls).toEqual([[true, 'floating'], [false]])
  })

  it('throws when region screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('region-empty-image')
    const instance = (manager as any).instances.get('region-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshotRegion('region-empty-image', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('throws when region screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('region-empty-png')
    const instance = (manager as any).instances.get('region-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshotRegion('region-empty-png', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('captures screenshot region from ref target', async () => {
    manager.createInstance('region-ref')
    const result = await manager.screenshotRegion('region-ref', { ref: '@e1' })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('ref')
  })

  it('captures screenshot region from selector target', async () => {
    manager.createInstance('region-selector')
    const result = await manager.screenshotRegion('region-selector', { selector: 'div.card', padding: 4 })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('selector')
  })

  it('throws for ambiguous screenshot region target modes', async () => {
    manager.createInstance('region-ambiguous')

    await expect(
      manager.screenshotRegion('region-ambiguous', { ref: '@e1', selector: 'div.card' })
    ).rejects.toThrow('Region screenshot target is ambiguous')
  })

  it('throws when selector target cannot be resolved', async () => {
    manager.createInstance('region-selector-missing')
    const instance = (manager as any).instances.get('region-selector-missing')
    instance.cdp.getElementGeometryBySelector = mock(async () => {
      throw new Error('No element found for selector "div.missing"')
    })

    await expect(
      manager.screenshotRegion('region-selector-missing', { selector: 'div.missing' })
    ).rejects.toThrow('No element found for selector "div.missing"')
  })

  it('throws when resolved region is outside viewport', async () => {
    manager.createInstance('region-oob')

    await expect(
      manager.screenshotRegion('region-oob', { x: 5000, y: 5000, width: 100, height: 100 })
    ).rejects.toThrow('Resolved screenshot region is outside the current viewport')
  })

  it('resizes browser window viewport and returns effective applied size', () => {
    manager.createInstance('resize-1')
    const resized = manager.windowResize('resize-1', 1280, 720)

    const instance = (manager as any).instances.get('resize-1')
    expect(instance.window.setContentSize).toHaveBeenCalledWith(1280, 768)
    expect(resized).toEqual({ width: 1280, height: 720 })
  })

  it('returns effective viewport size when min window constraints apply', () => {
    manager.createInstance('resize-min')
    const resized = manager.windowResize('resize-min', 200, 200)

    // BrowserWindow minHeight is 500, toolbar is 48, so effective viewport height is 452.
    expect(resized).toEqual({ width: 700, height: 452 })
  })

  // Found 2026-10-11: parallel sessions each opened their own Google sign-in popup, though all
  // browser windows share one cookie partition.
  describe('sign-in popups across browser windows', () => {
    const HANDLER = 'https://liza.firebaseapp.com/__/auth/handler?providerId=google.com'
    const openHandlerOf = (instance: any) => instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    it('lets one open sign-in popup serve every window', () => {
      manager.createInstance('signin-a')
      manager.createInstance('signin-b')
      const a = (manager as any).instances.get('signin-a')
      const b = (manager as any).instances.get('signin-b')
      const popupWindow = createMockWindow({ width: 520, height: 720 })
      emitDidCreateWindow(a.pageView.webContents, popupWindow, { url: HANDLER })

      expect(openHandlerOf(b)({ url: HANDLER, disposition: 'new-window' })).toEqual({ action: 'deny' })
      expect(popupWindow.moveTop).toHaveBeenCalledTimes(1)
      // Other popups, and the owner's own retries, still open.
      expect(openHandlerOf(b)({ url: 'https://example.com/share', disposition: 'new-window' }).action).toBe('allow')
      expect(openHandlerOf(a)({ url: HANDLER, disposition: 'new-window' }).action).toBe('allow')

      popupWindow.destroy() // closed: the next window may sign in itself
      expect(openHandlerOf(b)({ url: HANDLER, disposition: 'new-window' }).action).toBe('allow')
    })

    it('tells the agent what a click did with popups', async () => {
      manager.createInstance('signin-owner')
      manager.createInstance('signin-click')
      const owner = (manager as any).instances.get('signin-owner')
      const clicker = (manager as any).instances.get('signin-click')
      const geometry = { ref: '@e1', box: { x: 0, y: 0, width: 10, height: 10 }, clickPoint: { x: 5, y: 5 }, via: 'mouse' }

      owner.cdp.clickElement = mock(async () => {
        emitDidCreateWindow(owner.pageView.webContents, createMockWindow(), { url: HANDLER })
        return geometry
      })
      const opened = await manager.clickElement('signin-owner', '@e1')
      expect(opened.popup).toContain(`The page opened a popup window (${HANDLER})`)

      clicker.cdp.clickElement = mock(async () => {
        openHandlerOf(clicker)({ url: HANDLER, disposition: 'new-window' })
        return geometry
      })
      const joined = await manager.clickElement('signin-click', '@e1')
      expect(joined.popup).toContain('already open from another browser window (signin-owner)')

      clicker.cdp.clickElement = mock(async () => geometry)
      expect((await manager.clickElement('signin-click', '@e1')).popup).toBeUndefined()
    })

    it('recognizes sign-in popup URLs', () => {
      expect(isSignInPopupUrl(HANDLER)).toBe(true)
      expect(isSignInPopupUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true)
      expect(isSignInPopupUrl('https://github.com/login/oauth/authorize')).toBe(true)
      expect(isSignInPopupUrl('https://app.example.com/login')).toBe(true)
      expect(isSignInPopupUrl('https://example.com/share?u=1')).toBe(false)
      expect(isSignInPopupUrl('https://example.com/authors')).toBe(false)
    })
  })

  // Found 2026-10-11: the network log of a site's window also held the app's own localhost:5173
  // requests (its empty-state page), and console entries from the previous site.
  describe('console and network logs', () => {
    const electron = () => require('electron') as any
    const observers = () => {
      const results = electron().session.fromPartition.mock.results
      for (let i = results.length - 1; i >= 0; i--) {
        const ses = results[i].value
        const before = ses.webRequest.onBeforeRequest.mock.calls[0]?.[0]
        if (before) return { before, completed: ses.webRequest.onCompleted.mock.calls[0][0] }
      }
      throw new Error('no partition observers registered')
    }

    it('skips the empty-state page and keeps only the current site', async () => {
      manager.createInstance('logs')
      const instance = (manager as any).instances.get('logs')
      const wc = instance.pageView.webContents
      const { before, completed } = observers()
      let id = 0
      const request = (url: string) => {
        const details = { id: ++id, url, webContentsId: wc.id, method: 'GET', statusCode: 200, resourceType: 'script' }
        before(details, () => {})
        completed(details)
      }
      const navigate = async (url: string) => {
        await Bun.sleep(2) // distinct millisecond timestamps
        wc._emit('did-start-navigation', url, false, true)
        await Bun.sleep(1)
        request(url)
        await wc.loadURL(url)
        wc._emit('did-navigate', url)
      }
      const urls = () => manager.getNetworkLogs('logs').map((entry: any) => entry.url)

      // The empty-state page (the Vite dev server in development) is loaded first.
      request('http://localhost:5173/@vite/client')
      wc._emit('console-message', 1, '[vite] connected.')
      expect(urls()).toEqual([])
      expect(manager.getConsoleLogs('logs')).toEqual([])

      await navigate('https://slack.com/invite')
      wc._emit('console-message', 2, 'slack warning')
      await navigate('https://slack.com/welcome') // same site: history kept
      expect(urls()).toEqual(['https://slack.com/invite', 'https://slack.com/welcome'])

      await navigate('https://platform.example.com/')
      request('https://platform.example.com/app.js')
      expect(urls()).toEqual(['https://platform.example.com/', 'https://platform.example.com/app.js'])
      expect(manager.getConsoleLogs('logs')).toEqual([])
    })
  })

  it('annotates the elements on screen, not the first ones in the document', async () => {
    manager.createInstance('annotate-viewport')
    const instance = (manager as any).instances.get('annotate-viewport')
    const box = (y: number, height = 20) => ({ x: 10, y, width: 100, height })
    const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {
      '@e1': box(-200), // scrolled past
      '@e2': box(100),
      '@e3': box(2000), // below the fold
      '@e4': box(300, 0), // collapsed
    }
    instance.cdp.getAccessibilitySnapshot = mock(async () => ({ url: 'https://example.com', title: 'Example', nodes: Object.keys(boxes).map((ref) => ({ ref, role: 'button', name: ref })) }))
    instance.cdp.getElementGeometry = mock(async (ref: string) => ({ ref, box: boxes[ref], clickPoint: { x: 60, y: boxes[ref]!.y + 10 } }))
    instance.cdp.getViewportMetrics = mock(async () => ({ width: 1000, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }))

    const result = await manager.screenshot('annotate-viewport', { annotate: true })

    expect((result.metadata?.targets as Array<{ ref: string }>).map((t) => t.ref)).toEqual(['@e2'])
  })

  // Found 2026-10-11: screenshots of a hidden window showed an old frame. A throttled background
  // page stops painting and capturePage copies its last composited frame.
  describe('captures of a hidden page', () => {
    const image = (label: string) => {
      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: () => img,
        toPNG: () => Buffer.from(label),
        toJPEG: (_q: number) => Buffer.from(label),
      }
      return img
    }
    /** The paint probe never resolves until `paints()` is called (a hidden, throttled page). */
    const paintProbe = (instance: any) => {
      let painting = false
      const original = instance.pageView.webContents.executeJavaScript
      instance.pageView.webContents.executeJavaScript = mock(async (expr: string) => {
        if (!expr.includes('requestAnimationFrame')) return original(expr)
        return painting ? true : new Promise(() => {})
      })
      return { paints: () => { painting = true } }
    }

    it('lets the page render for the capture and throttles it again afterwards', async () => {
      manager.createInstance('cap-throttle')
      const instance = (manager as any).instances.get('cap-throttle')

      await manager.screenshot('cap-throttle')

      expect(instance.pageView.webContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
      expect(instance.rendersWhileHidden).toBe(false)
    })

    it('keeps the page rendering while an agent controls the window', () => {
      manager.createInstance('cap-agent')
      manager.bindSession('cap-agent', 'sess-cap')
      const instance = (manager as any).instances.get('cap-agent')

      manager.setAgentControl('sess-cap', { displayName: 'Browser' })
      expect(instance.pageView.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(false)

      manager.clearAgentControl('sess-cap')
      expect(instance.pageView.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
    })

    it('skips hidden captures of a page that is not painting and reveals it briefly instead', async () => {
      manager.createInstance('cap-stale')
      const instance = (manager as any).instances.get('cap-stale')
      const probe = paintProbe(instance)
      instance.window.showInactive = mock(() => { probe.paints() })
      instance.pageView.webContents.capturePage = mock(async (_rect: unknown, opts: unknown) => image(opts ? 'stale-hidden' : 'fresh'))

      const result = await manager.screenshot('cap-stale')

      expect(result.imageBuffer.toString()).toBe('fresh')
      expect(instance.pageView.webContents.capturePage).toHaveBeenCalledTimes(1)
      expect(instance.window.showInactive).toHaveBeenCalledTimes(1)
      expect(instance.window.hide).toHaveBeenCalled()
      // Raw screenshots report warnings without includeMetadata.
      expect(result.metadata?.warnings?.some((w: string) => w.includes('shown invisibly'))).toBe(true)
    })

    // setOpacity does nothing on Linux, so a transparent reveal would flash the window there.
    it('parks the window beyond every display on Linux instead of making it transparent', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { value: 'linux' })
      try {
        manager.createInstance('cap-linux')
        const instance = (manager as any).instances.get('cap-linux')
        const probe = paintProbe(instance)
        instance.window.showInactive = mock(() => { probe.paints() })

        await manager.screenshot('cap-linux')

        expect(instance.window.setOpacity).not.toHaveBeenCalled()
        expect(instance.window.setPosition).toHaveBeenCalledWith(4580, 60) // right of both displays
        expect(instance.window.setSkipTaskbar.mock.calls).toEqual([[true], [false]])
        expect(instance.window.setBounds).toHaveBeenCalledWith({ x: 40, y: 60, width: 1200, height: 900 })
        expect(instance.window.hide).toHaveBeenCalled()
      } finally {
        Object.defineProperty(process, 'platform', platform)
      }
    })

    it('warns when even a reveal produced no new frame', async () => {
      manager.createInstance('cap-never')
      const instance = (manager as any).instances.get('cap-never')
      paintProbe(instance)

      const result = await manager.screenshot('cap-never')

      expect(result.metadata?.warnings).toContain('The page did not paint a new frame, so this capture may show an older one.')
    })
  })


  describe('agent control overlay', () => {
    it('setAgentControl activates native overlay on bound instance', async () => {
      manager.createInstance('ac-1')
      manager.bindSession('ac-1', 'sess-1')

      manager.setAgentControl('sess-1', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-1')
      expect(instance.agentControl).toEqual({
        active: true,
        sessionId: 'sess-1',
        displayName: 'Navigate Page',
        intent: 'Loading example.com',
      })
      expect(instance.nativeOverlayView.webContents.executeJavaScript).toHaveBeenCalled()
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-1')?.agentControlActive).toBe(true)
    })

    it('keeps native overlay visible for active session control', async () => {
      manager.createInstance('ac-idle')
      manager.bindSession('ac-idle', 'sess-idle')

      manager.setAgentControl('sess-idle', {
        displayName: 'Browser',
        intent: 'Session controls this window',
      })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-idle')
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 48, width: 1200, height: 852 })
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-idle')?.agentControlActive).toBe(true)
    })

    it('emits state change when agent control is set and cleared', () => {
      const stateEvents: any[] = []
      manager.onStateChange((info) => stateEvents.push(info))

      manager.createInstance('ac-state')
      manager.bindSession('ac-state', 'sess-state')

      manager.setAgentControl('sess-state', { displayName: 'Browser Snapshot' })
      manager.clearAgentControl('sess-state')

      const acStateEvents = stateEvents.filter((event) => event.id === 'ac-state')
      expect(acStateEvents.some((event) => event.agentControlActive === true)).toBe(true)
      expect(acStateEvents.some((event) => event.agentControlActive === false)).toBe(true)
    })

    it('reapplies native overlay after did-stop-loading while control is active', async () => {
      manager.createInstance('ac-reapply')
      manager.bindSession('ac-reapply', 'sess-reapply')

      manager.setAgentControl('sess-reapply', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.pageView.webContents._emit('did-stop-loading')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('reapplies native overlay after hide/show while control is active', async () => {
      manager.createInstance('ac-show-reapply')
      manager.bindSession('ac-show-reapply', 'sess-show-reapply')

      manager.setAgentControl('sess-show-reapply', { displayName: 'Click Button', intent: 'Clicking submit' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-show-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.window._emit('hide')
      instance.window._emit('show')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('setAgentControl uses fallback label when no intent', async () => {
      manager.createInstance('ac-2')
      manager.bindSession('ac-2', 'sess-2')

      manager.setAgentControl('sess-2', { displayName: 'Browser Snapshot' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-2')
      const calls = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Browser Snapshot')
    })

    it('setAgentControl uses default label when no metadata', async () => {
      manager.createInstance('ac-3')
      manager.bindSession('ac-3', 'sess-3')

      manager.setAgentControl('sess-3', {})
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-3')
      const calls = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Agent is working…')
    })

    it('clearAgentControl dismisses native overlay', () => {
      manager.createInstance('ac-4')
      manager.bindSession('ac-4', 'sess-4')

      manager.setAgentControl('sess-4', { displayName: 'Click Button', intent: 'Clicking submit' })
      manager.clearAgentControl('sess-4')

      const instance = (manager as any).instances.get('ac-4')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('clearAgentControl is a no-op when not active', () => {
      manager.createInstance('ac-5')
      manager.bindSession('ac-5', 'sess-5')

      manager.clearAgentControl('sess-5')

      const instance = (manager as any).instances.get('ac-5')
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('clearVisualsForSession resets agent control state', async () => {
      manager.createInstance('ac-6')
      manager.bindSession('ac-6', 'sess-6')

      manager.setAgentControl('sess-6', { displayName: 'Fill Input', intent: 'Typing email' })
      await manager.clearVisualsForSession('sess-6')

      const instance = (manager as any).instances.get('ac-6')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('setAgentControl ignores unbound sessions', () => {
      manager.createInstance('ac-7')

      manager.setAgentControl('nonexistent-session', { displayName: 'Test' })

      const instance = (manager as any).instances.get('ac-7')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('navigate does not trigger overlay by itself', async () => {
      manager.createInstance('ac-8')
      manager.bindSession('ac-8', 'sess-8')

      await manager.navigate('ac-8', 'https://example.com')

      const instance = (manager as any).instances.get('ac-8')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })
  })

  describe('security challenge detection', () => {
    const NONE = { detected: false, provider: 'none', signals: [], suspected: false }
    const ordinaryPage = {
      readyState: 'complete',
      title: 'Example',
      cfChallengeOptions: false,
      challengeForm: false,
      challengeStage: false,
      text: 'Welcome',
      frames: [],
      turnstile: [],
      pxCaptcha: null,
      overlayOpen: false,
    }
    const interstitial = { ...ordinaryPage, title: 'Just a moment...', cfChallengeOptions: true }

    /** A settled page whose page script returns `pages` in turn; the confirm delay is stubbed out. */
    function setUpPage(id: string, pages: unknown[], options: { loading?: boolean } = {}) {
      manager.createInstance(id)
      const instance = (manager as any).instances.get(id)
      instance.currentUrl = 'https://example.com/'
      instance.pageView.webContents.isLoading = mock(() => options.loading ?? false)
      let call = 0
      instance.pageView.webContents.executeJavaScript = mock(async () => pages[Math.min(call++, pages.length - 1)])
      const sleep = mock(async (_ms: number) => {})
      ;(manager as any).sleep = sleep
      return { instance, sleep }
    }

    it('gives no verdict while the page is loading', async () => {
      const { instance, sleep } = setUpPage('sc-loading', [interstitial], { loading: true })

      expect(await manager.detectSecurityChallenge('sc-loading')).toEqual(NONE)
      expect(instance.pageView.webContents.executeJavaScript).not.toHaveBeenCalled()
      expect(sleep).not.toHaveBeenCalled()
    })

    it('does not flag a sparse page that shows no challenge', async () => {
      const { instance, sleep } = setUpPage('sc-sparse', [{ ...ordinaryPage, text: 'Invalid connect link' }])
      instance.cdp.getAccessibilitySnapshot = mock(async () => ({
        url: 'https://example.com/',
        title: 'Example',
        nodes: [
          { ref: '@e1', role: 'heading', name: 'Invalid connect link' },
          { ref: '@e2', role: 'paragraph', name: 'Ask for a new one.' },
          { ref: '@e3', role: 'link', name: 'Home' },
        ],
      }))

      expect(await manager.detectSecurityChallenge('sc-sparse')).toEqual({ ...NONE, signals: ['ax:near-empty(1/3)'] })
      expect(sleep).not.toHaveBeenCalled()
    })

    it('reports a challenge only after a second look confirms it', async () => {
      const { SECURITY_CHALLENGE_CONFIRM_DELAY_MS } = await import('../security-challenge')
      const { instance, sleep } = setUpPage('sc-confirmed', [interstitial, interstitial])

      const verdict = await manager.detectSecurityChallenge('sc-confirmed')

      expect(verdict).toEqual({ detected: true, provider: 'cloudflare', signals: ['js:cf-chl-opt', 'title:just-a-moment'], suspected: false })
      expect(sleep).toHaveBeenCalledTimes(1)
      expect(sleep).toHaveBeenCalledWith(SECURITY_CHALLENGE_CONFIRM_DELAY_MS)
      expect(instance.pageView.webContents.executeJavaScript).toHaveBeenCalledTimes(2)
    })

    it('drops a verdict that does not hold on the second look', async () => {
      const { sleep } = setUpPage('sc-passed', [interstitial, ordinaryPage])

      expect(await manager.detectSecurityChallenge('sc-passed')).toEqual(NONE)
      expect(sleep).toHaveBeenCalledTimes(1)
    })

    it('gives no verdict when the URL changes while facts are collected', async () => {
      const { instance } = setUpPage('sc-moved', [])
      instance.pageView.webContents.executeJavaScript = mock(async () => {
        instance.currentUrl = 'https://example.com/next'
        return interstitial
      })

      expect(await manager.detectSecurityChallenge('sc-moved')).toEqual(NONE)
    })

    it('gives no verdict when the page script fails or the instance is gone', async () => {
      const { instance } = setUpPage('sc-script-error', [])
      instance.pageView.webContents.executeJavaScript = mock(async () => { throw new Error('Script failed to execute') })

      expect(await manager.detectSecurityChallenge('sc-script-error')).toEqual(NONE)
      expect(await manager.detectSecurityChallenge('sc-missing')).toEqual(NONE)
    })
  })

  describe('browser selection references', () => {
    const capture = {
      quote: 'selected text',
      prefix: 'before',
      suffix: 'after',
      rect: { x: 100, y: 100, width: 80, height: 18 },
    }

    const evaluateSelectionActions = (instance: any) => {
      ;(manager as any).updateNativeOverlayState(instance)
      const overlayView = webContentsViews.find(({ options }) => (
        options?.webPreferences?.preload?.includes('browser-overlay-preload')
      ))?.view
      const expression = overlayView?.webContents.executeJavaScript.mock.calls.at(-1)?.[0] as string
      const loadedUrl = overlayView?.webContents.loadURL.mock.calls[0]?.[0] as string
      const html = decodeURIComponent(loadedUrl.slice(loadedUrl.indexOf(',') + 1))
      const noteLabel = {
        textContent: html.match(
          /data-browser-selection-action="add-note"[\s\S]*?<span data-browser-selection-label>([^<]*)<\/span>/,
        )?.[1] ?? null,
      }
      class FakeButton {
        disabled = false
        title = ''
        querySelector() { return noteLabel }
      }
      const addChat = new FakeButton()
      const newChat = new FakeButton()
      const addNote = new FakeButton()
      const chooseNoteTarget = new FakeButton()
      const overlay = { style: { display: 'block' } }
      const selectionActions = { style: { display: 'none' }, dataset: {} }
      const documentStub = {
        getElementById: (id: string) => (
          id === 'overlay' ? overlay : selectionActions
        ),
        querySelector: (selector: string) => ({
          '[data-browser-selection-action="add-chat"]': addChat,
          '[data-browser-selection-action="new-chat"]': newChat,
          '[data-browser-selection-action="add-note"]': addNote,
          '[data-browser-selection-action="choose-note-target"]': chooseNoteTarget,
        }[selector]),
      }

      Function('document', 'HTMLButtonElement', expression)(documentStub, FakeButton)
      return { addChat, addNote, chooseNoteTarget, noteLabel }
    }

    const queueOverlayScripts = async (instanceId: string) => {
      manager.createInstance(instanceId)
      await Bun.sleep(0)
      const instance = (manager as any).instances.get(instanceId)
      instance.nativeOverlayReady = true

      class FakeButton {
        disabled = false
        title = ''
      }

      const addChat = new FakeButton()
      const newChat = new FakeButton()
      const addNote = new FakeButton()
      const chooseNoteTarget = new FakeButton()
      const overlay = { style: { display: 'none' } }
      const selectionActions = {
        style: { display: 'none' },
        dataset: {},
      }
      const chip = { textContent: '', style: { display: 'none' } }
      const shield = {
        style: { pointerEvents: '', cursor: '', background: '' },
      }
      const elements: Record<string, unknown> = {
        overlay,
        'selection-actions': selectionActions,
        chip,
        shield,
      }
      const documentStub = {
        getElementById: (id: string) => elements[id] ?? null,
        querySelector: (selector: string) => ({
          '[data-browser-selection-action="add-chat"]': addChat,
          '[data-browser-selection-action="new-chat"]': newChat,
          '[data-browser-selection-action="add-note"]': addNote,
          '[data-browser-selection-action="choose-note-target"]': chooseNoteTarget,
        }[selector]),
      }
      const updates: Array<{ run: () => void, resolve: () => void }> = []
      instance.nativeOverlayView.webContents.executeJavaScript = mock((expression: string) => (
        new Promise<void>(resolve => {
          updates.push({
            run: () => Function('document', 'HTMLButtonElement', expression)(documentStub, FakeButton),
            resolve,
          })
        })
      ))

      return {
        instance,
        updates,
        addNote,
        overlay,
        selectionActions,
      }
    }

    const clickLastMenuItem = (label: string) => {
      const template = mockMenuBuildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
        label?: string
        click?: () => void
      }>
      const item = template.find(candidate => candidate.label === label)
      expect(item).toBeTruthy()
      item?.click?.()
    }

    it('keeps selection action labels compact when the Note target path is long', () => {
      manager.createInstance('selection-long-note-label')
      const instance = (manager as any).instances.get('selection-long-note-label')
      instance.nativeOverlayReady = true
      instance.pendingSelection = { capture }
      instance.targetChat = {
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath: 'notes/add-note-ui-test-with-a-very-long-file-name.md',
      }

      const { addNote, noteLabel } = evaluateSelectionActions(instance)

      expect(noteLabel.textContent).toBe('Add Note')
      expect(addNote.title).toContain('notes/add-note-ui-test-with-a-very-long-file-name.md')
    })

    it('keeps Add Note available when the target Chat has not chosen a Note yet', () => {
      manager.createInstance('selection-no-note-target')
      const instance = (manager as any).instances.get('selection-no-note-target')
      instance.nativeOverlayReady = true
      instance.pendingSelection = { capture }
      instance.targetChat = {
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath: null,
      }

      const { addNote, chooseNoteTarget } = evaluateSelectionActions(instance)

      expect(addNote.disabled).toBe(false)
      expect(addNote.title).toBe(i18n.t('projectNoteTarget.chooseFile'))
      expect(chooseNoteTarget.disabled).toBe(false)
    })

    it('keeps Add to Chat and Add Note available without a target Chat', () => {
      manager.createInstance('selection-no-chat-target', {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
      })
      const instance = (manager as any).instances.get('selection-no-chat-target')
      instance.nativeOverlayReady = true
      instance.pendingSelection = { capture }

      const { addChat, addNote, chooseNoteTarget } = evaluateSelectionActions(instance)

      expect(addChat.disabled).toBe(false)
      expect(addNote.disabled).toBe(false)
      expect(chooseNoteTarget.disabled).toBe(false)
    })

    it('ignores an older overlay script even when its promise never settles', async () => {
      const {
        instance,
        updates,
        addNote,
      } = await queueOverlayScripts('selection-overlay-update-order')
      instance.pendingSelection = { capture }

      instance.selectionActionPending = true
      ;(manager as any).updateNativeOverlayState(instance)
      instance.selectionActionPending = false
      ;(manager as any).updateNativeOverlayState(instance)

      updates[1]!.run()
      updates[1]!.resolve()
      await Bun.sleep(0)
      expect(addNote.disabled).toBe(false)

      updates[0]!.run()
      expect(addNote.disabled).toBe(false)
      expect(updates).toHaveLength(2)
    })

    it('keeps a newer agent overlay when an older selection script finishes later', async () => {
      const {
        instance,
        updates,
        overlay,
        selectionActions,
      } = await queueOverlayScripts('selection-agent-update-order')
      instance.pendingSelection = { capture }
      ;(manager as any).updateNativeOverlayState(instance)

      instance.agentControl = {
        active: true,
        sessionId: 'session-1',
        displayName: 'Research Agent',
      }
      ;(manager as any).updateNativeOverlayState(instance)

      updates[1]!.run()
      updates[1]!.resolve()
      await Bun.sleep(0)
      expect(overlay.style.display).toBe('block')
      expect(selectionActions.style.display).toBe('none')

      updates[0]!.run()
      expect(overlay.style.display).toBe('block')
      expect(selectionActions.style.display).toBe('none')
      expect(updates).toHaveLength(2)
    })

    it('keeps a restored selection overlay when an old agent script finishes after it was hidden', async () => {
      const {
        instance,
        updates,
        overlay,
        selectionActions,
      } = await queueOverlayScripts('agent-selection-restore-order')
      instance.agentControl = {
        active: true,
        sessionId: 'session-1',
        displayName: 'Research Agent',
      }
      ;(manager as any).updateNativeOverlayState(instance)

      instance.agentControl = null
      ;(manager as any).updateNativeOverlayState(instance)
      expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      })

      instance.pendingSelection = { capture }
      ;(manager as any).updateNativeOverlayState(instance)
      updates[1]!.run()
      updates[1]!.resolve()
      await Bun.sleep(0)
      expect(overlay.style.display).toBe('none')
      expect(selectionActions.style.display).toBe('flex')

      updates[0]!.run()
      expect(overlay.style.display).toBe('none')
      expect(selectionActions.style.display).toBe('flex')
      expect(updates).toHaveLength(2)
    })

    it('applies Add Note in the Browser Project without choosing a Chat', async () => {
      const applySelection = mock(async () => ({
        sessionId: null,
        targetTitle: null,
        noteTargetPath: 'notes/research.md',
      }))
      manager.setApplicationService({
        listProjectTargets: mock(async () => []),
        listChatTargets: mock(async () => []),
        openChat: mock(async () => {}),
        applySelection: applySelection as any,
      })
      manager.createInstance('selection-note-without-chat', {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
      })
      const instance = (manager as any).instances.get('selection-note-without-chat')
      instance.currentUrl = 'https://example.com/article'
      instance.title = 'Example article'
      instance.nativeOverlayReady = true

      ;(manager as any).handleSelectionCapture(instance, capture)
      await (manager as any).handleSelectionAction(instance, 'add-note')

      expect(applySelection).toHaveBeenCalledWith(expect.objectContaining({
        action: 'add-note',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        sessionId: null,
      }))
      expect(instance.pendingSelection).toBeNull()
      expect(instance.targetChat).toBeNull()
    })

  it('adds an independent-window selection to the target Chat through the application service', async () => {
    const applySelection = mock(async () => ({
      sessionId: 'session-1',
      targetTitle: 'Chat 1',
      noteTargetPath: 'notes/research.md',
    }))
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => []),
      openChat: mock(async () => {}),
      applySelection,
    })
    manager.createInstance('selection-1', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    const instance = (manager as any).instances.get('selection-1')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true

    ;(manager as any).handleSelectionCapture(instance, capture)
    await (manager as any).handleSelectionAction(instance, 'add-chat')

    expect(applySelection).toHaveBeenCalledWith(expect.objectContaining({
      action: 'add-chat',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      originWebContentsId: null,
      requestId: expect.any(String),
      source: expect.objectContaining({
        url: 'https://example.com/article',
        title: 'Example article',
        quote: 'selected text',
      }),
    }))
    expect(instance.pendingSelection).toBeNull()
  })

  it('adds a selection to the Chat and Note in the newly selected Project', async () => {
    const applySelection = mock(async () => ({
      sessionId: 'session-2',
      targetTitle: 'Chat 2',
      noteTargetPath: 'notes/project-2.md',
    }))
    manager.setApplicationService({
      listProjectTargets: mock(async () => [
        { id: 'project-1', title: 'Project 1' },
        { id: 'project-2', title: 'Project 2' },
      ]),
      listChatTargets: mock(async ({ projectId }) => projectId === 'project-2'
        ? [{ id: 'session-2', title: 'Chat 2', noteTargetPath: 'notes/project-2.md' }]
        : []),
      openChat: mock(async () => {}),
      applySelection,
    })
    manager.createInstance('selection-switched-project', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    await manager.setProject('selection-switched-project', 'project-2')
    await manager.setTargetSession('selection-switched-project', 'session-2')
    const instance = (manager as any).instances.get('selection-switched-project')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true

    ;(manager as any).handleSelectionCapture(instance, capture)
    await (manager as any).handleSelectionAction(instance, 'add-note')

    expect(applySelection).toHaveBeenCalledWith(expect.objectContaining({
      action: 'add-note',
      workspaceId: 'workspace-1',
      projectId: 'project-2',
      sessionId: 'session-2',
    }))
    expect(instance.targetChat.noteTargetPath).toBe('notes/project-2.md')
  })

    it('chooses a Chat and continues add-chat after switching Project', async () => {
      const action = 'add-chat' as const
      const applySelection = mock(async () => ({
        sessionId: 'session-2',
        targetTitle: 'Chat 2',
        noteTargetPath: 'notes/project-2.md',
      }))
      manager.setApplicationService({
        listProjectTargets: mock(async () => [
          { id: 'project-1', title: 'Project 1' },
          { id: 'project-2', title: 'Project 2' },
        ]),
        listChatTargets: mock(async ({ projectId }) => projectId === 'project-2'
          ? [{ id: 'session-2', title: 'Chat 2', noteTargetPath: 'notes/project-2.md' }]
          : []),
        openChat: mock(async () => {}),
        applySelection,
      })
      manager.createInstance(`selection-${action}-after-project-switch`, {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
      })
      await manager.setProject(`selection-${action}-after-project-switch`, 'project-2')
      const instance = (manager as any).instances.get(`selection-${action}-after-project-switch`)
      instance.currentUrl = 'https://example.com/article'
      instance.title = 'Example article'
      instance.nativeOverlayReady = true
      ;(manager as any).handleSelectionCapture(instance, capture)

      await (manager as any).handleSelectionAction(instance, action)

      clickLastMenuItem('Chat 2')
      await Bun.sleep(0)
      await Bun.sleep(0)

      expect(applySelection).toHaveBeenCalledWith(expect.objectContaining({
        action,
        projectId: 'project-2',
        sessionId: 'session-2',
      }))
      expect(instance.pendingSelection).toBeNull()
    })

  it('keeps the action busy while the selected Chat is being validated', async () => {
    let finishTargetLookup: ((targets: BrowserChatTarget[]) => void) | null = null
    let listCallCount = 0
    const applySelection = mock(async () => ({
      sessionId: 'session-2',
      targetTitle: 'Chat 2',
      noteTargetPath: 'notes/project-2.md',
    }))
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(() => {
        listCallCount += 1
        if (listCallCount <= 3) {
          return Promise.resolve([{
            id: 'session-2',
            title: 'Chat 2',
            noteTargetPath: 'notes/project-2.md',
          }])
        }
        return new Promise<BrowserChatTarget[]>(resolve => { finishTargetLookup = resolve })
      }),
      openChat: mock(async () => {}),
      applySelection,
    })
    manager.createInstance('selection-chat-validation', {
      workspaceId: 'workspace-1',
      projectId: 'project-2',
    })
    const instance = (manager as any).instances.get('selection-chat-validation')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    ;(manager as any).handleSelectionCapture(instance, capture)

    await (manager as any).handleSelectionAction(instance, 'add-chat')
    clickLastMenuItem('Chat 2')

    expect(instance.selectionActionPending).toBe(true)
    await (manager as any).handleSelectionAction(instance, 'new-chat')
    expect(applySelection).not.toHaveBeenCalled()

    finishTargetLookup!([{
      id: 'session-2',
      title: 'Chat 2',
      noteTargetPath: 'notes/project-2.md',
    }])
    await Bun.sleep(0)
    await Bun.sleep(0)

    expect(applySelection).toHaveBeenCalledTimes(1)
    expect(applySelection).toHaveBeenCalledWith(expect.objectContaining({
      action: 'add-chat',
      sessionId: 'session-2',
    }))
  })

  it('shows an error when the chosen Chat disappears before validation', async () => {
    let listCallCount = 0
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => {
        listCallCount += 1
        return listCallCount <= 3
          ? [{ id: 'session-2', title: 'Chat 2', noteTargetPath: null }]
          : []
      }),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-2',
        targetTitle: 'Chat 2',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('selection-chat-disappeared', {
      workspaceId: 'workspace-1',
      projectId: 'project-2',
    })
    const instance = (manager as any).instances.get('selection-chat-disappeared')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    ;(manager as any).handleSelectionCapture(instance, capture)

    await (manager as any).handleSelectionAction(instance, 'add-chat')
    clickLastMenuItem('Chat 2')
    await Bun.sleep(0)
    await Bun.sleep(0)

    expect(instance.selectionActionPending).toBe(false)
    expect(instance.pendingSelection).not.toBeNull()
    expect(instance.selectionFeedback).toEqual({
      kind: 'error',
      message: i18n.t('reference.couldNotAdd'),
    })
  })

  it('keeps a new page selection made while the previous action is pending', async () => {
    let finishSelection: ((value: {
      sessionId: string
      targetTitle: string
      noteTargetPath: string | null
    }) => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Chat 1',
        noteTargetPath: null,
      }]),
      openChat: mock(async () => {}),
      applySelection: mock(() => new Promise<{
        sessionId: string
        targetTitle: string
        noteTargetPath: string | null
      }>(resolve => { finishSelection = resolve })),
    })
    manager.createInstance('selection-replaced-while-pending', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    const instance = (manager as any).instances.get('selection-replaced-while-pending')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    ;(manager as any).handleSelectionCapture(instance, capture)
    const firstAction = (manager as any).handleSelectionAction(instance, 'add-chat')
    const replacement = { ...capture, quote: 'new selected text' }

    ;(manager as any).handleSelectionCapture(instance, replacement)
    finishSelection!({
      sessionId: 'session-1',
      targetTitle: 'Chat 1',
      noteTargetPath: null,
    })
    await firstAction

    expect(instance.selectionActionPending).toBe(false)
    expect(instance.pendingSelection?.capture.quote).toBe('new selected text')
  })

  for (const scenario of [
    {
      action: 'new-chat' as const,
      targetSessionId: null,
      result: {
        sessionId: 'session-new',
        targetTitle: 'New Chat',
        noteTargetPath: null,
      },
    },
    {
      action: 'add-note' as const,
      targetSessionId: 'session-1',
      result: {
        sessionId: 'session-1',
        targetTitle: 'Chat 1',
        noteTargetPath: 'notes/new-target.md',
      },
    },
  ]) {
    it(`syncs the ${scenario.action} result while preserving a newer page selection`, async () => {
      let finishSelection: ((value: typeof scenario.result) => void) | null = null
      manager.setApplicationService({
        listProjectTargets: mock(async () => []),
        listChatTargets: mock(async () => scenario.targetSessionId
          ? [{
              id: scenario.targetSessionId,
              title: 'Chat 1',
              noteTargetPath: null,
            }]
          : []),
        openChat: mock(async () => {}),
        applySelection: mock(() => new Promise<typeof scenario.result>(resolve => {
          finishSelection = resolve
        })),
      })
      manager.createInstance(`selection-${scenario.action}-result-with-replacement`, {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        targetSessionId: scenario.targetSessionId,
      })
      const instance = (manager as any).instances.get(
        `selection-${scenario.action}-result-with-replacement`,
      )
      instance.currentUrl = 'https://example.com/article'
      instance.title = 'Example article'
      instance.nativeOverlayReady = true
      ;(manager as any).handleSelectionCapture(instance, capture)
      const action = (manager as any).handleSelectionAction(instance, scenario.action)

      ;(manager as any).handleSelectionCapture(instance, {
        ...capture,
        quote: 'new selected text',
      })
      finishSelection!(scenario.result)
      await action

      expect(instance.pendingSelection?.capture.quote).toBe('new selected text')
      expect(instance.targetSessionId).toBe(scenario.result.sessionId)
      expect(instance.targetChat).toEqual({
        id: scenario.result.sessionId,
        title: scenario.result.targetTitle,
        noteTargetPath: scenario.result.noteTargetPath,
      })
    })
  }

  it('does not restore a deleted target Chat from a late Add Note result', async () => {
    let finishSelection!: (value: {
      sessionId: string
      targetTitle: string
      noteTargetPath: string
    }) => void
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Chat 1',
        noteTargetPath: null,
      }]),
      openChat: mock(async () => {}),
      applySelection: mock(() => new Promise<BrowserSelectionActionResult>(resolve => {
        finishSelection = resolve
      })),
    })
    manager.createInstance('late-note-result-after-chat-delete', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    const instance = (manager as any).instances.get('late-note-result-after-chat-delete')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    ;(manager as any).handleSelectionCapture(instance, capture)

    const action = (manager as any).handleSelectionAction(instance, 'add-note')
    instance.targetSessionId = null
    instance.targetChat = null
    finishSelection({
      sessionId: 'session-1',
      targetTitle: 'Chat 1',
      noteTargetPath: 'notes/research.md',
    })
    await action

    expect(instance.targetSessionId).toBeNull()
    expect(instance.targetChat).toBeNull()
  })

  it('does not let a slow toolbar Chat menu clear a newer page selection', async () => {
    let finishMenuTargets: ((targets: BrowserChatTarget[]) => void) | null = null
    let listCallCount = 0
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(() => {
        listCallCount += 1
        return listCallCount === 1
          ? new Promise<BrowserChatTarget[]>(resolve => { finishMenuTargets = resolve })
          : Promise.resolve([])
      }),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Chat 1',
        noteTargetPath: null,
      })),
    })
    manager.createInstance('slow-toolbar-chat-menu', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    const instance = (manager as any).instances.get('slow-toolbar-chat-menu')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    const menuCount = mockMenuBuildFromTemplate.mock.calls.length

    const showMenu = (manager as any).showChatTargetMenu(instance)
    ;(manager as any).handleSelectionCapture(instance, capture)
    finishMenuTargets!([])
    await showMenu

    expect(instance.pendingSelection?.capture.quote).toBe('selected text')
    expect(mockMenuBuildFromTemplate).toHaveBeenCalledTimes(menuCount)
  })

  it('does not show a stale Chat chooser after another selection action starts', async () => {
    let finishChooser: ((targets: BrowserChatTarget[]) => void) | null = null
    let finishNewChat: ((value: {
      sessionId: string
      targetTitle: string
      noteTargetPath: string | null
    }) => void) | null = null
    let listCallCount = 0
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(() => {
        listCallCount += 1
        return listCallCount <= 2
          ? Promise.resolve([])
          : new Promise<BrowserChatTarget[]>(resolve => { finishChooser = resolve })
      }),
      openChat: mock(async () => {}),
      applySelection: mock(() => new Promise<{
        sessionId: string
        targetTitle: string
        noteTargetPath: string | null
      }>(resolve => { finishNewChat = resolve })),
    })
    manager.createInstance('stale-selection-chat-chooser', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    const instance = (manager as any).instances.get('stale-selection-chat-chooser')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    ;(manager as any).handleSelectionCapture(instance, capture)
    const menuCount = mockMenuBuildFromTemplate.mock.calls.length

    const chooserAction = (manager as any).handleSelectionAction(instance, 'add-chat')
    const newChatAction = (manager as any).handleSelectionAction(instance, 'new-chat')
    finishChooser!([{
      id: 'session-1',
      title: 'Chat 1',
      noteTargetPath: null,
    }])
    await chooserAction

    expect(mockMenuBuildFromTemplate).toHaveBeenCalledTimes(menuCount)

    finishNewChat!({
      sessionId: 'session-new',
      targetTitle: 'New Chat',
      noteTargetPath: null,
    })
    await newChatAction
  })

  it('does not open the toolbar Chat menu or clear selection while an action is pending', async () => {
    let finishSelection: ((value: {
      sessionId: string
      targetTitle: string
      noteTargetPath: string | null
    }) => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Chat 1',
        noteTargetPath: null,
      }]),
      openChat: mock(async () => {}),
      applySelection: mock(() => new Promise<{
        sessionId: string
        targetTitle: string
        noteTargetPath: string | null
      }>(resolve => { finishSelection = resolve })),
    })
    manager.createInstance('toolbar-chat-menu-during-selection-action', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    const instance = (manager as any).instances.get(
      'toolbar-chat-menu-during-selection-action',
    )
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    ;(manager as any).handleSelectionCapture(instance, capture)
    const pendingSelection = instance.pendingSelection
    const action = (manager as any).handleSelectionAction(instance, 'add-chat')
    const menuCount = mockMenuBuildFromTemplate.mock.calls.length

    await (manager as any).showChatTargetMenu(instance)

    expect(instance.pendingSelection).toBe(pendingSelection)
    expect(mockMenuBuildFromTemplate).toHaveBeenCalledTimes(menuCount)

    finishSelection!({
      sessionId: 'session-1',
      targetTitle: 'Chat 1',
      noteTargetPath: null,
    })
    await action
  })

  it('targets a newly created Chat from a manual Browser', async () => {
    const applySelection = mock(async () => ({
      sessionId: 'session-new',
      targetTitle: 'New Chat',
      noteTargetPath: null,
    }))
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => []),
      openChat: mock(async () => {}),
      applySelection,
    })
    manager.createInstance('selection-new-chat', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    const instance = (manager as any).instances.get('selection-new-chat')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true

    ;(manager as any).handleSelectionCapture(instance, capture)
    await (manager as any).handleSelectionAction(instance, 'new-chat')

    expect(applySelection).toHaveBeenCalledWith(expect.objectContaining({
      action: 'new-chat',
      sessionId: null,
    }))
    expect(manager.listInstances()[0].targetSessionId).toBe('session-new')
  })

  it('rejects selection actions from an existing Browser while its Project is deleting', async () => {
    const applySelection = mock(async () => ({
      sessionId: 'orphan-session',
      targetTitle: 'Orphan Chat',
      noteTargetPath: null,
    }))
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => []),
      openChat: mock(async () => {}),
      applySelection,
    })
    manager.createInstance('selection-project-deleting', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    const instance = (manager as any).instances.get('selection-project-deleting')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    ;(manager as any).handleSelectionCapture(instance, capture)

    manager.beginProjectDeletion('workspace-1', 'project-1')
    await (manager as any).handleSelectionAction(instance, 'new-chat')

    expect(applySelection).not.toHaveBeenCalled()
    expect(instance.pendingSelection).not.toBeNull()
    expect(instance.selectionFeedback).toEqual({
      kind: 'error',
      message: i18n.t('reference.couldNotAdd'),
    })
  })

  it('keeps the selection and reports the Note destination error in the toolbar', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath: null,
      }]),
      openChat: mock(async () => {}),
      applySelection: mock(async () => {
        throw new Error('Target Chat has no Project note file')
      }),
    })
    manager.createInstance('selection-note-error', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get('selection-note-error')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true

    ;(manager as any).handleSelectionCapture(instance, capture)
    await (manager as any).handleSelectionAction(instance, 'add-note')

    expect(instance.pendingSelection).not.toBeNull()
    expect(instance.toolbarView.webContents.send).toHaveBeenCalledWith(
      'browser-toolbar:state-update',
      expect.objectContaining({
        selectionFeedback: {
          kind: 'error',
          message: i18n.t('reference.couldNotAddNote'),
        },
      }),
    )
  })

  it('reports the exact Note file after a successful append', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath: 'notes/research.md',
      }]),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({
        sessionId: 'session-1',
        targetTitle: 'Research Chat',
        noteTargetPath: 'notes/research.md',
      })),
    })
    manager.createInstance('selection-note-success', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get('selection-note-success')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true

    ;(manager as any).handleSelectionCapture(instance, capture)
    await (manager as any).handleSelectionAction(instance, 'add-note')

    expect(instance.pendingSelection).toBeNull()
    expect(instance.toolbarView.webContents.send).toHaveBeenCalledWith(
      'browser-toolbar:state-update',
      expect.objectContaining({
        selectionFeedback: {
          kind: 'success',
          message: 'Added to notes/research.md',
        },
      }),
    )
  })

  it('chooses a different Note target and keeps the Browser destination in sync', async () => {
    const applySelection = mock(async () => ({
      sessionId: 'session-1',
      targetTitle: null,
      noteTargetPath: 'notes/second.md',
    }))
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath: 'notes/first.md',
      }]),
      openChat: mock(async () => {}),
      applySelection,
    })
    manager.createInstance('selection-choose-note', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get('selection-choose-note')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    instance.toolbarReady = true
    instance.isVisible = true
    instance.window.focus.mockClear()

    ;(manager as any).handleSelectionCapture(instance, capture)
    await (manager as any).handleSelectionAction(instance, 'choose-note-target')

    expect(applySelection).toHaveBeenCalledWith(expect.objectContaining({
      action: 'choose-note-target',
      sessionId: 'session-1',
    }))
    expect(instance.pendingSelection).toBeNull()
    expect(instance.targetChat.title).toBe('Research Chat')
    expect(instance.targetChat.noteTargetPath).toBe('notes/second.md')
    expect(instance.window.focus).toHaveBeenCalledTimes(1)
    expect(instance.toolbarView.webContents.send).toHaveBeenCalledWith(
      'browser-toolbar:state-update',
      expect.objectContaining({
        selectionFeedback: {
          kind: 'success',
          message: 'Added to notes/second.md',
        },
      }),
    )
  })

  it('keeps the selection visible when the shared Note picker is cancelled', async () => {
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath: 'notes/first.md',
      }]),
      openChat: mock(async () => {}),
      applySelection: mock(async () => ({ cancelled: true as const })),
    })
    manager.createInstance('selection-cancel-note', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get('selection-cancel-note')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    instance.toolbarReady = true
    instance.isVisible = true
    instance.window.focus.mockClear()

    ;(manager as any).handleSelectionCapture(instance, capture)
    await (manager as any).handleSelectionAction(instance, 'choose-note-target')

    expect(instance.pendingSelection).not.toBeNull()
    expect(instance.selectionActionPending).toBe(false)
    expect(instance.selectionFeedback).toBeNull()
    expect(instance.window.focus).toHaveBeenCalledTimes(1)
  })

  it('does not reopen a Browser hidden while the shared Note picker is pending', async () => {
    let finish: ((value: { cancelled: true }) => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath: 'notes/first.md',
      }]),
      openChat: mock(async () => {}),
      applySelection: mock(() => new Promise<{ cancelled: true }>(resolve => {
        finish = resolve
      })),
    })
    manager.createInstance('selection-hide-during-note', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get('selection-hide-during-note')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    instance.toolbarReady = true
    instance.isVisible = true
    instance.window.show.mockClear()
    instance.window.focus.mockClear()

    ;(manager as any).handleSelectionCapture(instance, capture)
    const action = (manager as any).handleSelectionAction(instance, 'choose-note-target')
    manager.hide(instance.id)
    finish!({ cancelled: true })
    await action

    expect(instance.isVisible).toBe(false)
    expect(instance.window.show).not.toHaveBeenCalled()
    expect(instance.window.focus).not.toHaveBeenCalled()

    manager.focus(instance.id)
    ;(manager as any).handleSelectionCapture(instance, capture)
    expect(instance.selectionActionPending).toBe(false)
    expect(instance.pendingSelection).not.toBeNull()
  })

  it('runs only one application action while the same selection is pending', async () => {
    let finish: ((value: {
      sessionId: string
      targetTitle: string
      noteTargetPath: string | null
    }) => void) | null = null
    const applySelection = mock(() => new Promise<{
      sessionId: string
      targetTitle: string
      noteTargetPath: string | null
    }>(resolve => { finish = resolve }))
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => [{
        id: 'session-1',
        title: 'Research Chat',
        noteTargetPath: 'notes/research.md',
      }]),
      openChat: mock(async () => {}),
      applySelection,
    })
    manager.createInstance('selection-pending', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    await Promise.resolve()
    const instance = (manager as any).instances.get('selection-pending')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    ;(manager as any).handleSelectionCapture(instance, capture)

    const first = (manager as any).handleSelectionAction(instance, 'add-note')
    const second = (manager as any).handleSelectionAction(instance, 'add-note')
    expect(applySelection).toHaveBeenCalledTimes(1)

    finish!({
      sessionId: 'session-1',
      targetTitle: 'Research Chat',
      noteTargetPath: 'notes/research.md',
    })
    await Promise.all([first, second])
  })

  it('does not touch a Browser after an async selection action outlives it', async () => {
    let finish: ((value: {
      sessionId: string
      targetTitle: string
      noteTargetPath: string | null
    }) => void) | null = null
    manager.setApplicationService({
      listProjectTargets: mock(async () => []),
      listChatTargets: mock(async () => []),
      openChat: mock(async () => {}),
      applySelection: mock(() => new Promise<{
        sessionId: string
        targetTitle: string
        noteTargetPath: string | null
      }>(resolve => { finish = resolve })),
    })
    manager.createInstance('selection-destroyed-while-pending', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      targetSessionId: 'session-1',
    })
    const instance = (manager as any).instances.get('selection-destroyed-while-pending')
    instance.currentUrl = 'https://example.com/article'
    instance.title = 'Example article'
    instance.nativeOverlayReady = true
    ;(manager as any).handleSelectionCapture(instance, capture)

    const action = (manager as any).handleSelectionAction(instance, 'add-note')
    manager.destroyInstance(instance.id)
    await Promise.resolve()
    instance.nativeOverlayView.setBounds.mockClear()
    instance.rootView.addChildView.mockClear()
    instance.toolbarView.webContents.send.mockClear()

    finish!({
      sessionId: 'session-1',
      targetTitle: 'Research Chat',
      noteTargetPath: 'notes/research.md',
    })
    await expect(action).resolves.toBeUndefined()

    expect(instance.nativeOverlayView.setBounds).not.toHaveBeenCalled()
    expect(instance.rootView.addChildView).not.toHaveBeenCalled()
    expect(instance.toolbarView.webContents.send).not.toHaveBeenCalled()
  })

    it('clears selection actions when agent control takes priority', () => {
      manager.createInstance('selection-agent')
      const instance = (manager as any).instances.get('selection-agent')
      instance.currentUrl = 'https://example.com'
      instance.title = 'Example'
      instance.nativeOverlayReady = true
      manager.bindSession('selection-agent', 'session-1')
      ;(manager as any).handleSelectionCapture(instance, capture)

      manager.setAgentControl('session-1', { displayName: 'Agent' })

      expect(instance.pendingSelection).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({
        x: 0,
        y: 48,
        width: 1200,
        height: 852,
      })
    })

    it('refuses to create an orphan Browser when no Workspace owns the reveal', async () => {
      await expect(manager.revealSelection({
        version: 1,
        kind: 'web-selection',
        projectId: 'project-1',
        url: 'https://example.com/article',
        title: 'Example article',
        quote: 'selected text',
        locator: {
          type: 'web-text-quote',
          exact: 'selected text',
        },
      })).rejects.toThrow('requires an owning Workspace')

      expect(manager.listInstances()).toHaveLength(0)
    })

    it('reveals the saved text quote in the explicitly selected Runtime', async () => {
      manager.createInstance('selection-reveal', {
        workspaceId: 'workspace-1',
      })
      const instance = (manager as any).instances.get('selection-reveal')
      instance.currentUrl = 'https://example.com/article'
      instance.pageView.webContents.executeJavaScript = mock(async () => true)

      const result = await manager.revealSelection({
        version: 1,
        kind: 'web-selection',
        projectId: 'project-1',
        url: 'https://example.com/article',
        title: 'Example article',
        quote: 'selected text',
        locator: {
          type: 'web-text-quote',
          exact: 'selected text',
          prefix: 'before',
          suffix: 'after',
        },
      }, { workspaceId: 'workspace-1', browserId: 'selection-reveal' })

      expect(result).toEqual({
        ok: true,
        browserId: 'selection-reveal',
        found: true,
        created: false,
      })
      expect(manager.listInstances()).toHaveLength(1)
      expect(instance.pageView.webContents.executeJavaScript)
        .toHaveBeenCalledTimes(1)
    })

    it('creates a Project-owned window instead of guessing across other Projects', async () => {
      manager.createInstance('selection-other-project', {
        workspaceId: 'workspace-1',
      })
      const existing = (manager as any).instances.get('selection-other-project')
      existing.currentUrl = 'https://example.com/article'
      existing.pageView.webContents.executeJavaScript = mock(async () => true)

      const result = await manager.revealSelection({
        version: 1,
        kind: 'web-selection',
        projectId: 'project-2',
        url: 'https://example.com/article',
        title: 'Example article',
        quote: 'selected text',
        locator: {
          type: 'web-text-quote',
          exact: 'selected text',
          prefix: 'before',
          suffix: 'after',
        },
      }, { workspaceId: 'workspace-1' })

      expect(result.created).toBe(true)
      expect(result.browserId).not.toBe('selection-other-project')
      expect(existing.pageView.webContents.executeJavaScript).not.toHaveBeenCalled()
      expect(manager.listInstances()).toHaveLength(2)
    })
  })

  describe('failed interaction tracking', () => {
    it('clickElement records failed lastAction on error', async () => {
      manager.createInstance('fail-click')
      const instance = (manager as any).instances.get('fail-click')
      instance.cdp.clickElement = mock(async () => { throw new Error('click failed') })

      await expect(manager.clickElement('fail-click', '@e1')).rejects.toThrow('click failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_click',
        ref: '@e1',
        status: 'failed',
      })
    })

    it('fillElement records failed lastAction on error', async () => {
      manager.createInstance('fail-fill')
      const instance = (manager as any).instances.get('fail-fill')
      instance.cdp.fillElement = mock(async () => { throw new Error('fill failed') })

      await expect(manager.fillElement('fail-fill', '@e2', 'hello')).rejects.toThrow('fill failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_fill',
        ref: '@e2',
        status: 'failed',
      })
    })

    it('selectOption records failed lastAction on error', async () => {
      manager.createInstance('fail-select')
      const instance = (manager as any).instances.get('fail-select')
      instance.cdp.selectOption = mock(async () => { throw new Error('select failed') })

      await expect(manager.selectOption('fail-select', '@e3', 'opt-1')).rejects.toThrow('select failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_select',
        ref: '@e3',
        status: 'failed',
      })
    })
  })
})

// Regression for OSS #1059: closing a popup destroys its BrowserWindow, after
// which reading `webContents` throws "Object has been destroyed". Cleanup used
// to read it, so the popup stayed registered, the parent's teardown threw before
// removing the instance, and every later browser_tool call hit the dead window.
describe('BrowserPaneManager popup teardown after the popup window was destroyed', () => {
  let manager: InstanceType<typeof BrowserPaneManager>

  beforeEach(() => {
    webContentsViewOptions = []
    webContentsViews = []
    toolbarLoadFailuresRemaining = 0
    manager = new BrowserPaneManager()
  })

  /** Make a mock window behave like a destroyed Electron BrowserWindow. */
  function markDestroyed(win: any): void {
    win.isDestroyed = mock(() => true)
    Object.defineProperty(win, 'webContents', {
      configurable: true,
      get() {
        throw new Error('Object has been destroyed')
      },
    })
  }

  function openPopup(parentId: string) {
    const instance = (manager as any).instances.get(parentId)
    const popupWindow = createMockWindow({ width: 520, height: 720 })
    emitDidCreateWindow(instance.pageView.webContents, popupWindow, { url: 'https://accounts.google.com/signin' })
    return popupWindow
  }

  it('unregisters a popup whose window is already destroyed when closed fires', () => {
    manager.createInstance('popup-closed')
    const popupWindow = openPopup('popup-closed')
    const popupWcId = popupWindow.webContents.id
    expect((manager as any).popupParentByWebContentsId.get(popupWcId)).toBe('popup-closed')

    markDestroyed(popupWindow)
    expect(() => popupWindow._emit('closed')).not.toThrow()

    expect((manager as any).popupParentByWebContentsId.has(popupWcId)).toBe(false)
    expect((manager as any).popupWindowsByParentInstanceId.has('popup-closed')).toBe(false)
  })

  it('terminating the parent after closing a popup removes the instance and allows a fresh one', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))
    manager.createInstance('popup-then-terminate')
    const popupWindow = openPopup('popup-then-terminate')

    markDestroyed(popupWindow)
    popupWindow._emit('closed')

    expect(() => manager.destroyInstance('popup-then-terminate')).not.toThrow()
    expect(manager.listInstances()).toHaveLength(0)
    expect(removed).toEqual(['popup-then-terminate'])

    // The next browser_tool open must get a working window.
    manager.createInstance('popup-then-terminate')
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('tears down a parent whose still-registered popup was destroyed out of band', () => {
    manager.createInstance('popup-stale')
    const popupWindow = openPopup('popup-stale')
    // Destroyed without `closed` reaching us (e.g. crash of the popup renderer).
    markDestroyed(popupWindow)

    expect(() => manager.destroyInstance('popup-stale')).not.toThrow()
    expect(manager.listInstances()).toHaveLength(0)
    expect(popupWindow.destroy).not.toHaveBeenCalled()
    expect((manager as any).popupWindowsByParentInstanceId.has('popup-stale')).toBe(false)
  })

  it('removes the instance even when a teardown step throws', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))
    manager.createInstance('teardown-throws')
    const instance = (manager as any).instances.get('teardown-throws')
    instance.cdp.detach = mock(() => {
      throw new Error('Object has been destroyed')
    })

    expect(() => manager.destroyInstance('teardown-throws')).not.toThrow()
    expect(manager.listInstances()).toHaveLength(0)
    expect(removed).toEqual(['teardown-throws'])
  })

  it('resolves instances by page webContents id without touching destroyed webContents', () => {
    manager.createInstance('lookup-safe')
    const instance = (manager as any).instances.get('lookup-safe')
    const wcId = instance.pageWebContentsId
    Object.defineProperty(instance.pageView, 'webContents', {
      configurable: true,
      get() {
        throw new Error('Object has been destroyed')
      },
    })
    expect((manager as any).findInstanceByPageWebContentsId(wcId)).toBe(instance)
    expect((manager as any).findInstanceByPageWebContentsId(wcId + 1000)).toBeUndefined()
  })
})
