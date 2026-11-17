import { app, BrowserWindow, dialog, ipcMain, session, shell, webContents, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { notionPageIdFromUrl, notionPageUrl, NOTION_HOSTS, NOTION_PARTITION, type NotionViewRequest, type NotionViewState } from '@craft-agent/shared/notion'
import { i18n } from '@craft-agent/shared/i18n'

interface NotionView {
  window: BrowserWindow
  projectId: string
  contents: WebContents
  theme: 'light' | 'dark'
  state: NotionViewState
  agentNavigation: boolean
  closing: Promise<boolean> | null
  navigation: { pageId: string; result: Promise<NotionViewState> } | null
}

/** Restricted guests stay attached to one main workbench window for their entire lifetime. */
type NotionViewEvent = { type: 'changed'; projectId: string; state: NotionViewState } | { type: 'focused' | 'closeRequested'; projectId: string }

export class NotionViewManager {
  private eventSink: ((webContentsId: number, event: NotionViewEvent) => void) | null = null
  setEventSink(sink: (webContentsId: number, event: NotionViewEvent) => void): void { this.eventSink = sink }
  private views = new Map<string, NotionView>()
  get hasViews(): boolean { return this.views.size > 0 }

  private closingWindows = new Set<number>()
  private guests = new Map<number, Set<number>>()

  registerIpc(): void {
    const ses = session.fromPartition(NOTION_PARTITION)
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-attach-webview', (event, preferences, params) => {
        const window = BrowserWindow.fromWebContents(contents)
        if (!window || window.webContents !== contents || params.partition !== NOTION_PARTITION || params.src !== 'about:blank') {
          event.preventDefault(); return
        }
        delete preferences.preload
        preferences.nodeIntegration = false
        preferences.nodeIntegrationInSubFrames = false
        preferences.contextIsolation = true
        preferences.sandbox = true
        preferences.webviewTag = false
      })
      contents.on('did-attach-webview', (_event, guest) => {
        const ids = this.guests.get(contents.id) ?? new Set<number>()
        ids.add(guest.id)
        this.guests.set(contents.id, ids)
        guest.once('destroyed', () => ids.delete(guest.id))
      })
      contents.once('destroyed', () => this.guests.delete(contents.id))
    })
    ipcMain.handle('__notion:closeAll', event => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || window.webContents !== event.sender) throw new Error('NOTION_INVALID_HOST')
      return this.closeAll(window)
    })
    ipcMain.handle('__notion:view', (event, request: NotionViewRequest) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || window.webContents !== event.sender) throw new Error('NOTION_INVALID_HOST')
      return this.invoke(window, request)
    })
  }

  private key(window: BrowserWindow, projectId: string): string { return `${window.id}\0${projectId}` }

  private publish(entry: NotionView): void {
    if (!entry.window.isDestroyed()) this.eventSink?.(entry.window.webContents.id, { type: 'changed', projectId: entry.projectId, state: entry.state })
  }

  private async applyTheme(entry: NotionView): Promise<void> {
    const wc = entry.contents
    if (wc.isDestroyed()) return
    const url = new URL(wc.getURL() || 'about:blank')
    if (url.protocol !== 'https:' || !NOTION_HOSTS.includes(url.hostname)) return
    const theme = entry.theme
    // Only the guest sees this preference; Stair's system-theme detection stays unchanged.
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: theme }],
    })
    if (wc.isDestroyed() || entry.theme !== theme) return
    await wc.executeJavaScript(`(() => {
      if (location.protocol !== 'https:' || !${JSON.stringify(NOTION_HOSTS)}.includes(location.hostname)) return;
      const key = 'LRU:KeyValueStore2:appearanceSettingStorageKey';
      const newValue = JSON.stringify({ id: key.slice(4), value: 'system', important: true });
      localStorage.setItem('theme', JSON.stringify({ mode: ${JSON.stringify(theme)} }));
      localStorage.setItem(key, newValue);
      // Notify Notion's live preference store even when it already follows the system.
      window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
    })()`)
  }

  private async snapshot(entry: NotionView): Promise<NotionViewState> {
    const url = entry.contents.getURL()
    let pageId = notionPageIdFromUrl(url)
    if (pageId) {
      // Notion can retain a page URL while showing its login/permission UI.
      // Loading skeletons and sidebar/subpage links share page block classes.
      // Require the main document's title to match. No text or credentials cross.
      try {
        const ready = await entry.contents.executeJavaScript(`(() => {
          const login = [...document.querySelectorAll('input[type="email"],input[autocomplete="one-time-code"]')].some(el => el.getClientRects().length > 0);
          const title = document.querySelector('.notion-frame .notion-page-block[data-block-id] h1');
          const loaded = title?.closest('[data-block-id]')?.getAttribute('data-block-id') === ${JSON.stringify(pageId)};
          return !login && loaded && Boolean(document.querySelector('.notion-frame .notion-page-content'));
        })()`)
        if (!ready) pageId = null
      } catch { pageId = null }
    }
    if (entry.contents.isDestroyed()) throw new Error('NOTION_HOST_CHANGED')
    if (entry.contents.getURL() !== url) pageId = null
    if (pageId !== entry.state.pageId) entry.state.revision = randomUUID()
    entry.state.url = url
    entry.state.pageId = pageId
    return { ...entry.state }
  }

  private attach(window: BrowserWindow, projectId: string, guestId: number, theme: 'light' | 'dark'): NotionView {
    if (!this.guests.get(window.webContents.id)?.has(guestId)) throw new Error('NOTION_INVALID_GUEST')
    const wc = webContents.fromId(guestId)
    if (!wc || wc.session !== session.fromPartition(NOTION_PARTITION)) throw new Error('NOTION_INVALID_GUEST')
    const key = this.key(window, projectId)
    const current = this.views.get(key)
    if (current?.contents === wc) return current
    if (current && !current.contents.isDestroyed()) throw new Error('NOTION_DUPLICATE_PANEL')
    const entry: NotionView = {
      window, projectId, contents: wc, theme, agentNavigation: false, closing: null, navigation: null,
      state: { pageId: null, revision: randomUUID(), title: 'Notion', url: '', loading: false, error: null },
    }
    this.views.set(key, entry)
    const navigate = (_event: unknown, url: string) => {
      const pageId = notionPageIdFromUrl(url)
      const changed = pageId !== entry.state.pageId
      entry.state = { ...entry.state, url, pageId, revision: changed ? randomUUID() : entry.state.revision, error: null }
      this.publish(entry)
      void this.applyTheme(entry).catch(() => {})
    }
    wc.on('did-navigate', navigate)
    wc.on('did-navigate-in-page', (event, url, mainFrame) => { if (mainFrame) navigate(event, url) })
    wc.on('dom-ready', () => { void this.applyTheme(entry).catch(() => {}) })
    wc.on('page-title-updated', (_event, title) => { entry.state.title = title; this.publish(entry) })
    wc.on('did-start-loading', () => { entry.state.loading = true; this.publish(entry) })
    wc.on('did-stop-loading', () => { entry.state.loading = false; this.publish(entry) })
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return
      entry.state.error = description; entry.state.pageId = null
      this.publish(entry)
    })
    wc.on('render-process-gone', () => {
      entry.state.pageId = null; entry.state.error = i18n.t('notion.pageCrashed')
      this.publish(entry)
    })
    wc.on('destroyed', () => {
      if (this.views.get(key) === entry) this.views.delete(key)
    })
    wc.on('focus', () => {
      if (!window.isDestroyed()) this.eventSink?.(window.webContents.id, { type: 'focused', projectId })
    })
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.meta || input.control) && input.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (!window.isDestroyed()) this.eventSink?.(window.webContents.id, { type: 'closeRequested', projectId })
      }
    })
    wc.on('will-prevent-unload', event => {
      if (entry.agentNavigation) return
      const leave = dialog.showMessageBoxSync(window, {
        type: 'question', message: i18n.t('notion.leavePrompt'),
        buttons: [i18n.t('notion.stay'), i18n.t('notion.leave')], defaultId: 0, cancelId: 0,
      })
      if (leave === 1) event.preventDefault() // In Electron, this permits leaving.
    })
    wc.on('will-navigate', (event, url) => {
      if (new URL(url).protocol !== 'https:') event.preventDefault()
    })
    wc.setWindowOpenHandler(({ url }) => {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:') return { action: 'deny' }
      const loginPopup = ['accounts.google.com', 'appleid.apple.com'].includes(parsed.hostname)
        || (NOTION_HOSTS.includes(parsed.hostname)
          && /^\/(?:login|signup|sso|oauth|auth|popup)/i.test(parsed.pathname))
      if (notionPageIdFromUrl(url)) void wc.loadURL(url).catch(() => {})
      // Email-code sign-in stays inside the guest. Do not open Notion's SSO
      // bootstrap pages in another browser, whose session cannot sign it in.
      else if (!loginPopup) void shell.openExternal(url)
      return { action: 'deny' }
    })
    return entry
  }

  async invoke(window: BrowserWindow, request: NotionViewRequest): Promise<NotionViewState | boolean | null> {
    if (!request || typeof request.projectId !== 'string' || !request.projectId || request.projectId.length > 256) throw new Error('NOTION_INVALID_PROJECT')
    if ((request.action === 'attach' || request.action === 'theme') && request.theme !== 'light' && request.theme !== 'dark') throw new Error('NOTION_INVALID_THEME')
    if (request.action === 'attach') return this.attach(window, request.projectId, request.guestId, request.theme).state
    const entry = this.views.get(this.key(window, request.projectId))
    if (request.action === 'theme') {
      if (!entry) return false
      entry.theme = request.theme
      await this.applyTheme(entry)
      return true
    }
    if (request.action === 'close') return entry ? this.close(entry) : true
    if (request.action === 'current') return entry ? this.snapshot(entry) : null
    if (request.action !== 'open') throw new Error('NOTION_INVALID_REQUEST')
    if (!entry) throw new Error('NOTION_PANEL_NOT_READY')
    const url = notionPageUrl(request.pageId)
    if (entry.closing || this.closingWindows.has(window.id)) throw new Error('NOTION_CLOSING')
    if (entry.navigation) {
      if (entry.navigation.pageId === request.pageId) return entry.navigation.result
      throw new Error('NOTION_NAVIGATION_PENDING: Wait for the current navigation.')
    }
    const samePage = notionPageIdFromUrl(entry.contents.getURL()) === request.pageId && !entry.state.error
    entry.agentNavigation = !samePage && request.agent === true
    const result = (samePage ? Promise.resolve() : entry.contents.loadURL(url)).then(async () => {
      if (!samePage) entry.state.loading = false
      this.publish(entry)
      const deadline = Date.now() + 5000
      let state = await this.snapshot(entry)
      // Network load completion precedes SPA document rendering. Wait briefly
      // for the actual page without reloading a document the user is editing.
      while (!state.pageId && !state.error && notionPageIdFromUrl(entry.contents.getURL()) === request.pageId && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
        state = await this.snapshot(entry)
      }
      return state
    }).finally(() => {
      entry.agentNavigation = false
      entry.navigation = null
    })
    entry.navigation = { pageId: request.pageId, result }
    return result
  }

  private async close(entry: NotionView): Promise<boolean> {
    if (entry.closing) return entry.closing
    entry.closing = (async () => {
      const wc = entry.contents
      if (wc.isDestroyed()) return true
      // Guest webContents.close() can bypass beforeunload. Navigate first so the
      // page gets its standard chance to prevent leaving before destruction.
      try {
        await wc.loadURL('about:blank')
        wc.close()
        return true
      } catch { return wc.isDestroyed() }
    })().finally(() => { entry.closing = null })
    return entry.closing
  }

  async closeAll(window?: BrowserWindow): Promise<boolean> {
    const entries = [...this.views.values()].filter(entry => !window || entry.window === window)
    const prepared: Array<{ entry: NotionView; url: string }> = []
    for (const entry of entries) this.closingWindows.add(entry.window.id)
    try {
      for (const entry of entries) {
        if (entry.contents.isDestroyed()) continue
        const url = entry.contents.getURL()
        try {
          await entry.contents.loadURL('about:blank')
          prepared.push({ entry, url })
        } catch {
          // A later Project vetoed quit. Keep the existing guests and restore
          // pages which had already permitted leaving, instead of dead panels.
          await Promise.allSettled(prepared.map(({ entry: previous, url: original }) => previous.contents.loadURL(original)))
          return false
        }
      }
      for (const { entry } of prepared) if (!entry.contents.isDestroyed()) entry.contents.close()
      return true
    } finally {
      for (const entry of entries) this.closingWindows.delete(entry.window.id)
    }
  }

}

export const notionViewManager = new NotionViewManager()
