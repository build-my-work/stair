import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import {
  Highlighter,
  Loader2,
  MessageSquarePlus,
  MessageSquareQuote,
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
  addingReferenceTo: 'current' | 'new' | null
  onCreateHighlight: () => void
  onAddChat: () => void
  onAddNewChat: () => void
  onDismiss: () => void
}

export function EpubSelectionToolbar({
  anchorRect,
  collisionBoundary,
  addingReferenceTo,
  onCreateHighlight,
  onAddChat,
  onAddNewChat,
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
        collisionPadding={8}
        arrowPadding={8}
        className="flex w-auto items-stretch gap-0.5 p-1"
        aria-label="EPUB selection actions"
        onPointerDown={event => event.preventDefault()}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
      >
        <Button
          type="button"
          variant="ghost"
          className="h-12 min-w-16 flex-col gap-0.5 rounded-lg px-2 text-[10px] text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onClick={onCreateHighlight}
        >
          <Highlighter className="size-4" />
          Red wavy
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-12 min-w-16 flex-col gap-0.5 rounded-lg px-2 text-[10px]"
          disabled={addingReferenceTo !== null}
          title="Add this selection to a chat draft"
          onClick={onAddChat}
        >
          {addingReferenceTo === 'current'
            ? <Loader2 className="size-4 animate-spin" />
            : <MessageSquareQuote className="size-4" />}
          Add Chat
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-12 min-w-16 flex-col gap-0.5 rounded-lg px-2 text-[10px]"
          disabled={addingReferenceTo !== null}
          title="Start a new chat with this selection"
          onClick={onAddNewChat}
        >
          {addingReferenceTo === 'new'
            ? <Loader2 className="size-4 animate-spin" />
            : <MessageSquarePlus className="size-4" />}
          New Chat
        </Button>
        <PopoverPrimitive.Arrow
          width={14}
          height={7}
          className="fill-background"
        />
      </PopoverContent>
    </Popover>
  )
}
