import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import {
  Highlighter,
  Loader2,
  MessageSquarePlus,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover'

import type { EpubSelectionViewportRect } from './project-file-epub'

interface EpubSelectionToolbarProps {
  anchorRect: EpubSelectionViewportRect
  collisionBoundary: HTMLElement | null
  addingReference: boolean
  onCreateHighlight: () => void
  onAddChat: () => void
  onDismiss: () => void
}

export function EpubSelectionToolbar({
  anchorRect,
  collisionBoundary,
  addingReference,
  onCreateHighlight,
  onAddChat,
  onDismiss,
}: EpubSelectionToolbarProps) {
  const virtualAnchor = React.useMemo(() => ({
    current: {
      getBoundingClientRect: () => DOMRect.fromRect(anchorRect),
    },
  }), [anchorRect])

  return (
    <Popover
      open
      onOpenChange={open => {
        if (!open) onDismiss()
      }}
    >
      <PopoverAnchor virtualRef={virtualAnchor} />
      <PopoverContent
        side="top"
        align="center"
        sideOffset={10}
        collisionBoundary={collisionBoundary}
        collisionPadding={12}
        arrowPadding={12}
        className="flex w-auto items-stretch gap-1 p-1.5"
        aria-label="EPUB selection actions"
        onPointerDown={event => event.preventDefault()}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
      >
        <Button
          type="button"
          variant="ghost"
          className="h-16 min-w-20 flex-col gap-1 rounded-xl px-3 text-[11px] text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onClick={onCreateHighlight}
        >
          <Highlighter className="size-5" />
          Red wavy
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-16 min-w-20 flex-col gap-1 rounded-xl px-3 text-[11px]"
          disabled={addingReference}
          title="Add this selection to a chat draft"
          onClick={onAddChat}
        >
          {addingReference
            ? <Loader2 className="size-5 animate-spin" />
            : <MessageSquarePlus className="size-5" />}
          Add Chat
        </Button>
        <PopoverPrimitive.Arrow
          width={18}
          height={9}
          className="fill-background"
        />
      </PopoverContent>
    </Popover>
  )
}
