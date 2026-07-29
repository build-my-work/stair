/**
 * PanelStackContainer
 *
 * Horizontal layout container for ALL panels:
 * Sidebar → Navigator → Content Panel(s) with resize sashes.
 *
 * Each content panel owns an independent ratio of the visible PanelStack
 * width. Ratios never normalize; when their resolved widths exceed the
 * viewport, the track scrolls horizontally.
 *
 * Sidebar and Navigator are NOT part of the content-panel width model —
 * they have their own fixed/user-resizable widths managed by AppShell.
 * They just reduce the available width for content panels and scroll with everything else.
 *
 * The right sidebar stays OUTSIDE this container.
 *
 * Compact mode (mobile / narrow window):
 * The flex layout is replaced with an absolute-positioned, transform-animated
 * stack — navigator and the focused content panel both stay mounted and slide
 * in/out via CompactPanelTransition. This produces an iOS UINavigationController
 * feel rather than a CSS reflow.
 */

import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import {
  panelStackAtom,
  panelViewportWidthAtom,
  focusedPanelIdAtom,
  focusedPanelRouteAtom,
  focusedPanelContentRouteAtom,
} from '@/atoms/panel-stack'
import { parseRouteToNavigationState } from '../../../shared/route-parser'
import { isDetailNavState } from '@/lib/nav-helpers'
import { PanelSlot } from './PanelSlot'
import { PanelResizeSash } from './PanelResizeSash'
import { CompactPanelTransition } from './CompactPanelTransition'
import {
  PANEL_GAP,
  PANEL_EDGE_INSET,
  PANEL_STACK_VERTICAL_OVERFLOW,
  RADIUS_EDGE,
  RADIUS_INNER,
} from './panel-constants'

/** Spring transition matching AppShell's sidebar/navigator animation */
const PANEL_SPRING = { type: 'spring' as const, stiffness: 600, damping: 49 }

/** Visual breathing room between the fixed compact TopBar and the first panel. */
const COMPACT_PANEL_TOP_GAP = 8

interface PanelStackContainerProps {
  sidebarSlot: React.ReactNode
  sidebarWidth: number
  navigatorSlot: React.ReactNode
  navigatorWidth: number
  isSidebarAndNavigatorHidden: boolean
  isRightSidebarVisible?: boolean
  /** Compact mode: single-panel, list/content toggle (mobile or narrow window) */
  isCompact?: boolean
  isResizing?: boolean
}

export function PanelStackContainer({
  sidebarSlot,
  sidebarWidth,
  navigatorSlot,
  navigatorWidth,
  isSidebarAndNavigatorHidden,
  isRightSidebarVisible,
  isCompact = false,
  isResizing,
}: PanelStackContainerProps) {
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  const focusedRoute = useAtomValue(focusedPanelRouteAtom)
  const focusedContentRoute = useAtomValue(focusedPanelContentRouteAtom)
  const panelViewportWidth = useAtomValue(panelViewportWidthAtom)
  const setPanelViewportWidth = useSetAtom(panelViewportWidthAtom)

  // Compact mode: drill-in is "detail focused", not just "session selected".
  // For sessions: a session is selected. For settings: a subpage is selected.
  // For sources/skills/automations: a detail entity is selected.
  const focusedNavState = focusedRoute ? parseRouteToNavigationState(focusedRoute) : null
  const isDetailFocused = isDetailNavState(focusedNavState)
  const isCompanionFocused = (
    focusedContentRoute !== null
    && focusedContentRoute.kind !== 'navigation'
  )
  const hasSelectedContent = isCompact
    && (isCompanionFocused || isDetailFocused)

  const visiblePanels = isCompact
    ? panelStack.filter(entry => entry.id === focusedPanelId)
    : panelStack

  const scrollRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const updateViewportWidth = () => {
      const nextWidth = container.clientWidth
      if (nextWidth > 0) setPanelViewportWidth(nextWidth)
    }

    updateViewportWidth()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateViewportWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [isCompact, setPanelViewportWidth])

  const hasSidebar = sidebarWidth > 0
  // Desktop: navigator is shown when AppShell asks for it. Compact: navigator
  // is always mounted (transform-hidden when detail-focused) so the slide can
  // animate both slots in lockstep.
  const hasNavigator = navigatorWidth > 0
  const isMultiPanel = visiblePanels.length > 1
  const isLeftEdge = !hasSidebar && !hasNavigator

  // Keep the focused panel fully visible. A fixed right sidebar can reduce the
  // available lane after a companion is inserted, so measure after layout
  // settles instead of relying only on the panel-count transition.
  useEffect(() => {
    if (isCompact || !focusedPanelId) return

    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const container = scrollRef.current
        const panel = container?.querySelector<HTMLElement>(
          `[data-panel-id="${focusedPanelId}"]`,
        )
        if (!container || !panel) return

        const containerRect = container.getBoundingClientRect()
        const panelRect = panel.getBoundingClientRect()
        const rightOverflow = panelRect.right - containerRect.right
        const leftOverflow = containerRect.left - panelRect.left

        if (panelRect.width > containerRect.width) {
          const leftOffset = panelRect.left - containerRect.left
          if (Math.abs(leftOffset) > 1) {
            container.scrollTo({
              left: Math.max(0, container.scrollLeft + leftOffset),
              behavior: 'smooth',
            })
          }
        } else if (rightOverflow > 1) {
          container.scrollTo({
            left: container.scrollLeft + rightOverflow + PANEL_GAP,
            behavior: 'smooth',
          })
        } else if (leftOverflow > 1) {
          container.scrollTo({
            left: Math.max(0, container.scrollLeft - leftOverflow - PANEL_GAP),
            behavior: 'smooth',
          })
        }
      })
    })

    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [
    panelStack.length,
    panelViewportWidth,
    focusedPanelId,
    focusedRoute,
    isCompact,
    isRightSidebarVisible,
  ])

  const transition = (isResizing || isCompact) ? { duration: 0 } : PANEL_SPRING

  // === COMPACT BRANCH ===
  // Single-panel layout with iOS-style slide between navigator and detail.
  // Both stay in the DOM; CompactPanelTransition transforms whichever should be
  // off-screen. Sidebar is hidden by AppShell in compact mode (sidebarWidth = 0).
  if (isCompact) {
    const focusedEntry = visiblePanels[0]
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
          '--compact-panel-stack-top': `${PANEL_STACK_VERTICAL_OVERFLOW + COMPACT_PANEL_TOP_GAP}px`,
        } as React.CSSProperties}
      >
        {/* Navigator slot — full width, slides left to -30% when detail focused. */}
        {hasNavigator && (
          <CompactPanelTransition role="navigator" isDetailActive={hasSelectedContent}>
            <div
              data-panel-role="navigator"
              className={cn(
                'h-full w-full overflow-hidden relative',
                'bg-background shadow-middle',
              )}
              style={{
                // Compact mode runs flush to the viewport floor — no rounded bottom.
                borderTopLeftRadius: RADIUS_INNER,
                borderBottomLeftRadius: 0,
                borderTopRightRadius: RADIUS_INNER,
                borderBottomRightRadius: 0,
              }}
            >
              {navigatorSlot}
            </div>
          </CompactPanelTransition>
        )}

        {/* Content slot — full width, slides in from the right when detail focused. */}
        {focusedEntry && (
          <CompactPanelTransition role="detail" isDetailActive={hasSelectedContent}>
            <div className="h-full w-full flex">
              <PanelSlot
                key={focusedEntry.id}
                entry={focusedEntry}
                isOnly={true}
                isFocusedPanel={true}
                isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
                isAtLeftEdge={isLeftEdge}
                isAtRightEdge={!isRightSidebarVisible}
                panelViewportWidth={panelViewportWidth}
                isCompact={true}
              />
            </div>
          </CompactPanelTransition>
        )}
      </div>
    )
  }

  // === DESKTOP BRANCH ===
  // Independent-ratio horizontal panel track.
  return (
    <div
      ref={scrollRef}
      data-panel-scroll-container="true"
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
        style={{ gap: PANEL_GAP, flexGrow: 1, minWidth: '100%' }}
      >
        {/* === SIDEBAR SLOT === */}
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
          <div className="h-full" style={{ width: sidebarWidth }}>
            {sidebarSlot}
          </div>
        </motion.div>

        {/* === NAVIGATOR SLOT === */}
        <motion.div
          data-panel-role="navigator"
          initial={false}
          animate={{
            width: hasNavigator ? navigatorWidth : 0,
            marginRight: hasNavigator ? 0 : -PANEL_GAP,
            opacity: hasNavigator ? 1 : 0,
          }}
          transition={transition}
          className={cn(
            'h-full overflow-hidden relative shrink-0 z-[2]',
            'bg-background shadow-middle',
          )}
          style={{
            borderTopLeftRadius: RADIUS_INNER,
            borderBottomLeftRadius: !hasSidebar ? RADIUS_EDGE : RADIUS_INNER,
            borderTopRightRadius: RADIUS_INNER,
            borderBottomRightRadius: RADIUS_INNER,
          }}
        >
          <div className="h-full" style={{ width: navigatorWidth }}>
            {/* A zero-width desktop navigator is absent, not merely clipped.
                Keeping its controls mounted leaves hidden rows keyboard- and
                screen-reader-accessible (notably the retired Projects list). */}
            {hasNavigator ? navigatorSlot : null}
          </div>
        </motion.div>

        {/* === CONTENT PANELS WITH SASHES === */}
        {visiblePanels.length === 0 ? (
          <div className="flex-1 flex items-center justify-center" />
        ) : (
          visiblePanels.map((entry, index) => (
            <Fragment key={entry.id}>
              <PanelSlot
                entry={entry}
                isOnly={visiblePanels.length === 1}
                isFocusedPanel={isMultiPanel ? entry.id === focusedPanelId : true}
                isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
                isAtLeftEdge={index === 0 && isLeftEdge}
                isAtRightEdge={index === visiblePanels.length - 1 && !isRightSidebarVisible}
                panelViewportWidth={panelViewportWidth}
                isCompact={false}
              />
              {isMultiPanel && (
                <PanelResizeSash
                  panelId={entry.id}
                  panelViewportWidth={panelViewportWidth}
                />
              )}
            </Fragment>
          ))
        )}
      </motion.div>
    </div>
  )
}
