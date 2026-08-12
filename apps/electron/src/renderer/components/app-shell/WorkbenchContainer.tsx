import { useEffect, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import {
  focusedWorkbenchPanelIdAtom,
  workbenchPanelRevealRevisionAtom,
  workbenchPanelsAtom,
} from '@/workbench/workbench-state'
import {
  isSessionsNavigation,
  useNavigationState,
} from '@/contexts/NavigationContext'
import { useIsMultiSelectActive } from '@/hooks/useSession'
import { isDetailNavState } from '@/lib/nav-helpers'
import { SessionPanelSlot } from './SessionPanelSlot'
import { MainContentPanel } from './MainContentPanel'
import {
  PANEL_EDGE_INSET,
  PANEL_GAP,
  PANEL_STACK_VERTICAL_OVERFLOW,
  RADIUS_EDGE,
  RADIUS_INNER,
  getPanelBottomRadius,
} from './panel-constants'

const PANEL_SPRING = { type: 'spring' as const, stiffness: 600, damping: 49 }

interface WorkbenchContainerProps {
  sidebarSlot: React.ReactNode
  sidebarWidth: number
  navigatorSlot: React.ReactNode
  navigatorWidth: number
  isSidebarAndNavigatorHidden: boolean
  isRightSidebarVisible?: boolean
  isCompact?: boolean
  isResizing?: boolean
}

function ShellContentSlot({
  isSidebarAndNavigatorHidden,
  isAtLeftEdge,
  isAtRightEdge,
  isCompact,
}: {
  isSidebarAndNavigatorHidden: boolean
  isAtLeftEdge: boolean
  isAtRightEdge: boolean
  isCompact: boolean
}) {
  return (
    <div
      data-panel-role="shell-content"
      className="h-full min-w-0 flex-1 overflow-hidden relative @container/panel bg-foreground-2 shadow-middle"
      style={{
        borderTopLeftRadius: RADIUS_INNER,
        borderBottomLeftRadius: getPanelBottomRadius(isCompact, isAtLeftEdge),
        borderTopRightRadius: RADIUS_INNER,
        borderBottomRightRadius: getPanelBottomRadius(isCompact, isAtRightEdge),
      }}
    >
      <MainContentPanel isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden} />
    </div>
  )
}

export function WorkbenchContainer({
  sidebarSlot,
  sidebarWidth,
  navigatorSlot,
  navigatorWidth,
  isSidebarAndNavigatorHidden,
  isRightSidebarVisible,
  isCompact = false,
  isResizing,
}: WorkbenchContainerProps) {
  const panels = useAtomValue(workbenchPanelsAtom)
  const focusedPanelId = useAtomValue(focusedWorkbenchPanelIdAtom)
  const panelRevealRevision = useAtomValue(workbenchPanelRevealRevisionAtom)
  const navigationState = useNavigationState()
  const isMultiSelectActive = useIsMultiSelectActive()
  const scrollRef = useRef<HTMLDivElement>(null)

  const isSessionWorkbench = isSessionsNavigation(navigationState)
    && navigationState.viewMode !== 'board'
    && !isMultiSelectActive
  const hasSidebar = sidebarWidth > 0
  const hasNavigator = navigatorWidth > 0
  const isAtLeftEdge = !hasSidebar && !hasNavigator

  useEffect(() => {
    if (isCompact || !focusedPanelId) return
    const frame = requestAnimationFrame(() => {
      const container = scrollRef.current
      if (!container) return
      const focusedPanel = Array.from(
        container.querySelectorAll<HTMLElement>('[data-panel-id]'),
      ).find(panel => panel.dataset.panelId === focusedPanelId)
      if (!focusedPanel) return

      const containerRect = container.getBoundingClientRect()
      const panelRect = focusedPanel.getBoundingClientRect()
      let nextScrollLeft = container.scrollLeft
      if (panelRect.left < containerRect.left) {
        nextScrollLeft -= containerRect.left - panelRect.left
      } else if (panelRect.right > containerRect.right) {
        nextScrollLeft += panelRect.right - containerRect.right
      }
      container.scrollTo({ left: nextScrollLeft, behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusedPanelId, isCompact, panelRevealRevision])

  if (isCompact) {
    const focusedPanel = panels.find(panel => panel.id === focusedPanelId)
    const showNavigator = !isDetailNavState(navigationState)
      || (isSessionWorkbench && !focusedPanel)
    return (
      <div
        ref={scrollRef}
        data-mobile-menu-root="true"
        className="flex-1 min-w-0 relative panel-scroll @container/shell"
        style={{
          paddingBlock: PANEL_STACK_VERTICAL_OVERFLOW,
          marginBlock: -PANEL_STACK_VERTICAL_OVERFLOW,
          marginBottom: -6,
          paddingBottom: 6,
        }}
      >
        {showNavigator && hasNavigator ? (
          <div
            data-panel-role="navigator"
            className="h-full w-full overflow-hidden relative bg-background shadow-middle"
            style={{ borderTopLeftRadius: RADIUS_INNER, borderTopRightRadius: RADIUS_INNER }}
          >
            {navigatorSlot}
          </div>
        ) : isSessionWorkbench && focusedPanel ? (
          <SessionPanelSlot
            panel={focusedPanel}
            isOnly
            isFocusedPanel
            isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
            isAtLeftEdge
            isAtRightEdge={!isRightSidebarVisible}
            isCompact
          />
        ) : (
          <ShellContentSlot
            isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
            isAtLeftEdge
            isAtRightEdge={!isRightSidebarVisible}
            isCompact
          />
        )}
      </div>
    )
  }

  const transition = isResizing ? { duration: 0 } : PANEL_SPRING
  return (
    <div
      ref={scrollRef}
      data-mobile-menu-root="true"
      className="flex-1 min-w-0 flex relative z-panel panel-scroll @container/shell"
      style={{
        overflowX: 'auto',
        overflowY: 'hidden',
        paddingBlock: PANEL_STACK_VERTICAL_OVERFLOW,
        marginBlock: -PANEL_STACK_VERTICAL_OVERFLOW,
        marginBottom: -6,
        paddingBottom: 6,
        paddingRight: 8,
        marginRight: -8,
      }}
    >
      <motion.div
        className="flex h-full"
        initial={false}
        animate={{ paddingLeft: !hasSidebar ? PANEL_EDGE_INSET : 0 }}
        transition={transition}
        style={{ gap: PANEL_GAP, flexGrow: 1, minWidth: 0 }}
      >
        <motion.div
          data-panel-role="sidebar"
          initial={false}
          animate={{
            width: hasSidebar ? sidebarWidth : 0,
            marginRight: hasSidebar ? 0 : -PANEL_GAP,
            opacity: hasSidebar ? 1 : 0,
          }}
          transition={transition}
          className="h-full relative shrink-0"
          style={{ overflowX: 'clip', overflowY: 'visible' }}
        >
          <div className="h-full" style={{ width: sidebarWidth }}>{sidebarSlot}</div>
        </motion.div>

        <motion.div
          data-panel-role="navigator"
          initial={false}
          animate={{
            width: hasNavigator ? navigatorWidth : 0,
            marginRight: hasNavigator ? 0 : -PANEL_GAP,
            opacity: hasNavigator ? 1 : 0,
          }}
          transition={transition}
          className={cn('h-full overflow-hidden relative shrink-0 z-[2]', 'bg-background shadow-middle')}
          style={{
            borderTopLeftRadius: RADIUS_INNER,
            borderBottomLeftRadius: !hasSidebar ? RADIUS_EDGE : RADIUS_INNER,
            borderTopRightRadius: RADIUS_INNER,
            borderBottomRightRadius: RADIUS_INNER,
          }}
        >
          <div className="h-full" style={{ width: navigatorWidth }}>{navigatorSlot}</div>
        </motion.div>

        {isSessionWorkbench ? (
          panels.length === 0 ? (
            <div data-panel-role="empty-primary" className="flex-1" />
          ) : panels.map((panel, index) => (
            <SessionPanelSlot
              key={panel.id}
              panel={panel}
              isOnly={panels.length === 1}
              isFocusedPanel={panels.length === 1 || panel.id === focusedPanelId}
              isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
              isAtLeftEdge={index === 0 && isAtLeftEdge}
              isAtRightEdge={index === panels.length - 1 && !isRightSidebarVisible}
            />
          ))
        ) : (
          <ShellContentSlot
            isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
            isAtLeftEdge={isAtLeftEdge}
            isAtRightEdge={!isRightSidebarVisible}
            isCompact={false}
          />
        )}
      </motion.div>
    </div>
  )
}
