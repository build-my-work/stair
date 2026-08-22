import { useCallback } from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { resizeWorkbenchPanelAtom } from '@/workbench/workbench-commands'
import {
  getDefaultWorkbenchPanelRatio,
  getWorkbenchPanelRatio,
  getWorkbenchPanelWidth,
} from '@/workbench/panel-sizing'
import type { WorkbenchPanel } from '@/workbench/workbench-state'
import {
  PANEL_MIN_WIDTH,
  PANEL_SASH_FLEX_MARGIN,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
} from './panel-constants'

interface PanelResizeSashProps {
  projectId: string
  panel: WorkbenchPanel
  panelLayoutWidth: number
  isDragActive: boolean
}

export function PanelResizeSash({
  projectId,
  panel,
  panelLayoutWidth,
  isDragActive,
}: PanelResizeSashProps) {
  const { t } = useTranslation()
  const resizePanel = useSetAtom(resizeWorkbenchPanelAtom)
  const resolvedWidth = getWorkbenchPanelWidth(panel.widthRatio, panelLayoutWidth)

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || panelLayoutWidth <= 0) return
    const container = event.currentTarget.closest<HTMLElement>('[data-workbench-panels]')
    const panelFrame = container
      ? Array.from(container.querySelectorAll<HTMLElement>('[data-panel-frame]'))
        .find(frame => frame.dataset.panelId === panel.id)
      : undefined
    if (!panelFrame) return

    event.preventDefault()
    const pointerId = event.pointerId
    const sash = event.currentTarget
    const startX = event.clientX
    const startWidth = panelFrame.getBoundingClientRect().width
    const originalWidth = panelFrame.style.width
    const originalCursor = document.body.style.cursor
    const originalUserSelect = document.body.style.userSelect
    let previewWidth = startWidth
    let finished = false

    const cleanup = () => {
      if (finished) return
      finished = true
      document.body.style.cursor = originalCursor
      document.body.style.userSelect = originalUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('keydown', handleKeyDown, true)
      sash.removeEventListener('lostpointercapture', commit)
      if (sash.hasPointerCapture(pointerId)) sash.releasePointerCapture(pointerId)
    }
    const previewAt = (clientX: number) => {
      panelFrame.style.width = `${Math.max(PANEL_MIN_WIDTH, startWidth + clientX - startX)}px`
      previewWidth = panelFrame.getBoundingClientRect().width
    }
    const commit = () => {
      cleanup()
      resizePanel({
        projectId,
        panelId: panel.id,
        widthRatio: getWorkbenchPanelRatio(previewWidth, panelLayoutWidth),
      })
    }
    const cancel = () => {
      panelFrame.style.width = originalWidth
      cleanup()
    }
    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      if ((moveEvent.buttons & 1) === 0) {
        commit()
        return
      }
      previewAt(moveEvent.clientX)
    }
    const handlePointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return
      previewAt(upEvent.clientX)
      commit()
    }
    const handleKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return
      keyEvent.preventDefault()
      cancel()
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    sash.setPointerCapture(pointerId)
    sash.addEventListener('lostpointercapture', commit)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    document.addEventListener('keydown', handleKeyDown, true)
  }, [panel.id, panelLayoutWidth, projectId, resizePanel])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    resizePanel({
      projectId,
      panelId: panel.id,
      widthRatio: getWorkbenchPanelRatio(
        resolvedWidth + direction * 24,
        panelLayoutWidth,
      ),
    })
  }, [panel.id, panelLayoutWidth, projectId, resizePanel, resolvedWidth])

  const handleDoubleClick = useCallback(() => {
    resizePanel({
      projectId,
      panelId: panel.id,
      widthRatio: getDefaultWorkbenchPanelRatio(panelLayoutWidth),
    })
  }, [panel.id, panelLayoutWidth, projectId, resizePanel])

  return (
    <div
      className="relative h-full w-0 shrink-0 z-[4]"
      style={{ marginInline: PANEL_SASH_FLEX_MARGIN }}
    >
      <div
        role="separator"
        tabIndex={isDragActive ? -1 : 0}
        aria-hidden={isDragActive || undefined}
        aria-label={t('workbench.resizePanels')}
        aria-orientation="vertical"
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuenow={Math.round(resolvedWidth)}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        onDoubleClick={handleDoubleClick}
        className="group absolute inset-y-0 cursor-col-resize focus-visible:outline-none"
        style={{
          width: PANEL_SASH_HIT_WIDTH,
          left: -PANEL_SASH_HALF_HIT_WIDTH,
          opacity: isDragActive ? 0 : 1,
          pointerEvents: isDragActive ? 'none' : 'auto',
        }}
      >
        <div
          className="absolute inset-y-2 left-1/2 -translate-x-1/2 rounded-full bg-transparent transition-colors group-hover:bg-border group-focus-visible:bg-ring"
          style={{ width: PANEL_SASH_LINE_WIDTH }}
        />
      </div>
    </div>
  )
}
