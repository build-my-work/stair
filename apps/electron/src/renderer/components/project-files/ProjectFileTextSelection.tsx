import * as React from 'react'
import { Loader2, NotebookPen } from 'lucide-react'
import { toast } from 'sonner'
import {
  MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
  MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS,
  type ProjectFileSelectionReferenceV1,
  type SourceFingerprint,
} from '@craft-agent/core'
import type { ProjectFileMetadata } from '@craft-agent/shared/protocol'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface ProjectFileDomSelection {
  quote: string
  start: number
  end: number
  prefix: string
  suffix: string
  anchorRect: DOMRect
}

function resolveSelectionOffset(
  root: HTMLElement,
  container: Node,
  offset: number,
): number | null {
  if (!root.contains(container)) return null
  try {
    const prefixRange = document.createRange()
    prefixRange.selectNodeContents(root)
    prefixRange.setEnd(container, offset)
    return prefixRange.toString().length
  } catch {
    return null
  }
}

export function captureProjectFileDomSelection(
  root: HTMLElement,
  domSelection: Selection | null,
  pointer?: { x: number; y: number },
): ProjectFileDomSelection | null {
  if (!domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) {
    return null
  }
  const range = domSelection.getRangeAt(0)
  if (
    !root.contains(range.startContainer)
    || !root.contains(range.endContainer)
  ) {
    return null
  }

  const rawText = range.toString()
  const quote = rawText.trim()
  if (!quote) return null
  const rawStart = resolveSelectionOffset(
    root,
    range.startContainer,
    range.startOffset,
  )
  if (rawStart == null) return null

  const leadingWhitespace = rawText.length - rawText.trimStart().length
  const start = rawStart + leadingWhitespace
  const end = start + quote.length
  const fullRange = document.createRange()
  fullRange.selectNodeContents(root)
  const fullText = fullRange.toString()
  const prefix = fullText.slice(
    Math.max(0, start - MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS),
    start,
  )
  const suffix = fullText.slice(
    end,
    end + MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
  )

  const rects = Array.from(range.getClientRects())
    .filter(rect => rect.width > 0 && rect.height > 0)
  let anchorRect = range.getBoundingClientRect()
  if (rects.length > 0) {
    if (pointer) {
      anchorRect = rects.reduce((best, rect) => {
        const bestDistance = Math.abs((best.top + best.bottom) / 2 - pointer.y)
        const rectDistance = Math.abs((rect.top + rect.bottom) / 2 - pointer.y)
        return rectDistance < bestDistance ? rect : best
      })
    } else {
      anchorRect = rects[0]!
    }
  }

  return { quote, start, end, prefix, suffix, anchorRect }
}

export function buildProjectFileSelectionReference({
  projectId,
  relativePath,
  metadata,
  sourceFingerprint,
  selection,
}: {
  projectId: string
  relativePath: string
  metadata: ProjectFileMetadata
  sourceFingerprint: SourceFingerprint
  selection: ProjectFileDomSelection
}): ProjectFileSelectionReferenceV1 {
  return {
    version: 1,
    kind: 'project-file',
    projectId,
    relativePath,
    sourceFingerprint,
    fileName: metadata.name,
    quote: selection.quote,
    contextBefore: selection.prefix,
    contextAfter: selection.suffix,
    locator: {
      type: 'text-quote',
      exact: selection.quote,
      ...(selection.prefix ? { prefix: selection.prefix } : {}),
      ...(selection.suffix ? { suffix: selection.suffix } : {}),
      start: selection.start,
      end: selection.end,
    },
  }
}

export function ProjectFileSelectionPopover({
  selection,
  collisionBoundary,
  adding,
  onAddNote,
  onDismiss,
}: {
  selection: ProjectFileDomSelection
  collisionBoundary: HTMLElement | null
  adding: boolean
  onAddNote: () => void
  onDismiss: () => void
}) {
  const virtualAnchor = React.useMemo(() => ({
    current: {
      getBoundingClientRect: () => selection.anchorRect,
    },
  }), [selection.anchorRect])

  return (
    <Popover open onOpenChange={open => { if (!open) onDismiss() }}>
      <PopoverAnchor virtualRef={virtualAnchor} />
      <PopoverContent
        data-project-file-selection-menu
        side="top"
        align="center"
        sideOffset={10}
        collisionBoundary={collisionBoundary}
        collisionPadding={8}
        className="w-auto p-1"
        aria-label="Project File selection actions"
        onPointerDown={event => event.preventDefault()}
        onMouseUp={event => event.stopPropagation()}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
      >
        <Button
          type="button"
          variant="ghost"
          disabled={adding}
          onClick={onAddNote}
          className="h-9 gap-1.5 rounded-[8px] px-2.5 text-xs"
        >
          {adding
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <NotebookPen className="h-3.5 w-3.5" />}
          Add Note
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function ProjectFileTextSelectionSurface({
  projectId,
  relativePath,
  metadata,
  sourceFingerprint,
  onAddNote,
  className,
  children,
}: {
  projectId: string
  relativePath: string
  metadata: ProjectFileMetadata
  sourceFingerprint: SourceFingerprint
  onAddNote: (
    reference: ProjectFileSelectionReferenceV1,
  ) => boolean | Promise<boolean>
  className?: string
  children: React.ReactNode
}) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [selection, setSelection] =
    React.useState<ProjectFileDomSelection | null>(null)
  const [adding, setAdding] = React.useState(false)

  const dismiss = React.useCallback(() => {
    setSelection(null)
  }, [])

  React.useEffect(() => {
    if (!selection) return
    const closeOnScroll = () => dismiss()
    document.addEventListener('scroll', closeOnScroll, true)
    return () => document.removeEventListener('scroll', closeOnScroll, true)
  }, [dismiss, selection])

  const handleMouseUp = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (
      event.target instanceof Element
      && event.target.closest('[data-project-file-selection-menu]')
    ) {
      return
    }
    const root = rootRef.current
    if (!root) return
    requestAnimationFrame(() => {
      const next = captureProjectFileDomSelection(
        root,
        window.getSelection(),
        { x: event.clientX, y: event.clientY },
      )
      if (
        next
        && next.quote.length > MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS
      ) {
        toast.error('Add Note selections are limited to 4,000 characters.')
        setSelection(null)
        return
      }
      setSelection(next)
    })
  }, [])

  const addNote = React.useCallback(async () => {
    if (!selection || adding) return
    setAdding(true)
    try {
      const added = await onAddNote(
        buildProjectFileSelectionReference({
          projectId,
          relativePath,
          metadata,
          sourceFingerprint,
          selection,
        }),
      )
      if (added) {
        window.getSelection()?.removeAllRanges()
        dismiss()
      }
    } catch (error) {
      console.error('[ProjectFileTextSelection] Failed to add note:', error)
    } finally {
      setAdding(false)
    }
  }, [
    adding,
    dismiss,
    metadata,
    onAddNote,
    projectId,
    relativePath,
    selection,
    sourceFingerprint,
  ])

  return (
    <div
      ref={rootRef}
      onMouseUp={handleMouseUp}
      className={cn('relative', className)}
    >
      {children}
      {selection && (
        <ProjectFileSelectionPopover
          selection={selection}
          collisionBoundary={rootRef.current}
          adding={adding}
          onAddNote={() => void addNote()}
          onDismiss={dismiss}
        />
      )}
    </div>
  )
}
