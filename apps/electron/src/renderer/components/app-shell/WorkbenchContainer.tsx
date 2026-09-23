import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { motion } from 'motion/react'
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
  RADIUS_EDGE,
  RADIUS_INNER,
  getPanelBottomRadius,
} from './panel-constants'

const PANEL_SPRING = { type: 'spring' as const, stiffness: 600, damping: 49 }

function PanelContentSlot({
  panel,
  panelCount,
  isFocusedPanel,
  isSidebarAndNavigatorHidden,
  isAtLeftEdge,
  isAtRightEdge,
  isCompact = false,
  reorderHandle,
}: {
  panel: WorkbenchPanel
  panelCount: number
  isFocusedPanel: boolean
  isSidebarAndNavigatorHidden: boolean
  isAtLeftEdge: boolean
  isAtRightEdge: boolean
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
  shellWidth,
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
  const handledKeyboardFocusRevision = useRef(keyboardFocusRevision)
  const focusedPanel = panels.find(panel => panel.id === focusedPanelId)

  const isWorkbenchVisible = isSessionsNavigation(navigationState)
    && navigationState.viewMode !== 'board'
    && (!isMultiSelectActive || focusedPanel?.kind !== 'session')
  const hasSidebar = sidebarWidth > 0
  const hasNavigator = navigatorWidth > 0
  const isAtLeftEdge = !hasSidebar && !hasNavigator

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

  const transition = isResizing ? { duration: 0 } : PANEL_SPRING
  return (
    <div
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
      <motion.div
        className="flex h-full"
        initial={false}
        animate={{ paddingLeft: !isCompact && !hasSidebar ? PANEL_EDGE_INSET : 0 }}
        transition={transition}
        style={{ gap: isCompact ? 0 : PANEL_GAP, flexGrow: 1, minWidth: 0 }}
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
          style={{ display: isCompact ? 'none' : undefined, overflowX: 'clip', overflowY: 'visible' }}
        >
          <div className="h-full" style={{ width: sidebarWidth }}>{!isCompact && sidebarSlot}</div>
        </motion.div>

        <motion.div
          data-panel-role="navigator"
          initial={false}
          animate={{
            width: isCompact ? '100%' : hasNavigator ? navigatorWidth : 0,
            marginRight: isCompact || hasNavigator ? 0 : -PANEL_GAP,
            opacity: isCompact || hasNavigator ? 1 : 0,
          }}
          transition={transition}
          className={cn('h-full overflow-hidden relative shrink-0 z-[2]', 'bg-background shadow-middle')}
          style={{
            display: isCompact && (!showCompactNavigator || !hasNavigator) ? 'none' : undefined,
            borderTopLeftRadius: RADIUS_INNER,
            borderBottomLeftRadius: !hasSidebar ? RADIUS_EDGE : RADIUS_INNER,
            borderTopRightRadius: RADIUS_INNER,
            borderBottomRightRadius: RADIUS_INNER,
          }}
        >
          <div className="h-full" style={{ width: isCompact ? '100%' : navigatorWidth }}>
            {(!isCompact || showCompactNavigator) && navigatorSlot}
          </div>
        </motion.div>

        <div
          ref={scrollRef}
          data-panel-scroll-viewport="true"
          className="h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden panel-scroll"
          style={{
            display: showCompactNavigator && hasNavigator ? 'none' : undefined,
            overflowX: isCompact ? 'hidden' : undefined,
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
                isCompact={isCompact}
              />
            )}
          </div>
        </div>
      </motion.div>
    </div>
  )
}
