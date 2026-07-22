import * as React from 'react'
import ePub, {
  type Book,
  type Contents,
  type Location,
  type NavItem,
  type Rendition,
} from 'epubjs'
import {
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ListTree,
  Loader2,
  Play,
  Trash2,
  Underline,
  Waves,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import type {
  EpubHighlight,
  EpubHighlightInput,
  ImportedChapter,
  ImportedTextbook,
} from '@craft-agent/shared/learning'

import { useTheme } from '@/context/ThemeContext'
import * as storage from '@/lib/local-storage'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

import {
  buildEpubHighlightOutline,
  calculateEpubSelectionPopoverAnchor,
  createEpubUnderlineStyle,
  EPUB_UNDERLINE_HIGHLIGHT_NAME,
  epubHrefsMatch,
  findChapterForEpubLocation,
  mapEpubIframeRectToViewport,
  normalizeEpubSelectionText,
  resolveEpubHighlightRanges,
  type EpubHighlightOutlineItem,
  type EpubReaderTocItem,
  type EpubSelectionPopoverAnchor,
} from './epub-reader-utils'

interface EpubReaderProps {
  assetPath: string
  sourceKey: string
  workspaceId: string
  projectSlug: string
  textbook: ImportedTextbook
  selectedChapterId: string | null
  accentColor?: string
  starting: boolean
  onChapterChange: (chapterId: string) => void
  onStartLearning: () => void
}

type ReaderTocItem = EpubReaderTocItem

interface ReaderLocation {
  spineIndex: number
  href: string
  atStart: boolean
  atEnd: boolean
}

interface RenderedView {
  iframe?: HTMLIFrameElement
  contents?: Contents
}

type PendingEpubHighlight = EpubHighlightInput

type ReaderPanel = 'contents' | 'highlights'

interface HighlightRegistryLike {
  set: (name: string, highlight: Highlight) => void
  delete: (name: string) => boolean
}

type HighlightConstructor = new (...ranges: AbstractRange[]) => Highlight

interface EpubDisplayOptions {
  fixedLayout?: string
}

const LIGHT_READER_THEME = {
  'html, body': {
    'background-color': '#f8fafc',
  },
  body: {
    color: '#20242b',
    'font-family': 'Charter, "Iowan Old Style", "Songti SC", STSong, serif',
    'font-size': '16px',
    'line-height': '1.72',
    margin: '0 auto',
    'max-width': '720px',
    padding: '30px clamp(22px, 6vw, 48px)',
  },
  a: { color: '#624f8f' },
  'code, pre': { 'font-family': '"JetBrains Mono", ui-monospace, monospace' },
  'img, svg': { 'max-width': '100%', height: 'auto' },
}

const DARK_READER_THEME = {
  ...LIGHT_READER_THEME,
  'html, body': {
    'background-color': '#151821',
  },
  body: {
    ...LIGHT_READER_THEME.body,
    color: '#e5e7eb',
    'background-color': '#151821',
  },
  a: { color: '#b7a8e6' },
}

export function EpubReader({
  assetPath,
  sourceKey,
  workspaceId,
  projectSlug,
  textbook,
  selectedChapterId,
  accentColor,
  starting,
  onChapterChange,
  onStartLearning,
}: EpubReaderProps) {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const mountRef = React.useRef<HTMLDivElement>(null)
  const readerViewportRef = React.useRef<HTMLElement>(null)
  const selectionPopoverRef = React.useRef<HTMLDivElement>(null)
  const copyActionRef = React.useRef<HTMLButtonElement>(null)
  const selectionContentsRef = React.useRef<Contents | null>(null)
  const selectionScrollCleanupRef = React.useRef<(() => void) | null>(null)
  const bookRef = React.useRef<Book | null>(null)
  const renditionRef = React.useRef<Rendition | null>(null)
  const isDarkRef = React.useRef(isDark)
  const selectedChapterIdRef = React.useRef(selectedChapterId)
  const onChapterChangeRef = React.useRef(onChapterChange)
  const highlightsRef = React.useRef<EpubHighlight[]>([])
  const lastReportedChapterIdRef = React.useRef<string | null>(null)
  const reflowableRef = React.useRef(false)

  isDarkRef.current = isDark
  selectedChapterIdRef.current = selectedChapterId
  onChapterChangeRef.current = onChapterChange

  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = React.useState('')
  const [panelOpen, setPanelOpen] = React.useState(true)
  const [panel, setPanel] = React.useState<ReaderPanel>('contents')
  const [toc, setToc] = React.useState<ReaderTocItem[]>([])
  const [moving, setMoving] = React.useState(false)
  const [highlights, setHighlights] = React.useState<EpubHighlight[]>([])
  const [highlightsLoading, setHighlightsLoading] = React.useState(true)
  const [pendingHighlight, setPendingHighlight] = React.useState<PendingEpubHighlight | null>(null)
  const [selectionAnchor, setSelectionAnchor] = React.useState<EpubSelectionPopoverAnchor | null>(null)
  const [savingHighlight, setSavingHighlight] = React.useState(false)
  const [deletingCfi, setDeletingCfi] = React.useState<string | null>(null)
  const [exporting, setExporting] = React.useState(false)
  const [location, setLocation] = React.useState<ReaderLocation>(() => {
    const chapter = textbook.chapters.find((candidate) => candidate.id === selectedChapterId)
    const spineIndex = chapter?.locator.format === 'epub' ? chapter.locator.spineIndex : 0
    return {
      spineIndex,
      href: chapter?.locator.format === 'epub' ? chapter.locator.href : '',
      atStart: spineIndex === 0,
      atEnd: false,
    }
  })

  highlightsRef.current = highlights

  const selectedChapter = textbook.chapters.find((chapter) => chapter.id === selectedChapterId)
    ?? textbook.chapters.find(
      (chapter) => chapter.locator.format === 'epub' && chapter.locator.spineIndex === location.spineIndex,
    )
    ?? null
  const activeTocKey = React.useMemo(
    () => findActiveTocKey(toc, location.href, location.spineIndex),
    [toc, location.href, location.spineIndex],
  )
  const highlightOutline = React.useMemo(
    () => buildEpubHighlightOutline(toc, textbook.chapters, highlights),
    [toc, textbook.chapters, highlights],
  )
  const currentNumber = selectedChapter ? selectedChapter.order + 1 : location.spineIndex + 1

  const dismissSelectionPopover = React.useCallback(() => {
    selectionScrollCleanupRef.current?.()
    selectionScrollCleanupRef.current = null
    const selectedContents = selectionContentsRef.current
    selectionContentsRef.current = null
    selectedContents?.window.getSelection()?.removeAllRanges()
    const frame = selectedContents?.window.frameElement
    if (frame instanceof HTMLElement) frame.focus({ preventScroll: true })
    setPendingHighlight(null)
    setSelectionAnchor(null)
  }, [])

  React.useEffect(() => {
    let disposed = false
    setHighlightsLoading(true)
    setHighlights([])
    dismissSelectionPopover()

    void window.electronAPI.listProjectEpubHighlights(
      workspaceId,
      projectSlug,
      textbook.sourceFilename,
    ).then((saved) => {
      if (!disposed) setHighlights(saved)
    }).catch((error) => {
      console.error('[EpubReader] Failed to load underlines:', error)
      if (!disposed) toast.error(t('projectInfo.readerHighlightsLoadFailed'))
    }).finally(() => {
      if (!disposed) setHighlightsLoading(false)
    })

    return () => {
      disposed = true
    }
  }, [workspaceId, projectSlug, textbook.sourceFilename, t, dismissSelectionPopover])

  React.useEffect(() => {
    if (!pendingHighlight || !selectionAnchor) return
    const focusFrame = window.requestAnimationFrame(() => {
      copyActionRef.current?.focus({ preventScroll: true })
    })
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && selectionPopoverRef.current?.contains(target)) return
      dismissSelectionPopover()
    }
    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
    }
  }, [dismissSelectionPopover, pendingHighlight, selectionAnchor])

  React.useEffect(() => {
    let disposed = false
    let resizeObserver: ResizeObserver | null = null
    let rendition: Rendition | null = null
    let book: Book | null = null

    const handleRelocated = (nextLocation: Location) => {
      if (disposed) return
      dismissSelectionPopover()
      const start = nextLocation.start
      setLocation({
        spineIndex: start.index,
        href: start.href,
        atStart: nextLocation.atStart,
        atEnd: nextLocation.atEnd,
      })

      const chapter = findChapterForEpubLocation(textbook.chapters, start)
      if (chapter && chapter.id !== lastReportedChapterIdRef.current) {
        lastReportedChapterIdRef.current = chapter.id
        onChapterChangeRef.current(chapter.id)
      }

      if (start.cfi) storage.set(storage.KEYS.epubPosition, start.cfi, sourceKey)
    }

    const handleRendered = (_section: unknown, view: RenderedView) => {
      view.iframe?.setAttribute('title', textbook.title)
      if (view.contents) applyEpubHighlights(view.contents, highlightsRef.current)
    }

    const handleSelected = (cfiRange: string, contents: Contents) => {
      if (disposed || !cfiRange) return
      const selection = contents.window.getSelection()
      const text = normalizeEpubSelectionText(selection?.toString() ?? '')
      const selectionRange = selection && selection.rangeCount > 0
        ? selection.getRangeAt(0)
        : null
      const readerViewport = readerViewportRef.current

      let anchor: EpubSelectionPopoverAnchor | null = null
      if (selectionRange && readerViewport) {
        try {
          const iframe = contents.window.frameElement
          const clientRects = Array.from(selectionRange.getClientRects())
            .filter((rect) => rect.width > 0 && rect.height > 0)
          const focusAtStart = selection?.focusNode === selectionRange.startContainer
            && selection.focusOffset === selectionRange.startOffset
          const selectionRect = clientRects[focusAtStart ? 0 : clientRects.length - 1]
            ?? selectionRange.getBoundingClientRect()
          if (iframe instanceof HTMLIFrameElement && selectionRect.width > 0 && selectionRect.height > 0) {
            const iframeRect = iframe.getBoundingClientRect()
            const mappedSelectionRect = mapEpubIframeRectToViewport(
              selectionRect,
              iframeRect,
              { width: iframe.clientWidth, height: iframe.clientHeight },
            )
            anchor = calculateEpubSelectionPopoverAnchor(
              mappedSelectionRect,
              readerViewport.getBoundingClientRect(),
            )
          }
        } catch (error) {
          console.warn('[EpubReader] Failed to position selection actions:', error)
        }
      }

      if (!text || !anchor) {
        selection?.removeAllRanges()
        return
      }

      const chapter = findChapterForEpubLocation(textbook.chapters, {
        index: contents.sectionIndex,
      })
      if (!chapter || chapter.locator.format !== 'epub') {
        selection?.removeAllRanges()
        return
      }

      dismissSelectionPopover()
      selectionContentsRef.current = contents
      setPendingHighlight({
        sourceFilename: textbook.sourceFilename,
        cfiRange,
        text,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        chapterOrder: chapter.order,
        spineIndex: chapter.locator.spineIndex,
      })
      setSelectionAnchor(anchor)

      const closeOnScroll = () => dismissSelectionPopover()
      contents.window.addEventListener('scroll', closeOnScroll, { passive: true })
      mountRef.current?.addEventListener('scroll', closeOnScroll, true)
      selectionScrollCleanupRef.current = () => {
        contents.window.removeEventListener('scroll', closeOnScroll)
        mountRef.current?.removeEventListener('scroll', closeOnScroll, true)
      }
    }

    const load = async () => {
      setStatus('loading')
      setErrorMessage('')
      setToc([])
      lastReportedChapterIdRef.current = null
      reflowableRef.current = false

      try {
        const bytes = await window.electronAPI.readFileBinary(assetPath)
        if (disposed) return
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        book = ePub(buffer, { replacements: 'blobUrl' })
        bookRef.current = book

        const [navigation, metadata, displayOptions] = await Promise.all([
          book.loaded.navigation,
          book.loaded.metadata,
          loadDisplayOptions(book),
        ])
        if (disposed) return

        const parsedToc = mapNavigationItems(navigation.toc)
        setToc(parsedToc.length > 0 ? parsedToc : fallbackToc(textbook.chapters))

        const mount = mountRef.current
        if (!mount) throw new Error('Reader mount point is unavailable')
        const fixedLayout = metadata.layout === 'pre-paginated'
          || displayOptions?.fixedLayout === 'true'
        reflowableRef.current = !fixedLayout
        rendition = book.renderTo(mount, {
          width: '100%',
          height: '100%',
          flow: fixedLayout ? 'paginated' : 'scrolled-doc',
          layout: fixedLayout ? 'pre-paginated' : 'reflowable',
          spread: 'none',
          allowScriptedContent: false,
        })
        renditionRef.current = rendition
        rendition.on('relocated', handleRelocated)
        rendition.on('rendered', handleRendered)
        rendition.on('selected', handleSelected)
        rendition.on('mousedown', dismissSelectionPopover)
        rendition.on('touchstart', dismissSelectionPopover)

        if (!fixedLayout) {
          rendition.themes.register('socratopia-light', LIGHT_READER_THEME)
          rendition.themes.register('socratopia-dark', DARK_READER_THEME)
          rendition.themes.select(isDarkRef.current ? 'socratopia-dark' : 'socratopia-light')
        }

        const initialChapter = textbook.chapters.find(
          (chapter) => chapter.id === selectedChapterIdRef.current,
        )
        const initialTarget = initialChapter?.locator.format === 'epub'
          ? initialChapter.locator.spineIndex
          : 0
        const savedCfi = storage.get<string | null>(storage.KEYS.epubPosition, null, sourceKey)

        try {
          if (savedCfi) {
            const savedSpineIndex = book.spine.get(savedCfi)?.index
            if (!Number.isInteger(savedSpineIndex)) throw new Error('Saved EPUB position is invalid')
            await displayEpubCfi(rendition, savedSpineIndex, savedCfi)
          } else {
            await rendition.display(initialTarget)
          }
        } catch (error) {
          if (!savedCfi) throw error
          storage.remove(storage.KEYS.epubPosition, sourceKey)
          await rendition.display(initialTarget)
        }

        // epub.js creates its view manager asynchronously. Observing earlier can
        // fire an eager resize before the manager exists.
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            if (!rendition || disposed) return
            dismissSelectionPopover()
            const bounds = mount.getBoundingClientRect()
            if (bounds.width > 0 && bounds.height > 0) {
              rendition.resize(Math.floor(bounds.width), Math.floor(bounds.height))
            }
          })
          resizeObserver.observe(mount)
        }

        if (!disposed) setStatus('ready')
      } catch (error) {
        console.error('[EpubReader] Failed to render EPUB:', error)
        if (!disposed) {
          setErrorMessage(error instanceof Error ? error.message : String(error))
          setStatus('error')
        }
      }
    }

    void load()

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      if (rendition) {
        rendition.off('relocated', handleRelocated)
        rendition.off('rendered', handleRendered)
        rendition.off('selected', handleSelected)
        rendition.off('mousedown', dismissSelectionPopover)
        rendition.off('touchstart', dismissSelectionPopover)
      }
      selectionScrollCleanupRef.current?.()
      selectionScrollCleanupRef.current = null
      selectionContentsRef.current?.window.getSelection()?.removeAllRanges()
      selectionContentsRef.current = null
      if (book) book.destroy()
      else rendition?.destroy()
      if (renditionRef.current === rendition) renditionRef.current = null
      if (bookRef.current === book) bookRef.current = null
    }
  }, [assetPath, sourceKey, textbook.chapters, textbook.sourceFilename, textbook.title, dismissSelectionPopover])

  React.useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition || !reflowableRef.current || status !== 'ready') return
    rendition.themes.select(isDark ? 'socratopia-dark' : 'socratopia-light')
  }, [isDark, status])

  React.useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition || status !== 'ready') return
    for (const contents of getRenderedContents(rendition)) {
      applyEpubHighlights(contents, highlights)
    }
  }, [highlights, status])

  const displayTocItem = React.useCallback(async (item: ReaderTocItem) => {
    const rendition = renditionRef.current
    if (!rendition || moving) return
    dismissSelectionPopover()
    setMoving(true)
    try {
      if (item.spineIndex !== undefined) await rendition.display(item.spineIndex)
      else await rendition.display(item.href)
    } catch (error) {
      console.error('[EpubReader] Failed to open table-of-contents item:', error)
    } finally {
      setMoving(false)
    }
  }, [dismissSelectionPopover, moving])

  const move = React.useCallback(async (direction: 'previous' | 'next') => {
    const rendition = renditionRef.current
    if (!rendition || moving) return
    dismissSelectionPopover()
    setMoving(true)
    try {
      if (direction === 'previous') await rendition.prev()
      else await rendition.next()
    } catch (error) {
      console.error(`[EpubReader] Failed to move ${direction}:`, error)
    } finally {
      setMoving(false)
    }
  }, [dismissSelectionPopover, moving])

  const togglePanel = React.useCallback((nextPanel: ReaderPanel) => {
    if (panel === nextPanel) {
      setPanelOpen((open) => !open)
      return
    }
    setPanel(nextPanel)
    setPanelOpen(true)
  }, [panel])

  const savePendingHighlight = React.useCallback(async () => {
    if (!pendingHighlight || savingHighlight) return
    setSavingHighlight(true)
    try {
      const saved = await window.electronAPI.saveProjectEpubHighlight(
        workspaceId,
        projectSlug,
        pendingHighlight,
      )
      setHighlights((current) => [
        ...current.filter((item) => item.cfiRange !== saved.cfiRange),
        saved,
      ])
      dismissSelectionPopover()
    } catch (error) {
      console.error('[EpubReader] Failed to save underline:', error)
      toast.error(t('projectInfo.readerHighlightSaveFailed'))
    } finally {
      setSavingHighlight(false)
    }
  }, [dismissSelectionPopover, pendingHighlight, projectSlug, savingHighlight, t, workspaceId])

  const copyPendingSelection = React.useCallback(async () => {
    if (!pendingHighlight) return
    try {
      await navigator.clipboard.writeText(pendingHighlight.text)
      dismissSelectionPopover()
    } catch (error) {
      console.error('[EpubReader] Failed to copy selection:', error)
      toast.error(t('toast.copyFailed'))
    }
  }, [dismissSelectionPopover, pendingHighlight, t])

  const displayHighlight = React.useCallback(async (highlight: EpubHighlight) => {
    const rendition = renditionRef.current
    if (!rendition || moving) return
    dismissSelectionPopover()
    setMoving(true)
    try {
      await displayEpubCfi(rendition, highlight.spineIndex, highlight.cfiRange)
    } catch (error) {
      console.error('[EpubReader] Failed to open underline:', error)
      toast.error(t('projectInfo.readerHighlightOpenFailed'))
    } finally {
      setMoving(false)
    }
  }, [dismissSelectionPopover, moving, t])

  const deleteHighlight = React.useCallback(async (highlight: EpubHighlight) => {
    if (deletingCfi) return
    setDeletingCfi(highlight.cfiRange)
    try {
      await window.electronAPI.deleteProjectEpubHighlight(
        workspaceId,
        projectSlug,
        textbook.sourceFilename,
        highlight.cfiRange,
      )
      setHighlights((current) => current.filter((item) => item.cfiRange !== highlight.cfiRange))
    } catch (error) {
      console.error('[EpubReader] Failed to delete underline:', error)
      toast.error(t('projectInfo.readerHighlightDeleteFailed'))
    } finally {
      setDeletingCfi(null)
    }
  }, [deletingCfi, projectSlug, t, textbook.sourceFilename, workspaceId])

  const exportHighlights = React.useCallback(async () => {
    if (exporting || highlights.length === 0) return
    setExporting(true)
    try {
      const exported = await window.electronAPI.exportProjectEpubHighlights(
        workspaceId,
        projectSlug,
        textbook.sourceFilename,
      )
      downloadMarkdown(exported.filename, exported.markdown)
    } catch (error) {
      console.error('[EpubReader] Failed to export underlines:', error)
      toast.error(t('projectInfo.readerHighlightsExportFailed'))
    } finally {
      setExporting(false)
    }
  }, [exporting, highlights.length, projectSlug, t, textbook.sourceFilename, workspaceId])

  return (
    <div
      className="overflow-hidden"
      style={{ '--reader-accent': accentColor ?? 'var(--accent)' } as React.CSSProperties}
    >
      <div className="min-h-16 border-b border-border/50 px-3 py-2.5 flex items-center gap-3">
        <Button
          type="button"
          variant={panelOpen && panel === 'contents' ? 'secondary' : 'ghost'}
          size="sm"
          className="shrink-0 text-muted-foreground"
          aria-expanded={panelOpen && panel === 'contents'}
          onClick={() => togglePanel('contents')}
        >
          <ListTree />
          <span className="hidden sm:inline">{t('projectInfo.readerContents')}</span>
        </Button>
        <Button
          type="button"
          variant={panelOpen && panel === 'highlights' ? 'secondary' : 'ghost'}
          size="sm"
          className="shrink-0 text-muted-foreground"
          aria-expanded={panelOpen && panel === 'highlights'}
          onClick={() => togglePanel('highlights')}
        >
          <Underline />
          <span className="hidden sm:inline">{t('projectInfo.readerHighlights')}</span>
          <span className="font-mono text-[10px] tabular-nums">{highlights.length}</span>
        </Button>

        <div className="h-8 w-px bg-border/60" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <BookOpenText className="h-3 w-3" style={{ color: 'var(--reader-accent)' }} />
            <span>EPUB{textbook.author?.trim() ? ` · ${textbook.author}` : ''}</span>
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground">
            {selectedChapter?.title ?? textbook.title}
          </div>
        </div>

        <Button
          type="button"
          size="sm"
          className="shrink-0"
          aria-label={t('projectInfo.learnCurrentChapter')}
          disabled={!selectedChapter || starting}
          onClick={onStartLearning}
        >
          {starting ? <Loader2 className="animate-spin" /> : <Play />}
          <span className="hidden sm:inline">{t('projectInfo.learnCurrentChapter')}</span>
        </Button>
      </div>

      <div
        className={cn(
          'grid',
          panelOpen && 'md:grid-cols-[240px_minmax(0,1fr)]',
        )}
      >
        {panelOpen && (
          <nav
            className="relative h-64 overflow-y-auto border-b border-border/50 bg-foreground/[0.015] md:h-[min(68vh,650px)] md:border-b-0 md:border-r"
            aria-label={panel === 'contents'
              ? t('projectInfo.readerContents')
              : t('projectInfo.readerHighlights')}
          >
            <div className="absolute inset-y-0 left-0 w-px bg-foreground/10" aria-hidden="true" />
            {panel === 'contents' ? (
              <TocTree
                items={toc}
                activeKey={activeTocKey}
                onSelect={displayTocItem}
              />
            ) : (
              <div>
                <div className="sticky top-0 z-10 min-h-11 border-b border-border/50 bg-background/95 px-3 backdrop-blur flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {t('projectInfo.readerAllHighlights')}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-muted-foreground"
                    aria-label={t('projectInfo.readerExportHighlights')}
                    disabled={highlights.length === 0 || exporting}
                    onClick={() => void exportHighlights()}
                  >
                    {exporting ? <Loader2 className="animate-spin" /> : <Download />}
                    <span className="sr-only">{t('projectInfo.readerExportHighlights')}</span>
                  </Button>
                </div>

                {highlightsLoading ? (
                  <div className="h-32 flex items-center justify-center text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                ) : highlightOutline.items.length === 0 && highlightOutline.unmatched.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <Underline className="mx-auto h-5 w-5 text-muted-foreground/70" />
                    <p className="mt-2 text-xs font-medium text-foreground/80">
                      {t('projectInfo.readerNoHighlights')}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {t('projectInfo.readerHighlightHint')}
                    </p>
                  </div>
                ) : (
                  <div className="pb-2">
                    <HighlightOutline
                      items={highlightOutline.items}
                      deletingCfi={deletingCfi}
                      deleteLabel={t('projectInfo.readerDeleteHighlight')}
                      onSelect={(highlight) => void displayHighlight(highlight)}
                      onDelete={(highlight) => void deleteHighlight(highlight)}
                    />
                    {highlightOutline.unmatched.map((group) => (
                      <section key={`${group.chapterOrder}:${group.chapterId}`}>
                        <h3 className="border-b border-border/40 bg-background/70 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                          {group.chapterTitle}
                        </h3>
                        <HighlightEntries
                          highlights={group.highlights}
                          depth={0}
                          deletingCfi={deletingCfi}
                          deleteLabel={t('projectInfo.readerDeleteHighlight')}
                          onSelect={(highlight) => void displayHighlight(highlight)}
                          onDelete={(highlight) => void deleteHighlight(highlight)}
                        />
                      </section>
                    ))}
                  </div>
                )}
              </div>
            )}
          </nav>
        )}

        <section
          ref={readerViewportRef}
          className="relative h-[min(68vh,650px)] min-h-[520px] overflow-hidden bg-[#f8fafc] dark:bg-[#151821]"
        >
          <div ref={mountRef} className="h-full w-full overflow-hidden" />

          {pendingHighlight && selectionAnchor && status === 'ready' && (
            <div
              ref={selectionPopoverRef}
              role="toolbar"
              aria-label={t('projectInfo.readerHighlights')}
              data-placement={selectionAnchor.placement}
              className="absolute z-20 flex h-11 w-[88px] items-stretch overflow-hidden rounded-xl border border-white/10 bg-[#3f444d] p-1 text-zinc-100 shadow-modal-small"
              style={{ left: selectionAnchor.left, top: selectionAnchor.top }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                dismissSelectionPopover()
              }}
            >
              <Button
                ref={copyActionRef}
                type="button"
                variant="ghost"
                size="sm"
                className="h-full min-w-0 flex-1 rounded-lg px-0 text-zinc-200 hover:bg-white/10 hover:text-white"
                disabled={savingHighlight}
                onClick={() => void copyPendingSelection()}
              >
                <Copy className="h-[18px] w-[18px]" />
                <span className="sr-only">{t('common.copy')}</span>
              </Button>
              <div className="my-1.5 w-px bg-white/15" aria-hidden="true" />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-full min-w-0 flex-1 rounded-lg px-0 text-zinc-200 hover:bg-white/10 hover:text-white"
                disabled={savingHighlight}
                onClick={() => void savePendingHighlight()}
              >
                {savingHighlight
                  ? <Loader2 className="h-[18px] w-[18px] animate-spin" />
                  : <Waves className="h-[18px] w-[18px]" />}
                <span className="sr-only">{t('projectInfo.readerSaveHighlight')}</span>
              </Button>
            </div>
          )}

          {status !== 'ready' && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#f8fafc] px-6 text-center dark:bg-[#151821]">
              {status === 'loading' ? (
                <div className="space-y-3 text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  <p className="text-sm">{t('projectInfo.readerLoading')}</p>
                </div>
              ) : (
                <div className="max-w-sm space-y-2">
                  <BookOpenText className="mx-auto h-7 w-7 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">{t('projectInfo.readerLoadFailed')}</p>
                  {errorMessage && <p className="text-xs text-muted-foreground">{errorMessage}</p>}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="min-h-12 border-t border-border/50 px-3 flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={status !== 'ready' || moving || location.atStart}
          onClick={() => void move('previous')}
        >
          <ChevronLeft />
          {t('projectInfo.readerPrevious')}
        </Button>

        <span className="font-mono text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
          {t('projectInfo.readerProgress', {
            current: Math.min(Math.max(currentNumber, 1), textbook.chapters.length),
            total: textbook.chapters.length,
          })}
        </span>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={status !== 'ready' || moving || location.atEnd}
          onClick={() => void move('next')}
        >
          {t('projectInfo.readerNext')}
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}

type HighlightActionProps = {
  deletingCfi: string | null
  deleteLabel: string
  onSelect: (highlight: EpubHighlight) => void
  onDelete: (highlight: EpubHighlight) => void
}

function HighlightOutline({
  items,
  deletingCfi,
  deleteLabel,
  onSelect,
  onDelete,
  depth = 0,
}: HighlightActionProps & {
  items: EpubHighlightOutlineItem[]
  depth?: number
}) {
  if (items.length === 0) return null
  return (
    <ul className={cn(depth === 0 && 'py-2')}>
      {items.map((item) => (
        <HighlightOutlineItem
          key={item.key}
          item={item}
          depth={depth}
          deletingCfi={deletingCfi}
          deleteLabel={deleteLabel}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </ul>
  )
}

function HighlightOutlineItem({
  item,
  depth,
  deletingCfi,
  deleteLabel,
  onSelect,
  onDelete,
}: HighlightActionProps & {
  item: EpubHighlightOutlineItem
  depth: number
}) {
  const [expanded, setExpanded] = React.useState(true)

  return (
    <li>
      <button
        type="button"
        className="flex min-h-8 w-full items-center gap-1.5 pr-2 text-left text-xs text-foreground/65 hover:bg-foreground/[0.035] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ paddingLeft: 4 + Math.min(depth, 5) * 11 }}
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none',
            expanded && 'rotate-90',
          )}
        />
        <span className="line-clamp-2 leading-snug">{item.label}</span>
      </button>
      {expanded && (
        <>
          <HighlightEntries
            highlights={item.highlights}
            depth={depth + 1}
            deletingCfi={deletingCfi}
            deleteLabel={deleteLabel}
            onSelect={onSelect}
            onDelete={onDelete}
          />
          <HighlightOutline
            items={item.subitems}
            depth={depth + 1}
            deletingCfi={deletingCfi}
            deleteLabel={deleteLabel}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        </>
      )}
    </li>
  )
}

function HighlightEntries({
  highlights,
  depth,
  deletingCfi,
  deleteLabel,
  onSelect,
  onDelete,
}: HighlightActionProps & {
  highlights: EpubHighlight[]
  depth: number
}) {
  if (highlights.length === 0) return null
  return (
    <ul className="divide-y divide-border/40">
      {highlights.map((highlight) => (
        <li
          key={highlight.cfiRange}
          className="group flex items-start gap-1 py-1.5 pr-2"
          style={{ paddingLeft: 10 + Math.min(depth, 5) * 11 }}
        >
          <button
            type="button"
            className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-xs leading-relaxed text-foreground/75 hover:bg-foreground/[0.035] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => onSelect(highlight)}
          >
            <span className="line-clamp-3">{highlight.text}</span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 px-0 text-muted-foreground opacity-70 hover:text-destructive md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
            aria-label={deleteLabel}
            disabled={deletingCfi !== null}
            onClick={() => onDelete(highlight)}
          >
            {deletingCfi === highlight.cfiRange
              ? <Loader2 className="animate-spin" />
              : <Trash2 />}
          </Button>
        </li>
      ))}
    </ul>
  )
}

function TocTree({
  items,
  activeKey,
  onSelect,
  depth = 0,
}: {
  items: ReaderTocItem[]
  activeKey: string | null
  onSelect: (item: ReaderTocItem) => void
  depth?: number
}) {
  return (
    <ul className={cn(depth === 0 && 'py-2')}>
      {items.map((item) => (
        <TocTreeItem
          key={item.key}
          item={item}
          activeKey={activeKey}
          onSelect={onSelect}
          depth={depth}
        />
      ))}
    </ul>
  )
}

function TocTreeItem({
  item,
  activeKey,
  onSelect,
  depth,
}: {
  item: ReaderTocItem
  activeKey: string | null
  onSelect: (item: ReaderTocItem) => void
  depth: number
}) {
  const active = item.key === activeKey
  const activeWithin = active || containsTocKey(item.subitems, activeKey)
  const [expanded, setExpanded] = React.useState(activeWithin)
  const hasChildren = item.subitems.length > 0

  React.useEffect(() => {
    if (activeWithin) setExpanded(true)
  }, [activeWithin])

  return (
    <li>
      <div
        className={cn(
          'relative flex min-h-8 items-center pr-2 text-xs',
          active ? 'bg-foreground/[0.06] text-foreground' : 'text-foreground/65 hover:bg-foreground/[0.035]',
        )}
      >
        {active && (
          <span
            className="absolute inset-y-0 left-0 w-0.5"
            style={{ backgroundColor: 'var(--reader-accent)' }}
            aria-hidden="true"
          />
        )}
        {hasChildren ? (
          <button
            type="button"
            className="h-7 w-7 shrink-0 rounded-sm flex items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={{ marginLeft: 4 + Math.min(depth, 5) * 11 }}
            aria-label={item.label}
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} />
          </button>
        ) : (
          <span className="h-7 w-7 shrink-0" style={{ marginLeft: 4 + Math.min(depth, 5) * 11 }} />
        )}
        <button
          type="button"
          className="min-w-0 flex-1 py-1.5 text-left leading-snug focus-visible:outline-none focus-visible:underline"
          aria-current={active ? 'location' : undefined}
          onClick={() => onSelect(item)}
        >
          <span className="line-clamp-2">{item.label}</span>
        </button>
      </div>
      {hasChildren && expanded && (
        <TocTree
          items={item.subitems}
          activeKey={activeKey}
          onSelect={onSelect}
          depth={depth + 1}
        />
      )}
    </li>
  )
}

function mapNavigationItems(items: NavItem[], parentKey = 'toc'): ReaderTocItem[] {
  return items.map((item, index) => {
    const key = `${parentKey}:${index}:${item.id || 'item'}`
    return {
      key,
      label: item.label?.trim() || `Section ${index + 1}`,
      href: item.href,
      subitems: mapNavigationItems(item.subitems ?? [], key),
    }
  })
}

function fallbackToc(chapters: ImportedChapter[]): ReaderTocItem[] {
  return chapters.flatMap((chapter) => chapter.locator.format === 'epub'
    ? [{
        key: `spine:${chapter.locator.spineIndex}`,
        label: chapter.title,
        href: chapter.locator.href,
        spineIndex: chapter.locator.spineIndex,
        subitems: [],
      }]
    : [])
}

function findActiveTocKey(
  items: ReaderTocItem[],
  href: string,
  spineIndex: number,
): string | null {
  for (const item of items) {
    if (
      (item.spineIndex !== undefined && item.spineIndex === spineIndex)
      || (href && epubHrefsMatch(item.href, href))
    ) {
      return item.key
    }
    const nested = findActiveTocKey(item.subitems, href, spineIndex)
    if (nested) return nested
  }
  return null
}

function containsTocKey(items: ReaderTocItem[], key: string | null): boolean {
  if (!key) return false
  return items.some((item) => item.key === key || containsTocKey(item.subitems, key))
}

function loadDisplayOptions(book: Book): Promise<EpubDisplayOptions | undefined> {
  const loaded = book.loaded as typeof book.loaded & {
    displayOptions?: Promise<EpubDisplayOptions>
  }
  return loaded.displayOptions ?? Promise.resolve(undefined)
}

function getRenderedContents(rendition: Rendition): Contents[] {
  const contents = rendition.getContents() as unknown
  return Array.isArray(contents) ? contents as Contents[] : []
}

async function displayEpubCfi(
  rendition: Rendition,
  spineIndex: number,
  cfiRange: string,
): Promise<void> {
  // Loading the spine first avoids an epub.js continuous-flow stall when a
  // range CFI targets a view that has not been mounted yet.
  await rendition.display(spineIndex)
  await rendition.display(cfiRange)
}

function applyEpubHighlights(contents: Contents, highlights: EpubHighlight[]): void {
  try {
    const contentWindow = contents.window as Window & {
      CSS?: typeof CSS
      Highlight?: HighlightConstructor
    }
    const registry = (contentWindow.CSS as (typeof CSS & {
      highlights?: HighlightRegistryLike
    }) | undefined)?.highlights
    const HighlightForDocument = contentWindow.Highlight
    if (!registry || !HighlightForDocument) return

    const styleId = 'socratopia-epub-underline-style'
    if (!contents.document.getElementById(styleId)) {
      const style = contents.document.createElement('style')
      style.id = styleId
      style.textContent = createEpubUnderlineStyle()
      const styleRoot = contents.document.head ?? contents.document.documentElement
      styleRoot.appendChild(style)
    }

    const ranges = resolveEpubHighlightRanges(
      highlights,
      contents.sectionIndex,
      (cfiRange) => contents.range(cfiRange),
    )

    if (ranges.length === 0) {
      registry.delete(EPUB_UNDERLINE_HIGHLIGHT_NAME)
      return
    }
    registry.set(
      EPUB_UNDERLINE_HIGHLIGHT_NAME,
      new HighlightForDocument(...ranges),
    )
  } catch (error) {
    console.warn('[EpubReader] Failed to render saved underlines:', error)
  }
}

function downloadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.endsWith('.md') ? filename : `${filename}.md`
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }
}
