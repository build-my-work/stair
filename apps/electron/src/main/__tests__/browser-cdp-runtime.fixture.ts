import { app, BrowserWindow, WebContentsView } from 'electron'
import { readFileSync } from 'node:fs'
import { BrowserCDP } from '../browser-cdp'

// B01 / BROWSER-02: one hidden test window; no desktop input or user profile.
app.setPath('userData', process.argv[2]!)
const timeout = setTimeout(() => app.exit(2), 20_000)
void app.whenReady().then(async () => {
  app.dock?.hide()
  const window = new BrowserWindow({ show: false, width: 800, height: 600 })
  const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
  const page = view.webContents
  const cdp = new BrowserCDP(page)
  const results: Record<string, unknown> = {}
  let exitCode = 0

  async function loadControls(html: string): Promise<{ input: string; button: string }> {
    await page.loadURL(`data:text/html,${encodeURIComponent(html)}`)
    const snapshot = await cdp.getAccessibilitySnapshot()
    return {
      input: snapshot.nodes.find(node => node.role === 'textbox' || node.role === 'spinbutton')!.ref,
      button: snapshot.nodes.find(node => node.role === 'button')!.ref,
    }
  }

  try {
    let refs = await loadControls('<input id="entry" aria-label="Input"><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#entry\').value">Commit</button><output id="result"></output>')
    // Electron documents that native input requires a focused BrowserWindow.
    // Model an unavailable native-input path that silently drops events.
    const nativeInput = page.sendInputEvent.bind(page)
    page.sendInputEvent = () => {}
    await cdp.fillElement(refs.input, 'B01-HIDDEN')
    await cdp.clickElement(refs.button)
    results.background = await page.executeJavaScript('({value:entry.value,result:result.textContent})')
    page.sendInputEvent = nativeInput

    refs = await loadControls(`<div id="root"></div><script>${readFileSync(process.argv[3]!, 'utf8')}</script>`)
    await cdp.fillElement(refs.input, 'React 中文')
    await cdp.clickElement(refs.button)
    results.react = await page.executeJavaScript('({value:document.querySelector("input").value,result:document.querySelector("output").textContent})')

    refs = await loadControls('<div id="entry" contenteditable="true" role="textbox" aria-label="Input">Old value</div><button>Commit</button>')
    await cdp.fillElement(refs.input, 'New 中文\nvalue')
    results.contenteditable = await page.executeJavaScript('entry.innerText')
    await cdp.fillElement(refs.input, '')
    results.emptyContenteditable = await page.executeJavaScript('entry.textContent')

    refs = await loadControls('<input id="entry" aria-label="Input" readonly value="Keep me"><button>Commit</button>')
    let rejected = false
    try { await cdp.fillElement(refs.input, 'Must reject') } catch { rejected = true }
    results.readonly = { rejected, value: await page.executeJavaScript('entry.value') }

    refs = await loadControls('<input id="entry" aria-label="Input" maxlength="3" value="Old"><button>Commit</button>')
    rejected = false
    try { await cdp.fillElement(refs.input, 'Too long') } catch { rejected = true }
    results.maxlength = { rejected, value: await page.executeJavaScript('entry.value') }

    // Numeric inputs ignore maxlength, unlike text inputs and textareas.
    refs = await loadControls('<input id="entry" type="number" maxlength="1" aria-label="Input" value="123"><button>Commit</button>')
    await cdp.fillElement(refs.input, '42')
    results.number = await page.executeJavaScript('entry.value')
    rejected = false
    try { await cdp.fillElement(refs.input, '0x20') } catch { rejected = true }
    results.invalidNumber = { rejected, value: await page.executeJavaScript('entry.value') }

    refs = await loadControls('<textarea id="entry" aria-label="Input">Old value</textarea><button>Commit</button>')
    await cdp.fillElement(refs.input, 'New 中文\nvalue')
    results.textarea = await page.executeJavaScript('entry.value')
    await cdp.fillElement(refs.input, '')
    results.emptyTextarea = await page.executeJavaScript('entry.value')
    await cdp.fillElement(refs.input, 'Windows\r\ntext')
    results.crlfTextarea = await page.executeJavaScript('entry.value')

    refs = await loadControls('<input id="entry" aria-label="Input"><button>Commit</button><script>entry.addEventListener("beforeinput",e=>e.preventDefault())</script>')
    rejected = false
    try { await cdp.fillElement(refs.input, 'Cancelled by page') } catch { rejected = true }
    results.cancelledInput = { rejected, value: await page.executeJavaScript('entry.value') }
    refs = await loadControls('<fieldset disabled><input id="entry" aria-label="Input" value="Keep me"></fieldset><button>Commit</button>')
    rejected = false
    try { await cdp.fillElement(refs.input, 'Must reject') } catch { rejected = true }
    results.disabledFieldset = { rejected, value: await page.executeJavaScript('entry.value') }

    refs = await loadControls('<input id="entry" aria-label="Input" value="Keep me"><input id="other"><button>Commit</button><script>entry.addEventListener("focus",()=>other.focus())</script>')
    rejected = false
    try { await cdp.fillElement(refs.input, 'Wrong target') } catch { rejected = true }
    results.redirectedFocus = { rejected, value: await page.executeJavaScript('entry.value'), other: await page.executeJavaScript('other.value') }

    await loadControls('<div style="width:300px;height:300px">Canvas</div><input aria-label="Input"><button>Commit</button><script>window.__dragResult={down:false,up:false,x:0};document.addEventListener("mousedown",e=>{e.preventDefault();window.__dragResult.down=true});document.addEventListener("mousemove",e=>window.__dragResult.x=e.clientX);document.addEventListener("mouseup",()=>window.__dragResult.up=true)</script>')
    await cdp.drag(10, 10, 110, 10)
    results.drag = await page.executeJavaScript('window.__dragResult')

    console.log(`BROWSER_RUNTIME_RESULT=${JSON.stringify(results)}`)
  } catch (error) {
    console.error(JSON.stringify(results))
    console.error(error)
    exitCode = 1
  } finally {
    clearTimeout(timeout)
    cdp.detach()
    window.destroy()
    if (!page.isDestroyed()) page.close()
    app.exit(exitCode)
  }
}).catch(error => {
  console.error(error)
  app.exit(1)
})
