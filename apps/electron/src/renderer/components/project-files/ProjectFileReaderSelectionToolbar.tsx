import * as React from 'react'
import { Highlighter, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover'

interface ReaderSelectionToolbarProps {
  anchorRect: { x: number; y: number; width: number; height: number }
  collisionBoundary: HTMLElement | null
  disabled?: boolean
  onCreateHighlight: () => void
  onDismiss: () => void
}

export function ProjectFileReaderSelectionToolbar({
  anchorRect,
  collisionBoundary,
  disabled = false,
  onCreateHighlight,
  onDismiss,
}: ReaderSelectionToolbarProps) {
  const virtualAnchor = React.useMemo(() => ({
    current: {
      getBoundingClientRect: () => DOMRect.fromRect(anchorRect),
    },
  }), [anchorRect])

  return (
    <Popover
      open
      onOpenChange={open => {
        if (!open && !disabled) onDismiss()
      }}
    >
      <PopoverAnchor virtualRef={virtualAnchor} />
      <PopoverContent
        side="top"
        align="center"
        sideOffset={10}
        collisionBoundary={collisionBoundary}
        collisionPadding={8}
        className="flex w-auto items-center gap-1 p-1"
        aria-label="Reader selection actions"
        onPointerDown={event => event.preventDefault()}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onClick={onCreateHighlight}
        >
          <Highlighter />
          Red wavy
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label="Dismiss selection actions"
          disabled={disabled}
          onClick={onDismiss}
        >
          <X />
        </Button>
      </PopoverContent>
    </Popover>
  )
}
