import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FlipOnChange, type FlipTarget } from '@craft-agent/ui/motion'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { cn } from '@/lib/utils'
import { useToastAnchor } from '@/components/ui/sonner'
import {
  activeProjectWorkbenchAtom,
  focusedWorkbenchPanelIdAtom,
  workbenchKeyboardFocusRevisionAtom,
  workbenchPanelLayoutWidthAtom,
  workbenchPanelRevealRevisionAtom,
  workbenchPanelsAtom,
  type WorkbenchPanel,
} from '@/workbench/workbench-state'
import { reorderAuxiliaryPanelAtom } from '@/workbench/workbench-commands'
import {
  isSessionsNavigation,
  useNavigationState,
} from '@/contexts/NavigationContext'
import { useIsMultiSelectActive } from '@/hooks/useSession'
import { isDetailNavState } from '@/lib/nav-helpers'
import { SessionPanelSlot } from './SessionPanelSlot'
import { ProjectFilePanelSlot } from './ProjectFilePanelSlot'
import { MainContentPanel } from './MainContentPanel'
import { PanelResizeSash } from './PanelResizeSash'
import {
  SortableWorkbenchPanelFrame,
  WorkbenchPanelFrame,
} from './WorkbenchPanelFrame'
import {
  PANEL_EDGE_INSET,
  PANEL_GAP,
  PANEL_STACK_VERTICAL_OVERFLOW,
  RADIUS_INNER,
  getPanelBottomRadius,
} from './panel-constants'

function PanelContentSlot({
  panel,
  panelCount,
  isFocusedPanel,
  isSidebarAndNavigatorHidden,
  isAtLeftEdge,
  isAtRightEdge,
  isJoinedToNavigator,
  isCompact = false,
  reorderHandle,
}: {
  panel: WorkbenchPanel
  panelCount: number
  isFocusedPanel: boolean
  isSidebarAndNavigatorHidden: boolean
  isAtLeftEdge: boolean
  isAtRightEdge: boolean
  isJoinedToNavigator: boolean
  isCompact?: boolean
  reorderHandle?: ReactNode
}) {
  if (panel.kind === 'session') {
    return (
      <SessionPanelSlot
        panel={panel}
        isOnly={panelCount === 1}
        isFocusedPanel={isFocusedPanel}
        isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
        isAtLeftEdge={isAtLeftEdge}
        isAtRightEdge={isAtRightEdge}
        isJoinedToNavigator={isJoinedToNavigator}
        isCompact={isCompact}
        reorderHandle={reorderHandle}
      />
    )
  }
  return (
    <ProjectFilePanelSlot
      panel={panel}
      isOnly={panelCount === 1}
      isFocusedPanel={isFocusedPanel}
      isAtLeftEdge={isAtLeftEdge}
      isAtRightEdge={isAtRightEdge}
      isJoinedToNavigator={isJoinedToNavigator}
      isCompact={isCompact}
      reorderHandle={reorderHandle}
    />
  )
}

interface WorkbenchContainerProps {
  shellWidth: number
  sidebarSlot: React.ReactNode
  sidebarWidth: number
  navigatorSlot: React.ReactNode
  navigatorWidth: number
  isSidebarAndNavigatorHidden: boolean
  isRightSidebarVisible?: boolean
  isCompact?: boolean
  isResizing?: boolean
  /** Pointer toggles animate; keyboard toggles, resizing and Compact remain instant. */
  animateLayout?: boolean
}

function ShellContentSlot({
  isSidebarAndNavigatorHidden,
  isAtLeftEdge,
  isAtRightEdge,
  isJoinedToNavigator,
  isCompact,
}: {
  isSidebarAndNavigatorHidden: boolean
  isAtLeftEdge: boolean
  isAtRightEdge: boolean
  isJoinedToNavigator: boolean
  isCompact: boolean
}) {
  const radii = {
    borderTopLeftRadius: isJoinedToNavigator ? 0 : RADIUS_INNER,
    borderBottomLeftRadius: isJoinedToNavigator ? 0 : getPanelBottomRadius(isCompact, isAtLeftEdge),
    borderTopRightRadius: RADIUS_INNER,
    borderBottomRightRadius: getPanelBottomRadius(isCompact, isAtRightEdge),
  }
  return (
    <div
      data-panel-role="shell-content"
      data-panel-surface="true"
      data-joined-to-navigator={isJoinedToNavigator || undefined}
      className="h-full min-w-0 flex-1 relative isolate @container/panel"
    >
      <div
        data-panel-material="true"
        aria-hidden="true"
        className="shell-card absolute inset-0 -z-10 pointer-events-none bg-paper shadow-elev-0"
        style={radii}
      />
      <div className="h-full overflow-hidden" style={radii}>
        <MainContentPanel isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden} />
      </div>
    </div>
  )
}

export function WorkbenchContainer({
  shellWidth,
  sidebarSlot,
  sidebarWidth,
  navigatorSlot,
  navigatorWidth,
  isSidebarAndNavigatorHidden,
  isRightSidebarVisible,
  isCompact = false,
  isResizing,
  animateLayout = true,
}: WorkbenchContainerProps) {
  const panels = useAtomValue(workbenchPanelsAtom)
  const activeLayout = useAtomValue(activeProjectWorkbenchAtom)
  const focusedPanelId = useAtomValue(focusedWorkbenchPanelIdAtom)
  const panelRevealRevision = useAtomValue(workbenchPanelRevealRevisionAtom)
  const keyboardFocusRevision = useAtomValue(workbenchKeyboardFocusRevisionAtom)
  const panelLayoutWidth = useAtomValue(workbenchPanelLayoutWidthAtom)
  const setPanelLayoutWidth = useSetAtom(workbenchPanelLayoutWidthAtom)
  const reorderPanel = useSetAtom(reorderAuxiliaryPanelAtom)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const navigationState = useNavigationState()
  const isMultiSelectActive = useIsMultiSelectActive()
  const scrollRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const layoutAnimations = useRef<Animation[]>([])
  const [isAnimatingLayout, setIsAnimatingLayout] = useState(false)
  const handledKeyboardFocusRevision = useRef(keyboardFocusRevision)
  const focusedPanel = panels.find(panel => panel.id === focusedPanelId)

  const isWorkbenchVisible = isSessionsNavigation(navigationState)
    && navigationState.viewMode !== 'board'
    && (!isMultiSelectActive || focusedPanel?.kind !== 'session')
  const hasSidebar = sidebarWidth > 0
  const hasNavigator = navigatorWidth > 0
  const isAtLeftEdge = !hasSidebar && !hasNavigator
  const isJoined = !isCompact && hasNavigator && (!isWorkbenchVisible || panels.length > 0)
  const flipEnabled = animateLayout && !isCompact && !isResizing && activeDragId === null

  useToastAnchor(
    isCompact ? null : hasSidebar ? sidebarWidth + PANEL_GAP : PANEL_EDGE_INSET,
    hasNavigator ? navigatorWidth : null,
  )

  const getFlipTargets = useCallback((): FlipTarget[] => {
    const elements = shellRef.current?.querySelectorAll<HTMLElement>('[data-panel-surface], [data-panel-material]')
    if (!elements) return []
    // Keep DnD's transform on the outer frame. Only visible inner surfaces participate in FLIP.
    return Array.from(elements)
      .filter(el => el.getClientRects().length > 0)
      .map((el): FlipTarget => ({ el, mode: el.hasAttribute('data-panel-material') ? 'scale' : 'translate' }))
  }, [])

  const cancelLayoutAnimations = useCallback(() => {
    for (const animation of layoutAnimations.current) animation.cancel()
    layoutAnimations.current = []
    setIsAnimatingLayout(false)
  }, [])

  const handleFlipPlayed = useCallback((animations: Animation[]) => {
    cancelLayoutAnimations()
    layoutAnimations.current = animations
    setIsAnimatingLayout(animations.length > 0)
    // Translated cards must not temporarily increase the content scroller's scrollable width.
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (layoutAnimations.current !== animations) return
      layoutAnimations.current = []
      setIsAnimatingLayout(false)
    })
  }, [cancelLayoutAnimations])

  useLayoutEffect(() => {
    if (!flipEnabled) cancelLayoutAnimations()
  }, [cancelLayoutAnimations, flipEnabled])

  useLayoutEffect(() => () => {
    for (const animation of layoutAnimations.current) animation.cancel()
    layoutAnimations.current = []
  }, [])

  useLayoutEffect(() => {
    if (shellWidth > 0) setPanelLayoutWidth(shellWidth)
  }, [setPanelLayoutWidth, shellWidth])

  useEffect(() => {
    if (!focusedPanelId) return
    const shouldMoveDomFocus = handledKeyboardFocusRevision.current !== keyboardFocusRevision
    handledKeyboardFocusRevision.current = keyboardFocusRevision
    const container = scrollRef.current
    if (!container) return
    const focusedPanelElement = Array.from(
      container.querySelectorAll<HTMLElement>(
        isCompact ? '[data-panel-id]' : '[data-panel-frame]',
      ),
    ).find(panel => panel.getAttribute('data-panel-id') === focusedPanelId)
    if (!focusedPanelElement) return
    if (shouldMoveDomFocus) focusedPanelElement.focus({ preventScroll: true })
    if (isCompact) {
      container.scrollLeft = 0
      return
    }
    const containerRect = container.getBoundingClientRect()
    const panelRect = focusedPanelElement.getBoundingClientRect()
    if (panelRect.left < containerRect.left) {
      container.scrollLeft -= containerRect.left - panelRect.left
    } else if (panelRect.right > containerRect.right) {
      container.scrollLeft += panelRect.right - containerRect.right
    }
  }, [focusedPanelId, isCompact, keyboardFocusRevision, panelRevealRevision])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null)
    const { active, over } = event
    if (!activeLayout || !over || active.id === over.id) return
    const draggedPanel = activeLayout.auxiliary.find(panel => panel.id === active.id)
    const toIndex = activeLayout.auxiliary.findIndex(panel => panel.id === over.id)
    if (!draggedPanel || toIndex < 0) return
    reorderPanel({
      projectId: draggedPanel.projectId,
      panelId: String(active.id),
      toIndex,
    })
  }, [activeLayout, reorderPanel])

  const showCompactNavigator = isCompact && (
    isWorkbenchVisible
      ? !focusedPanel || (focusedPanel.kind === 'session' && !isDetailNavState(navigationState))
      : !isDetailNavState(navigationState)
  )

  return (
    <div
      ref={shellRef}
      onPointerDownCapture={cancelLayoutAnimations}
      data-mobile-menu-root="true"
      className="flex-1 min-w-0 relative z-panel @container/shell"
      style={{
        overflow: 'hidden',
        paddingBlock: PANEL_STACK_VERTICAL_OVERFLOW,
        marginBlock: -PANEL_STACK_VERTICAL_OVERFLOW,
        marginBottom: -6,
        paddingBottom: 6,
      }}
    >
      <FlipOnChange
        value={`${hasSidebar ? 1 : 0}:${hasNavigator ? 1 : 0}:${isCompact ? 1 : 0}`}
        enabled={flipEnabled}
        getTargets={getFlipTargets}
        axis="x"
        onPlay={handleFlipPlayed}
      >
        <div
          className="flex h-full"
          style={{
            paddingLeft: !isCompact && !hasSidebar ? PANEL_EDGE_INSET : 0,
            gap: isCompact ? 0 : PANEL_GAP, flexGrow: 1, minWidth: 0,
          }}
        >
          <div
            data-panel-role="sidebar"
            className="h-full relative shrink-0"
            style={{
              width: hasSidebar ? sidebarWidth : 0,
              marginRight: hasSidebar ? 0 : -PANEL_GAP,
              opacity: hasSidebar ? 1 : 0,
              display: isCompact ? 'none' : undefined, overflowX: 'clip', overflowY: 'visible',
            }}
          >
            <div className="h-full" style={{ width: sidebarWidth }}>{!isCompact && sidebarSlot}</div>
          </div>

          <div
            data-panel-role="navigator"
            data-panel-surface="true"
            className={cn('shell-card h-full overflow-hidden relative shrink-0 z-[2] bg-paper', hasNavigator && 'shadow-elev-0')}
            style={{
              width: isCompact ? '100%' : hasNavigator ? navigatorWidth : 0,
              marginRight: isCompact || hasNavigator ? 0 : -PANEL_GAP,
              opacity: isCompact || hasNavigator ? 1 : 0,
              display: isCompact && (!showCompactNavigator || !hasNavigator) ? 'none' : undefined,
              borderTopLeftRadius: RADIUS_INNER,
              borderBottomLeftRadius: getPanelBottomRadius(isCompact, !hasSidebar),
              borderTopRightRadius: isJoined ? 0 : RADIUS_INNER,
              borderBottomRightRadius: isJoined || isCompact ? 0 : RADIUS_INNER,
            }}
          >
            <div className="h-full" style={{ width: isCompact ? '100%' : navigatorWidth }}>
              {(!isCompact || showCompactNavigator) && navigatorSlot}
            </div>
          </div>

          <div
            ref={scrollRef}
            data-panel-scroll-viewport="true"
            className="h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden panel-scroll"
            style={{
              display: showCompactNavigator && hasNavigator ? 'none' : undefined,
              overflowX: isCompact || isAnimatingLayout ? 'hidden' : undefined,
              // Join the list and first card without moving the shell panes into this scroller.
              marginLeft: isJoined ? -PANEL_GAP : undefined,
              // Reserve paint space inside the clipping viewport without changing panel height.
              height: isCompact ? undefined : `calc(100% + ${PANEL_STACK_VERTICAL_OVERFLOW * 2}px)`,
              marginBlock: isCompact ? 0 : -PANEL_STACK_VERTICAL_OVERFLOW,
              paddingBlock: isCompact ? 0 : PANEL_STACK_VERTICAL_OVERFLOW,
              paddingRight: isCompact ? 0 : 8,
              marginRight: isCompact ? 0 : -8,
            }}
          >
            <div
              data-workbench-panels="true"
              className="flex h-full"
              style={{ gap: isCompact ? 0 : PANEL_GAP, flexGrow: 1, minWidth: 0 }}
            >
              {isWorkbenchVisible && panels.length === 0 && (
                <div data-panel-role="empty-primary" className="flex-1" />
              )}
              {/* Panel identity follows the Workbench lifetime, including while hidden in Compact. */}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={event => setActiveDragId(String(event.active.id))}
                onDragEnd={handleDragEnd}
                onDragCancel={() => setActiveDragId(null)}
              >
                <SortableContext
                  items={activeLayout?.auxiliary.map(panel => panel.id) ?? []}
                  strategy={horizontalListSortingStrategy}
                >
                  {panels.map((panel, index) => {
                    const slotProps = {
                      panel,
                      panelCount: isCompact ? 1 : panels.length,
                      isFocusedPanel: isWorkbenchVisible && !(showCompactNavigator && hasNavigator)
                        && (isCompact ? panel.id === focusedPanelId : panels.length === 1 || panel.id === focusedPanelId),
                      isSidebarAndNavigatorHidden,
                      isAtLeftEdge: isCompact || (index === 0 && isAtLeftEdge),
                      isAtRightEdge: (isCompact || index === panels.length - 1) && !isRightSidebarVisible,
                      isJoinedToNavigator: index === 0 && isJoined,
                      isCompact,
                    }
                    const frameProps = {
                      panel,
                      position: isCompact ? 1 : index + 1,
                      panelCount: isCompact ? 1 : panels.length,
                      isOnly: isCompact || panels.length === 1,
                      isFocused: slotProps.isFocusedPanel,
                      panelLayoutWidth,
                      fillRemainingSpace: isCompact || index === panels.length - 1,
                      style: {
                        display: !isWorkbenchVisible || (isCompact && panel.id !== focusedPanelId) ? 'none' : undefined,
                      },
                    }
                    const isPrimary = panel.id === activeLayout?.primary?.id
                    return (
                      <Fragment key={panel.id}>
                        {isPrimary ? (
                          <WorkbenchPanelFrame {...frameProps}>
                            <PanelContentSlot {...slotProps} />
                          </WorkbenchPanelFrame>
                        ) : (
                          <SortableWorkbenchPanelFrame
                            {...frameProps}
                            canReorder={!isCompact && (activeLayout?.auxiliary.length ?? 0) > 1}
                          >
                            {reorderHandle => (
                              <PanelContentSlot
                                {...slotProps}
                                reorderHandle={reorderHandle}
                              />
                            )}
                          </SortableWorkbenchPanelFrame>
                        )}
                        {!isCompact && isWorkbenchVisible && panels.length > 1 && activeLayout && (
                          <PanelResizeSash
                            projectId={panel.projectId}
                            panel={panel}
                            panelLayoutWidth={panelLayoutWidth}
                            isDragActive={activeDragId !== null}
                          />
                        )}
                      </Fragment>
                    )
                  })}
                </SortableContext>
              </DndContext>
              {!isWorkbenchVisible && (
                <ShellContentSlot
                  isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
                  isAtLeftEdge={isCompact || isAtLeftEdge}
                  isAtRightEdge={!isRightSidebarVisible}
                  isJoinedToNavigator={isJoined}
                  isCompact={isCompact}
                />
              )}
            </div>
          </div>
        </div>
      </FlipOnChange>
    </div>
  )
}
