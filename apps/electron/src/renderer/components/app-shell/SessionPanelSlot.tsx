import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { ChevronLeft, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { routes } from '../../../shared/routes'
import { parseRouteToNavigationState } from '../../../shared/route-parser'
import {
  closeWorkbenchPanelAtom,
  focusWorkbenchPanelAtom,
} from '@/workbench/workbench-commands'
import type { SessionWorkbenchPanel } from '@/workbench/workbench-state'
import { useAppShellContext, AppShellProvider } from '@/context/AppShellContext'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { MainContentPanel } from './MainContentPanel'
import { getPanelBottomRadius, PANEL_MIN_WIDTH, RADIUS_INNER } from './panel-constants'

interface SessionPanelSlotProps {
  panel: SessionWorkbenchPanel
  isOnly: boolean
  isFocusedPanel: boolean
  isSidebarAndNavigatorHidden: boolean
  isAtLeftEdge: boolean
  isAtRightEdge: boolean
  isCompact?: boolean
}

export function SessionPanelSlot({
  panel,
  isOnly,
  isFocusedPanel,
  isSidebarAndNavigatorHidden,
  isAtLeftEdge,
  isAtRightEdge,
  isCompact = false,
}: SessionPanelSlotProps) {
  const { t } = useTranslation()
  const closePanel = useSetAtom(closeWorkbenchPanelAtom)
  const focusPanel = useSetAtom(focusWorkbenchPanelAtom)
  const parentContext = useAppShellContext()
  const navState = parseRouteToNavigationState(routes.view.allSessions(panel.sessionId))

  const handleClose = useCallback(() => {
    closePanel({ projectId: panel.projectId, panelId: panel.id })
  }, [closePanel, panel.id, panel.projectId])

  const closeButton = useMemo(() => (
    <PanelHeaderCenterButton
      icon={<X className="h-4 w-4" />}
      onClick={handleClose}
      tooltip={t('common.close')}
    />
  ), [handleClose, t])

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
  }), [parentContext, closeButton, backButton, isFocusedPanel])

  const handlePointerDown = useCallback(() => {
    if (!isFocusedPanel) {
      focusPanel({ projectId: panel.projectId, panelId: panel.id })
    }
  }, [focusPanel, isFocusedPanel, panel.id, panel.projectId])

  return (
    <div
      onPointerDown={handlePointerDown}
      data-panel-role="content"
      data-session-id={panel.sessionId}
      data-panel-id={panel.id}
      data-compact={isCompact || undefined}
      className={cn(
        'h-full overflow-hidden relative @container/panel',
        !isOnly && isFocusedPanel ? 'shadow-panel-focused z-[1]' : 'shadow-middle z-0',
        'bg-foreground-2',
      )}
      style={{
        ...(!isFocusedPanel && !isOnly
          ? {
              '--background': 'var(--background-elevated)',
              '--shadow-minimal': 'var(--shadow-minimal-flat)',
              '--user-message-bubble': 'var(--user-message-bubble-dimmed)',
        } as React.CSSProperties
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
      <div className="h-full flex flex-col">
        <AppShellProvider value={contextOverride}>
          <MainContentPanel
            navStateOverride={navState}
            isPhysicalSessionPanel
            isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
          />
        </AppShellProvider>
      </div>
    </div>
  )
}
