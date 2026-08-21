import * as React from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  Download,
  FileQuestion,
  FileText,
  Highlighter,
  ListTree,
  Loader2,
  Trash2,
  X,
} from 'lucide-react'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useTranslation } from 'react-i18next'
import 'react-pdf/dist/Page/TextLayer.css'

import type {
  PdfHighlightV1,
  PdfProgressV1,
  PdfTextQuoteLocatorV1,
  ProjectFileMetadata,
  SourceFingerprint,
} from '@craft-agent/shared/project-files'

import { useTheme } from '@/context/ThemeContext'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { saveTextFile } from '@/lib/save-text-file'
import { registerOpenProjectFileDocument } from './project-file-document-registry'
import {
  createPdfPageLayout,
  findPdfPageAtOffset,
  getPdfNavigationLayout,
  getPdfPageDisplayLabel,
  loadPdfPageAspectRatios,
  pdfPageRenderWindow,
  pdfPageScrollTop,
} from './project-file-pdf-layout'
import { ProjectFileReaderSelectionToolbar } from './ProjectFileReaderSelectionToolbar'
import {
  buildPdfHighlightsMarkdown,
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

const PDF_RED_WAVY_UNDERLINE =
  'url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%226%22 height=%223%22 viewBox=%220 0 6 3%22%3E%3Cpath d=%22M0 2 Q1.5 0 3 2 T6 2%22 fill=%22none%22 stroke=%22%23ef4444%22 stroke-width=%221%22/%3E%3C/svg%3E")'

interface PdfOutlineItem {
  title: string
  dest: string | unknown[] | null
  items?: PdfOutlineItem[]
}

interface PdfOutlineNode {
  id: string
  title: string
  pageNumber?: number
  children: PdfOutlineNode[]
}

interface PendingPdfSelection {
  snapshot: PdfSelectionSnapshot
  anchorRect: DOMRect
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
    // Keep malformed outline labels visible, but disable navigation for them.
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

function closestPdfPageNumber(node: Node): number | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement
  const page = element?.closest<HTMLElement>('[data-pdf-page-number]')
  const pageNumber = Number(page?.dataset.pdfPageNumber)
  return Number.isSafeInteger(pageNumber) && pageNumber >= 1
    ? pageNumber
    : null
}

function samePdfSelection(
  highlight: PdfHighlightV1,
  selection: PdfSelectionSnapshot,
): boolean {
  return highlight.quote === selection.quote
    && JSON.stringify(highlight.rects) === JSON.stringify(selection.rects)
}

export function ProjectFilePdfReader({
  projectId,
  relativePath,
  metadata,
  bytes,
  sourceFingerprint,
  initialLocator,
}: {
  projectId: string
  relativePath: string
  metadata: ProjectFileMetadata
  bytes: Uint8Array
  sourceFingerprint: SourceFingerprint
  initialLocator?: PdfTextQuoteLocatorV1 & { anchor: NonNullable<PdfTextQuoteLocatorV1['anchor']> }
}) {
  const { isDark } = useTheme()
  const { t } = useTranslation()
  const readerShellRef = React.useRef<HTMLDivElement>(null)
  const viewportRef = React.useRef<HTMLElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const coordinatorRef = React.useRef<ReturnType<
    typeof createPdfStateMutationCoordinator
  > | null>(null)
  const restoreKeyRef = React.useRef<string | null>(null)
  const scrollFrameRef = React.useRef<number>()
  const [numPages, setNumPages] = React.useState(0)
  const [pageAspectRatios, setPageAspectRatios] = React.useState<number[]>([])
  const [pageWidth, setPageWidth] = React.useState(720)
  const [currentPage, setCurrentPage] = React.useState(1)
  const [outline, setOutline] = React.useState<PdfOutlineNode[]>([])
  const [pageLabels, setPageLabels] = React.useState<string[] | null>(null)
  const [navOpen, setNavOpen] = React.useState(true)
  const [compactNavigation, setCompactNavigation] = React.useState(false)
  const [tab, setTab] = React.useState<'contents' | 'highlights'>('contents')
  const [highlights, setHighlights] = React.useState<PdfHighlightV1[]>([])
  const [savedProgress, setSavedProgress] = React.useState<
    PdfProgressV1 | null | undefined
  >(undefined)
  const [selection, setSelection] = React.useState<PendingPdfSelection | null>(null)
  const [notice, setNotice] = React.useState('')
  const [error, setError] = React.useState('')
  const [savingHighlight, setSavingHighlight] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const file = React.useMemo(() => ({ data: bytes.slice() }), [bytes])
  const viewerKey = `${projectId}\0${relativePath}\0${sourceFingerprint}`
  const pageLayout = React.useMemo(
    () => createPdfPageLayout(pageAspectRatios, pageWidth),
    [pageAspectRatios, pageWidth],
  )
  const wavyHighlights = React.useMemo(
    () => highlights
      .filter(highlight => highlight.style.type === 'wavy')
      .sort(comparePdfHighlights),
    [highlights],
  )

  const dismissSelection = React.useCallback(() => {
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }, [])

  React.useLayoutEffect(() => {
    const shell = readerShellRef.current
    if (!shell) return

    let wasCompact: boolean | null = null
    const update = () => {
      const nextCompact = getPdfNavigationLayout(
        shell.getBoundingClientRect().width,
      ) === 'overlay'
      if (nextCompact && wasCompact !== true) setNavOpen(false)
      wasCompact = nextCompact
      setCompactNavigation(nextCompact)
    }

    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  const revealPage = React.useCallback((
    pageNumber: number,
    pageOffsetRatio: number,
    behavior: ScrollBehavior,
  ) => {
    const root = scrollRef.current
    const page = pageLayout[pageNumber - 1]
    if (!root || !page) return false
    root.scrollTo({
      top: pdfPageScrollTop(page, pageOffsetRatio),
      behavior,
    })
    setCurrentPage(pageNumber)
    return true
  }, [pageLayout])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver === 'undefined') return
    const update = () => {
      setPageWidth(Math.max(280, Math.min(900, viewport.clientWidth - 32)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    let disposed = false
    let unregister: () => void = () => undefined
    let coordinator: ReturnType<typeof createPdfStateMutationCoordinator> | null = null
    const request = { projectId, relativePath, sourceFingerprint }
    setHighlights([])
    setSavedProgress(undefined)

    const loadState = async () => {
      let state = null
      try {
        state = await window.electronAPI.getPdfDocumentState(request)
      } catch (stateError) {
        console.error('[ProjectFilePdfReader] State load failed:', stateError)
        if (!disposed) {
          setNotice('Reading progress and highlights could not be loaded.')
        }
      }
      if (disposed) return
      const matchingState = state
          && state.projectId === projectId
          && state.relativePath === relativePath
          && state.sourceFingerprint === sourceFingerprint
          ? state
          : null
      setHighlights(matchingState?.highlights ?? [])
      setSavedProgress(matchingState?.progress ?? null)
      coordinator = createPdfStateMutationCoordinator({
        initialRevision: matchingState?.revision ?? 0,
        applyMutation: mutation => window.electronAPI.applyPdfStateMutation({
          ...request,
          mutation,
        }),
        getState: () => window.electronAPI.getPdfDocumentState(request),
        onStateRefresh: refreshed => {
          if (!disposed) setHighlights(refreshed.highlights)
        },
        onBackgroundError: (stateError, operation) => {
          console.error(`[ProjectFilePdfReader] ${operation} failed:`, stateError)
          if (!disposed) setNotice('Reading state could not be saved.')
        },
      })
      coordinatorRef.current = coordinator
      unregister = registerOpenProjectFileDocument(projectId, relativePath, {
        flush: () => coordinator!.flush(),
      })
    }
    void loadState()

    return () => {
      disposed = true
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null
      void (coordinator?.dispose() ?? Promise.resolve())
        .catch(disposeError => {
          console.error('[ProjectFilePdfReader] Progress flush failed:', disposeError)
        })
        .finally(unregister)
    }
  }, [projectId, relativePath, sourceFingerprint])

  React.useLayoutEffect(() => {
    if (
      numPages === 0
      || pageLayout.length !== numPages
      || savedProgress === undefined
    ) return
    const locatorKey = initialLocator ? JSON.stringify(initialLocator) : ''
    const restoreKey = `${viewerKey}\0${locatorKey}`
    if (restoreKeyRef.current === restoreKey) return
    let target: { pageNumber: number; offset: number } | null = null
    if (initialLocator) {
      target = {
        pageNumber: initialLocator.anchor.pageNumber,
        offset: initialLocator.anchor.y,
      }
    } else if (savedProgress) {
      target = {
        pageNumber: savedProgress.pageNumber,
        offset: savedProgress.pageOffsetRatio,
      }
    }
    restoreKeyRef.current = restoreKey
    if (!target) return
    requestAnimationFrame(() => {
      revealPage(Math.min(numPages, target.pageNumber), target.offset, 'auto')
    })
  }, [initialLocator, numPages, pageLayout.length, revealPage, savedProgress, viewerKey])

  React.useEffect(() => () => {
    if (scrollFrameRef.current !== undefined) {
      cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [])

  const handleDocumentLoad = React.useCallback(async (pdf: PDFDocumentProxy) => {
    setNumPages(pdf.numPages)
    setPageAspectRatios([])
    setPageLabels(null)
    setError('')
    try {
      setPageAspectRatios(await loadPdfPageAspectRatios(pdf))
    } catch (layoutError) {
      setError(layoutError instanceof Error ? layoutError.message : String(layoutError))
      return
    }
    const [labelsResult, outlineResult] = await Promise.allSettled([
      pdf.getPageLabels(),
      pdf.getOutline(),
    ])
    if (labelsResult.status === 'fulfilled') {
      setPageLabels(labelsResult.value)
    } else {
      console.error('[ProjectFilePdfReader] Page label load failed:', labelsResult.reason)
    }
    try {
      if (outlineResult.status === 'rejected') throw outlineResult.reason
      const items = outlineResult.value
      setOutline(await mapPdfOutline(pdf, (items ?? []) as PdfOutlineItem[]))
    } catch (outlineError) {
      console.error('[ProjectFilePdfReader] Outline load failed:', outlineError)
      setOutline([])
    }
  }, [])

  const handleScroll = React.useCallback(() => {
    dismissSelection()
    if (scrollFrameRef.current !== undefined) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined
      const root = scrollRef.current
      if (!root || pageLayout.length === 0) return
      const current = findPdfPageAtOffset(pageLayout, root.scrollTop)
      if (!current) return
      setCurrentPage(current.pageNumber)
      coordinatorRef.current?.scheduleProgress({
        pageNumber: current.pageNumber,
        pageOffsetRatio: Math.round(current.pageOffsetRatio * 1_000) / 1_000,
        percentage: Math.min(
          1,
          Math.max(0, (
            current.pageNumber - 1 + current.pageOffsetRatio
          ) / numPages),
        ),
      })
    })
  }, [dismissSelection, numPages, pageLayout])

  const handleMouseUp = React.useCallback(() => {
    const root = scrollRef.current
    if (!root) return
    requestAnimationFrame(() => {
      const domSelection = window.getSelection()
      if (!domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) {
        setSelection(null)
        return
      }
      const range = domSelection.getRangeAt(0)
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
        setSelection(null)
        return
      }
      const startPage = closestPdfPageNumber(range.startContainer)
      const endPage = closestPdfPageNumber(range.endContainer)
      if (!startPage || !endPage) {
        setSelection(null)
        return
      }
      try {
        const snapshot = createPdfSelectionSnapshot({
          quote: range.toString(),
          rects: capturePdfSelectionRects(root, range),
        })
        if (
          snapshot.startPage !== Math.min(startPage, endPage)
          || snapshot.endPage !== Math.max(startPage, endPage)
        ) {
          throw new Error('This selection cannot be located reliably.')
        }
        const rects = Array.from(range.getClientRects())
          .filter(rect => rect.width > 0 && rect.height > 0)
        const anchorRect = rects.at(-1) ?? range.getBoundingClientRect()
        setSelection({ snapshot, anchorRect })
        setNotice('')
      } catch (selectionError) {
        setSelection(null)
        setNotice(selectionError instanceof Error
          ? selectionError.message
          : String(selectionError))
      }
    })
  }, [])

  const createHighlight = React.useCallback(async () => {
    const snapshot = selection?.snapshot
    const coordinator = coordinatorRef.current
    if (!snapshot || !coordinator) {
      setNotice('Highlights are not ready yet.')
      return
    }
    if (highlights.some(highlight => samePdfSelection(highlight, snapshot))) {
      setTab('highlights')
      dismissSelection()
      setNotice('This selection is already highlighted.')
      return
    }
    setSavingHighlight(true)
    const highlight = createOptimisticPdfHighlight(
      snapshot,
      globalThis.crypto.randomUUID(),
    )
    dismissSelection()
    setTab('highlights')
    try {
      await persistOptimisticPdfHighlight({
        highlight,
        mutate: mutation => coordinator.mutate(mutation),
        updateHighlights: setHighlights,
      })
    } catch (highlightError) {
      console.error('[ProjectFilePdfReader] Highlight save failed:', highlightError)
      setNotice('The highlight could not be saved.')
    } finally {
      setSavingHighlight(false)
    }
  }, [dismissSelection, highlights, selection])

  const deleteHighlight = React.useCallback(async (highlight: PdfHighlightV1) => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    try {
      await deletePdfHighlightOptimistically({
        highlight,
        mutate: mutation => coordinator.mutate(mutation),
        updateHighlights: setHighlights,
      })
    } catch (deleteError) {
      console.error('[ProjectFilePdfReader] Highlight delete failed:', deleteError)
      setNotice('The highlight could not be deleted.')
    }
  }, [])

  const exportHighlights = React.useCallback(async () => {
    if (wavyHighlights.length === 0 || exporting) return
    setExporting(true)
    try {
      const result = await saveTextFile({
        suggestedName: getPdfHighlightsSuggestedFilename(metadata.name),
        content: buildPdfHighlightsMarkdown({
          fileName: metadata.name,
          pageLabels,
          highlights: wavyHighlights,
        }),
      })
      if (result.saved) setNotice('')
    } catch (exportError) {
      console.error('[ProjectFilePdfReader] Highlight export failed:', exportError)
      setNotice(t('projectFileReader.exportFailed'))
    } finally {
      setExporting(false)
    }
  }, [exporting, metadata.name, pageLabels, t, wavyHighlights])

  const marksByPage = React.useMemo(() => {
    const result = new Map<number, Array<{
      highlight: PdfHighlightV1
      rect: PdfHighlightV1['rects'][number]
      rectIndex: number
    }>>()
    for (const highlight of highlights) {
      highlight.rects.forEach((rect, rectIndex) => {
        const marks = result.get(rect.pageNumber) ?? []
        marks.push({ highlight, rect, rectIndex })
        result.set(rect.pageNumber, marks)
      })
    }
    return result
  }, [highlights])
  const renderWindow = pdfPageRenderWindow(currentPage, numPages)
  const pageElements = React.useMemo(() => pageLayout.map(page => {
    const pageNumber = page.pageNumber
    const pageMarks = marksByPage.get(pageNumber) ?? []
    const shouldRender = pageNumber >= renderWindow.start
      && pageNumber <= renderWindow.end
    return (
      <div
        key={pageNumber}
        data-pdf-page-number={pageNumber}
        className="relative overflow-hidden rounded bg-white shadow-minimal"
        style={{ width: `${pageWidth}px`, height: `${page.height}px` }}
      >
        {shouldRender && (
          <Page
            pageNumber={pageNumber}
            width={pageWidth}
            className="!m-0 !shadow-none"
            renderTextLayer
            renderAnnotationLayer={false}
          />
        )}
        <div className="pointer-events-none absolute inset-0 z-20" aria-hidden="true">
          {pageMarks.map(({ highlight, rect, rectIndex }) => (
            <span
              key={`${highlight.id}:${rectIndex}`}
              className="absolute block bg-repeat-x"
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
                ...(highlight.style.type === 'wavy'
                  ? {
                      backgroundImage: PDF_RED_WAVY_UNDERLINE,
                      backgroundPosition: 'left bottom',
                      backgroundSize: '6px 3px',
                    }
                  : { backgroundColor: 'rgb(59 130 246 / 0.2)' }),
              }}
            />
          ))}
        </div>
      </div>
    )
  }), [marksByPage, pageLayout, pageWidth, renderWindow.end, renderWindow.start])

  const percentage = numPages > 0 ? Math.round((currentPage / numPages) * 100) : 0

  return (
    <div
      ref={readerShellRef}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <Button
          type="button"
          variant={navOpen ? 'secondary' : 'ghost'}
          size="icon"
          className="size-8"
          aria-label="Toggle PDF navigation"
          aria-expanded={navOpen}
          onClick={() => setNavOpen(open => !open)}
        >
          <ListTree />
        </Button>
        <FileText className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Page {getPdfPageDisplayLabel(currentPage, pageLabels)} of {numPages || '—'}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{percentage}%</span>
      </div>

      <div className={cn(
        'relative grid min-h-0 flex-1',
        navOpen && !compactNavigation
          ? 'grid-cols-[240px_minmax(0,1fr)]'
          : 'grid-cols-1',
      )}>
        {navOpen && compactNavigation && (
          <button
            type="button"
            className="absolute inset-0 z-20 bg-black/25"
            aria-label="Close PDF navigation"
            onClick={() => setNavOpen(false)}
          />
        )}

        {navOpen && (
          <nav
            className={cn(
              'relative z-30 flex min-h-0 flex-col overflow-hidden border-r border-border/60 bg-background',
              compactNavigation
                ? 'absolute inset-y-0 left-0 w-[min(84%,290px)] shadow-strong'
                : 'bg-foreground/[0.015]',
            )}
            aria-label="PDF navigation"
          >
            <div className="grid h-10 shrink-0 grid-cols-2 border-b border-border/50 p-1">
              {(['contents', 'highlights'] as const).map(value => (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    'rounded text-[11px] capitalize',
                    tab === value
                      ? 'bg-foreground/[0.07] text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setTab(value)}
                >
                  {value}{value === 'highlights' ? ` ${wavyHighlights.length}` : ''}
                </button>
              ))}
            </div>
            {tab === 'contents' ? (
              <div className="min-h-0 flex-1 overflow-y-auto py-2">
                {outline.length > 0 ? (
                  <PdfOutlineTree
                    nodes={outline}
                    currentPage={currentPage}
                    pageLabels={pageLabels}
                    onSelect={page => {
                      revealPage(page, 0, 'smooth')
                      if (compactNavigation) setNavOpen(false)
                    }}
                  />
                ) : (
                  <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                    This PDF has no table of contents.
                  </p>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/50 px-3">
                  <span className="text-[11px] text-muted-foreground">
                    {t('projectFileReader.highlightCount', {
                      count: wavyHighlights.length,
                    })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={wavyHighlights.length === 0 || exporting}
                    title={t('projectFileReader.exportHighlights')}
                    onClick={() => void exportHighlights()}
                  >
                    {exporting
                      ? <Loader2 className="animate-spin" />
                      : <Download />}
                    {t('projectFileReader.export')}
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto py-2">
                  {wavyHighlights.length > 0 ? (
                    wavyHighlights.map(highlight => (
                      <div key={highlight.id} className="group flex items-start gap-2 px-3 py-2 hover:bg-foreground/[0.03]">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => {
                            const rect = highlight.rects[0]
                            if (rect) revealPage(rect.pageNumber, rect.y, 'smooth')
                            if (compactNavigation) setNavOpen(false)
                          }}
                        >
                          <span className="block text-[10px] text-muted-foreground">
                            Page {getPdfPageDisplayLabel(highlight.startPage, pageLabels)}
                          </span>
                          <span className="line-clamp-2 text-xs">{highlight.quote}</span>
                        </button>
                        <button
                          type="button"
                          className="mt-1 text-muted-foreground opacity-0 hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
                          aria-label={`Delete highlight: ${highlight.quote}`}
                          onClick={() => void deleteHighlight(highlight)}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                      <Highlighter className="mx-auto mb-2 size-5 text-red-400" />
                      Select text to add a red wavy underline.
                    </div>
                  )}
                </div>
              </div>
            )}
          </nav>
        )}

        <section
          ref={viewportRef}
          className={cn('relative min-h-0 overflow-hidden', isDark ? 'bg-[#151821]' : 'bg-[#f1f3f5]')}
          aria-label={metadata.name}
        >
          <div
            ref={scrollRef}
            className="h-full overflow-auto py-4"
            onScroll={handleScroll}
            onMouseUp={handleMouseUp}
          >
            {error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                <FileQuestion className="size-7 text-destructive/60" />
                <p className="text-sm text-destructive">PDF could not be rendered</p>
                <p className="max-w-lg text-xs text-muted-foreground">{error}</p>
              </div>
            ) : (
              <Document
                file={file}
                onLoadSuccess={handleDocumentLoad}
                onLoadError={loadError => setError(loadError.message)}
                loading={(
                  <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Rendering PDF…
                  </div>
                )}
                className="flex flex-col items-center gap-4"
              >
                {pageLayout.length === numPages ? pageElements : (
                  <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Preparing pages…
                  </div>
                )}
              </Document>
            )}
          </div>

          {selection && !error && (
            <ProjectFileReaderSelectionToolbar
              anchorRect={selection.anchorRect}
              collisionBoundary={viewportRef.current}
              disabled={savingHighlight}
              onCreateHighlight={() => void createHighlight()}
              onDismiss={dismissSelection}
            />
          )}
          {notice && (
            <div className="absolute right-3 top-3 z-40 flex max-w-sm gap-2 rounded border border-border bg-background/95 px-3 py-2 text-xs shadow-middle">
              <span>{notice}</span>
              <button type="button" aria-label="Dismiss" onClick={() => setNotice('')}>
                <X className="size-3.5" />
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function PdfOutlineTree({
  nodes,
  currentPage,
  pageLabels,
  onSelect,
  depth = 0,
}: {
  nodes: PdfOutlineNode[]
  currentPage: number
  pageLabels: string[] | null
  onSelect: (pageNumber: number) => void
  depth?: number
}) {
  return (
    <>
      {nodes.map(node => (
        <React.Fragment key={node.id}>
          <button
            type="button"
            disabled={!node.pageNumber}
            className={cn(
              'flex w-full items-center py-2 pr-3 text-left text-xs disabled:opacity-50',
              node.pageNumber === currentPage
                ? 'bg-foreground/[0.06] text-foreground'
                : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground',
            )}
            style={{ paddingLeft: `${12 + depth * 12}px` }}
            onClick={() => {
              if (node.pageNumber) onSelect(node.pageNumber)
            }}
          >
            <span className="min-w-0 flex-1 truncate">{node.title}</span>
            {node.pageNumber && (
              <span className="font-mono text-[10px]">
                {getPdfPageDisplayLabel(node.pageNumber, pageLabels)}
              </span>
            )}
          </button>
          {node.children.length > 0 && (
            <PdfOutlineTree
              nodes={node.children}
              currentPage={currentPage}
              pageLabels={pageLabels}
              onSelect={onSelect}
              depth={depth + 1}
            />
          )}
        </React.Fragment>
      ))}
    </>
  )
}
