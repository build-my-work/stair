import { useCallback, useMemo, type ReactNode } from 'react'
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
import { getPanelBottomRadius, RADIUS_INNER } from './panel-constants'

interface ProjectFilePanelSlotProps {
  panel: ProjectFileWorkbenchPanel
  isOnly: boolean
  isFocusedPanel: boolean
  isAtLeftEdge: boolean
  isAtRightEdge: boolean
  isJoinedToNavigator?: boolean
  isCompact?: boolean
  reorderHandle?: ReactNode
}

export function ProjectFilePanelSlot({
  panel,
  isOnly,
  isFocusedPanel,
  isAtLeftEdge,
  isAtRightEdge,
  isJoinedToNavigator = false,
  isCompact = false,
  reorderHandle,
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
      {!isCompact && reorderHandle}
      {parentContext.rightSidebarButton}
      <PanelHeaderCenterButton
        icon={<X className="h-4 w-4" />}
        onClick={handleClose}
        tooltip={t('common.close')}
      />
    </div>
  ), [handleClose, isCompact, parentContext.rightSidebarButton, reorderHandle, t])

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

  const radii = {
    borderTopLeftRadius: isJoinedToNavigator ? 0 : RADIUS_INNER,
    borderBottomLeftRadius: isJoinedToNavigator ? 0 : getPanelBottomRadius(isCompact, isAtLeftEdge),
    borderTopRightRadius: RADIUS_INNER,
    borderBottomRightRadius: getPanelBottomRadius(isCompact, isAtRightEdge),
  }
  const isLifted = !isOnly && isFocusedPanel

  return (
    <div
      onPointerDown={handlePointerDown}
      data-panel-role="content"
      data-panel-surface="true"
      data-joined-to-navigator={isJoinedToNavigator || undefined}
      data-project-file={panel.relativePath}
      data-panel-id={panel.id}
      data-compact={isCompact || undefined}
      tabIndex={isCompact ? 0 : undefined}
      className={cn(
        'h-full w-full min-w-0 relative isolate @container/panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        isLifted ? 'z-[1]' : 'z-0',
      )}
      style={{
        ...(!isFocusedPanel && !isOnly
          ? { '--background': 'var(--background-elevated)' } as React.CSSProperties
          : {}),
      }}
    >
      {/* Only the card material scales during layout animation; editors and Canvas never do. */}
      <div
        data-panel-material="true"
        aria-hidden="true"
        className={cn(
          'shell-card absolute inset-0 -z-10 pointer-events-none bg-paper',
          isLifted ? 'shadow-elev-2' : 'shadow-elev-0',
        )}
        style={radii}
      />
      <div className="h-full overflow-hidden" style={radii}>
        <AppShellProvider value={contextOverride}>
          <ProjectFilePage
            projectId={panel.projectId}
            relativePath={panel.relativePath}
            presentation={panel.presentation}
            panelId={panel.id}
            chatTargetSessionId={panel.chatTargetSessionId}
            openIntent={panel.openIntent}
            openIntentRevision={panel.openIntentRevision}
          />
        </AppShellProvider>
      </div>
    </div>
  )
}
