// Isolated because this test owns the process-wide Electron module mock.
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { pathToFileURL } from 'node:url'

delete process.env.VITE_DEV_SERVER_URL

const createdWindows: any[] = []
let nextWebContentsId = 900

function createMockWebContents() {
  const listeners = new Map<string, Function[]>()
  let currentUrl = ''

  const addListener = (event: string, listener: Function) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener])
  }

  return {
    id: nextWebContentsId++,
    mainFrame: {},
    isDestroyed: mock(() => false),
    setWindowOpenHandler: mock(() => {}),
    inspectElement: mock(() => {}),
    send: mock(() => {}),
    getURL: mock(() => currentUrl),
    on: (event: string, listener: Function) => addListener(event, listener),
    once: (event: string, listener: Function) => {
      const wrapped = (...args: unknown[]) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter(item => item !== wrapped),
        )
        listener(...args)
      }
      addListener(event, wrapped)
    },
    _setURL: (url: string) => {
      currentUrl = url
    },
    _emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

function createMockWindow() {
  const listeners = new Map<string, Function[]>()
  const webContents = createMockWebContents()

  const addListener = (event: string, listener: Function) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener])
  }
  const window = {
    webContents,
    contentView: {
      addChildView: mock(() => {}),
      removeChildView: mock(() => {}),
    },
    show: mock(() => {}),
    hide: mock(() => {}),
    focus: mock(() => {}),
    close: mock(() => {}),
    destroy: mock(() => {}),
    isDestroyed: mock(() => false),
    isMinimized: mock(() => false),
    restore: mock(() => {}),
    setTitle: mock(() => {}),
    setWindowButtonVisibility: mock(() => {}),
    setWindowButtonPosition: mock(() => {}),
    getBounds: mock(() => ({ x: 0, y: 0, width: 1400, height: 900 })),
    loadURL: mock(async (url: string) => {
      webContents._setURL(url)
    }),
    loadFile: mock(async (
      filePath: string,
      options?: {
        query?: Record<string, string>
        hash?: string
      },
    ) => {
      const url = pathToFileURL(filePath)
      for (const [key, value] of Object.entries(options?.query ?? {})) {
        url.searchParams.set(key, value)
      }
      url.hash = options?.hash ?? ''
      webContents._setURL(url.toString())
    }),
    on: (event: string, listener: Function) => addListener(event, listener),
    once: (event: string, listener: Function) => {
      const wrapped = (...args: unknown[]) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter(item => item !== wrapped),
        )
        listener(...args)
      }
      addListener(event, wrapped)
    },
  }
  return window
}

mock.module('electron', () => ({
  app: {
    getName: mock(() => 'Craft Agents'),
    isPackaged: true,
  },
  BrowserWindow: class MockBrowserWindow {
    static getFocusedWindow = mock(() => null)

    constructor() {
      const window = createMockWindow()
      createdWindows.push(window)
      return window
    }
  },
  Menu: {
    buildFromTemplate: mock(() => ({ popup: mock(() => {}) })),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    on: mock(() => {}),
    removeListener: mock(() => {}),
  },
  shell: {
    openExternal: mock(async () => {}),
  },
}))

const { WindowManager } = await import('../window-manager')

describe('WindowManager renderer lifecycle', () => {
  beforeEach(() => {
    createdWindows.length = 0
  })

  it('ignores child-frame failures and Chromium ERR_ABORTED', () => {
    const manager = new WindowManager()
    const parked: number[] = []
    manager.setRendererSurfaceParkingHandler(id => parked.push(id))
    manager.createWindow({ workspaceId: 'workspace-1' })
    const window = createdWindows[0]
    const rendererUrl = window.webContents.getURL()

    window.webContents._emit(
      'did-fail-load',
      {},
      -3,
      'ERR_ABORTED',
      rendererUrl,
      true,
      1,
      1,
    )
    window.webContents._emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'blob:epub-frame',
      false,
      1,
      2,
    )

    expect(parked).toEqual([])
    expect(window.loadURL).not.toHaveBeenCalled()
  })

  it('recovers a real main-frame failure with the complete renderer URL', () => {
    const manager = new WindowManager()
    const parked: number[] = []
    manager.setRendererSurfaceParkingHandler(id => parked.push(id))
    manager.createWindow({ workspaceId: 'workspace-1' })
    const window = createdWindows[0]
    const recoveryUrl = new URL(window.webContents.getURL())
    recoveryUrl.pathname = `${recoveryUrl.pathname}/reader`
    recoveryUrl.searchParams.set('layout', 'v2-panel-layout')
    recoveryUrl.hash = 'chapter-4'

    window.webContents._emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      recoveryUrl.toString(),
      true,
      1,
      1,
    )

    expect(parked).toEqual([window.webContents.id])
    expect(window.loadURL).toHaveBeenCalledWith(recoveryUrl.toString())
  })

  it('parks hosted Browser surfaces on real navigation, crash, and destruction', () => {
    const manager = new WindowManager()
    const parked: number[] = []
    manager.setRendererSurfaceParkingHandler(id => parked.push(id))
    manager.createWindow({ workspaceId: 'workspace-1' })
    const window = createdWindows[0]
    const rendererUrl = window.webContents.getURL()

    window.webContents._emit('did-start-navigation', {
      url: rendererUrl,
      isMainFrame: true,
      isSameDocument: true,
    })
    window.webContents._emit('did-start-navigation', {
      url: 'blob:epub-frame',
      isMainFrame: false,
      isSameDocument: false,
    })
    expect(parked).toEqual([])

    window.webContents._emit('did-start-navigation', {
      url: rendererUrl,
      isMainFrame: true,
      isSameDocument: false,
    })
    window.webContents._emit(
      'render-process-gone',
      {},
      { reason: 'crashed' },
    )
    window.webContents._emit('destroyed')

    expect(parked).toEqual([
      window.webContents.id,
      window.webContents.id,
      window.webContents.id,
    ])
  })
})
