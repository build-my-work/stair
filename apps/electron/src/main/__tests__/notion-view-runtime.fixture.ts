import { app, BrowserWindow, desktopCapturer, session, dialog, shell, nativeTheme } from 'electron'
import { NotionViewManager } from '../notion-view-manager'
import { NOTION_PARTITION, notionPageIdFromUrl } from '@craft-agent/shared/notion'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
app.setPath('userData', process.argv[2] ?? mkdtempSync(join(tmpdir(), 'stair-notion-native-')))
const timeout = setTimeout(() => app.exit(2), 35_000)
void app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'
  const manager = new NotionViewManager()
  manager.registerIpc()
  const externalLinks: string[] = []
  shell.openExternal = async url => { externalLinks.push(url) }
  const ses = session.fromPartition(NOTION_PARTITION)
  let delayedLoads = 0
  let lateLoads = 0
  let initialPageLoads = 0
  await ses.protocol.handle('https', request => {
    const pageId = notionPageIdFromUrl(request.url)
    if (pageId === '11111111-1111-1111-1111-111111111111') initialPageLoads++
    const surface = `<div class="notion-frame"><div class="notion-selectable notion-page-block" data-block-id="${pageId}"><h1></h1></div><div class="notion-page-content"><textarea id="note">draft</textarea></div></div>`
    const skeleton = `<div class="notion-frame"><div class="notion-page-content"><div class="notion-selectable notion-unknown-block" data-block-id="${pageId}"></div></div></div>`
    let html = `<body style="background:rgb(255,0,0)">${surface}</body>`
    if (request.url.includes('44444444444444444444444444444444')) html = '<body><input type="email" /></body>'
    if (request.url.includes('55555555555555555555555555555555')) {
      delayedLoads++
      html = `<body>${skeleton}<script>setTimeout(()=>document.body.innerHTML=${JSON.stringify(surface)},300)</script></body>`
    }
    if (request.url.includes('66666666666666666666666666666666')) html = `<body>${skeleton}</body>`
    if (request.url.includes('77777777777777777777777777777777')) {
      lateLoads++
      html = `<body>${skeleton}</body>`
    }
    html += `<style>#theme-probe{color:rgb(250,250,250)}.notion-dark-theme #theme-probe{color:rgb(20,20,20)}</style><span id="theme-probe"></span><script>
      const appearanceKey='LRU:KeyValueStore2:appearanceSettingStorageKey';
      if(!localStorage.getItem(appearanceKey))localStorage.setItem(appearanceKey,JSON.stringify({value:'dark'}));
      const media=matchMedia('(prefers-color-scheme: dark)');
      const applyTheme=()=>{const mode=JSON.parse(localStorage.getItem(appearanceKey)).value;document.body.classList.toggle('notion-dark-theme',mode==='system'?media.matches:mode==='dark')};
      addEventListener('storage',e=>{if(e.key===appearanceKey)applyTheme()});media.addEventListener('change',applyTheme);applyTheme();
    </script>`
    return new Response(html, { headers: { 'Content-Type': 'text/html' } })
  })
  const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, webviewTag: true } })
  let preferences: Electron.WebPreferences | undefined
  window.webContents.on('will-attach-webview', (_event, value) => { preferences = value })
  const attached = new Promise<Electron.WebContents>(resolve => window.webContents.once('did-attach-webview', (_event, contents) => resolve(contents)))
  await window.loadURL(`data:text/html,<body style="background:blue"><div id="clip" style="position:absolute;left:300px;top:100px;width:200px;height:300px;overflow:hidden"><webview partition="${NOTION_PARTITION}" src="about:blank" allowpopups style="position:absolute;left:-100px;width:400px;height:300px"></webview></div></body>`)
  const contents = await attached
  if (contents.isLoading()) await new Promise<void>(resolve => contents.once('did-stop-loading', () => resolve()))
  const projectId = 'project-test'
  const pageId = '11111111-1111-1111-1111-111111111111'
  await manager.invoke(window, { projectId, action: 'attach', guestId: contents.id, theme: 'light' })
  const opened = await manager.invoke(window, { projectId, action: 'open', pageId })
  const viewport = await contents.executeJavaScript('innerWidth')
  await contents.executeJavaScript('note.value="edited draft"')
  let themeFollowed = false
  try {
    const initialLight = await contents.executeJavaScript(`!matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.getElementById('theme-probe')).color==='rgb(250, 250, 250)'`)
    await manager.invoke(window, { projectId, action: 'theme', theme: 'dark' })
    const dark = await contents.executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.getElementById('theme-probe')).color==='rgb(20, 20, 20)'`)
    await manager.invoke(window, { projectId, action: 'theme', theme: 'light' })
    const light = await contents.executeJavaScript(`!matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.getElementById('theme-probe')).color==='rgb(250, 250, 250)' && note.value==='edited draft'`)
    themeFollowed = initialLight && dark && light && initialPageLoads === 1 && nativeTheme.themeSource === 'dark'
  } catch { /* The pre-fix manager has no theme action. Keep the failure in the report. */ }
  await window.webContents.executeJavaScript('clip.style.display="none"')
  const parkedDraft = await contents.executeJavaScript('note.value')
  await window.webContents.executeJavaScript('clip.style.display="block"')
  await window.webContents.executeJavaScript(`{const tip=document.createElement('div');tip.id='qa-tooltip';tip.setAttribute('data-radix-popper-content-wrapper','');tip.setAttribute('role','tooltip');tip.style.cssText='position:fixed;left:320px;top:200px;width:100px;height:80px;background:rgb(0,255,0);z-index:9999';document.body.appendChild(tip)}`)
  window.setTitle('Stair Notion Test')
  window.show()
  window.focus()
  await new Promise(resolve => setTimeout(resolve, 500))
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 800, height: 600 } })
  const shot = sources.find(source => source.id === window.getMediaSourceId())?.thumbnail
  if (!shot || shot.isEmpty()) throw new Error('Screen capture permission is required for this external test.')
  const size = shot.getSize()
  const bytes = shot.toBitmap()
  const pixel = (x: number, y: number) => [...bytes.subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 3)]
  const clipping = { outside: pixel(250, 250), inside: pixel(450, 250), after: pixel(550, 250) }
  const tooltipVisible = pixel(350, 250)[1]! > 200
  await window.webContents.executeJavaScript(`document.getElementById('qa-tooltip').remove()`)

  const ssoPopupsBlocked = await contents.executeJavaScript(`[
    'https://accounts.google.com/o/oauth2/auth',
    'https://appleid.apple.com/auth/authorize',
    'https://www.notion.so/loginWithGoogle'
  ].map(url => window.open(url) === null).every(Boolean)`, true)
  const ssoStayedInApp = BrowserWindow.getAllWindows().length === 1 && externalLinks.length === 0
  for (const popup of BrowserWindow.getAllWindows()) if (popup !== window) popup.destroy()
  await contents.executeJavaScript(`window.open('https://example.com/resource')`, true)
  await contents.executeJavaScript(`window.open('https://www.notion.com/help/intro')`, true)
  const externalLinkOpened = externalLinks.length === 2 && externalLinks[0] === 'https://example.com/resource' && externalLinks[1] === 'https://www.notion.com/help/intro'

  await contents.executeJavaScript(`window.onbeforeunload=()=>false; note.focus()`, true)
  contents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 })
  const nextPage = '22222222-2222-2222-2222-222222222222'
  let blocked = false
  try { await manager.invoke(window, { projectId, action: 'open', pageId: nextPage, agent: true }) } catch { blocked = true }
  const stayed = await manager.invoke(window, { projectId, action: 'current' })
  // User choosing Stay must retain the guest; this exercises the real unload event.
  dialog.showMessageBoxSync = () => 0
  const closePrevented = !await manager.invoke(window, { projectId, action: 'close' })
  if(!contents.isDestroyed()) await contents.executeJavaScript('window.onbeforeunload=null')
  const loginState = await manager.invoke(window, { action: 'open', projectId, pageId: '44444444-4444-4444-4444-444444444444' })
  const loginBlocked = Boolean(loginState && typeof loginState === 'object' && loginState.pageId === null)
  const skeletonState = await manager.invoke(window, { action: 'open', projectId, pageId: '66666666-6666-6666-6666-666666666666' })
  const skeletonBlocked = Boolean(skeletonState && typeof skeletonState === 'object' && skeletonState.pageId === null)
  await contents.executeJavaScript(`{const block=document.querySelector('.notion-unknown-block');block.className='notion-page-block';block.setAttribute('data-block-id','${pageId}')}`)
  const staleState = await manager.invoke(window, { action: 'current', projectId })
  const stalePageBlocked = Boolean(staleState && typeof staleState === 'object' && staleState.pageId === null)
  await contents.executeJavaScript(`{const link=document.querySelector('.notion-page-block');link.setAttribute('data-block-id','66666666-6666-6666-6666-666666666666')}`)
  const childLinkState = await manager.invoke(window, { action: 'current', projectId })
  const childLinkBlocked = Boolean(childLinkState && typeof childLinkState === 'object' && childLinkState.pageId === null)
  await contents.executeJavaScript(`{const title=document.createElement('div');title.className='notion-page-block';title.setAttribute('data-block-id','${pageId}');title.innerHTML='<h1></h1>';document.querySelector('.notion-frame').prepend(title)}`)
  const oldTitleState = await manager.invoke(window, { action: 'current', projectId })
  const oldTitleBlocked = Boolean(oldTitleState && typeof oldTitleState === 'object' && oldTitleState.pageId === null)
  await contents.executeJavaScript(`{const sidebar=document.createElement('aside');sidebar.innerHTML='<div class="notion-page-block" data-block-id="66666666-6666-6666-6666-666666666666"><h1>Sidebar link</h1></div>';document.body.appendChild(sidebar)}`)
  const sidebarState = await manager.invoke(window, { action: 'current', projectId })
  const sidebarBlocked = Boolean(sidebarState && typeof sidebarState === 'object' && sidebarState.pageId === null)
  await manager.invoke(window, { action: 'open', projectId, pageId })
  const delayedId = '55555555-5555-5555-5555-555555555555'
  const delayedState = await manager.invoke(window, { action: 'open', projectId, pageId: delayedId })
  await manager.invoke(window, { action: 'open', projectId, pageId: delayedId })
  const spaReady = Boolean(delayedState && typeof delayedState === 'object' && delayedState.pageId === delayedId && delayedLoads === 1 && await contents.executeJavaScript('Boolean(document.querySelector(".notion-page-block"))'))
  const lateId = '77777777-7777-7777-7777-777777777777'
  const lateState = await manager.invoke(window, { action: 'open', projectId, pageId: lateId })
  const retry = manager.invoke(window, { action: 'open', projectId, pageId: lateId })
  await contents.executeJavaScript(`setTimeout(()=>{const block=document.querySelector('.notion-unknown-block');block.className='notion-page-block';block.innerHTML='<h1></h1>'},100)`)
  const retryState = await retry
  const samePageRetryReady = Boolean(lateState && typeof lateState === 'object' && lateState.pageId === null && retryState && typeof retryState === 'object' && retryState.pageId === lateId && lateLoads === 1)
  await manager.invoke(window, { action: 'open', projectId, pageId })
  const secondAttached = new Promise<Electron.WebContents>(resolve => window.webContents.once('did-attach-webview', (_event, value) => resolve(value)))
  await window.webContents.executeJavaScript(`{const v=document.createElement('webview');v.setAttribute('partition','${NOTION_PARTITION}');v.setAttribute('src','about:blank');document.body.appendChild(v)}`)
  const second = await secondAttached
  if (second.isLoading()) await new Promise<void>(resolve => second.once('did-stop-loading', () => resolve()))
  await manager.invoke(window, { action: 'attach', projectId: 'second-project', guestId: second.id, theme: 'dark' })
  await manager.invoke(window, { action: 'open', projectId: 'second-project', pageId: nextPage })
  const themesIsolated = !await contents.executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches`) && await second.executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches`)
  await second.executeJavaScript('window.onbeforeunload=()=>false; note.focus()', true)
  second.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 })
  second.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 })
  const quitPrevented = !await manager.closeAll(window)
  const firstAfterCanceledQuit = await manager.invoke(window, { action: 'current', projectId })
  const firstRestored = Boolean(firstAfterCanceledQuit && typeof firstAfterCanceledQuit === 'object' && firstAfterCanceledQuit.pageId === pageId)
  if (!second.isDestroyed()) await second.executeJavaScript('window.onbeforeunload=null')
  const results = { opened, viewport, parkedDraft, clipping, blocked, stayed, closePrevented, quitPrevented, firstRestored, loginBlocked, skeletonBlocked, stalePageBlocked, childLinkBlocked, oldTitleBlocked, sidebarBlocked, spaReady, samePageRetryReady, tooltipVisible, ssoPopupsBlocked, ssoStayedInApp, externalLinkOpened, themeFollowed, themesIsolated,
    sandbox: preferences?.sandbox, node: preferences?.nodeIntegration, isolated: preferences?.contextIsolation,
    closed: await manager.closeAll(window) }
  console.log('NOTION_NATIVE_RESULT=' + JSON.stringify(results))
  if (process.env.NOTION_TEST_SCREENSHOT) writeFileSync(process.env.NOTION_TEST_SCREENSHOT, shot.toPNG())
  window.destroy()
  clearTimeout(timeout)
  app.exit(viewport === 400 && parkedDraft === 'edited draft' && clipping.outside[0]! > 240 && clipping.inside[2]! > 220 && clipping.after[0]! > 240 && blocked && closePrevented && quitPrevented && firstRestored && loginBlocked && skeletonBlocked && stalePageBlocked && childLinkBlocked && oldTitleBlocked && sidebarBlocked && spaReady && samePageRetryReady && tooltipVisible && ssoPopupsBlocked && ssoStayedInApp && externalLinkOpened && themeFollowed && themesIsolated && results.sandbox && !results.node && results.isolated && results.closed ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })
