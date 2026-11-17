import { join, dirname } from 'node:path'
import { app, BrowserWindow, session, ipcMain, nativeTheme } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { NotionViewManager } from '../notion-view-manager'
import { NOTION_PARTITION } from '@craft-agent/shared/notion'
app.setPath('userData', process.argv[2]!)
const timeout = setTimeout(() => app.exit(2), 20_000)
void app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'
  const manager = new NotionViewManager()
  manager.registerIpc()
  let loads = 0
  await session.fromPartition(NOTION_PARTITION).protocol.handle('https', () => {
    loads++
    return new Response(`<body><div class="notion-frame"><div class="notion-page-block" data-block-id="11111111-1111-1111-1111-111111111111"><h1>Notion fixture page</h1></div><div class="notion-page-content"><textarea id="note">draft</textarea></div></div>
      <style>#theme-probe{color:rgb(250,250,250)}.notion-dark-theme #theme-probe{color:rgb(20,20,20)}</style><span id="theme-probe"></span><script>
        const appearanceKey='LRU:KeyValueStore2:appearanceSettingStorageKey';
        if(!localStorage.getItem(appearanceKey))localStorage.setItem(appearanceKey,JSON.stringify({value:'dark'}));
        const media=matchMedia('(prefers-color-scheme: dark)');
        const applyTheme=()=>{const mode=JSON.parse(localStorage.getItem(appearanceKey)).value;document.body.classList.toggle('notion-dark-theme',mode==='system'?media.matches:mode==='dark')};
        addEventListener('storage',e=>{if(e.key===appearanceKey)applyTheme()});media.addEventListener('change',applyTheme);applyTheme();
      </script></body>`, { headers: { 'Content-Type': 'text/html' } })
  })
  const report = new Promise<Record<string, unknown>>(resolve => ipcMain.once('__notion:testReport', (_event, value) => resolve(value)))
  const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, webviewTag: true, preload: process.argv[4] } })
  const html = join(dirname(process.argv[3]!), 'host.html')
  writeFileSync(html, '<head><style>.z-panel{z-index:50}</style></head><body><div id="root"></div></body>')
  await window.loadFile(html)
  await window.webContents.executeJavaScript(readFileSync(process.argv[3]!, 'utf8'))
  const result = await report
  console.log('NOTION_POOL_RESULT=' + JSON.stringify({ ...result, loads }))
  await manager.closeAll(window)
  window.destroy()
  clearTimeout(timeout)
  app.exit(result.guestCount === 1 && result.width === 400 && result.clipWidth === 200 && result.chatScrollStayed === true && result.chatAtBottom === true && result.guestAboveShell === true && result.themeFollowed === true && result.themeKeptDraft === true && result.roundedCorners === true && loads === 1 && !result.error ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })
