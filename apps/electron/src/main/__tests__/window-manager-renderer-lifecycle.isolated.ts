// Isolated because this test owns the process-wide Electron module mock.
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173/'

const createdWindows: any[] = []
let nextWebContentsId = 900
const originalSetTimeout = globalThis.setTimeout

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

  return {
    webContents,
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
    loadFile: mock(async () => {}),
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
}

mock.module('electron', () => ({
  app: {
    getName: mock(() => 'Stair'),
    isPackaged: false,
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
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
      callback()
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  it('ignores child-frame failures and Chromium ERR_ABORTED', () => {
    const manager = new WindowManager()
    manager.createWindow({ workspaceId: 'workspace-1' })
    const window = createdWindows[0]
    window.loadURL.mockClear()

    window.webContents._emit(
      'did-fail-load',
      {},
      -3,
      'ERR_ABORTED',
      'http://localhost:5173/reader?layout=two#chapter-4',
      true,
    )
    window.webContents._emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'blob:epub-frame',
      false,
    )

    expect(window.loadURL).not.toHaveBeenCalled()
    expect(window.loadFile).not.toHaveBeenCalled()
  })

  it('retries the complete main-frame URL at most five times without a production fallback', () => {
    const manager = new WindowManager()
    manager.createWindow({ workspaceId: 'workspace-1' })
    const window = createdWindows[0]
    const recoveryUrl = 'http://localhost:5173/reader/book?layout=v2-panel-layout#chapter-4'
    window.loadURL.mockClear()

    for (let attempt = 0; attempt < 6; attempt++) {
      window.webContents._emit(
        'did-fail-load',
        {},
        -105,
        'ERR_NAME_NOT_RESOLVED',
        recoveryUrl,
        true,
      )
    }

    expect(window.loadURL).toHaveBeenCalledTimes(5)
    expect(window.loadURL).toHaveBeenCalledWith(recoveryUrl)
    expect(window.loadFile).not.toHaveBeenCalled()
  })

  it('resets recovery after a successful load and retains the latest in-page URL', () => {
    const manager = new WindowManager()
    manager.createWindow({ workspaceId: 'workspace-1' })
    const window = createdWindows[0]
    const latestUrl = 'http://localhost:5173/reader/book?layout=three#chapter-7'

    for (let attempt = 0; attempt < 5; attempt++) {
      window.webContents._emit(
        'did-fail-load',
        {},
        -105,
        'ERR_NAME_NOT_RESOLVED',
        'http://localhost:5173/reader/book?layout=two#chapter-4',
        true,
      )
    }

    window.webContents._setURL(latestUrl)
    window.webContents._emit('did-navigate-in-page', {}, latestUrl, true)
    window.webContents._emit('did-finish-load')
    window.loadURL.mockClear()
    window.loadFile.mockClear()

    window.webContents._emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      '',
      true,
    )

    expect(window.loadURL).toHaveBeenCalledTimes(1)
    expect(window.loadURL).toHaveBeenCalledWith(latestUrl)
    expect(window.loadFile).not.toHaveBeenCalled()
  })
})
