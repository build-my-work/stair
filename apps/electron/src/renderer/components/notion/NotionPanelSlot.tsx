import { notionViewLayoutsAtom } from './notion-view-state'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { closeWorkbenchPanelAtom, focusWorkbenchPanelAtom } from '@/workbench/workbench-commands'
import type { NotionWorkbenchPanel } from '@/workbench/workbench-state'
import { useModalRegistry } from '@/context/ModalContext'
import { useDismissibleLayerRegistry } from '@/context/DismissibleLayerContext'
import type { NotionViewState } from '@craft-agent/shared/notion'
import { cn } from '@/lib/utils'
import { getPanelBottomRadius, RADIUS_INNER } from '@/components/app-shell/panel-constants'
import { Button } from '@/components/ui/button'

interface NotionPanelSlotProps {
  panel: NotionWorkbenchPanel
  isOnly: boolean
  isFocusedPanel: boolean
  isAtLeftEdge: boolean
  isAtRightEdge: boolean
  isJoinedToNavigator?: boolean
  isCompact?: boolean
}

export function NotionPanelSlot({
  panel,
  isOnly,
  isFocusedPanel,
  isAtLeftEdge,
  isAtRightEdge,
  isJoinedToNavigator = false,
  isCompact = false,
}: NotionPanelSlotProps) {
  const { t } = useTranslation()
  const isWeb = window.electronAPI.getRuntimeEnvironment?.() === 'web'
  const host = useRef<HTMLDivElement>(null)
  const scrollHandle = useRef<HTMLButtonElement>(null)
  const scrollDrag = useRef<{ pointerId: number; startX: number; scrollLeft: number; viewport: HTMLElement } | null>(null)
  const [scrollHandleExpanded, setScrollHandleExpanded] = useState(false)
  const close = useSetAtom(closeWorkbenchPanelAtom)
  const setLayouts = useSetAtom(notionViewLayoutsAtom)
  const layout = useAtomValue(notionViewLayoutsAtom)[panel.projectId]
  const focus = useSetAtom(focusWorkbenchPanelAtom)
  const modals = useModalRegistry()
  const layers = useDismissibleLayerRegistry()
  const [state, setState] = useState<NotionViewState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handlePointerDown = useCallback(() => {
    if (!isFocusedPanel) {
      focus({ projectId: panel.projectId, panelId: panel.id })
    }
  }, [focus, isFocusedPanel, panel.projectId, panel.id])

  const radii = {
    borderTopLeftRadius: isJoinedToNavigator ? 0 : RADIUS_INNER,
    borderBottomLeftRadius: isJoinedToNavigator ? 0 : getPanelBottomRadius(isCompact, isAtLeftEdge),
    borderTopRightRadius: RADIUS_INNER,
    borderBottomRightRadius: getPanelBottomRadius(isCompact, isAtRightEdge),
  }
  const isLifted = !isOnly && isFocusedPanel
  const showScrollHandle = !isWeb && !isOnly && !isCompact

  useEffect(() => {
    if (!showScrollHandle || !layout?.visible) {
      scrollDrag.current = null
      setScrollHandleExpanded(false)
    }
  }, [showScrollHandle, layout?.visible])

  useEffect(() => {
    const handle = scrollHandle.current
    if (!handle) return
    // A body portal has no native scroll chain to the Workbench viewport.
    const onWheel = (event: WheelEvent) => {
      const viewport = host.current?.closest<HTMLElement>('[data-panel-scroll-viewport]')
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0)
      if (!viewport || !delta) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1
      viewport.scrollLeft += delta * unit
    }
    handle.addEventListener('wheel', onWheel, { passive: false })
    return () => handle.removeEventListener('wheel', onWheel)
  }, [showScrollHandle, layout?.visible])

  useEffect(() => {
    if (isWeb) return
    let stopped = false
    const off = window.electronAPI.onNotionViewChanged((projectId, next) => {
      if (projectId === panel.projectId) setState(next)
    })
    const offFocus = window.electronAPI.onNotionViewFocused(projectId => {
      if (projectId === panel.projectId) focus({ projectId, panelId: panel.id })
    })
    const offClose = window.electronAPI.onNotionViewCloseRequested(projectId => {
      if (projectId === panel.projectId) void close({ projectId, panelId: panel.id })
    })
    void window.electronAPI.notionView?.({ action: 'current', projectId: panel.projectId })
      .then(current => {
        if (!stopped && current && typeof current === 'object') setState(current)
      })
      .catch(reason => {
        if (!stopped) setError(String(reason))
      })
    return () => {
      stopped = true
      off()
      offFocus()
      offClose()
    }
  }, [panel.id, panel.projectId, close, focus, isWeb])

  useEffect(() => {
    if (isWeb) return
    let frame: number
    let last = ''
    let stopped = false
    const update = () => {
      if (stopped) return
      const el = host.current
      if (el) {
        const bounds = el.getBoundingClientRect()
        const hostStyle = getComputedStyle(el)
        let left = Math.max(0, bounds.left)
        let top = Math.max(0, bounds.top)
        let right = Math.min(innerWidth, bounds.right)
        let bottom = Math.min(innerHeight, bounds.bottom)
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent)
          const rect = parent.getBoundingClientRect()
          if (style.overflowX !== 'visible') {
            left = Math.max(left, rect.left)
            right = Math.min(right, rect.right)
          }
          if (style.overflowY !== 'visible') {
            top = Math.max(top, rect.top)
            bottom = Math.min(bottom, rect.bottom)
          }
        }
        const reachesTop = top === bounds.top
        const reachesBottom = bottom === bounds.bottom
        const topLeftRadius = reachesTop && left === bounds.left ? hostStyle.borderTopLeftRadius : '0px'
        const topRightRadius = reachesTop && right === bounds.right ? hostStyle.borderTopRightRadius : '0px'
        const bottomRightRadius = reachesBottom && right === bounds.right ? hostStyle.borderBottomRightRadius : '0px'
        const bottomLeftRadius = reachesBottom && left === bounds.left ? hostStyle.borderBottomLeftRadius : '0px'
        const visible = !document.hidden && !modals.hasOpenModals() && !layers.hasOpenLayers()
          && !document.querySelector('[role="dialog"][data-state="open"], [data-dragging="true"]')
        const request = {
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          clip: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
          borderRadius: `${topLeftRadius} ${topRightRadius} ${bottomRightRadius} ${bottomLeftRadius}`,
          visible,
        }
        const serialized = JSON.stringify(request)
        if (serialized !== last) {
          last = serialized
          setLayouts(current => ({ ...current, [panel.projectId]: request }))
        }
      }
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      setLayouts(current => {
        const layout = current[panel.projectId]
        if (!layout) return current
        return { ...current, [panel.projectId]: { ...layout, visible: false } }
      })
    }
  }, [panel.projectId, modals, layers, setLayouts, isWeb])

  return (
    <div
      onPointerDown={handlePointerDown}
      data-panel-role="content"
      data-panel-surface="true"
      data-joined-to-navigator={isJoinedToNavigator || undefined}
      data-panel-id={panel.id}
      data-compact={isCompact || undefined}
      tabIndex={isCompact ? 0 : undefined}
      className={cn(
        'flex h-full w-full min-w-0 flex-col relative isolate @container/panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        isLifted ? 'z-[1]' : 'z-0',
      )}
      style={!isFocusedPanel && !isOnly ? { '--background': 'var(--background-elevated)' } as React.CSSProperties : undefined}
    >
      <div
        data-panel-material="true"
        aria-hidden="true"
        className={cn(
          'shell-card absolute inset-0 -z-10 pointer-events-none bg-paper',
          isLifted ? 'shadow-elev-2' : 'shadow-elev-0',
        )}
        style={radii}
      />
      {showScrollHandle && layout?.visible && createPortal(
        <div
          className="fixed overflow-hidden pointer-events-none"
          style={{
            ...(!isFocusedPanel && !isOnly ? { '--background': 'var(--background-elevated)' } : {}),
            zIndex: 'calc(var(--z-panel) + 1)',
            left: layout.clip.x,
            top: layout.clip.y,
            width: layout.clip.width,
            height: layout.clip.height,
            clipPath: `inset(0 round ${layout.borderRadius})`,
          }}
        >
          <div
            className="absolute"
            style={{ left: layout.bounds.x - layout.clip.x, top: layout.bounds.y - layout.clip.y, width: layout.bounds.width }}
          >
            <button
              ref={scrollHandle}
              type="button"
              aria-label={t('workbench.scrollPanels')}
              data-notion-scroll-handle={panel.id}
              className={cn(
                'absolute top-0 flex pointer-events-auto cursor-grab touch-none select-none items-center justify-center text-muted-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring titlebar-no-drag transition-[height] duration-micro motion-reduce:transition-none',
                scrollHandleExpanded ? 'left-0 h-12 w-full bg-paper shadow-elev-2' : 'left-1/2 h-3 w-12 -translate-x-1/2',
              )}
              style={{ borderTopLeftRadius: radii.borderTopLeftRadius, borderTopRightRadius: radii.borderTopRightRadius }}
              onPointerLeave={event => {
                if (!scrollDrag.current && document.activeElement !== event.currentTarget) setScrollHandleExpanded(false)
              }}
              onFocus={() => setScrollHandleExpanded(true)}
              onBlur={() => { if (!scrollDrag.current) setScrollHandleExpanded(false) }}
              onPointerDown={event => {
                if (!event.isPrimary || event.button !== 0) return
                const viewport = host.current?.closest<HTMLElement>('[data-panel-scroll-viewport]')
                if (!viewport) return
                event.preventDefault()
                event.stopPropagation()
                event.currentTarget.setPointerCapture(event.pointerId)
                setScrollHandleExpanded(true)
                scrollDrag.current = { pointerId: event.pointerId, startX: event.clientX, scrollLeft: viewport.scrollLeft, viewport }
              }}
              onPointerMove={event => {
                const drag = scrollDrag.current
                if (drag?.pointerId === event.pointerId) {
                  drag.viewport.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX)
                }
              }}
              onLostPointerCapture={event => {
                scrollDrag.current = null
                setScrollHandleExpanded(event.currentTarget.matches(':hover') || document.activeElement === event.currentTarget)
              }}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                event.stopPropagation()
                const viewport = host.current?.closest<HTMLElement>('[data-panel-scroll-viewport]')
                if (viewport) viewport.scrollLeft += event.key === 'ArrowRight' ? viewport.clientWidth : -viewport.clientWidth
              }}
            >
              <span aria-hidden="true" className="flex h-3 w-12 items-center justify-center" onPointerEnter={() => setScrollHandleExpanded(true)}>
                <span className="h-0.5 w-8 rounded-full bg-current opacity-40" />
              </span>
            </button>
          </div>
        </div>,
        document.body,
      )}
      <div ref={host} className="min-h-0 flex-1 overflow-hidden" style={radii}>
        {isWeb ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-sm text-muted-foreground">{t('notion.desktopRequired')}</p>
            <Button variant="secondary" size="sm" onClick={() => { void close({ projectId: panel.projectId, panelId: panel.id }) }}>
              {t('common.close')}
            </Button>
          </div>
        ) : (error || state?.error) && <p className="p-4 text-sm text-destructive">{error || state?.error}</p>}
      </div>
    </div>
  )
}
