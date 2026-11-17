import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue } from 'jotai'
import type { WebviewTag } from 'electron'
import { NOTION_PARTITION } from '@craft-agent/shared/notion'
import { workbenchAtom } from '@/workbench/workbench-state'
import { notionGuestReady, removeNotionGuest, notionViewLayoutsAtom } from './notion-view-state'
import { useTheme } from '@/context/ThemeContext'

/** Guests remain mounted across Project switches so Notion retains in-progress edits. */
function NotionGuest({ projectId, initialPageId, isDark }: { projectId: string; initialPageId: string; isDark: boolean }) {
  const element = useRef<HTMLDivElement>(null)
  const dark = useRef(isDark)
  dark.current = isDark
  const layouts = useAtomValue(notionViewLayoutsAtom)
  const layout = layouts[projectId]
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const parent = element.current!
    const guest = document.createElement('webview') as WebviewTag
    guest.setAttribute('partition', NOTION_PARTITION)
    guest.setAttribute('allowpopups', '')
    guest.setAttribute('src', 'about:blank')
    guest.style.cssText = 'position:absolute;display:flex;'
    const ready = notionGuestReady(projectId)
    let attached = false
    let alive = true
    const attach = async () => {
      if (attached || !alive) return
      attached = true
      try {
        await window.electronAPI.notionView({
          action: 'attach',
          projectId,
          guestId: guest.getWebContentsId(),
          theme: dark.current ? 'dark' : 'light',
        })
        if (!alive) return
        ready.resolve()
        await window.electronAPI.notionView({ action: 'open', projectId, pageId: initialPageId })
      } catch (reason) {
        if (!alive) return
        ready.reject(reason)
        setError(String(reason))
      }
    }
    guest.addEventListener('dom-ready', attach)
    parent.appendChild(guest)
    return () => {
      alive = false
      guest.removeEventListener('dom-ready', attach)
      guest.remove()
      // StrictMode replays effects on the same host. Preserve the readiness
      // promise if its replacement guest was mounted in this commit.
      queueMicrotask(() => {
        if (!parent.querySelector('webview')) removeNotionGuest(projectId)
      })
    }
  }, [projectId])
  useEffect(() => {
    let active = true
    void notionGuestReady(projectId).promise.then(() => {
      if (active) return window.electronAPI.notionView({ action: 'theme', projectId, theme: isDark ? 'dark' : 'light' })
    }).catch(reason => {
      if (active) console.warn('Notion theme update failed', reason)
    })
    return () => { active = false }
  }, [projectId, isDark])
  useEffect(() => {
    const guest = element.current?.querySelector<WebviewTag>('webview')
    if (!guest || !layout) return
    Object.assign(guest.style, {
      left: `${layout.bounds.x - layout.clip.x}px`,
      top: `${layout.bounds.y - layout.clip.y}px`,
      width: `${layout.bounds.width}px`,
      height: `${layout.bounds.height}px`,
    })
  }, [layout])
  return (
    <div
      ref={element}
      className="z-panel"
      style={{
        position: 'fixed',
        overflow: 'hidden',
        pointerEvents: 'auto',
        display: layout?.visible ? 'block' : 'none',
        left: layout?.clip.x ?? 0,
        top: layout?.clip.y ?? 0,
        width: layout?.clip.width ?? 0,
        height: layout?.clip.height ?? 0,
        clipPath: layout ? `inset(0 round ${layout.borderRadius})` : undefined,
      }}
    >
      {error && <p className="p-4 text-sm text-destructive">{error}</p>}
    </div>
  )
}

export function NotionViewPool() {
  const { isDark } = useTheme()
  const workbench = useAtomValue(workbenchAtom)
  if (window.electronAPI.getRuntimeEnvironment?.() !== 'electron') return null
  const panels = Object.values(workbench.layoutsByProject).flatMap(layout =>
    layout.auxiliary.filter(panel => panel.kind === 'notion-page'))
  return createPortal(
    <>
      {panels.map(panel => (
        <NotionGuest
          key={`${workbench.workspaceId}:${panel.projectId}`}
          projectId={panel.projectId}
          initialPageId={panel.pageId}
          isDark={isDark}
        />
      ))}
    </>,
    document.body,
  )
}
