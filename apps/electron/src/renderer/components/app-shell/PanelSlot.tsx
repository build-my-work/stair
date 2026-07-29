/**
 * PanelSlot
 *
 * Renders a single content panel within the PanelStackContainer.
 *
 * When a panel is the only one (isOnly), it flex-grows to fill available space.
 * When multiple panels exist, each derives a fixed width from its independent
 * viewport ratio. The lane scrolls instead of shrinking neighboring panels.
 *
 * Each PanelSlot overrides AppShellContext to inject a per-panel close button
 * into PanelHeader's rightSidebarButton slot. All panels are equal — closing
 * any panel removes it from the stack. A reactive effect handles window close
 * when the stack becomes empty.
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { X, ChevronLeft } from 'lucide-react'
import { parseRouteToNavigationState } from '../../../shared/route-parser'
import type { ViewRoute } from '../../../shared/routes'
import {
  backFromCompanionPanelAtom,
  closePanelAtom,
  focusedPanelIdAtom,
  type PanelStackEntry,
} from '@/atoms/panel-stack'
import { useAppShellContext, AppShellProvider } from '@/context/AppShellContext'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { RADIUS_EDGE, RADIUS_INNER } from './panel-constants'
import { isCompanionPanelRoute } from '@/lib/project-file-route'
import { getPanelSizePolicy, getPanelWidthPx } from '@/lib/panel-sizing'
import { navigate, routes } from '@/lib/navigate'
import { PanelContentRouter } from './PanelContentRouter'

/**
 * Compact Project navigation has two drill-in levels:
 * Projects → Project → Session. A session's Back action must therefore return
 * to its Project root instead of removing the whole panel and skipping a level.
 */
export function getCompactProjectBackRoute(
  route: PanelStackEntry['route'],
): ViewRoute | null {
  if (route.kind !== 'navigation') return null

  const navigationState = parseRouteToNavigationState(route.viewRoute)
  if (
    navigationState?.navigator === 'projects'
    && navigationState.details?.sessionId
  ) {
    return routes.view.projects(navigationState.details.projectSlug)
  }
  return null
}

interface PanelSlotProps {
  entry: PanelStackEntry
  isOnly: boolean
  /** Whether this panel is the focused panel in a multi-panel layout */
  isFocusedPanel: boolean
  isSidebarAndNavigatorHidden: boolean
  /** Whether this panel's left corners touch the window edge (no sidebar/navigator before it) */
  isAtLeftEdge: boolean
  /** Whether this panel's right corners touch the window edge (no right sidebar after it) */
  isAtRightEdge: boolean
  /** Visible width used to resolve the independent desktop width ratio. */
  panelViewportWidth: number
  /** Compact (mobile) mode — shows back button in panel header */
  isCompact?: boolean
}

export function PanelSlot({
  entry,
  isOnly,
  isFocusedPanel,
  isSidebarAndNavigatorHidden,
  isAtLeftEdge,
  isAtRightEdge,
  panelViewportWidth,
  isCompact,
}: PanelSlotProps) {
  const { t } = useTranslation()
  const closePanel = useSetAtom(closePanelAtom)
  const backFromCompanion = useSetAtom(backFromCompanionPanelAtom)
  const setFocusedPanel = useSetAtom(focusedPanelIdAtom)
  const parentContext = useAppShellContext()
  const compactProjectBackRoute = getCompactProjectBackRoute(entry.route)
  const { minWidthPx } = getPanelSizePolicy(entry.route)

  const handleClose = useCallback(() => {
    closePanel(entry.id)
  }, [closePanel, entry.id])

  const handleBack = useCallback(() => {
    if (isCompanionPanelRoute(entry.route)) {
      backFromCompanion(entry.id)
      return
    }
    if (compactProjectBackRoute) {
      navigate(compactProjectBackRoute)
      return
    }
    handleClose()
  }, [
    backFromCompanion,
    compactProjectBackRoute,
    entry.id,
    entry.route,
    handleClose,
  ])

  // Build close button for PanelHeader (via context override)
  const closeButton = useMemo(() => {
    return (
      <PanelHeaderCenterButton
        icon={<X className="h-4 w-4" />}
        onClick={handleClose}
        tooltip={t("common.close")}
      />
    )
  }, [handleClose, t])

  // Build back button for compact mode — closes the panel to reveal the session list.
  // Same PanelHeaderCenterButton style as X and share, just on the left side.
  const backButton = useMemo(() => {
    if (!isCompact) return undefined
    return (
      <PanelHeaderCenterButton
        icon={<ChevronLeft className="h-4 w-4" />}
        onClick={handleBack}
        tooltip={t("common.backToList")}
      />
    )
  }, [isCompact, handleBack, t])

  // Override AppShellContext so ChatPage/PanelHeader gets our per-panel close button,
  // back button (compact mode), and isFocusedPanel for input field appearance
  const contextOverride = useMemo(() => ({
    ...parentContext,
    rightSidebarButton: closeButton,
    leadingAction: backButton,
    isFocusedPanel,
  }), [parentContext, closeButton, backButton, isFocusedPanel])

  const handlePointerDown = useCallback(() => {
    if (!isFocusedPanel) {
      setFocusedPanel(entry.id)
    }
  }, [isFocusedPanel, setFocusedPanel, entry.id])

  return (
    <div
      onPointerDown={handlePointerDown}
      data-panel-role="content"
      data-panel-id={entry.id}
      data-compact={isCompact || undefined}
      className={cn(
        'h-full overflow-hidden relative @container/panel',
        !isOnly && isFocusedPanel ? 'shadow-panel-focused z-[1]' : 'shadow-middle z-0',
        'bg-foreground-2',
      )}
      style={{
        // In multi-panel, unfocused panels override --background so all
        // bg-background children render at the elevated (dimmed) background.
        ...(!isFocusedPanel && !isOnly
          ? {
              '--background': 'var(--background-elevated)',
              '--shadow-minimal': 'var(--shadow-minimal-flat)',
              '--user-message-bubble': 'var(--user-message-bubble-dimmed)',
            } as React.CSSProperties
          : {}
        ),
        // Corner radii: edge corners (touching window boundary) vs interior corners.
        // Compact mode panels run flush to the viewport floor — no rounded bottom.
        borderTopLeftRadius: RADIUS_INNER,
        borderBottomLeftRadius: isCompact ? 0 : (isAtLeftEdge ? RADIUS_EDGE : RADIUS_INNER),
        borderTopRightRadius: RADIUS_INNER,
        borderBottomRightRadius: isCompact ? 0 : (isAtRightEdge ? RADIUS_EDGE : RADIUS_INNER),
        ...(isOnly
          ? { flexGrow: 1, minWidth: 0 }
          : {
              flex: '0 0 auto',
              width: getPanelWidthPx(
                entry.route,
                entry.widthRatio,
                panelViewportWidth,
              ),
              minWidth: minWidthPx,
            }
        ),
      }}
    >
      <div className="h-full flex flex-col">
        <AppShellProvider value={contextOverride}>
          <PanelContentRouter
            entry={entry}
            isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
          />
        </AppShellProvider>
      </div>
    </div>
  )
}
