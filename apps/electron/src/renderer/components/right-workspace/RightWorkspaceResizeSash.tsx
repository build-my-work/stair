import * as React from 'react'

import { cn } from '@/lib/utils'

interface RightWorkspaceResizeSashProps {
  value: number
  min: number
  max: number
  edge?: 'left' | 'right'
  onChange: (value: number) => void
  resetValue?: number
  className?: string
}

export function RightWorkspaceResizeSash({
  value,
  min,
  max,
  edge = 'left',
  onChange,
  resetValue,
  className,
}: RightWorkspaceResizeSashProps) {
  const startRef = React.useRef<{ x: number; value: number } | null>(null)

  const onPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    startRef.current = { x: event.clientX, value }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [value])

  const onPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current
    if (!start) return
    const delta = event.clientX - start.x
    const next = start.value + (edge === 'left' ? -delta : delta)
    onChange(Math.min(max, Math.max(min, next)))
  }, [edge, max, min, onChange])

  const finish = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return
    startRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  React.useEffect(() => () => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      className={cn(
        'group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none',
        edge === 'left' ? '-left-1' : '-right-1',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => {
        if (resetValue !== undefined) onChange(Math.min(max, Math.max(min, resetValue)))
      }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/0 transition-colors group-hover:bg-border group-active:bg-foreground/25" />
    </div>
  )
}
