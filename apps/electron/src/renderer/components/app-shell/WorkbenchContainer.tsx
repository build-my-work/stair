import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { motion, useReducedMotion } from 'motion/react'
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
import { BrowserPanelSlot } from './BrowserPanelSlot'
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
  if (panel.kind === 'project-file') {
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
  return (
    <BrowserPanelSlot
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
  const reduceMotion = useReducedMotion()
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
    const frame = requestAnimationFrame(() => {
      const container = scrollRef.current
      if (!container) return
      const focusedPanelElement = Array.from(
        container.querySelectorAll<HTMLElement>(
          isCompact ? '[data-panel-id]' : '[data-panel-frame]',
        ),
      ).find(panel => panel.dataset.panelId === focusedPanelId)
      if (!focusedPanelElement) return
      if (shouldMoveDomFocus) focusedPanelElement.focus({ preventScroll: true })
      if (isCompact) return

      const containerRect = container.getBoundingClientRect()
      const panelRect = focusedPanelElement.getBoundingClientRect()
      let nextScrollLeft = container.scrollLeft
      if (panelRect.left < containerRect.left) {
        nextScrollLeft -= containerRect.left - panelRect.left
      } else if (panelRect.right > containerRect.right) {
        nextScrollLeft += panelRect.right - containerRect.right
      }
      container.scrollTo({ left: nextScrollLeft, behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(frame)
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

  if (isCompact) {
    const showNavigator = !isDetailNavState(navigationState)
      || (isWorkbenchVisible && !focusedPanel)
    const compactKey = showNavigator
      ? 'navigator'
      : focusedPanel ? `panel-${focusedPanel.id}` : 'shell'
    const isDetail = !showNavigator && Boolean(focusedPanel)
    return (
      <div
        ref={scrollRef}
        data-mobile-menu-root="true"
        className="flex-1 min-w-0 relative overflow-hidden panel-scroll @container/shell"
        style={{
          paddingBlock: PANEL_STACK_VERTICAL_OVERFLOW,
          marginBlock: -PANEL_STACK_VERTICAL_OVERFLOW,
          marginBottom: -6,
          paddingBottom: 6,
        }}
      >
        <motion.div
          key={compactKey}
          className="absolute inset-0"
          initial={reduceMotion
            ? { opacity: 0 }
            : { x: isDetail ? '100%' : '-20%', opacity: 0.92 }}
          animate={{ x: 0, opacity: 1 }}
          transition={reduceMotion
            ? { duration: 0.12 }
            : { type: 'spring', stiffness: 400, damping: 36, mass: 0.8 }}
        >
          {showNavigator && hasNavigator ? (
            <div
              data-panel-role="navigator"
              className="h-full w-full overflow-hidden relative bg-background shadow-middle"
              style={{ borderTopLeftRadius: RADIUS_INNER, borderTopRightRadius: RADIUS_INNER }}
            >
              {navigatorSlot}
            </div>
          ) : isWorkbenchVisible && focusedPanel ? (
            <PanelContentSlot
              panel={focusedPanel}
              panelCount={1}
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
        </motion.div>
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
        data-workbench-panels="true"
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

        {isWorkbenchVisible ? (
          panels.length === 0 ? (
            <div data-panel-role="empty-primary" className="flex-1" />
          ) : (
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
                    panelCount: panels.length,
                    isFocusedPanel: panels.length === 1 || panel.id === focusedPanelId,
                    isSidebarAndNavigatorHidden,
                    isAtLeftEdge: index === 0 && isAtLeftEdge,
                    isAtRightEdge: index === panels.length - 1 && !isRightSidebarVisible,
                  }
                  const frameProps = {
                    panel,
                    position: index + 1,
                    panelCount: panels.length,
                    isOnly: panels.length === 1,
                    isFocused: slotProps.isFocusedPanel,
                    panelLayoutWidth,
                    fillRemainingSpace: index === panels.length - 1,
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
                          canReorder={(activeLayout?.auxiliary.length ?? 0) > 1}
                        >
                          {reorderHandle => (
                            <PanelContentSlot
                              {...slotProps}
                              reorderHandle={reorderHandle}
                            />
                          )}
                        </SortableWorkbenchPanelFrame>
                      )}
                      {panels.length > 1 && activeLayout && (
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
          )
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
