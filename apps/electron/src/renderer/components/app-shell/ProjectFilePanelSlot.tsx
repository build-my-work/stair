import { useCallback, useMemo } from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppShellProvider, useAppShellContext } from '@/context/AppShellContext'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import ProjectFilePage from '@/pages/ProjectFilePage'
import {
  closeWorkbenchPanelAtom,
  focusWorkbenchPanelAtom,
} from '@/workbench/workbench-commands'
import type { ProjectFileWorkbenchPanel } from '@/workbench/workbench-state'
import { getPanelBottomRadius, PANEL_MIN_WIDTH, RADIUS_INNER } from './panel-constants'

interface ProjectFilePanelSlotProps {
  panel: ProjectFileWorkbenchPanel
  isOnly: boolean
  isFocusedPanel: boolean
  isAtLeftEdge: boolean
  isAtRightEdge: boolean
  isCompact?: boolean
}

export function ProjectFilePanelSlot({
  panel,
  isOnly,
  isFocusedPanel,
  isAtLeftEdge,
  isAtRightEdge,
  isCompact = false,
}: ProjectFilePanelSlotProps) {
  const { t } = useTranslation()
  const closePanel = useSetAtom(closeWorkbenchPanelAtom)
  const focusPanel = useSetAtom(focusWorkbenchPanelAtom)
  const parentContext = useAppShellContext()

  const handleClose = useCallback(() => {
    void closePanel({ projectId: panel.projectId, panelId: panel.id })
  }, [closePanel, panel.id, panel.projectId])

  const closeButton = useMemo(() => (
    <div className="flex items-center gap-1.5">
      {parentContext.rightSidebarButton}
      <PanelHeaderCenterButton
        icon={<X className="h-4 w-4" />}
        onClick={handleClose}
        tooltip={t('common.close')}
      />
    </div>
  ), [handleClose, parentContext.rightSidebarButton, t])

  const backButton = useMemo(() => isCompact ? (
    <PanelHeaderCenterButton
      icon={<ChevronLeft className="h-4 w-4" />}
      onClick={handleClose}
      tooltip={t('common.backToList')}
    />
  ) : undefined, [handleClose, isCompact, t])

  const contextOverride = useMemo(() => ({
    ...parentContext,
    rightSidebarButton: closeButton,
    leadingAction: backButton,
    isFocusedPanel,
  }), [backButton, closeButton, isFocusedPanel, parentContext])

  const handlePointerDown = useCallback(() => {
    if (!isFocusedPanel) {
      focusPanel({ projectId: panel.projectId, panelId: panel.id })
    }
  }, [focusPanel, isFocusedPanel, panel.id, panel.projectId])

  return (
    <div
      onPointerDown={handlePointerDown}
      data-panel-role="content"
      data-project-file={panel.relativePath}
      data-panel-id={panel.id}
      data-compact={isCompact || undefined}
      className={cn(
        'h-full overflow-hidden relative @container/panel bg-foreground-2',
        !isOnly && isFocusedPanel ? 'shadow-panel-focused z-[1]' : 'shadow-middle z-0',
      )}
      style={{
        ...(!isFocusedPanel && !isOnly
          ? { '--background': 'var(--background-elevated)' } as React.CSSProperties
          : {}),
        borderTopLeftRadius: RADIUS_INNER,
        borderBottomLeftRadius: getPanelBottomRadius(isCompact, isAtLeftEdge),
        borderTopRightRadius: RADIUS_INNER,
        borderBottomRightRadius: getPanelBottomRadius(isCompact, isAtRightEdge),
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: isOnly ? 0 : PANEL_MIN_WIDTH,
      }}
    >
      <AppShellProvider value={contextOverride}>
        <ProjectFilePage
          projectId={panel.projectId}
          relativePath={panel.relativePath}
          presentation={panel.presentation}
        />
      </AppShellProvider>
    </div>
  )
}
