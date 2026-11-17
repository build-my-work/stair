import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { NotionViewPool } from '../../renderer/components/notion/NotionViewPool'
import { workbenchAtom, createEmptyProjectWorkbench } from '../../renderer/workbench/workbench-state'
import { notionViewLayoutsAtom } from '../../renderer/components/notion/notion-view-state'
import { openNotionPageAtom } from '../../renderer/components/notion/notion-workbench'
import { ScrollOnMount, scrollChatToBottom } from '../../renderer/components/app-shell/chat-display/ScrollOnMount'
import { NotionTestThemeContext } from './notion-theme-context.fixture'
import type { WebviewTag } from 'electron'

const store = createStore()
const projectId = 'pool-test'
const pageId = '11111111-1111-1111-1111-111111111111'
document.getElementById('root')!.style.cssText = 'position:fixed;inset:0;z-index:50;background:blue'
store.set(workbenchAtom, { workspaceId: 'w', activeProjectId: projectId, layoutsByProject: { [projectId]: createEmptyProjectWorkbench() } })
const layout = { bounds: { x: 200, y: 100, width: 400, height: 300 }, clip: { x: 300, y: 100, width: 200, height: 300 }, borderRadius: '0px', visible: true }
store.set(notionViewLayoutsAtom, { [projectId]: layout })
const root = createRoot(document.getElementById('root')!)
function renderTheme(isDark: boolean) {
  root.render(<React.StrictMode><NotionTestThemeContext.Provider value={{ isDark }}><Provider store={store}><NotionViewPool /></Provider></NotionTestThemeContext.Provider></React.StrictMode>)
}
renderTheme(false)
void (async () => {
  try {
    const horizontal = document.createElement('div')
    horizontal.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:100px;overflow:auto'
    horizontal.innerHTML = '<div style="width:1000px"><div id="qa-chat-scroll" style="width:200px;height:100px;overflow:auto"><div style="height:400px"></div><div id="qa-chat-bottom" style="height:1px"></div></div></div>'
    document.body.appendChild(horizontal)
    horizontal.scrollLeft = 300
    const chatViewport = horizontal.querySelector<HTMLDivElement>('#qa-chat-scroll')!
    const mount = document.createElement('div')
    horizontal.appendChild(mount)
    const scrollRoot = createRoot(mount)
    await new Promise<void>(resolve => scrollRoot.render(<ScrollOnMount viewportRef={{ current: chatViewport }} onScroll={resolve} />))
    const stayedOnMount = horizontal.scrollLeft === 300
    ;(chatViewport.firstElementChild as HTMLElement).style.height = '600px'
    scrollChatToBottom(chatViewport, 'instant')
    const chatScrollStayed = stayedOnMount && horizontal.scrollLeft === 300
    const chatAtBottom = chatViewport.scrollTop >= chatViewport.scrollHeight - chatViewport.clientHeight - 1
    scrollRoot.unmount()
    horizontal.remove()
    await store.set(openNotionPageAtom, { projectId, pageId, agent: true })
    const current = await window.electronAPI.notionView({ action: 'current', projectId })
    const guests = document.querySelectorAll('webview')
    const guest = guests[0] as WebviewTag
    const rect = guest?.getBoundingClientRect()
    const clip = guest?.parentElement?.getBoundingClientRect()
    const guestAboveShell = document.elementFromPoint(350, 250) === guest
    const guestId = guest.getWebContentsId()
    await guest.executeJavaScript(`note.value='draft kept'`)
    async function matchesTheme(dark: boolean) {
      const deadline = Date.now() + 2500
      do {
        const matched = await guest.executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches === ${dark} && getComputedStyle(document.getElementById('theme-probe')).color === '${dark ? 'rgb(20, 20, 20)' : 'rgb(250, 250, 250)'}'`)
        if (matched) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      } while (Date.now() < deadline)
      return false
    }
    const initialLight = await matchesTheme(false)
    store.set(notionViewLayoutsAtom, { [projectId]: { ...layout, visible: false } })
    renderTheme(true)
    const hiddenDark = await matchesTheme(true)
    store.set(notionViewLayoutsAtom, { [projectId]: { ...layout, clip: layout.bounds, borderRadius: '12px 14px 14px 12px' } })
    renderTheme(false)
    const lightAgain = await matchesTheme(false)
    await new Promise(requestAnimationFrame)
    const themeFollowed = initialLight && hiddenDark && lightAgain
    const themeKeptDraft = guest.getWebContentsId() === guestId && await guest.executeJavaScript(`note.value==='draft kept'`)
    const roundedCorners = document.elementFromPoint(201, 101) !== guest && document.elementFromPoint(599, 101) !== guest
      && document.elementFromPoint(201, 399) !== guest && document.elementFromPoint(599, 399) !== guest
      && document.elementFromPoint(350, 250) === guest
    ;(window as unknown as { reportNotionTest(value: unknown): void }).reportNotionTest({ current, guestCount: guests.length, width: rect?.width, clipWidth: clip?.width, chatScrollStayed, chatAtBottom, guestAboveShell, themeFollowed, themeKeptDraft, roundedCorners })
  } catch (error) { (window as unknown as { reportNotionTest(value: unknown): void }).reportNotionTest({ error: String(error) }) }
})()
