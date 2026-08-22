import { useCallback, type CSSProperties, type ReactNode, type Ref } from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { GripVertical } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { focusWorkbenchPanelAtom } from '@/workbench/workbench-commands'
import { getWorkbenchPanelWidth } from '@/workbench/panel-sizing'
import type { WorkbenchPanel } from '@/workbench/workbench-state'
import { PANEL_MIN_WIDTH } from './panel-constants'

interface WorkbenchPanelFrameProps {
  panel: WorkbenchPanel
  position: number
  panelCount: number
  isOnly: boolean
  isFocused: boolean
  panelLayoutWidth: number
  fillRemainingSpace: boolean
  frameRef?: Ref<HTMLDivElement>
  style?: CSSProperties
  children: ReactNode
}

export function WorkbenchPanelFrame({
  panel,
  position,
  panelCount,
  isOnly,
  isFocused,
  panelLayoutWidth,
  fillRemainingSpace,
  frameRef,
  style,
  children,
}: WorkbenchPanelFrameProps) {
  const { t } = useTranslation()
  const focusPanel = useSetAtom(focusWorkbenchPanelAtom)
  const handleFocus = useCallback(() => {
    if (!isFocused) {
      focusPanel({ projectId: panel.projectId, panelId: panel.id })
    }
  }, [focusPanel, isFocused, panel.id, panel.projectId])

  return (
    <div
      ref={frameRef}
      role="region"
      tabIndex={0}
      aria-label={t('workbench.panelPosition', { position, count: panelCount })}
      data-panel-frame="true"
      data-panel-id={panel.id}
      data-focused={isFocused || undefined}
      onFocus={handleFocus}
      className="h-full min-w-0 relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      style={{
        ...(isOnly
          ? { flexGrow: 1, minWidth: 0 }
          : {
              flex: `${fillRemainingSpace ? 1 : 0} 0 auto`,
              width: getWorkbenchPanelWidth(panel.widthRatio, panelLayoutWidth),
              minWidth: PANEL_MIN_WIDTH,
            }),
        ...style,
      }}
    >
      {children}
    </div>
  )
}

interface SortableWorkbenchPanelFrameProps extends Omit<WorkbenchPanelFrameProps, 'children'> {
  canReorder: boolean
  children: (reorderHandle: ReactNode) => ReactNode
}

export function SortableWorkbenchPanelFrame({
  panel,
  canReorder,
  children,
  style,
  ...frameProps
}: SortableWorkbenchPanelFrameProps) {
  const { t } = useTranslation()
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: panel.id, disabled: !canReorder })
  const activateDrag = listeners?.onPointerDown
  const reorderHandle = canReorder ? (
    <PanelHeaderCenterButton
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      onPointerDown={event => {
        event.stopPropagation()
        if (event.isPrimary && event.button === 0) {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        activateDrag?.(event)
      }}
      icon={<GripVertical className="h-4 w-4" />}
      tooltip={t('workbench.movePanel')}
      className="cursor-grab touch-none active:cursor-grabbing"
    />
  ) : null

  return (
    <WorkbenchPanelFrame
      {...frameProps}
      panel={panel}
      frameRef={setNodeRef}
      style={{
        ...style,
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 3 : style?.zIndex,
      }}
    >
      {children(reorderHandle)}
    </WorkbenchPanelFrame>
  )
}
