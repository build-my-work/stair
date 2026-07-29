/**
 * Resizes the panel immediately before this sash.
 *
 * Later panels translate with the widened panel; they are never compressed to
 * pay for the resize. Width is previewed directly in the DOM while dragging
 * and committed once on pointerup, so URL persistence does not run per frame.
 */

import { useCallback } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { panelStackAtom, resizePanelAtom } from '@/atoms/panel-stack'
import {
  getDefaultPanelWidthRatio,
  getPanelSizePolicy,
  getPanelWidthPx,
  getPanelWidthRatio,
} from '@/lib/panel-sizing'
import { useResizeGradient } from '@/hooks/useResizeGradient'
import {
  PANEL_SASH_FLEX_MARGIN,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
  PANEL_STACK_VERTICAL_OVERFLOW,
} from './panel-constants'

const AUTO_SCROLL_EDGE_PX = 40
const AUTO_SCROLL_MAX_STEP_PX = 18

interface PanelResizeSashProps {
  panelId: string
  panelViewportWidth: number
}

function resolveViewportWidth(
  scrollContainer: HTMLElement | null | undefined,
  fallbackWidth: number,
): number {
  const measuredWidth = scrollContainer?.clientWidth ?? 0
  return measuredWidth > 0 ? measuredWidth : fallbackWidth
}

function getAutoScrollStep(
  pointerX: number,
  bounds: DOMRect,
): number {
  if (pointerX < bounds.left + AUTO_SCROLL_EDGE_PX) {
    const strength = (
      bounds.left + AUTO_SCROLL_EDGE_PX - pointerX
    ) / AUTO_SCROLL_EDGE_PX
    return -Math.ceil(
      Math.min(1, strength) * AUTO_SCROLL_MAX_STEP_PX,
    )
  }
  if (pointerX > bounds.right - AUTO_SCROLL_EDGE_PX) {
    const strength = (
      pointerX - (bounds.right - AUTO_SCROLL_EDGE_PX)
    ) / AUTO_SCROLL_EDGE_PX
    return Math.ceil(
      Math.min(1, strength) * AUTO_SCROLL_MAX_STEP_PX,
    )
  }
  return 0
}

export function PanelResizeSash({
  panelId,
  panelViewportWidth,
}: PanelResizeSashProps) {
  const resizePanel = useSetAtom(resizePanelAtom)
  const panelStack = useAtomValue(panelStackAtom)
  const { ref, handlers, gradientStyle } = useResizeGradient()
  const {
    onMouseDown: startGradientDrag,
    onMouseMove: trackGradient,
    onMouseLeave: clearGradient,
    onMouseUp: stopGradientDrag,
  } = handlers
  const panel = panelStack.find(entry => entry.id === panelId)

  const handlePointerDown = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || !event.isPrimary || !panel) return
    event.preventDefault()

    const sash = ref.current
    const panelElement = sash?.previousElementSibling as HTMLElement | null
    if (!sash || !panelElement) return
    const activeSash = sash
    const activePanelElement = panelElement
    const panelRoute = panel.route

    const scrollContainer = sash.closest<HTMLElement>(
      '[data-panel-scroll-container="true"]',
    )
    const viewportWidth = resolveViewportWidth(
      scrollContainer,
      panelViewportWidth,
    )
    if (viewportWidth <= 0) return

    startGradientDrag()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startScrollLeft = scrollContainer?.scrollLeft ?? 0
    const startWidthPx = activePanelElement.getBoundingClientRect().width
    const { minWidthPx } = getPanelSizePolicy(panelRoute)
    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    let previewWidthPx = startWidthPx
    let isFinished = false

    function previewAt(pointerX: number) {
      const scrollDelta = (
        scrollContainer?.scrollLeft ?? 0
      ) - startScrollLeft
      previewWidthPx = Math.max(
        minWidthPx,
        startWidthPx + pointerX - startX + scrollDelta,
      )
      activePanelElement.style.width = `${previewWidthPx}px`
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return
      if ((moveEvent.buttons & 1) === 0) {
        commitPreview()
        return
      }
      if (scrollContainer) {
        const step = getAutoScrollStep(
          moveEvent.clientX,
          scrollContainer.getBoundingClientRect(),
        )
        if (step !== 0) {
          scrollContainer.scrollLeft += step
        }
      }
      previewAt(moveEvent.clientX)
    }

    function cleanup() {
      if (isFinished) return
      isFinished = true
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', cancelPreview)
      document.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('blur', cancelPreview)
      activeSash.removeEventListener('lostpointercapture', commitPreview)
      if (activeSash.hasPointerCapture(pointerId)) {
        activeSash.releasePointerCapture(pointerId)
      }
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      stopGradientDrag()
    }

    function commitPreview() {
      const widthRatio = getPanelWidthRatio(
        panelRoute,
        previewWidthPx,
        viewportWidth,
      )
      cleanup()
      resizePanel({
        panelId,
        widthRatio,
      })
    }

    function handlePointerUp(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId) return
      previewAt(upEvent.clientX)
      commitPreview()
    }

    function cancelPreview() {
      activePanelElement.style.width = `${startWidthPx}px`
      cleanup()
    }

    function handleKeyDown(keyEvent: KeyboardEvent) {
      if (keyEvent.key !== 'Escape') return
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      cancelPreview()
    }

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', cancelPreview)
    document.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('blur', cancelPreview)
    sash.addEventListener('lostpointercapture', commitPreview)
    sash.setPointerCapture(pointerId)
  }, [
    panel,
    panelId,
    panelViewportWidth,
    ref,
    resizePanel,
    startGradientDrag,
    stopGradientDrag,
  ])

  const handleDoubleClick = useCallback(() => {
    if (!panel) return
    const scrollContainer = ref.current?.closest<HTMLElement>(
      '[data-panel-scroll-container="true"]',
    )
    const activeViewportWidth = resolveViewportWidth(
      scrollContainer,
      panelViewportWidth,
    )
    if (activeViewportWidth <= 0) return
    resizePanel({
      panelId,
      widthRatio: getDefaultPanelWidthRatio(
        panel.route,
        activeViewportWidth,
      ),
    })
  }, [panel, panelId, panelViewportWidth, ref, resizePanel])

  return (
    <div
      ref={ref}
      role="separator"
      aria-label="Resize panel"
      aria-orientation="vertical"
      aria-valuemin={panel
        ? getPanelSizePolicy(panel.route).minWidthPx
        : undefined}
      aria-valuenow={panel
        ? Math.round(getPanelWidthPx(
            panel.route,
            panel.widthRatio,
            panelViewportWidth,
          ))
        : undefined}
      className="relative w-0 h-full cursor-col-resize flex justify-center shrink-0"
      style={{
        margin: `0 ${PANEL_SASH_FLEX_MARGIN}px`,
        touchAction: 'none',
      }}
      onPointerDown={handlePointerDown}
      onMouseMove={trackGradient}
      onMouseLeave={clearGradient}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className="absolute inset-y-0 flex justify-center cursor-col-resize"
        style={{
          left: -PANEL_SASH_HALF_HIT_WIDTH,
          right: -PANEL_SASH_HALF_HIT_WIDTH,
        }}
      >
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            ...gradientStyle,
            width: PANEL_SASH_LINE_WIDTH,
            top: PANEL_STACK_VERTICAL_OVERFLOW,
            bottom: PANEL_STACK_VERTICAL_OVERFLOW,
          }}
        />
      </div>
    </div>
  )
}
