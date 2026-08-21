import * as React from 'react'
import { toast } from 'sonner'

import type {
  ProjectFileReferenceV1,
  SourceFingerprint,
  TextQuoteLocatorV1,
} from '@craft-agent/core'

import {
  ProjectFileReaderSelectionToolbar,
  type ProjectFileReferenceAction,
} from './ProjectFileReaderSelectionToolbar'
import {
  buildTextProjectFileReference,
  resolveTextQuoteOffset,
} from './project-file-text-reference'
import {
  shouldDismissReaderSelection,
  type ReaderSelectionActionResult,
} from './selection-action-result'

function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    nodes.push(node as Text)
    node = walker.nextNode()
  }
  return nodes
}

function domPointAtOffset(root: HTMLElement, offset: number): { node: Text; offset: number } | null {
  let consumed = 0
  for (const node of textNodes(root)) {
    const next = consumed + node.data.length
    if (offset <= next) return { node, offset: offset - consumed }
    consumed = next
  }
  return null
}

function rangeOffset(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange()
  range.selectNodeContents(root)
  range.setEnd(node, offset)
  return range.toString().length
}

export function ProjectFileTextSelection({
  children,
  projectId,
  relativePath,
  sourceFingerprint,
  fileName,
  initialLocator,
  revealRevision = 0,
  contentSelector,
  contentRevision = 0,
  onReferenceAction,
}: {
  children: React.ReactNode
  projectId: string
  relativePath: string
  sourceFingerprint: SourceFingerprint
  fileName: string
  initialLocator?: TextQuoteLocatorV1
  revealRevision?: number
  contentSelector?: string
  contentRevision?: number
  onReferenceAction: (
    action: ProjectFileReferenceAction,
    reference: ProjectFileReferenceV1,
  ) => ReaderSelectionActionResult | Promise<ReaderSelectionActionResult>
}) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [selection, setSelection] = React.useState<{
    reference: ProjectFileReferenceV1
    anchorRect: DOMRect
  } | null>(null)
  const [busy, setBusy] = React.useState(false)

  const dismiss = React.useCallback(() => {
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }, [])

  React.useEffect(() => {
    if (!selection) return
    const root = rootRef.current
    root?.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      root?.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [dismiss, selection])

  const captureSelection = React.useCallback(() => {
    requestAnimationFrame(() => {
      const outerRoot = rootRef.current
      const root = contentSelector
        ? outerRoot?.querySelector<HTMLElement>(contentSelector) ?? null
        : outerRoot
      const domSelection = window.getSelection()
      if (!root || !domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) {
        setSelection(null)
        return
      }
      const range = domSelection.getRangeAt(0)
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
        setSelection(null)
        return
      }

      try {
        const fullRange = document.createRange()
        fullRange.selectNodeContents(root)
        const rects = Array.from(range.getClientRects())
          .filter(rect => rect.width > 0 && rect.height > 0)
        setSelection({
          reference: buildTextProjectFileReference({
            projectId,
            relativePath,
            sourceFingerprint,
            fileName,
            fullText: fullRange.toString(),
            selectionStart: rangeOffset(root, range.startContainer, range.startOffset),
            selectionEnd: rangeOffset(root, range.endContainer, range.endOffset),
          }),
          anchorRect: rects.at(-1) ?? range.getBoundingClientRect(),
        })
      } catch {
        setSelection(null)
      }
    })
  }, [contentSelector, fileName, projectId, relativePath, sourceFingerprint])

  React.useEffect(() => {
    const outerRoot = rootRef.current
    const root = contentSelector
      ? outerRoot?.querySelector<HTMLElement>(contentSelector) ?? null
      : outerRoot
    if (!root || !initialLocator) return
    const fullRange = document.createRange()
    fullRange.selectNodeContents(root)
    const start = resolveTextQuoteOffset(fullRange.toString(), initialLocator)
    if (start === null) return
    const startPoint = domPointAtOffset(root, start)
    const endPoint = domPointAtOffset(root, start + initialLocator.exact.length)
    if (!startPoint || !endPoint) return

    const range = document.createRange()
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
    const domSelection = window.getSelection()
    domSelection?.removeAllRanges()
    domSelection?.addRange(range)
    range.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }, [
    contentRevision,
    contentSelector,
    initialLocator,
    projectId,
    relativePath,
    revealRevision,
    sourceFingerprint,
  ])

  const runAction = React.useCallback(async (action: ProjectFileReferenceAction) => {
    if (!selection) return
    setBusy(true)
    try {
      const result = await onReferenceAction(action, selection.reference)
      if (shouldDismissReaderSelection(result)) dismiss()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [dismiss, onReferenceAction, selection])

  return (
    <div ref={rootRef} className="relative h-full" onMouseUp={captureSelection}>
      {children}
      {selection && (
        <ProjectFileReaderSelectionToolbar
          anchorRect={selection.anchorRect}
          collisionBoundary={rootRef.current}
          disabled={busy}
          onAddChat={() => void runAction('add-chat')}
          onAddNewChat={() => void runAction('new-chat')}
          onAddNote={() => void runAction('add-note')}
          onChooseNoteTarget={() => void runAction('choose-note-target')}
          onDismiss={dismiss}
        />
      )}
    </div>
  )
}
