import * as React from 'react'
import { useStore } from 'jotai'
import { Document, Page, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  Download,
  FileQuestion,
  FileText,
  Highlighter,
  ListTree,
  Loader2,
  MessageSquareQuote,
  Trash2,
  X,
} from 'lucide-react'
import {
  MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS,
  type PdfHighlightV1,
  type PdfProgressV1,
  type PdfProjectFileReferenceV1,
  type ProjectFileSelectionReferenceV1,
  type SourceFingerprint,
} from '@craft-agent/core'
import type { ProjectFileMetadata } from '@craft-agent/shared/protocol'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

import { useTheme } from '@/context/ThemeContext'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ChatTargetMenu } from '@/components/app-shell/ChatTargetMenu'
import { projectFileOpenIntentsAtom } from '@/atoms/panel-stack'
import { EpubSelectionToolbar } from './EpubSelectionToolbar'
import {
  captureProjectFileDomSelection,
  type ProjectFileDomSelection,
} from './ProjectFileTextSelection'
import {
  buildPdfHighlightsMarkdown,
  buildPdfProjectFileReference,
  capturePdfSelectionRects,
  comparePdfHighlights,
  createOptimisticPdfHighlight,
  createPdfSelectionSnapshot,
  createPdfStateMutationCoordinator,
  deletePdfHighlightOptimistically,
  getPdfHighlightsSuggestedFilename,
  persistOptimisticPdfHighlight,
  type PdfSelectionSnapshot,
} from './project-file-pdf-state'

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

type PdfSidebarTab = 'contents' | 'highlights' | 'references'

interface PdfOutlineNode {
  id: string
  title: string
  pageNumber?: number
  children: PdfOutlineNode[]
}

interface PendingPdfSelection {
  dom: ProjectFileDomSelection
  snapshot: PdfSelectionSnapshot
}

interface PendingReveal {
  key: string
  pageNumber: number
  pageOffsetRatio: number
  kind: 'intent' | 'progress'
}

interface PdfOutlineItem {
  title: string
  dest: string | unknown[] | null
  items?: PdfOutlineItem[]
}

const PDF_INLINE_NAV_MIN_WIDTH_PX = 760
const filterPdfAnnotations: NonNullable<
  React.ComponentProps<typeof Page>['filterAnnotations']
> = ({ annotations }) =>
  annotations.filter(annotation => annotation.subtype !== 'Highlight')

function closestPageNumber(node: Node): number | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement
  const page = element?.closest<HTMLElement>('[data-pdf-page-number]')
  const value = Number(page?.dataset.pdfPageNumber)
  return Number.isSafeInteger(value) && value >= 1 ? value : null
}

async function resolvePdfDestinationPage(
  pdf: PDFDocumentProxy,
  destination: PdfOutlineItem['dest'],
): Promise<number | undefined> {
  if (!destination) return undefined
  try {
    const explicit = typeof destination === 'string'
      ? await pdf.getDestination(destination)
      : destination
    const target = explicit?.[0]
    if (typeof target === 'number' && Number.isSafeInteger(target) && target >= 0) {
      return target + 1
    }
    if (target && typeof target === 'object') {
      return await pdf.getPageIndex(
        target as Parameters<PDFDocumentProxy['getPageIndex']>[0],
      ) + 1
    }
  } catch {
    // Keep the outline label even when a malformed destination cannot resolve.
  }
  return undefined
}

async function mapPdfOutline(
  pdf: PDFDocumentProxy,
  items: PdfOutlineItem[],
  parentPath: number[] = [],
): Promise<PdfOutlineNode[]> {
  return Promise.all(items.map(async (item, index) => {
    const path = [...parentPath, index]
    const [pageNumber, children] = await Promise.all([
      resolvePdfDestinationPage(pdf, item.dest),
      mapPdfOutline(pdf, item.items ?? [], path),
    ])
    return {
      id: `outline:${path.join('.')}`,
      title: item.title?.trim() || 'Untitled section',
      ...(pageNumber ? { pageNumber } : {}),
      children,
    }
  }))
}

function samePdfSelection(
  highlight: PdfHighlightV1,
  selection: PdfSelectionSnapshot,
): boolean {
  return highlight.quote === selection.quote
    && JSON.stringify(highlight.rects) === JSON.stringify(selection.rects)
}

function pageDisplayLabel(
  pageNumber: number,
  pageLabels: string[] | null,
): string {
  return pageLabels?.[pageNumber - 1]?.trim() || String(pageNumber)
}

export function ProjectFilePdfReader({
  panelId,
  projectId,
  relativePath,
  metadata,
  bytes,
  sourceFingerprint,
  initialLocator,
  chatTargetSessionId,
  chatTargets,
  onReady,
  onChatTargetChange,
  onAddChatReference,
  onAddNewChatReference,
  onAddNote,
  onExportMarkdown,
}: {
  panelId: string
  projectId: string
  relativePath: string
  metadata: ProjectFileMetadata
  bytes: Uint8Array
  sourceFingerprint: SourceFingerprint
  initialLocator?: PdfProjectFileReferenceV1['locator']
  chatTargetSessionId: string | null
  chatTargets: Array<{ id: string; title: string }>
  onReady: () => void
  onChatTargetChange: (sessionId: string) => void
  onAddChatReference: (
    reference: PdfProjectFileReferenceV1,
  ) => boolean | Promise<boolean>
  onAddNewChatReference: (
    reference: PdfProjectFileReferenceV1,
  ) => boolean | Promise<boolean>
  onAddNote: (
    reference: ProjectFileSelectionReferenceV1,
    mode?: 'current' | 'choose-target',
  ) => boolean | Promise<boolean>
  onExportMarkdown: (exported: {
    suggestedFilename: string
    content: string
  }) => unknown | Promise<unknown>
}) {
  const store = useStore()
  const { isDark } = useTheme()
  const shellRef = React.useRef<HTMLDivElement>(null)
  const viewportRef = React.useRef<HTMLElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const stateCoordinatorRef = React.useRef<ReturnType<
    typeof createPdfStateMutationCoordinator
  > | null>(null)
  const loadedPagesRef = React.useRef(new Set<number>())
  const pendingRevealRef = React.useRef<PendingReveal | null>(null)
  const handledIntentKeyRef = React.useRef<string | null>(null)
  const restoredProgressKeyRef = React.useRef<string | null>(null)
  const restoringPositionRef = React.useRef(true)
  const onReadyRef = React.useRef(onReady)
  const scrollFrameRef = React.useRef<number | undefined>(undefined)
  const viewerKey = `${projectId}\0${relativePath}\0${sourceFingerprint}`
  const initialLocatorKey = initialLocator
    ? JSON.stringify(initialLocator)
    : undefined

  onReadyRef.current = onReady

  const [numPages, setNumPages] = React.useState(0)
  const [width, setWidth] = React.useState(760)
  const [error, setError] = React.useState<string>()
  const [outline, setOutline] = React.useState<PdfOutlineNode[]>([])
  const [pageLabels, setPageLabels] = React.useState<string[] | null>(null)
  const [currentPage, setCurrentPage] = React.useState(1)
  const [navOpen, setNavOpen] = React.useState(true)
  const [compact, setCompact] = React.useState(false)
  const [sidebarTab, setSidebarTab] = React.useState<PdfSidebarTab>('contents')
  const [highlights, setHighlights] = React.useState<PdfHighlightV1[]>([])
  const [savedProgress, setSavedProgress] = React.useState<PdfProgressV1 | null>()
  const [selection, setSelection] = React.useState<PendingPdfSelection | null>(null)
  const [readerNotice, setReaderNotice] = React.useState('')
  const [addingReferenceTo, setAddingReferenceTo] =
    React.useState<'current' | 'new' | null>(null)
  const [addingNote, setAddingNote] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)

  // pdf.js may transfer/detach its input buffer, so keep the Project File
  // response immutable and hand the renderer its own copy.
  const file = React.useMemo(() => ({ data: bytes.slice() }), [bytes])
  const wavyHighlights = React.useMemo(
    () => highlights.filter(highlight => highlight.style.type === 'wavy'),
    [highlights],
  )
  const referenceUnderlines = React.useMemo(
    () => highlights.filter(highlight => highlight.style.type === 'solid'),
    [highlights],
  )
  const marksByPage = React.useMemo(() => {
    const result = new Map<number, Array<{
      highlight: PdfHighlightV1
      rectIndex: number
    }>>()
    for (const highlight of highlights) {
      highlight.rects.forEach((rect, rectIndex) => {
        const pageMarks = result.get(rect.pageNumber) ?? []
        pageMarks.push({ highlight, rectIndex })
        result.set(rect.pageNumber, pageMarks)
      })
    }
    return result
  }, [highlights])

  const dismissSelection = React.useCallback(() => {
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }, [])

  const revealPage = React.useCallback((
    pageNumber: number,
    pageOffsetRatio: number,
    behavior: ScrollBehavior,
  ): boolean => {
    const root = scrollRef.current
    const page = root?.querySelector<HTMLElement>(
      `[data-pdf-page-number="${pageNumber}"]`,
    )
    const anchor = page?.querySelector<HTMLElement>('[data-pdf-reveal-anchor]')
    if (!root || !anchor || !loadedPagesRef.current.has(pageNumber)) return false
    anchor.style.top = `${Math.min(1, Math.max(0, pageOffsetRatio)) * 100}%`
    anchor.scrollIntoView({ block: 'start', behavior })
    setCurrentPage(pageNumber)
    return true
  }, [])

  const tryPendingReveal = React.useCallback(() => {
    const pending = pendingRevealRef.current
    if (!pending) return false
    if (!revealPage(pending.pageNumber, pending.pageOffsetRatio, 'auto')) {
      return false
    }
    pendingRevealRef.current = null
    restoringPositionRef.current = false
    if (pending.kind === 'intent') {
      handledIntentKeyRef.current = pending.key
      restoredProgressKeyRef.current = viewerKey
      onReadyRef.current()
    } else {
      restoredProgressKeyRef.current = pending.key
    }
    return true
  }, [revealPage, viewerKey])

  React.useEffect(() => {
    // Reveal before React reconciles the full PDF page tree. The locator prop
    // path below remains the fallback for readers that are not mounted yet.
    const revealIncomingIntent = () => {
      const intent = store.get(projectFileOpenIntentsAtom).get(panelId)
      if (
        !intent
        || !numPages
        || intent.expectedFingerprint !== sourceFingerprint
        || intent.locator.type !== 'pdf-text-quote'
      ) {
        return
      }
      const key = JSON.stringify(intent.locator)
      pendingRevealRef.current = {
        key,
        pageNumber: Math.min(numPages, intent.locator.anchor.pageNumber),
        pageOffsetRatio: intent.locator.anchor.y,
        kind: 'intent',
      }
      restoringPositionRef.current = true
      void tryPendingReveal()
    }
    return store.sub(projectFileOpenIntentsAtom, revealIncomingIntent)
  }, [numPages, panelId, sourceFingerprint, store, tryPendingReveal])

  React.useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    let wasCompact: boolean | null = null
    const update = () => {
      const nextCompact = shell.getBoundingClientRect().width
        < PDF_INLINE_NAV_MIN_WIDTH_PX
      if (nextCompact && wasCompact !== true) setNavOpen(false)
      wasCompact = nextCompact
      setCompact(nextCompact)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width
      if (!nextWidth) return
      setWidth(Math.max(280, Math.min(900, nextWidth - 32)))
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    let disposed = false
    let coordinator: ReturnType<typeof createPdfStateMutationCoordinator> | null = null
    const stateRequest = { projectId, relativePath, sourceFingerprint }
    setHighlights([])
    setSavedProgress(undefined)
    const load = async () => {
      let loadedState = null
      try {
        loadedState = await window.electronAPI.getPdfDocumentState(stateRequest)
      } catch (stateError) {
        console.error('[ProjectFilePdfReader] Failed to load PDF state:', stateError)
        if (!disposed) {
          setReaderNotice('Reading progress and highlights could not be loaded.')
        }
      }
      if (disposed) return
      const matchingState = loadedState
        && loadedState.projectId === projectId
        && loadedState.relativePath === relativePath
        && loadedState.sourceFingerprint === sourceFingerprint
        ? loadedState
        : null
      setHighlights(matchingState?.highlights ?? [])
      setSavedProgress(matchingState?.progress ?? null)
      coordinator = createPdfStateMutationCoordinator({
        initialRevision: matchingState?.revision ?? 0,
        applyMutation: mutation => window.electronAPI.applyPdfStateMutation({
          ...stateRequest,
          mutation,
        }),
        getState: () => window.electronAPI.getPdfDocumentState(stateRequest),
        onStateRefresh: state => {
          if (
            disposed
            || state.projectId !== projectId
            || state.relativePath !== relativePath
            || state.sourceFingerprint !== sourceFingerprint
          ) {
            return
          }
          setHighlights(state.highlights)
        },
        onBackgroundError: (backgroundError, operation) => {
          if (disposed) return
          console.error(
            `[ProjectFilePdfReader] PDF state ${operation} failed:`,
            backgroundError,
          )
          setReaderNotice(operation === 'set-progress'
            ? 'Reading progress could not be saved.'
            : 'Highlights changed elsewhere and could not be refreshed.')
        },
      })
      stateCoordinatorRef.current = coordinator
    }
    void load()
    return () => {
      disposed = true
      if (stateCoordinatorRef.current === coordinator) {
        stateCoordinatorRef.current = null
      }
      void coordinator?.dispose().catch(disposeError => {
        console.error(
          '[ProjectFilePdfReader] Failed to flush PDF progress:',
          disposeError,
        )
      })
    }
  }, [projectId, relativePath, sourceFingerprint])

  React.useLayoutEffect(() => {
    if (!initialLocator || !initialLocatorKey) {
      handledIntentKeyRef.current = null
      return
    }
    if (!numPages) return
    if (handledIntentKeyRef.current === initialLocatorKey) {
      onReadyRef.current()
      return
    }
    const pageNumber = Math.min(numPages, initialLocator.anchor.pageNumber)
    pendingRevealRef.current = {
      key: initialLocatorKey,
      pageNumber,
      pageOffsetRatio: initialLocator.anchor.y,
      kind: 'intent',
    }
    restoringPositionRef.current = true
    void tryPendingReveal()
  }, [initialLocator, initialLocatorKey, numPages, tryPendingReveal])

  React.useEffect(() => {
    if (!numPages || savedProgress === undefined || initialLocator) return
    if (restoredProgressKeyRef.current === viewerKey) return
    if (!savedProgress) {
      restoredProgressKeyRef.current = viewerKey
      restoringPositionRef.current = false
      return
    }
    pendingRevealRef.current = {
      key: viewerKey,
      pageNumber: Math.min(numPages, savedProgress.pageNumber),
      pageOffsetRatio: savedProgress.pageOffsetRatio,
      kind: 'progress',
    }
    requestAnimationFrame(() => void tryPendingReveal())
  }, [initialLocator, numPages, savedProgress, tryPendingReveal, viewerKey])

  React.useEffect(() => () => {
    if (scrollFrameRef.current !== undefined) {
      cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [])

  const handleDocumentLoad = React.useCallback((pdf: PDFDocumentProxy) => {
    setNumPages(pdf.numPages)
    setError(undefined)
    loadedPagesRef.current.clear()
    const loadNavigation = async () => {
      try {
        const [loadedOutline, loadedPageLabels] = await Promise.all([
          pdf.getOutline(),
          pdf.getPageLabels(),
        ])
        setOutline(await mapPdfOutline(pdf, loadedOutline as PdfOutlineItem[]))
        setPageLabels(loadedPageLabels)
      } catch (navigationError) {
        console.error(
          '[ProjectFilePdfReader] Failed to load PDF navigation:',
          navigationError,
        )
        setOutline([])
        setPageLabels(null)
      }
    }
    void loadNavigation()
  }, [])

  const handlePageLoaded = React.useCallback((pageNumber: number) => {
    loadedPagesRef.current.add(pageNumber)
    if (pendingRevealRef.current?.pageNumber === pageNumber) {
      requestAnimationFrame(() => void tryPendingReveal())
    }
  }, [tryPendingReveal])

  const handleScroll = React.useCallback(() => {
    dismissSelection()
    if (restoringPositionRef.current || scrollFrameRef.current !== undefined) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined
      const root = scrollRef.current
      if (!root || numPages === 0) return
      const rootTop = root.getBoundingClientRect().top + 32
      const pages = Array.from(
        root.querySelectorAll<HTMLElement>('[data-pdf-page-number]'),
      )
      let current: { pageNumber: number; offset: number; distance: number } | null = null
      for (const page of pages) {
        const pageNumber = Number(page.dataset.pdfPageNumber)
        const rect = page.getBoundingClientRect()
        if (!Number.isSafeInteger(pageNumber) || rect.height <= 0) continue
        const offset = Math.min(1, Math.max(0, (rootTop - rect.top) / rect.height))
        let distance = 0
        if (rootTop < rect.top) {
          distance = rect.top - rootTop
        } else if (rootTop > rect.bottom) {
          distance = rootTop - rect.bottom
        }
        if (!current || distance < current.distance) {
          current = { pageNumber, offset, distance }
        }
      }
      if (!current) return
      setCurrentPage(current.pageNumber)
      stateCoordinatorRef.current?.scheduleProgress({
        pageNumber: current.pageNumber,
        pageOffsetRatio: Math.round(current.offset * 1_000) / 1_000,
        percentage: Math.min(
          1,
          Math.max(0, (current.pageNumber - 1 + current.offset) / numPages),
        ),
      })
    })
  }, [dismissSelection, numPages])

  const handleMouseUp = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const root = scrollRef.current
    if (!root) return
    requestAnimationFrame(() => {
      const domSelection = window.getSelection()
      const captured = captureProjectFileDomSelection(
        root,
        domSelection,
        { x: event.clientX, y: event.clientY },
      )
      if (!captured || !domSelection || domSelection.rangeCount === 0) {
        setSelection(null)
        return
      }
      if (captured.quote.length > MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS) {
        setReaderNotice('Selections are limited to 4,000 characters.')
        setSelection(null)
        return
      }
      try {
        const range = domSelection.getRangeAt(0)
        const firstPage = closestPageNumber(range.startContainer)
        const lastPage = closestPageNumber(range.endContainer)
        if (!firstPage || !lastPage) {
          setSelection(null)
          return
        }
        const snapshot = createPdfSelectionSnapshot({
          quote: captured.quote,
          contextBefore: captured.prefix,
          contextAfter: captured.suffix,
          rects: capturePdfSelectionRects(root, range),
        })
        if (
          snapshot.startPage !== Math.min(firstPage, lastPage)
          || snapshot.endPage !== Math.max(firstPage, lastPage)
        ) {
          throw new Error('This selection cannot be located reliably.')
        }
        setSelection({ dom: captured, snapshot })
        setReaderNotice('')
      } catch (selectionError) {
        setSelection(null)
        setReaderNotice(
          selectionError instanceof Error
            ? selectionError.message
            : String(selectionError),
        )
      }
    })
  }, [])

  const buildReference = React.useCallback((snapshot: PdfSelectionSnapshot) => (
    buildPdfProjectFileReference({
      identity: { projectId, relativePath },
      sourceFingerprint,
      fileName: metadata.name,
      selection: snapshot,
    })
  ), [metadata.name, projectId, relativePath, sourceFingerprint])

  const createRedWavyHighlight = React.useCallback(async () => {
    const snapshot = selection?.snapshot
    const coordinator = stateCoordinatorRef.current
    if (!snapshot || !coordinator) {
      setReaderNotice('Highlights are not ready yet.')
      return
    }
    if (wavyHighlights.some(highlight => samePdfSelection(highlight, snapshot))) {
      setSidebarTab('highlights')
      setReaderNotice('This selection is already highlighted.')
      dismissSelection()
      return
    }
    const optimistic = createOptimisticPdfHighlight(
      snapshot,
      globalThis.crypto.randomUUID(),
    )
    dismissSelection()
    setSidebarTab('highlights')
    try {
      const response = await persistOptimisticPdfHighlight({
        highlight: optimistic,
        mutate: mutation => coordinator.mutate(mutation),
        updateHighlights: setHighlights,
      })
      if (!response.applied && !response.canonicalHighlight) {
        await coordinator.refresh()
      }
      setReaderNotice('')
    } catch (highlightError) {
      console.error(
        '[ProjectFilePdfReader] Failed to create PDF highlight:',
        highlightError,
      )
      setReaderNotice('The highlight could not be saved.')
    }
  }, [dismissSelection, selection, wavyHighlights])

  const addSelectionToChat = React.useCallback(async (
    target: 'current' | 'new',
  ) => {
    const snapshot = selection?.snapshot
    if (!snapshot || addingReferenceTo) return
    let attached = false
    setAddingReferenceTo(target)
    try {
      const addReference = target === 'new'
        ? onAddNewChatReference
        : onAddChatReference
      attached = await addReference(buildReference(snapshot))
      dismissSelection()
      if (!attached) return
      setSidebarTab('references')
      if (referenceUnderlines.some(mark => samePdfSelection(mark, snapshot))) {
        setReaderNotice('')
        return
      }
      const coordinator = stateCoordinatorRef.current
      if (!coordinator) throw new Error('PDF state coordinator is unavailable')
      const optimistic = createOptimisticPdfHighlight(
        snapshot,
        globalThis.crypto.randomUUID(),
        { style: { type: 'solid', color: 'blue' } },
      )
      const response = await persistOptimisticPdfHighlight({
        highlight: optimistic,
        mutate: mutation => coordinator.mutate(mutation),
        updateHighlights: setHighlights,
      })
      if (!response.applied && !response.canonicalHighlight) {
        await coordinator.refresh()
      }
      setReaderNotice('')
    } catch (referenceError) {
      console.error(
        attached
          ? '[ProjectFilePdfReader] Failed to save PDF reference underline:'
          : '[ProjectFilePdfReader] Failed to add PDF reference:',
        referenceError,
      )
      setReaderNotice(attached
        ? 'The selection was added to chat, but its underline could not be saved.'
        : 'The selection could not be added to chat.')
    } finally {
      setAddingReferenceTo(null)
    }
  }, [
    addingReferenceTo,
    buildReference,
    dismissSelection,
    onAddChatReference,
    onAddNewChatReference,
    referenceUnderlines,
    selection,
  ])

  const addSelectionToNote = React.useCallback(async (
    mode: 'current' | 'choose-target' = 'current',
  ) => {
    const snapshot = selection?.snapshot
    if (!snapshot || addingNote || addingReferenceTo) return
    setAddingNote(true)
    try {
      const added = await onAddNote(buildReference(snapshot), mode)
      if (added) dismissSelection()
    } catch (noteError) {
      console.error(
        '[ProjectFilePdfReader] Failed to add PDF selection to notes:',
        noteError,
      )
      setReaderNotice('The selection could not be added to the note file.')
    } finally {
      setAddingNote(false)
    }
  }, [
    addingNote,
    addingReferenceTo,
    buildReference,
    dismissSelection,
    onAddNote,
    selection,
  ])

  const displayPage = React.useCallback((pageNumber: number) => {
    dismissSelection()
    restoringPositionRef.current = true
    if (revealPage(pageNumber, 0, 'smooth')) {
      requestAnimationFrame(() => {
        restoringPositionRef.current = false
      })
    } else {
      restoringPositionRef.current = false
    }
    if (compact) setNavOpen(false)
  }, [compact, dismissSelection, revealPage])

  const displayHighlight = React.useCallback((highlight: PdfHighlightV1) => {
    const rect = highlight.rects[0]
    if (!rect) return
    dismissSelection()
    restoringPositionRef.current = true
    if (revealPage(rect.pageNumber, rect.y, 'smooth')) {
      requestAnimationFrame(() => {
        restoringPositionRef.current = false
      })
    } else {
      restoringPositionRef.current = false
      setReaderNotice('This highlight could not be located in the PDF.')
    }
    if (compact) setNavOpen(false)
  }, [compact, dismissSelection, revealPage])

  const deleteHighlight = React.useCallback(async (highlight: PdfHighlightV1) => {
    const coordinator = stateCoordinatorRef.current
    if (!coordinator) return
    try {
      await deletePdfHighlightOptimistically({
        highlight,
        mutate: mutation => coordinator.mutate(mutation),
        updateHighlights: setHighlights,
      })
      setReaderNotice('')
    } catch (deleteError) {
      console.error(
        '[ProjectFilePdfReader] Failed to delete PDF highlight:',
        deleteError,
      )
      setReaderNotice('The highlight could not be deleted.')
    }
  }, [])

  const exportHighlights = React.useCallback(async () => {
    if (wavyHighlights.length === 0 || exporting) return
    setExporting(true)
    try {
      await onExportMarkdown({
        suggestedFilename: getPdfHighlightsSuggestedFilename(metadata.name),
        content: buildPdfHighlightsMarkdown({
          fileName: metadata.name,
          pageLabels,
          highlights: wavyHighlights,
        }),
      })
      setReaderNotice('')
    } catch (exportError) {
      console.error(
        '[ProjectFilePdfReader] Failed to export PDF highlights:',
        exportError,
      )
      setReaderNotice('Highlights could not be exported.')
    } finally {
      setExporting(false)
    }
  }, [exporting, metadata.name, onExportMarkdown, pageLabels, wavyHighlights])

  const pageElements = React.useMemo(
    () => Array.from({ length: numPages }, (_, index) => {
      const pageNumber = index + 1
      return (
        <div
          key={pageNumber}
          data-pdf-page-number={pageNumber}
          className="relative overflow-hidden rounded-[4px] bg-white shadow-minimal"
        >
          <span
            data-pdf-reveal-anchor
            className="pointer-events-none absolute left-0 size-0 scroll-mt-8"
            aria-hidden="true"
          />
          <Page
            pageNumber={pageNumber}
            width={width}
            className="!m-0"
            renderTextLayer
            renderAnnotationLayer
            filterAnnotations={filterPdfAnnotations}
            onLoadSuccess={() => handlePageLoaded(pageNumber)}
          />
          <PdfPageMarks
            pageNumber={pageNumber}
            marks={marksByPage.get(pageNumber) ?? []}
          />
        </div>
      )
    }),
    [handlePageLoaded, marksByPage, numPages, width],
  )
  const documentElement = React.useMemo(() => (
    <Document
      file={file}
      onLoadSuccess={handleDocumentLoad}
      onLoadError={loadError => setError(loadError.message)}
      loading={(
        <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Rendering PDF…
        </div>
      )}
      className="flex flex-col items-center gap-4"
    >
      {pageElements}
    </Document>
  ), [file, handleDocumentLoad, pageElements])

  const navId = React.useId()
  const showingReferences = sidebarTab === 'references'
  const sidebarMarks = React.useMemo(() => {
    const marks = showingReferences ? referenceUnderlines : wavyHighlights
    return [...marks].sort(comparePdfHighlights)
  }, [referenceUnderlines, showingReferences, wavyHighlights])
  const sidebarMarkNoun = showingReferences ? 'reference' : 'highlight'
  const sidebarMarkCount =
    `${sidebarMarks.length} ${sidebarMarkNoun}${sidebarMarks.length === 1 ? '' : 's'}`
  const emptySidebarTitle = showingReferences
    ? 'No chat references yet'
    : 'No highlights yet'
  const emptySidebarDescription = showingReferences
    ? 'Use Add Chat on selected text to add a straight underline.'
    : 'Select text in the PDF to add a red wavy underline.'
  const EmptySidebarIcon = showingReferences ? MessageSquareQuote : Highlighter
  const percentage = numPages > 0
    ? Math.round((currentPage / numPages) * 100)
    : null

  return (
    <div
      ref={shellRef}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={navOpen ? 'secondary' : 'ghost'}
              size="icon"
              className="size-8 shrink-0 text-muted-foreground"
              aria-label="Contents"
              aria-expanded={navOpen}
              aria-controls={navId}
              onClick={() => setNavOpen(open => !open)}
            >
              <ListTree />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Contents</TooltipContent>
        </Tooltip>

        <ChatTargetMenu
          targetSessionId={chatTargetSessionId}
          targets={chatTargets}
          onChange={onChatTargetChange}
        />

        <div className="h-7 w-px bg-border/60" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <FileText className="size-3" />
            <span className="truncate">
              PDF · {numPages || '—'} {numPages === 1 ? 'page' : 'pages'}
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground">
            Page {pageDisplayLabel(currentPage, pageLabels)} of {numPages || '—'}
          </div>
        </div>

        {percentage !== null && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {percentage}%
          </span>
        )}
      </header>

      <div className={cn(
        'relative grid min-h-0 flex-1',
        navOpen && !compact
          ? 'grid-cols-[minmax(240px,280px)_minmax(0,1fr)]'
          : 'grid-cols-1',
      )}>
        {navOpen && compact && (
          <button
            type="button"
            className="absolute inset-0 z-20 bg-black/25"
            aria-label="Close PDF navigation"
            onClick={() => setNavOpen(false)}
          />
        )}

        {navOpen && (
          <nav
            id={navId}
            className={cn(
              'relative z-30 flex min-h-0 flex-col overflow-hidden border-r border-border/60 bg-background',
              compact
                ? 'absolute inset-y-0 left-0 w-[min(84%,290px)] shadow-strong'
                : 'bg-foreground/[0.015]',
            )}
            aria-label="PDF navigation"
          >
            <div
              className="flex h-11 shrink-0 items-end gap-1 border-b border-border/60 px-2"
              role="tablist"
              aria-label="PDF navigation views"
            >
              {(['contents', 'highlights', 'references'] as const).map(tab => {
                let count = 0
                let indicatorClass = 'bg-foreground/70'
                if (tab === 'highlights') {
                  count = wavyHighlights.length
                  indicatorClass = 'bg-red-500/80'
                } else if (tab === 'references') {
                  count = referenceUnderlines.length
                  indicatorClass = 'bg-blue-500/80'
                }
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={sidebarTab === tab}
                    className={cn(
                      'relative h-10 flex-1 px-1 text-[11px] font-medium capitalize',
                      sidebarTab === tab
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => setSidebarTab(tab)}
                  >
                    {tab}
                    {count > 0 && (
                      <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                        {count}
                      </span>
                    )}
                    {sidebarTab === tab && (
                      <span
                        className={cn(
                          'absolute inset-x-2 bottom-0 h-0.5 rounded-t',
                          indicatorClass,
                        )}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                )
              })}
            </div>

            {sidebarTab === 'contents' ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {outline.length > 0 ? (
                  <PdfOutlineTree
                    nodes={outline}
                    currentPage={currentPage}
                    onSelect={displayPage}
                  />
                ) : (
                  <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                    This PDF has no table of contents.
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/50 px-3">
                  <span className="text-[11px] text-muted-foreground">
                    {sidebarMarkCount}
                  </span>
                  {!showingReferences && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={sidebarMarks.length === 0 || exporting}
                      title="Export highlights as Markdown"
                      onClick={() => void exportHighlights()}
                    >
                      {exporting
                        ? <Loader2 className="animate-spin" />
                        : <Download />}
                      Export
                    </Button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {sidebarMarks.length > 0 ? (
                    <PdfHighlightRows
                      highlights={sidebarMarks}
                      pageLabels={pageLabels}
                      onSelect={displayHighlight}
                      onDelete={deleteHighlight}
                    />
                  ) : (
                    <div className="px-5 py-10 text-center">
                      <EmptySidebarIcon
                        className={cn(
                          'mx-auto size-5',
                          showingReferences
                            ? 'text-blue-400/80'
                            : 'text-red-400/80',
                        )}
                      />
                      <p className="mt-3 text-xs font-medium text-foreground">
                        {emptySidebarTitle}
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {emptySidebarDescription}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </nav>
        )}

        <section
          ref={viewportRef}
          className={cn(
            'relative min-h-0 overflow-hidden',
            isDark ? 'bg-[#151821]' : 'bg-[#f8fafc]',
          )}
          aria-label={metadata.name}
        >
          <div
            ref={scrollRef}
            onMouseUp={handleMouseUp}
            onScroll={handleScroll}
            className="h-full overflow-auto py-4"
          >
            {error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                <FileQuestion className="h-7 w-7 text-destructive/55" />
                <p className="text-sm font-medium text-destructive">PDF could not be rendered</p>
                <p className="max-w-lg text-xs text-muted-foreground">{error}</p>
              </div>
            ) : (
              documentElement
            )}
          </div>

          {selection && !error && (
            <EpubSelectionToolbar
              anchorRect={selection.dom.anchorRect}
              collisionBoundary={viewportRef.current}
              addingReferenceTo={addingReferenceTo}
              addingNote={addingNote}
              onCreateHighlight={() => void createRedWavyHighlight()}
              onAddNote={() => void addSelectionToNote()}
              onAddNoteTo={() => void addSelectionToNote('choose-target')}
              onAddChat={() => void addSelectionToChat('current')}
              onAddNewChat={() => void addSelectionToChat('new')}
              onDismiss={dismissSelection}
              ariaLabel="PDF selection actions"
            />
          )}

          {readerNotice && (
            <div
              className="absolute right-3 top-3 z-40 flex max-w-sm items-start gap-2 rounded-lg border border-border/70 bg-background/95 px-3 py-2 text-xs text-foreground shadow-middle backdrop-blur"
              role="status"
            >
              <span className="leading-relaxed">{readerNotice}</span>
              <button
                type="button"
                className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Dismiss"
                onClick={() => setReaderNotice('')}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function PdfPageMarks({
  pageNumber,
  marks,
}: {
  pageNumber: number
  marks: Array<{ highlight: PdfHighlightV1; rectIndex: number }>
}) {
  if (marks.length === 0) return null
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      data-pdf-highlight-layer={pageNumber}
      aria-hidden="true"
    >
      {marks.map(({ highlight, rectIndex }) => {
        const rect = highlight.rects[rectIndex]
        if (!rect) return null
        return (
          <span
            key={`${highlight.id}:${rectIndex}`}
            className={cn(
              'absolute block',
              highlight.style.type === 'wavy'
                ? 'pdf-selection-mark-wavy'
                : 'pdf-selection-mark-solid',
            )}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            }}
          />
        )
      })}
    </div>
  )
}

function PdfHighlightRows({
  highlights,
  pageLabels,
  onSelect,
  onDelete,
}: {
  highlights: PdfHighlightV1[]
  pageLabels: string[] | null
  onSelect: (highlight: PdfHighlightV1) => void
  onDelete: (highlight: PdfHighlightV1) => void
}) {
  return (
    <div className="py-2">
      {highlights.map(highlight => {
        const isReference = highlight.style.type === 'solid'
        const location = highlight.startPage === highlight.endPage
          ? `Page ${pageDisplayLabel(highlight.startPage, pageLabels)}`
          : `Pages ${pageDisplayLabel(highlight.startPage, pageLabels)}–${pageDisplayLabel(highlight.endPage, pageLabels)}`
        return (
          <div
            key={highlight.id}
            className="group relative flex min-h-12 items-start gap-2 px-3 hover:bg-foreground/[0.025]"
          >
            <span
              className={cn(
                'mt-4 size-1.5 shrink-0 rounded-full',
                isReference ? 'bg-blue-500/80' : 'bg-red-500/80',
              )}
              aria-hidden="true"
            />
            <button
              type="button"
              className="min-w-0 flex-1 py-2 text-left"
              title={highlight.quote}
              onClick={() => onSelect(highlight)}
            >
              <span className="block text-[10px] text-muted-foreground">
                {location}
              </span>
              <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-foreground/85">
                {highlight.quote}
              </span>
            </button>
            <button
              type="button"
              className={cn(
                'mt-2 grid size-7 shrink-0 place-items-center rounded text-muted-foreground opacity-0 focus:opacity-100 group-hover:opacity-100',
                isReference
                  ? 'hover:bg-blue-500/10 hover:text-blue-500'
                  : 'hover:bg-red-500/10 hover:text-red-500',
              )}
              aria-label={isReference
                ? `Remove reference underline: ${highlight.quote}`
                : `Delete highlight: ${highlight.quote}`}
              onClick={() => onDelete(highlight)}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function PdfOutlineTree({
  nodes,
  currentPage,
  onSelect,
  depth = 0,
}: {
  nodes: PdfOutlineNode[]
  currentPage: number
  onSelect: (pageNumber: number) => void
  depth?: number
}) {
  return (
    <div className={depth === 0 ? 'py-2' : undefined}>
      {nodes.map(node => (
        <React.Fragment key={node.id}>
          <button
            type="button"
            disabled={!node.pageNumber}
            className={cn(
              'flex w-full items-center gap-2 py-2 pr-3 text-left text-xs disabled:cursor-default disabled:opacity-60',
              node.pageNumber === currentPage
                ? 'bg-foreground/[0.055] font-medium text-foreground'
                : 'text-muted-foreground hover:bg-foreground/[0.025] hover:text-foreground',
            )}
            style={{ paddingLeft: `${12 + depth * 12}px` }}
            title={node.title}
            onClick={() => node.pageNumber && onSelect(node.pageNumber)}
          >
            <span className="min-w-0 flex-1 truncate">{node.title}</span>
            {node.pageNumber && (
              <span className="shrink-0 font-mono text-[10px] opacity-70">
                {node.pageNumber}
              </span>
            )}
          </button>
          {node.children.length > 0 && (
            <PdfOutlineTree
              nodes={node.children}
              currentPage={currentPage}
              onSelect={onSelect}
              depth={depth + 1}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  )
}
