import * as React from 'react'
import ePub, {
  EpubCFI,
  type Book,
  type Contents,
  type Location,
  type Rendition,
} from 'epubjs'
import {
  BookOpenText,
  ChevronRight,
  Download,
  Highlighter,
  ListTree,
  Loader2,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type {
  EpubHighlightV1,
  EpubTocNode,
  ProjectFileMetadata,
  SourceFingerprint,
} from '@craft-agent/shared/project-files'
import { MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS } from '@craft-agent/shared/project-files'

import { useTheme } from '@/context/ThemeContext'
import { Button } from '@/components/ui/button'
import {
  buildEpubHighlightsMarkdown,
  buildEpubHighlightTree,
  type EpubHighlightTree,
  type EpubHighlightTreeNode,
} from '@/lib/epub-highlights'
import { saveTextFile } from '@/lib/save-text-file'
import { cn } from '@/lib/utils'
import { registerOpenProjectFileDocument } from './project-file-document-registry'
import { ProjectFileReaderSelectionToolbar } from './ProjectFileReaderSelectionToolbar'
import {
  attachEpubContentsSelectionLifecycle,
  createEpubSerializeHook,
  createIdempotentEpubCleanup,
  createEpubResizeScheduler,
  EPUB_RESOURCE_REPLACEMENTS,
  findCurrentEpubTocNode,
  getEpubNavigationLayout,
  getEpubReaderTheme,
  getEpubRenditionOptions,
  getEpubSelectionViewportRect,
  isFixedLayoutEpub,
  mapEpubNavigation,
  shouldBlockEpubLink,
  type EpubSelectionViewportRect,
} from './project-file-epub'
import {
  createEpubCssHighlightManager,
  createEpubSelectionSnapshot,
  createEpubStateMutationCoordinator,
  createOptimisticEpubHighlight,
  deleteEpubHighlightOptimistically,
  displayEpubHighlightLocation,
  findEpubTocPath,
  getEpubHighlightsSuggestedFilename,
  persistOptimisticEpubHighlight,
  type EpubSelectionSnapshot,
} from './project-file-epub-state'

interface PendingEpubSelection {
  snapshot: EpubSelectionSnapshot
  anchorRect: EpubSelectionViewportRect
}

interface UnloadedEpubView {
  contents?: Contents
}

const LIGHT_THEME_NAME = 'stair-project-file-light'
const DARK_THEME_NAME = 'stair-project-file-dark'
const EPUB_CFI = new EpubCFI()
const compareCfi = (left: string, right: string) => EPUB_CFI.compare(left, right)

async function loadDisplayOptions(
  book: Book,
): Promise<{ fixedLayout?: string } | undefined> {
  const loaded = book.loaded as typeof book.loaded & {
    displayOptions?: Promise<{ fixedLayout?: string }>
  }
  return loaded.displayOptions
}

function attachEpubContentsGuards(contents: Contents): () => void {
  const document = contents.document
  const stop = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }
  const guard = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('form')) {
      stop(event)
      return
    }
    const link = target.closest('a[href], area[href]')
    if (link && shouldBlockEpubLink(
      link.getAttribute('href'),
      link.getAttribute('target'),
    )) {
      stop(event)
    }
  }
  document.addEventListener('click', guard, true)
  document.addEventListener('auxclick', guard, true)
  document.addEventListener('submit', stop, true)
  return () => {
    document.removeEventListener('click', guard, true)
    document.removeEventListener('auxclick', guard, true)
    document.removeEventListener('submit', stop, true)
  }
}

function captureEpubSelection(
  book: Book,
  toc: EpubTocNode[],
  cfiRange: string,
  contents: Contents,
): PendingEpubSelection {
  const selection = contents.window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    throw new Error('Select some text first.')
  }
  const range = selection.getRangeAt(0)
  const section = book.spine.get(contents.sectionIndex)
  const chapter = findCurrentEpubTocNode(toc, section?.href)
  let contextBefore = ''
  let contextAfter = ''
  try {
    const walker = contents.document.createTreeWalker(
      contents.document.body ?? contents.document.documentElement,
      NodeFilter.SHOW_TEXT,
    )
    const textNodes: Text[] = []
    let node: Node | null = walker.nextNode()
    while (node) {
      textNodes.push(node as Text)
      node = walker.nextNode()
    }

    const startIndex = range.startContainer.nodeType === Node.TEXT_NODE
      ? textNodes.indexOf(range.startContainer as Text)
      : textNodes.findIndex(text => range.startContainer.contains(text))
    const before: string[] = []
    let remaining = MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS
    for (let index = startIndex; index >= 0 && remaining > 0; index -= 1) {
      const text = textNodes[index]
      const value = index === startIndex && text === range.startContainer
        ? text.data.slice(0, range.startOffset)
        : text.data
      const chunk = value.slice(-remaining)
      before.unshift(chunk)
      remaining -= chunk.length
    }
    contextBefore = before.join('')

    const endIndex = range.endContainer.nodeType === Node.TEXT_NODE
      ? textNodes.indexOf(range.endContainer as Text)
      : textNodes.findIndex(text => range.endContainer.contains(text))
    const after: string[] = []
    remaining = MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS
    for (
      let index = endIndex;
      index >= 0 && index < textNodes.length && remaining > 0;
      index += 1
    ) {
      const text = textNodes[index]
      const value = index === endIndex && text === range.endContainer
        ? text.data.slice(range.endOffset)
        : text.data
      const chunk = value.slice(0, remaining)
      after.push(chunk)
      remaining -= chunk.length
    }
    contextAfter = after.join('')
  } catch {
    // Exact quote and CFI remain usable when nearby context cannot be read.
  }

  const iframe = contents.window.frameElement
  if (!(iframe instanceof HTMLIFrameElement)) {
    throw new Error('The selection actions could not be positioned.')
  }
  const rangeRects = Array.from(range.getClientRects())
  if (!rangeRects.some(rect => rect.width > 0 && rect.height > 0)) {
    rangeRects.push(range.getBoundingClientRect())
  }
  const anchorRect = getEpubSelectionViewportRect(
    rangeRects,
    iframe.getBoundingClientRect(),
    { width: iframe.clientWidth, height: iframe.clientHeight },
  )
  if (!anchorRect) throw new Error('The selection actions could not be positioned.')

  return {
    snapshot: createEpubSelectionSnapshot({
      cfiRange,
      quote: range.toString(),
      contextBefore,
      contextAfter,
      chapter,
      tocPath: findEpubTocPath(toc, chapter?.key),
      spineIndex: contents.sectionIndex,
    }),
    anchorRect,
  }
}

export function ProjectFileEpubReader({
  projectId,
  relativePath,
  metadata,
  bytes,
  sourceFingerprint,
  initialCfi,
}: {
  projectId: string
  relativePath: string
  metadata: ProjectFileMetadata
  bytes: Uint8Array
  sourceFingerprint: SourceFingerprint
  initialCfi?: string
}) {
  const { isDark } = useTheme()
  const { t } = useTranslation()
  const readerShellRef = React.useRef<HTMLDivElement>(null)
  const mountRef = React.useRef<HTMLDivElement>(null)
  const viewportRef = React.useRef<HTMLElement>(null)
  const renditionRef = React.useRef<Rendition | null>(null)
  const isDarkRef = React.useRef(isDark)
  const reflowableRef = React.useRef(false)
  const coordinatorRef = React.useRef<ReturnType<
    typeof createEpubStateMutationCoordinator
  > | null>(null)
  const highlightManagerRef = React.useRef<ReturnType<
    typeof createEpubCssHighlightManager
  > | null>(null)
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = React.useState(0)
  const [error, setError] = React.useState('')
  const [toc, setToc] = React.useState<EpubTocNode[]>([])
  const [location, setLocation] = React.useState<Partial<Location['start']>>({})
  const [bookTitle, setBookTitle] = React.useState(metadata.name)
  const [bookAuthor, setBookAuthor] = React.useState('')
  const [navOpen, setNavOpen] = React.useState(true)
  const [compactNavigation, setCompactNavigation] = React.useState(false)
  const [tab, setTab] = React.useState<'contents' | 'highlights'>('contents')
  const [highlights, setHighlights] = React.useState<EpubHighlightV1[]>([])
  const [selection, setSelection] = React.useState<PendingEpubSelection | null>(null)
  const [notice, setNotice] = React.useState('')
  const [moving, setMoving] = React.useState(false)
  const [savingHighlight, setSavingHighlight] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)

  const wavyHighlights = React.useMemo(
    () => highlights.filter(highlight => highlight.style.type === 'wavy'),
    [highlights],
  )
  const highlightTree = React.useMemo(
    () => buildEpubHighlightTree(toc, wavyHighlights, compareCfi),
    [toc, wavyHighlights],
  )

  isDarkRef.current = isDark

  React.useLayoutEffect(() => {
    const shell = readerShellRef.current
    if (!shell) return

    let wasCompact: boolean | null = null
    const update = () => {
      const nextCompact = getEpubNavigationLayout(
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

  const dismissSelection = React.useCallback(() => {
    const rendition = renditionRef.current
    if (rendition) {
      for (const contents of rendition.getContents() as unknown as Contents[]) {
        contents.window.getSelection()?.removeAllRanges()
      }
    }
    setSelection(null)
  }, [])

  React.useEffect(() => {
    highlightManagerRef.current?.sync(highlights)
  }, [highlights])

  React.useEffect(() => {
    if (!reflowableRef.current) return
    renditionRef.current?.themes.select(isDark ? DARK_THEME_NAME : LIGHT_THEME_NAME)
  }, [isDark])

  React.useEffect(() => {
    let disposed = false
    let book: Book | null = null
    let rendition: Rendition | null = null
    let coordinator: ReturnType<typeof createEpubStateMutationCoordinator> | null = null
    let unregisterDocument: () => void = () => undefined
    let resizeObserver: ResizeObserver | null = null
    let resizeScheduler: ReturnType<typeof createEpubResizeScheduler> | null = null
    let serializeHook: ReturnType<typeof createEpubSerializeHook> | null = null
    let contentHook: ((contents: Contents) => void) | null = null
    let unloadedHook: ((view: UnloadedEpubView) => void) | null = null
    const contentCleanups = new Map<Document, () => void>()
    const highlightManager = createEpubCssHighlightManager()
    let loadedToc: EpubTocNode[] = []
    let loadedTitle = metadata.name
    const mount = mountRef.current

    const handleRelocated = (nextLocation: Location) => {
      if (disposed) return
      const start = nextLocation.start
      setLocation(start)
      const chapter = findCurrentEpubTocNode(loadedToc, start.href)
      if (start.cfi) {
        coordinator?.scheduleProgress({
          cfi: start.cfi,
          ...(chapter?.key ? { chapterKey: chapter.key } : {}),
          ...(typeof start.percentage === 'number'
            ? { percentage: Math.min(1, Math.max(0, start.percentage)) }
            : {}),
        })
      }
    }

    const handleSelected = (cfiRange: string, contents: Contents) => {
      if (disposed || !book) return
      try {
        setSelection(captureEpubSelection(book, loadedToc, cfiRange, contents))
        setNotice('')
      } catch (selectionError) {
        setSelection(null)
        setNotice(selectionError instanceof Error
          ? selectionError.message
          : String(selectionError))
      }
    }

    const cleanup = createIdempotentEpubCleanup([
      () => { disposed = true },
      () => {
        if (coordinatorRef.current === coordinator) coordinatorRef.current = null
        void (coordinator?.dispose() ?? Promise.resolve())
          .catch(disposeError => {
            console.error('[ProjectFileEpubReader] Progress flush failed:', disposeError)
          })
          .finally(unregisterDocument)
      },
      () => resizeObserver?.disconnect(),
      () => resizeScheduler?.cancel(),
      () => mount?.removeEventListener('scroll', dismissSelection, true),
      () => {
        if (!rendition) return
        rendition.off('relocated', handleRelocated)
        rendition.off('selected', handleSelected)
        if (contentHook) rendition.hooks.content.deregister(contentHook)
        if (unloadedHook) rendition.hooks.unloaded.deregister(unloadedHook)
      },
      () => {
        for (const remove of contentCleanups.values()) remove()
        contentCleanups.clear()
      },
      () => {
        highlightManager.destroy()
        if (highlightManagerRef.current === highlightManager) {
          highlightManagerRef.current = null
        }
      },
      () => {
        if (book && serializeHook) book.spine.hooks.serialize.deregister(serializeHook)
      },
      () => book?.destroy(),
      () => {
        if (renditionRef.current === rendition) renditionRef.current = null
        reflowableRef.current = false
        mount?.replaceChildren()
      },
    ])

    const load = async () => {
      setStatus('loading')
      setError('')
      setToc([])
      setHighlights([])
      setSelection(null)
      setBookTitle(metadata.name)
      setBookAuthor('')
      setNotice('')
      setExporting(false)
      try {
        if (!mount) throw new Error('EPUB reader mount point is unavailable')
        // epub.js creates blob URLs quickly. The serialize hook registered
        // below converts only resources used by the current section to data
        // URLs, keeping Craft's application-wide CSP unchanged.
        book = ePub(bytes.slice().buffer, {
          replacements: EPUB_RESOURCE_REPLACEMENTS,
        })
        const stateRequest = { projectId, relativePath, sourceFingerprint }
        let stateLoadError: unknown
        let openTimeout: ReturnType<typeof setTimeout> | undefined
        const opening = Promise.race([
          book.opened,
          new Promise<never>((_, reject) => {
            openTimeout = setTimeout(() => {
              reject(new Error('EPUB opening timed out.'))
            }, 60_000)
          }),
        ]).finally(() => clearTimeout(openTimeout))
        const [, navigation, epubMetadata, displayOptions, loadedState] = await Promise.all([
          opening,
          book.loaded.navigation,
          book.loaded.metadata,
          loadDisplayOptions(book),
          window.electronAPI.getEpubDocumentState(stateRequest).catch(stateError => {
            stateLoadError = stateError
            return null
          }),
        ])
        if (disposed) return
        // Register after book.opened so epub.js performs its blob substitution
        // first and this final hook can materialize the substituted output.
        serializeHook = createEpubSerializeHook()
        book.spine.hooks.serialize.register(serializeHook)
        loadedToc = mapEpubNavigation(navigation.toc)
        loadedTitle = epubMetadata.title?.trim() || metadata.name
        setToc(loadedToc)
        setBookTitle(loadedTitle)
        setBookAuthor(epubMetadata.creator?.trim() || '')
        if (stateLoadError) {
          setNotice('Reading progress and highlights could not be loaded.')
        }
        const matchingState = loadedState
          && loadedState.projectId === projectId
          && loadedState.relativePath === relativePath
          && loadedState.sourceFingerprint === sourceFingerprint
          ? loadedState
          : null
        const loadedHighlights = matchingState?.highlights ?? []
        setHighlights(loadedHighlights)
        highlightManager.sync(loadedHighlights)
        highlightManagerRef.current = highlightManager

        coordinator = createEpubStateMutationCoordinator({
          initialRevision: matchingState?.revision ?? 0,
          applyMutation: mutation => window.electronAPI.applyEpubStateMutation({
            ...stateRequest,
            mutation,
          }),
          getState: () => window.electronAPI.getEpubDocumentState(stateRequest),
          onStateRefresh: refreshed => {
            if (!disposed) setHighlights(refreshed.highlights)
          },
          onBackgroundError: (backgroundError, operation) => {
            console.error(`[ProjectFileEpubReader] ${operation} failed:`, backgroundError)
            if (!disposed) setNotice('Reading state could not be saved.')
          },
        })
        coordinatorRef.current = coordinator
        unregisterDocument = registerOpenProjectFileDocument(projectId, relativePath, {
          flush: () => coordinator!.flush(),
        })

        const fixedLayout = isFixedLayoutEpub(
          epubMetadata.layout,
          displayOptions?.fixedLayout,
        )
        reflowableRef.current = !fixedLayout
        rendition = book.renderTo(mount, getEpubRenditionOptions(fixedLayout))
        renditionRef.current = rendition
        contentHook = (contents: Contents) => {
          if (disposed || contentCleanups.has(contents.document)) return
          const frame = contents.window.frameElement
          if (frame instanceof HTMLIFrameElement) {
            frame.setAttribute('sandbox', 'allow-same-origin')
            frame.setAttribute('title', loadedTitle)
          }
          const removeGuards = attachEpubContentsGuards(contents)
          const removeHighlights = highlightManager.registerContents(contents)
          const removeSelectionLifecycle = attachEpubContentsSelectionLifecycle(
            contents,
            dismissSelection,
          )
          contentCleanups.set(contents.document, () => {
            removeGuards()
            removeHighlights()
            removeSelectionLifecycle()
          })
        }
        unloadedHook = (view: UnloadedEpubView) => {
          dismissSelection()
          const document = view.contents?.document
          if (!document) return
          contentCleanups.get(document)?.()
          contentCleanups.delete(document)
        }
        rendition.hooks.content.register(contentHook)
        rendition.hooks.unloaded.register(unloadedHook)
        rendition.on('relocated', handleRelocated)
        rendition.on('selected', handleSelected)
        if (!fixedLayout) {
          rendition.themes.register(LIGHT_THEME_NAME, getEpubReaderTheme('light'))
          rendition.themes.register(DARK_THEME_NAME, getEpubReaderTheme('dark'))
          rendition.themes.select(isDarkRef.current ? DARK_THEME_NAME : LIGHT_THEME_NAME)
        }
        const targetCfi = initialCfi ?? matchingState?.progress?.cfi
        if (targetCfi) {
          try {
            await displayEpubHighlightLocation(rendition, targetCfi)
          } catch {
            await rendition.display(0)
          }
        } else {
          await rendition.display(0)
        }
        if (disposed) return

        if (typeof ResizeObserver !== 'undefined') {
          const bounds = mount.getBoundingClientRect()
          resizeScheduler = createEpubResizeScheduler(
            (width, height) => rendition?.resize(width, height),
            bounds,
          )
          resizeObserver = new ResizeObserver(() => {
            dismissSelection()
            const next = mount.getBoundingClientRect()
            resizeScheduler?.schedule(next.width, next.height)
          })
          resizeObserver.observe(mount)
        }
        setStatus('ready')
      } catch (loadError) {
        if (disposed) return
        cleanup()
        console.error('[ProjectFileEpubReader] Render failed:', loadError)
        setError(loadError instanceof Error ? loadError.message : String(loadError))
        setStatus('error')
      }
    }

    mount?.addEventListener('scroll', dismissSelection, true)
    void load()
    return cleanup
  }, [attempt, bytes, dismissSelection, initialCfi, metadata.name, projectId, relativePath, sourceFingerprint])

  const currentChapter = React.useMemo(
    () => findCurrentEpubTocNode(toc, location.href),
    [location.href, toc],
  )

  const displayTocNode = React.useCallback(async (node: EpubTocNode) => {
    const rendition = renditionRef.current
    if (!rendition || !node.href || moving) return
    dismissSelection()
    setMoving(true)
    try {
      await rendition.display(node.href)
    } catch (navigationError) {
      console.error('[ProjectFileEpubReader] TOC navigation failed:', navigationError)
      setNotice('This chapter could not be opened.')
    } finally {
      setMoving(false)
    }
    if (compactNavigation) setNavOpen(false)
  }, [compactNavigation, dismissSelection, moving])

  const displayHighlight = React.useCallback(async (highlight: EpubHighlightV1) => {
    const rendition = renditionRef.current
    if (!rendition || moving) return
    dismissSelection()
    setMoving(true)
    try {
      await displayEpubHighlightLocation(rendition, highlight.cfiRange)
    } catch (revealError) {
      console.error('[ProjectFileEpubReader] Highlight reveal failed:', revealError)
      setNotice('This highlight could not be located in the book.')
    } finally {
      setMoving(false)
    }
    if (compactNavigation) setNavOpen(false)
  }, [compactNavigation, dismissSelection, moving])

  const createHighlight = React.useCallback(async () => {
    const snapshot = selection?.snapshot
    const coordinator = coordinatorRef.current
    if (!snapshot || !coordinator) {
      setNotice('Highlights are not ready yet.')
      return
    }
    if (highlights.some(highlight => highlight.cfiRange === snapshot.cfiRange)) {
      setTab('highlights')
      dismissSelection()
      setNotice('This selection is already highlighted.')
      return
    }
    setSavingHighlight(true)
    const highlight = createOptimisticEpubHighlight(
      snapshot,
      globalThis.crypto.randomUUID(),
    )
    dismissSelection()
    setTab('highlights')
    try {
      await persistOptimisticEpubHighlight({
        highlight,
        mutate: mutation => coordinator.mutate(mutation),
        updateHighlights: setHighlights,
      })
    } catch (highlightError) {
      console.error('[ProjectFileEpubReader] Highlight save failed:', highlightError)
      setNotice('The highlight could not be saved.')
    } finally {
      setSavingHighlight(false)
    }
  }, [dismissSelection, highlights, selection])

  const deleteHighlight = React.useCallback(async (highlight: EpubHighlightV1) => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    try {
      await deleteEpubHighlightOptimistically({
        highlight,
        mutate: mutation => coordinator.mutate(mutation),
        updateHighlights: setHighlights,
      })
    } catch (deleteError) {
      console.error('[ProjectFileEpubReader] Highlight delete failed:', deleteError)
      setNotice('The highlight could not be deleted.')
    }
  }, [])

  const exportHighlights = React.useCallback(async () => {
    if (wavyHighlights.length === 0 || exporting) return
    const content = buildEpubHighlightsMarkdown({
      bookTitle,
      fileName: metadata.name,
      toc,
      highlights: wavyHighlights,
      compareCfi,
    })
    if (!content) return

    setExporting(true)
    try {
      const result = await saveTextFile({
        suggestedName: getEpubHighlightsSuggestedFilename(
          bookTitle,
          metadata.name,
        ),
        content,
      })
      if (result.saved) setNotice('')
    } catch (exportError) {
      console.error('[ProjectFileEpubReader] Highlight export failed:', exportError)
      setNotice(t('projectFileReader.exportFailed'))
    } finally {
      setExporting(false)
    }
  }, [bookTitle, exporting, metadata.name, t, toc, wavyHighlights])

  const percentage = typeof location.percentage === 'number'
    ? Math.round(Math.min(1, Math.max(0, location.percentage)) * 100)
    : 0

  return (
    <div
      ref={readerShellRef}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-3">
        <Button
          type="button"
          variant={navOpen ? 'secondary' : 'ghost'}
          size="icon"
          className="size-8"
          aria-label="Toggle EPUB navigation"
          aria-expanded={navOpen}
          onClick={() => setNavOpen(open => !open)}
        >
          <ListTree />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <BookOpenText className="size-3" />
            <span className="truncate">
              EPUB{bookAuthor ? ` · ${bookAuthor}` : ''}
            </span>
          </div>
          <div
            className="mt-0.5 truncate text-sm font-medium text-foreground"
            title={currentChapter?.title || bookTitle}
          >
            {currentChapter?.title || bookTitle}
          </div>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">{percentage}%</span>
      </header>

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
            aria-label="Close EPUB navigation"
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
            aria-label="EPUB navigation"
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
                {toc.length > 0 ? (
                  <EpubTocTree
                    nodes={toc}
                    activeKey={currentChapter?.key ?? null}
                    moving={moving}
                    onSelect={node => void displayTocNode(node)}
                  />
                ) : (
                  <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                    This book has no table of contents.
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
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {wavyHighlights.length > 0 ? (
                    <EpubHighlightTreeView
                      tree={highlightTree}
                      moving={moving}
                      onSelect={highlight => void displayHighlight(highlight)}
                      onDelete={highlight => void deleteHighlight(highlight)}
                    />
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
          className={cn('relative min-h-0 overflow-hidden', isDark ? 'bg-[#151821]' : 'bg-[#f8fafc]')}
          aria-label={metadata.name}
        >
          <div ref={mountRef} className="h-full w-full overflow-hidden" />
          {selection && status === 'ready' && (
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
          {status !== 'ready' && (
            <div className={cn(
              'absolute inset-0 flex items-center justify-center px-6 text-center',
              isDark ? 'bg-[#151821]' : 'bg-[#f8fafc]',
            )}>
              {status === 'loading' ? (
                <div className="space-y-3 text-muted-foreground">
                  <Loader2 className="mx-auto size-5 animate-spin" />
                  <p className="text-sm">Opening EPUB…</p>
                </div>
              ) : (
                <div className="max-w-sm">
                  <BookOpenText className="mx-auto size-7 text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">Couldn’t open this EPUB</p>
                  <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{error}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    onClick={() => setAttempt(value => value + 1)}
                  >
                    <RotateCcw />
                    Retry
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function EpubHighlightTreeView({
  tree,
  moving,
  onSelect,
  onDelete,
}: {
  tree: EpubHighlightTree
  moving: boolean
  onSelect: (highlight: EpubHighlightV1) => void
  onDelete: (highlight: EpubHighlightV1) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="py-2">
      <EpubHighlightTreeNodes
        nodes={tree.nodes}
        moving={moving}
        onSelect={onSelect}
        onDelete={onDelete}
      />
      {tree.unmatched.length > 0 && (
        <section className="mt-2 border-t border-border/50 pt-2">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('projectFileReader.unrecognizedChapter')}
          </div>
          <EpubHighlightRows
            highlights={tree.unmatched}
            moving={moving}
            onSelect={onSelect}
            onDelete={onDelete}
            depth={0}
          />
        </section>
      )}
    </div>
  )
}

function EpubHighlightTreeNodes({
  nodes,
  moving,
  onSelect,
  onDelete,
  depth = 0,
}: {
  nodes: EpubHighlightTreeNode[]
  moving: boolean
  onSelect: (highlight: EpubHighlightV1) => void
  onDelete: (highlight: EpubHighlightV1) => void
  depth?: number
}) {
  return (
    <>
      {nodes.map(item => (
        <section key={item.node.key}>
          <div
            className="truncate py-1.5 pr-3 text-[11px] font-medium text-muted-foreground"
            style={{ paddingLeft: `${12 + depth * 12}px` }}
            title={item.node.title}
          >
            {item.node.title}
          </div>
          <EpubHighlightRows
            highlights={item.highlights}
            moving={moving}
            onSelect={onSelect}
            onDelete={onDelete}
            depth={depth}
          />
          <EpubHighlightTreeNodes
            nodes={item.children}
            moving={moving}
            onSelect={onSelect}
            onDelete={onDelete}
            depth={depth + 1}
          />
        </section>
      ))}
    </>
  )
}

function EpubHighlightRows({
  highlights,
  moving,
  onSelect,
  onDelete,
  depth,
}: {
  highlights: EpubHighlightV1[]
  moving: boolean
  onSelect: (highlight: EpubHighlightV1) => void
  onDelete: (highlight: EpubHighlightV1) => void
  depth: number
}) {
  return (
    <>
      {highlights.map(highlight => (
        <div
          key={highlight.id}
          className="group relative flex min-h-10 items-start gap-1 pr-1 hover:bg-foreground/[0.025]"
          style={{ paddingLeft: `${19 + depth * 12}px` }}
        >
          <span
            className="mt-3.5 size-1.5 shrink-0 rounded-full bg-red-500/80"
            aria-hidden="true"
          />
          <button
            type="button"
            className="min-w-0 flex-1 py-2 text-left"
            disabled={moving}
            title={highlight.quote}
            onClick={() => onSelect(highlight)}
          >
            <span className="line-clamp-2 text-xs leading-relaxed text-foreground/85">
              {highlight.quote}
            </span>
          </button>
          <button
            type="button"
            className="mt-1.5 grid size-7 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-red-500/10 hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
            aria-label={`Delete highlight: ${highlight.quote}`}
            onClick={() => onDelete(highlight)}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </>
  )
}

function EpubTocTree({
  nodes,
  activeKey,
  moving,
  onSelect,
  depth = 0,
}: {
  nodes: EpubTocNode[]
  activeKey: string | null
  moving: boolean
  onSelect: (node: EpubTocNode) => void
  depth?: number
}) {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())
  return (
    <ul role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map(node => {
        const expanded = node.children.length > 0 && !collapsed.has(node.key)
        return (
          <li key={node.key} role="treeitem" aria-current={node.key === activeKey ? 'location' : undefined}>
            <div
              className={cn(
                'flex min-h-8 items-center pr-2 text-xs',
                node.key === activeKey
                  ? 'bg-foreground/[0.06] text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground',
              )}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
            >
              {node.children.length > 0 ? (
                <button
                  type="button"
                  className="grid size-7 shrink-0 place-items-center"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.title}`}
                  aria-expanded={expanded}
                  onClick={() => setCollapsed(current => {
                    const next = new Set(current)
                    if (next.has(node.key)) next.delete(node.key)
                    else next.add(node.key)
                    return next
                  })}
                >
                  <ChevronRight className={cn('size-3.5', expanded && 'rotate-90')} />
                </button>
              ) : <span className="size-7 shrink-0" />}
              <button
                type="button"
                className="min-w-0 flex-1 truncate py-1 text-left"
                disabled={!node.href || moving}
                onClick={() => onSelect(node)}
              >
                {node.title}
              </button>
            </div>
            {expanded && (
              <EpubTocTree
                nodes={node.children}
                activeKey={activeKey}
                moving={moving}
                onSelect={onSelect}
                depth={depth + 1}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
