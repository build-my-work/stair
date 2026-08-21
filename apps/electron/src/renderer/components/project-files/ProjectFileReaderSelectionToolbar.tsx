import * as React from 'react'
import {
  ChevronRight,
  Highlighter,
  MessageSquarePlus,
  MessageSquareQuote,
  NotebookPen,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

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
  onCreateHighlight?: () => void
  onAddChat?: () => void
  onAddNewChat?: () => void
  onAddNote?: () => void
  onChooseNoteTarget?: () => void
  onDismiss: () => void
}

export type ProjectFileReferenceAction =
  | 'add-chat'
  | 'new-chat'
  | 'add-note'
  | 'choose-note-target'

export function ProjectFileReaderSelectionToolbar({
  anchorRect,
  collisionBoundary,
  disabled = false,
  onCreateHighlight,
  onAddChat,
  onAddNewChat,
  onAddNote,
  onChooseNoteTarget,
  onDismiss,
}: ReaderSelectionToolbarProps) {
  const { t } = useTranslation()
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
        className="flex w-auto max-w-[var(--radix-popover-content-available-width)] flex-wrap items-center justify-center gap-1 p-1"
        aria-label={t('reference.selectionActions')}
        onPointerDown={event => event.preventDefault()}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
      >
        {onCreateHighlight && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="text-red-500 hover:bg-red-500/10 hover:text-red-500"
            onClick={onCreateHighlight}
          >
            <Highlighter />
            {t('reference.highlight')}
          </Button>
        )}
        {onAddNote && (
          <div className="flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              className={onChooseNoteTarget ? 'rounded-r-none' : undefined}
              onClick={onAddNote}
            >
              <NotebookPen />
              {t('reference.addNote')}
            </Button>
            {onChooseNoteTarget && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                title={t('projectNoteTarget.chooseFile')}
                aria-label={t('projectNoteTarget.chooseFile')}
                className="size-8 rounded-l-none border-l border-border/45"
                onClick={onChooseNoteTarget}
              >
                <ChevronRight />
              </Button>
            )}
          </div>
        )}
        {onAddChat && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onAddChat}>
            <MessageSquareQuote />
            {t('reference.addChat')}
          </Button>
        )}
        {onAddNewChat && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onAddNewChat}>
            <MessageSquarePlus />
            {t('reference.newChat')}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label={t('common.close')}
          disabled={disabled}
          onClick={onDismiss}
        >
          <X />
        </Button>
      </PopoverContent>
    </Popover>
  )
}
