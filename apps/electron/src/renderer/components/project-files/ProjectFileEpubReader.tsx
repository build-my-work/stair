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
  MessageSquareQuote,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'

import type {
  EpubHighlightV1,
  EpubProjectFileReferenceV1,
  ProjectFileSelectionReferenceV1,
  ProjectFileIdentity,
  SourceFingerprint,
} from '@craft-agent/core/types'
import type { ProjectFileMetadata } from '@craft-agent/shared/protocol'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'

import { useTheme } from '@/context/ThemeContext'
import {
  buildEpubHighlightsMarkdown,
  buildEpubHighlightTree,
  type EpubHighlightTree,
  type EpubHighlightTreeNode,
} from '@/lib/epub-highlights'
import { cn } from '@/lib/utils'
import { EPUB_INLINE_NAV_MIN_WIDTH_PX } from '@/lib/panel-sizing'
import { Button } from '@/components/ui/button'
import { ChatTargetMenu } from '@/components/app-shell/ChatTargetMenu'

import {
  createEpubSerializeHook,
  createIdempotentEpubCleanup,
  createProjectFileEpubViewerKey,
  createEpubResizeScheduler,
  findCurrentEpubTocNode,
  getEpubReaderTheme,
  getEpubRenditionOptions,
  getEpubSelectionViewportRect,
  isFixedLayoutEpub,
  mapEpubNavigation,
  shouldBlockEpubLink,
  type EpubTocNode,
  type EpubSelectionViewportRect,
} from './project-file-epub'
import { EpubSelectionToolbar } from './EpubSelectionToolbar'
import {
  buildProjectFileReferenceFromSelection,
  createEpubCssHighlightManager,
  createEpubSelectionSnapshot,
  createEpubStateMutationCoordinator,
  createOptimisticEpubHighlight,
  deleteEpubHighlightOptimistically,
  displayEpubHighlightLocation,
  findEpubTocPath,
  getEpubHighlightsSuggestedFilename,
  persistOptimisticEpubHighlight,
  updateEpubInitialLocatorLatch,
  type EpubInitialLocatorLatch,
  type EpubSelectionSnapshot,
} from './project-file-epub-state'

interface ProjectFileEpubReaderProps {
  identity: ProjectFileIdentity
  metadata: ProjectFileMetadata
  bytes: Uint8Array
  sourceFingerprint: SourceFingerprint
  initialLocator?: {
    type: 'epub-cfi'
    cfiRange: string
  }
  chatTargetSessionId: string | null
  chatTargets: Array<{
    id: string
    title: string
  }>
  onReady: () => void
  onChatTargetChange: (sessionId: string) => void
  onAddChatReference: (
    reference: EpubProjectFileReferenceV1,
  ) => boolean | Promise<boolean>
  onAddNewChatReference: (
    reference: EpubProjectFileReferenceV1,
  ) => boolean | Promise<boolean>
  onAddNoteReference: (
    reference: ProjectFileSelectionReferenceV1,
    mode?: 'current' | 'choose-target',
  ) => boolean | Promise<boolean>
  onExportMarkdown: (exported: {
    suggestedFilename: string
    content: string
  }) => unknown | Promise<unknown>
}

interface RenderedView {
  iframe?: HTMLIFrameElement
  contents?: Contents
}

type ReaderStatus = 'loading' | 'ready' | 'error'
type ReaderSidebarTab = 'contents' | 'highlights' | 'references'

interface PendingEpubSelection {
  snapshot: EpubSelectionSnapshot
  anchorRect: EpubSelectionViewportRect
}

const LIGHT_THEME_NAME = 'craft-project-file-light'
const DARK_THEME_NAME = 'craft-project-file-dark'
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

function attachContentsGuards(contents: Contents): () => void {
  const contentDocument = contents.document

  const stop = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  const blockUnsafeInteraction = (event: Event) => {
    const target = event.target
    if (!target || typeof (target as Element).closest !== 'function') return
    const targetElement = target as Element

    if (targetElement.closest('form')) {
      stop(event)
      return
    }

    const link = targetElement.closest('a[href], area[href]')
    if (!link) return
    if (
      shouldBlockEpubLink(
        link.getAttribute('href'),
        link.getAttribute('target'),
      )
    ) {
      stop(event)
    }
  }

  const blockFormSubmit = (event: Event) => stop(event)

  contentDocument.addEventListener('click', blockUnsafeInteraction, true)
  contentDocument.addEventListener('auxclick', blockUnsafeInteraction, true)
  contentDocument.addEventListener('submit', blockFormSubmit, true)

  return () => {
    contentDocument.removeEventListener('click', blockUnsafeInteraction, true)
    contentDocument.removeEventListener('auxclick', blockUnsafeInteraction, true)
    contentDocument.removeEventListener('submit', blockFormSubmit, true)
  }
}

function attachContentsSelectionLifecycle(
  contents: Contents,
  dismissSelection: () => void,
): () => void {
  const contentDocument = contents.document
  const contentWindow = contents.window

  const handleSelectionChange = () => {
    const selection = contentWindow.getSelection()
    if (!selection || selection.isCollapsed) dismissSelection()
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') dismissSelection()
  }

  contentDocument.addEventListener('pointerdown', dismissSelection)
  contentDocument.addEventListener('selectionchange', handleSelectionChange)
  contentDocument.addEventListener('keydown', handleKeyDown)
  contentWindow.addEventListener('scroll', dismissSelection, { passive: true })

  return () => {
    contentDocument.removeEventListener('pointerdown', dismissSelection)
    contentDocument.removeEventListener('selectionchange', handleSelectionChange)
    contentDocument.removeEventListener('keydown', handleKeyDown)
    contentWindow.removeEventListener('scroll', dismissSelection)
  }
}

async function displayInitialLocation(
  rendition: Rendition,
  cfiRange: string | undefined,
): Promise<void> {
  if (!cfiRange) {
    await rendition.display(0)
    return
  }

  try {
    await displayEpubHighlightLocation(rendition, cfiRange)
  } catch {
    await rendition.display(0)
  }
}

function captureEpubSelection(
  book: Book,
  toc: EpubTocNode[],
  cfiRange: string,
  contents: Contents,
): PendingEpubSelection {
  const selection = contents.window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    throw new Error('Select some text first.')
  }
  const range = selection.getRangeAt(0)
  if (range.collapsed) throw new Error('Select some text first.')

  const section = book.spine.get(contents.sectionIndex)
  const chapter = findCurrentEpubTocNode(toc, section?.href)
  const root = contents.document.body ?? contents.document.documentElement
  let contextBefore = ''
  let contextAfter = ''
  try {
    const beforeRange = contents.document.createRange()
    beforeRange.selectNodeContents(root)
    beforeRange.setEnd(range.startContainer, range.startOffset)
    contextBefore = beforeRange.toString()

    const afterRange = contents.document.createRange()
    afterRange.selectNodeContents(root)
    afterRange.setStart(range.endContainer, range.endOffset)
    contextAfter = afterRange.toString()
  } catch {
    // The quote and CFI remain useful if a malformed publication prevents
    // context extraction across unusual document roots.
  }

  const iframe = contents.window.frameElement
  if (!(iframe instanceof HTMLIFrameElement)) {
    throw new Error('The selection actions could not be positioned.')
  }
  const rangeRects = Array.from(range.getClientRects())
  if (!rangeRects.some(rect => rect.width > 0 && rect.height > 0)) {
    rangeRects.push(range.getBoundingClientRect())
  }
  const frameRect = iframe.getBoundingClientRect()
  const anchorRect = getEpubSelectionViewportRect(
    rangeRects,
    frameRect,
    { width: iframe.clientWidth, height: iframe.clientHeight },
  )
  if (!anchorRect) {
    throw new Error('The selection actions could not be positioned.')
  }

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
  identity,
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
  onAddNoteReference,
  onExportMarkdown,
}: ProjectFileEpubReaderProps) {
  const { isDark } = useTheme()
  const readerShellRef = React.useRef<HTMLDivElement>(null)
  const mountRef = React.useRef<HTMLDivElement>(null)
  const readerViewportRef = React.useRef<HTMLElement>(null)
  const renditionRef = React.useRef<Rendition | null>(null)
  const stateCoordinatorRef =
    React.useRef<ReturnType<typeof createEpubStateMutationCoordinator> | null>(
      null,
    )
  const cssHighlightManagerRef =
    React.useRef<ReturnType<typeof createEpubCssHighlightManager> | null>(null)
  const reflowableRef = React.useRef(false)
  const isDarkRef = React.useRef(isDark)
  const onReadyRef = React.useRef(onReady)
  const clearSelectionRef = React.useRef<(() => void) | null>(null)
  const selectionDocumentRef = React.useRef<Document | null>(null)
  const readySignalKeyRef = React.useRef<string | null>(null)
  const initialLocatorLatchRef =
    React.useRef<EpubInitialLocatorLatch | null>(null)
  const viewerKey = createProjectFileEpubViewerKey(identity, sourceFingerprint)
  const initialLocatorLatch = updateEpubInitialLocatorLatch(
    initialLocatorLatchRef.current,
    viewerKey,
    initialLocator?.cfiRange,
  )
  initialLocatorLatchRef.current = initialLocatorLatch
  const effectiveInitialCfi = initialLocatorLatch.cfiRange
  const readySignalKey =
    `${viewerKey}\0${initialLocatorLatch.generation}\0${effectiveInitialCfi ?? ''}`
  const tocId = React.useId()

  isDarkRef.current = isDark
  onReadyRef.current = onReady

  const [status, setStatus] = React.useState<ReaderStatus>('loading')
  const [errorMessage, setErrorMessage] = React.useState('')
  const [attempt, setAttempt] = React.useState(0)
  const [tocOpen, setTocOpen] = React.useState(true)
  const [toc, setToc] = React.useState<EpubTocNode[]>([])
  const [location, setLocation] = React.useState<Partial<Location['start']>>({})
  const [bookTitle, setBookTitle] = React.useState(metadata.name)
  const [bookAuthor, setBookAuthor] = React.useState('')
  const [moving, setMoving] = React.useState(false)
  const [sidebarTab, setSidebarTab] = React.useState<ReaderSidebarTab>('contents')
  const [highlights, setHighlights] = React.useState<EpubHighlightV1[]>([])
  const [pendingSelection, setPendingSelection] =
    React.useState<PendingEpubSelection | null>(null)
  const [readerNotice, setReaderNotice] = React.useState('')
  const [exporting, setExporting] = React.useState(false)
  const [addingReferenceTo, setAddingReferenceTo] =
    React.useState<'current' | 'new' | null>(null)
  const [addingNote, setAddingNote] = React.useState(false)
  const [compact, setCompact] = React.useState(false)

  const dismissSelection = React.useCallback(() => {
    clearSelectionRef.current?.()
    clearSelectionRef.current = null
    selectionDocumentRef.current = null
    setPendingSelection(null)
  }, [])

  const currentChapter = React.useMemo(
    () => findCurrentEpubTocNode(toc, location.href),
    [location.href, toc],
  )
  const wavyHighlights = React.useMemo(
    () => highlights.filter(highlight => highlight.style.type === 'wavy'),
    [highlights],
  )
  const referenceUnderlines = React.useMemo(
    () => highlights.filter(highlight => highlight.style.type === 'solid'),
    [highlights],
  )
  const showingReferences = sidebarTab === 'references'
  const sidebarMarks = showingReferences
    ? referenceUnderlines
    : wavyHighlights
  const sidebarMarkNoun = showingReferences ? 'reference' : 'highlight'
  const sidebarMarkCount =
    `${sidebarMarks.length} ${sidebarMarkNoun}${sidebarMarks.length === 1 ? '' : 's'}`
  const emptySidebarTitle = showingReferences
    ? 'No chat references yet'
    : 'No highlights yet'
  const emptySidebarDescription = showingReferences
    ? 'Use Add Chat on selected text to add a straight underline.'
    : 'Select text in the book to add a red wavy underline.'
  const sidebarMarkTree = React.useMemo(
    () => buildEpubHighlightTree(toc, sidebarMarks, compareCfi),
    [sidebarMarks, toc],
  )

  React.useLayoutEffect(() => {
    const shell = readerShellRef.current
    if (!shell) return

    let wasCompact: boolean | null = null
    const update = () => {
      const nextCompact = (
        shell.getBoundingClientRect().width < EPUB_INLINE_NAV_MIN_WIDTH_PX
      )
      if (nextCompact && wasCompact !== true) setTocOpen(false)
      wasCompact = nextCompact
      setCompact(nextCompact)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    cssHighlightManagerRef.current?.sync(highlights)
  }, [highlights])

  React.useEffect(() => {
    let disposed = false
    let book: Book | null = null
    let rendition: Rendition | null = null
    let resizeObserver: ResizeObserver | null = null
    let resizeScheduler:
      ReturnType<typeof createEpubResizeScheduler> | null = null
    let serializeHook: ReturnType<typeof createEpubSerializeHook> | null = null
    let contentHook: ((contents: Contents) => void) | null = null
    let unloadedHook: ((view: RenderedView) => void) | null = null
    let stateCoordinator:
      ReturnType<typeof createEpubStateMutationCoordinator> | null = null
    const cssHighlightManager = createEpubCssHighlightManager()
    let loadedToc: EpubTocNode[] = []
    let loadedBookTitle = metadata.name
    const contentCleanups = new Map<Document, () => void>()
    const mount = mountRef.current

    const handleRelocated = (nextLocation: Location) => {
      if (disposed) return
      const start = nextLocation.start
      setLocation(start)
      const chapter = findCurrentEpubTocNode(loadedToc, start.href)
      if (start.cfi) {
        stateCoordinator?.scheduleProgress({
          cfi: start.cfi,
          ...(chapter?.key ? { chapterKey: chapter.key } : {}),
          ...(typeof start.percentage === 'number'
            ? {
                percentage: Math.min(
                  1,
                  Math.max(0, start.percentage),
                ),
              }
            : {}),
        })
      }
    }

    const handleSelected = (cfiRange: string, contents: Contents) => {
      if (disposed || !book) return
      try {
        const pending = captureEpubSelection(
          book,
          loadedToc,
          cfiRange,
          contents,
        )
        const selection = contents.window.getSelection()
        clearSelectionRef.current = () => selection?.removeAllRanges()
        selectionDocumentRef.current = contents.document
        setPendingSelection(pending)
        setReaderNotice('')
      } catch (error) {
        setPendingSelection(null)
        setReaderNotice(
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    const handleRendered = (_section: unknown, view: RenderedView) => {
      view.iframe?.setAttribute('sandbox', 'allow-same-origin')
      view.iframe?.setAttribute('title', loadedBookTitle)
    }

    const cleanup = createIdempotentEpubCleanup([
      () => {
        void stateCoordinator?.dispose().catch(error => {
          console.error(
            '[ProjectFileEpubReader] Failed to flush EPUB progress:',
            error,
          )
        })
      },
      () => {
        disposed = true
        clearSelectionRef.current?.()
        clearSelectionRef.current = null
        selectionDocumentRef.current = null
      },
      () => resizeObserver?.disconnect(),
      () => resizeScheduler?.cancel(),
      () => mount?.removeEventListener('scroll', dismissSelection, true),
      () => {
        if (!rendition) return
        rendition.off('relocated', handleRelocated)
        rendition.off('rendered', handleRendered)
        rendition.off('selected', handleSelected)
        if (contentHook) rendition.hooks.content.deregister(contentHook)
        if (unloadedHook) rendition.hooks.unloaded.deregister(unloadedHook)
      },
      () => {
        for (const removeListeners of contentCleanups.values()) removeListeners()
        contentCleanups.clear()
      },
      () => {
        cssHighlightManager.destroy()
        if (cssHighlightManagerRef.current === cssHighlightManager) {
          cssHighlightManagerRef.current = null
        }
      },
      () => {
        if (stateCoordinatorRef.current === stateCoordinator) {
          stateCoordinatorRef.current = null
        }
      },
      () => {
        if (book && serializeHook) book.spine.hooks.serialize.deregister(serializeHook)
      },
      () => {
        if (book) book.destroy()
        else rendition?.destroy()
      },
      () => {
        if (renditionRef.current === rendition) renditionRef.current = null
        if (mount) mount.replaceChildren()
      },
    ])

    const load = async () => {
      setStatus('loading')
      setErrorMessage('')
      setToc([])
      setLocation({})
      setBookTitle(metadata.name)
      setBookAuthor('')
      setHighlights([])
      setPendingSelection(null)
      setReaderNotice('')
      setExporting(false)
      setAddingReferenceTo(null)
      clearSelectionRef.current = null

      try {
        if (!mount) throw new Error('EPUB reader mount point is unavailable')
        mount.addEventListener('scroll', dismissSelection, true)
        const buffer = new Uint8Array(bytes).buffer
        book = ePub(buffer, { replacements: 'blobUrl' })
        serializeHook = createEpubSerializeHook()
        book.spine.hooks.serialize.register(serializeHook)

        let stateLoadError: unknown
        const stateRequest = {
          projectId: identity.projectId,
          relativePath: identity.relativePath,
          sourceFingerprint,
        }
        const [navigation, epubMetadata, displayOptions, loadedState] =
          await Promise.all([
            book.loaded.navigation,
            book.loaded.metadata,
            loadDisplayOptions(book),
            window.electronAPI.getEpubDocumentState(stateRequest).catch(error => {
              stateLoadError = error
              return null
            }),
          ])
        if (disposed) return

        const mappedToc = mapEpubNavigation(navigation.toc)
        loadedToc = mappedToc
        loadedBookTitle = epubMetadata.title?.trim() || metadata.name
        setToc(mappedToc)
        setBookTitle(loadedBookTitle)
        setBookAuthor(epubMetadata.creator?.trim() || '')
        if (stateLoadError) {
          setReaderNotice('Reading progress and highlights could not be loaded.')
        }

        const matchingState = loadedState
          && loadedState.projectId === identity.projectId
          && loadedState.relativePath === identity.relativePath
          && loadedState.sourceFingerprint === sourceFingerprint
          ? loadedState
          : null
        const loadedHighlights = matchingState?.highlights ?? []
        setHighlights(loadedHighlights)
        cssHighlightManager.sync(loadedHighlights)
        cssHighlightManagerRef.current = cssHighlightManager

        stateCoordinator = createEpubStateMutationCoordinator({
          initialRevision: matchingState?.revision ?? 0,
          applyMutation: mutation =>
            window.electronAPI.applyEpubStateMutation({
              ...stateRequest,
              mutation,
            }),
          getState: () =>
            window.electronAPI.getEpubDocumentState(stateRequest),
          onStateRefresh: state => {
            if (
              disposed
              || state.projectId !== identity.projectId
              || state.relativePath !== identity.relativePath
              || state.sourceFingerprint !== sourceFingerprint
            ) {
              return
            }
            setHighlights(state.highlights)
          },
          onBackgroundError: (error, operation) => {
            if (disposed) return
            console.error(
              `[ProjectFileEpubReader] EPUB state ${operation} failed:`,
              error,
            )
            setReaderNotice(
              operation === 'set-progress'
                ? 'Reading progress could not be saved.'
                : 'Highlights changed elsewhere and could not be refreshed.',
            )
          },
        })
        stateCoordinatorRef.current = stateCoordinator

        const fixedLayout = isFixedLayoutEpub(
          epubMetadata.layout,
          displayOptions?.fixedLayout,
        )
        reflowableRef.current = !fixedLayout
        rendition = book.renderTo(mount, getEpubRenditionOptions(fixedLayout))
        renditionRef.current = rendition

        contentHook = (contents: Contents) => {
          if (disposed || contentCleanups.has(contents.document)) return
          const removeGuards = attachContentsGuards(contents)
          const removeHighlights =
            cssHighlightManager.registerContents(contents)
          const removeSelectionLifecycle =
            attachContentsSelectionLifecycle(contents, dismissSelection)
          contentCleanups.set(contents.document, () => {
            removeGuards()
            removeHighlights()
            removeSelectionLifecycle()
          })
        }
        unloadedHook = (view: RenderedView) => {
          const document = view.contents?.document
          if (!document) return
          if (selectionDocumentRef.current === document) dismissSelection()
          contentCleanups.get(document)?.()
          contentCleanups.delete(document)
        }
        rendition.hooks.content.register(contentHook)
        rendition.hooks.unloaded.register(unloadedHook)
        rendition.on('relocated', handleRelocated)
        rendition.on('rendered', handleRendered)
        rendition.on('selected', handleSelected)

        if (!fixedLayout) {
          rendition.themes.register(LIGHT_THEME_NAME, getEpubReaderTheme('light'))
          rendition.themes.register(DARK_THEME_NAME, getEpubReaderTheme('dark'))
          rendition.themes.select(isDarkRef.current ? DARK_THEME_NAME : LIGHT_THEME_NAME)
        }

        await displayInitialLocation(
          rendition,
          effectiveInitialCfi ?? matchingState?.progress?.cfi,
        )
        if (disposed) return

        if (typeof ResizeObserver !== 'undefined') {
          const initialBounds = mount.getBoundingClientRect()
          resizeScheduler = createEpubResizeScheduler(
            (width, height) => {
              if (disposed || !rendition) return
              dismissSelection()
              rendition.resize(width, height)
            },
            initialBounds,
          )
          resizeObserver = new ResizeObserver(() => {
            if (disposed) return
            const bounds = mount.getBoundingClientRect()
            resizeScheduler?.schedule(bounds.width, bounds.height)
          })
          resizeObserver.observe(mount)
        }
        setStatus('ready')
        if (readySignalKeyRef.current !== readySignalKey) {
          readySignalKeyRef.current = readySignalKey
          try {
            onReadyRef.current()
          } catch (error) {
            console.error(
              '[ProjectFileEpubReader] onReady callback failed:',
              error,
            )
          }
        }
      } catch (error) {
        if (disposed) return
        cleanup()
        console.error('[ProjectFileEpubReader] Failed to render EPUB:', error)
        setErrorMessage(error instanceof Error ? error.message : String(error))
        setStatus('error')
      }
    }

    void load()
    return cleanup
  }, [
    attempt,
    bytes,
    dismissSelection,
    effectiveInitialCfi,
    identity.projectId,
    identity.relativePath,
    initialLocatorLatch.generation,
    metadata.name,
    readySignalKey,
    sourceFingerprint,
    viewerKey,
  ])

  React.useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition || !reflowableRef.current || status !== 'ready') return
    rendition.themes.select(isDark ? DARK_THEME_NAME : LIGHT_THEME_NAME)
  }, [isDark, status])

  const displayTocNode = React.useCallback(async (node: EpubTocNode) => {
    const rendition = renditionRef.current
    if (!rendition || !node.href || moving) return
    dismissSelection()
    setMoving(true)
    try {
      await rendition.display(node.href)
      if (compact) setTocOpen(false)
    } catch (error) {
      console.error('[ProjectFileEpubReader] Failed to open TOC item:', error)
    } finally {
      setMoving(false)
    }
  }, [compact, dismissSelection, moving])

  const createRedWavyHighlight = React.useCallback(async () => {
    const selection = pendingSelection?.snapshot
    const coordinator = stateCoordinatorRef.current
    if (!selection || !coordinator) return
    if (wavyHighlights.some(mark => mark.cfiRange === selection.cfiRange)) {
      setReaderNotice('This selection is already highlighted.')
      setSidebarTab('highlights')
      dismissSelection()
      return
    }

    const optimistic = createOptimisticEpubHighlight(
      selection,
      globalThis.crypto.randomUUID(),
    )
    dismissSelection()
    setSidebarTab('highlights')
    try {
      const response = await persistOptimisticEpubHighlight({
        highlight: optimistic,
        mutate: mutation => coordinator.mutate(mutation),
        updateHighlights: setHighlights,
      })
      if (!response.applied && !response.canonicalHighlight) {
        try {
          await coordinator.refresh()
        } catch (error) {
          console.error(
            '[ProjectFileEpubReader] Failed to canonicalize EPUB highlight:',
            error,
          )
          setReaderNotice('The saved highlight could not be refreshed.')
          return
        }
      }
      setReaderNotice('')
    } catch (error) {
      console.error(
        '[ProjectFileEpubReader] Failed to create EPUB highlight:',
        error,
      )
      setReaderNotice('The highlight could not be saved.')
    }
  }, [
    dismissSelection,
    pendingSelection,
    wavyHighlights,
  ])

  const addSelectionToChat = React.useCallback(async (
    target: 'current' | 'new',
  ) => {
    const selection = pendingSelection?.snapshot
    if (!selection || addingReferenceTo) return

    let attached = false
    setAddingReferenceTo(target)
    try {
      const addReference = target === 'new'
        ? onAddNewChatReference
        : onAddChatReference
      attached = await addReference(
        buildProjectFileReferenceFromSelection({
          identity,
          sourceFingerprint,
          fileName: metadata.name,
          selection,
        }),
      )
      dismissSelection()
      if (!attached) {
        setReaderNotice('')
        return
      }

      setSidebarTab('references')
      if (referenceUnderlines.some(
        mark => mark.cfiRange === selection.cfiRange,
      )) {
        setReaderNotice('')
        return
      }

      const coordinator = stateCoordinatorRef.current
      if (!coordinator) throw new Error('EPUB state coordinator is unavailable')
      const optimistic = createOptimisticEpubHighlight(
        selection,
        globalThis.crypto.randomUUID(),
        { style: { type: 'solid', color: 'blue' } },
      )
      const response = await persistOptimisticEpubHighlight({
        highlight: optimistic,
        mutate: mutation => coordinator.mutate(mutation),
        updateHighlights: setHighlights,
      })
      if (!response.applied && !response.canonicalHighlight) {
        await coordinator.refresh()
      }
      setReaderNotice('')
    } catch (error) {
      console.error(
        attached
          ? '[ProjectFileEpubReader] Failed to save EPUB reference underline:'
          : '[ProjectFileEpubReader] Failed to add EPUB reference:',
        error,
      )
      setReaderNotice(attached
        ? 'The selection was added to chat, but its underline could not be saved.'
        : 'The selection could not be added to chat.')
    } finally {
      setAddingReferenceTo(null)
    }
  }, [
    addingReferenceTo,
    dismissSelection,
    identity,
    metadata.name,
    onAddChatReference,
    onAddNewChatReference,
    pendingSelection,
    referenceUnderlines,
    sourceFingerprint,
  ])

  const addSelectionToNote = React.useCallback(async (
    mode: 'current' | 'choose-target' = 'current',
  ) => {
    const selection = pendingSelection?.snapshot
    if (!selection || addingNote || addingReferenceTo) return

    setAddingNote(true)
    try {
      const added = await onAddNoteReference(
        buildProjectFileReferenceFromSelection({
          identity,
          sourceFingerprint,
          fileName: metadata.name,
          selection,
        }),
        mode,
      )
      if (added) dismissSelection()
    } catch (error) {
      console.error(
        '[ProjectFileEpubReader] Failed to add EPUB selection to notes:',
        error,
      )
      setReaderNotice('The selection could not be added to the note file.')
    } finally {
      setAddingNote(false)
    }
  }, [
    addingNote,
    addingReferenceTo,
    dismissSelection,
    identity,
    metadata.name,
    onAddNoteReference,
    pendingSelection,
    sourceFingerprint,
  ])

  const displayHighlight = React.useCallback(async (
    highlight: EpubHighlightV1,
  ) => {
    const rendition = renditionRef.current
    if (!rendition || moving) return
    dismissSelection()
    setMoving(true)
    try {
      await displayEpubHighlightLocation(rendition, highlight.cfiRange)
      if (compact) setTocOpen(false)
    } catch (error) {
      console.error(
        '[ProjectFileEpubReader] Failed to open EPUB highlight:',
        error,
      )
      setReaderNotice('This highlight could not be located in the book.')
    } finally {
      setMoving(false)
    }
  }, [compact, dismissSelection, moving])

  const deleteHighlight = React.useCallback(async (
    highlight: EpubHighlightV1,
  ) => {
    const coordinator = stateCoordinatorRef.current
    if (!coordinator) return
    try {
      await deleteEpubHighlightOptimistically({
        highlight,
        mutate: mutation => coordinator.mutate(mutation),
        updateHighlights: setHighlights,
      })
      setReaderNotice('')
    } catch (error) {
      console.error(
        '[ProjectFileEpubReader] Failed to delete EPUB highlight:',
        error,
      )
      setReaderNotice('The highlight could not be deleted.')
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
      await onExportMarkdown({
        suggestedFilename: getEpubHighlightsSuggestedFilename(
          bookTitle,
          metadata.name,
        ),
        content,
      })
      setReaderNotice('')
    } catch (error) {
      console.error(
        '[ProjectFileEpubReader] Failed to export EPUB highlights:',
        error,
      )
      setReaderNotice('Highlights could not be exported.')
    } finally {
      setExporting(false)
    }
  }, [
    bookTitle,
    exporting,
    metadata.name,
    onExportMarkdown,
    toc,
    wavyHighlights,
  ])

  const chapterLabel = currentChapter?.title || bookTitle || metadata.name
  const percentage = typeof location.percentage === 'number'
    ? Math.min(100, Math.max(0, Math.round(location.percentage * 100)))
    : null

  return (
    <div
      ref={readerShellRef}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={tocOpen ? 'secondary' : 'ghost'}
              size="icon"
              className="size-8 shrink-0 text-muted-foreground"
              aria-label="Contents"
              aria-expanded={tocOpen}
              aria-controls={tocId}
              onClick={() => setTocOpen(open => !open)}
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
            <BookOpenText className="size-3" />
            <span className="truncate">
              EPUB{bookAuthor ? ` · ${bookAuthor}` : ''}
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground" title={chapterLabel}>
            {chapterLabel}
          </div>
        </div>

        {percentage !== null && (
          <span
            className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {percentage}%
          </span>
        )}
      </header>

      <div className={cn(
        'relative grid min-h-0 flex-1',
        tocOpen && !compact
          ? 'grid-cols-[minmax(240px,280px)_minmax(0,1fr)]'
          : 'grid-cols-1',
      )}>
        {tocOpen && compact && (
          <button
            type="button"
            className="absolute inset-0 z-20 bg-black/25"
            aria-label="Close EPUB navigation"
            onClick={() => setTocOpen(false)}
          />
        )}

        {tocOpen && (
          <nav
            id={tocId}
            className={cn(
              'relative z-30 flex min-h-0 flex-col overflow-hidden border-r border-border/60 bg-background',
              compact
                ? 'absolute inset-y-0 left-0 w-[min(84%,290px)] shadow-strong'
                : 'bg-foreground/[0.015]',
            )}
            aria-label="EPUB navigation"
          >
            <div className="absolute inset-y-0 left-0 w-px bg-foreground/10" aria-hidden="true" />

            <div
              className="flex h-11 shrink-0 items-end gap-1 border-b border-border/60 px-2"
              role="tablist"
              aria-label="EPUB navigation views"
            >
              <button
                type="button"
                role="tab"
                aria-selected={sidebarTab === 'contents'}
                className={cn(
                  'relative h-10 flex-1 px-2 text-xs font-medium',
                  sidebarTab === 'contents'
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setSidebarTab('contents')}
              >
                Contents
                {sidebarTab === 'contents' && (
                  <span
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-t bg-foreground/70"
                    aria-hidden="true"
                  />
                )}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebarTab === 'highlights'}
                className={cn(
                  'relative h-10 flex-1 px-2 text-xs font-medium',
                  sidebarTab === 'highlights'
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setSidebarTab('highlights')}
              >
                Highlights
                {wavyHighlights.length > 0 && (
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                    {wavyHighlights.length}
                  </span>
                )}
                {sidebarTab === 'highlights' && (
                  <span
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-t bg-red-500/80"
                    aria-hidden="true"
                  />
                )}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebarTab === 'references'}
                className={cn(
                  'relative h-10 flex-1 px-1 text-[11px] font-medium',
                  sidebarTab === 'references'
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setSidebarTab('references')}
              >
                References
                {referenceUnderlines.length > 0 && (
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                    {referenceUnderlines.length}
                  </span>
                )}
                {sidebarTab === 'references' && (
                  <span
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-t bg-blue-500/80"
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>

            {sidebarTab === 'contents' ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {toc.length > 0 ? (
                  <EpubTocTree
                    nodes={toc}
                    activeKey={currentChapter?.key ?? null}
                    moving={moving}
                    onSelect={displayTocNode}
                  />
                ) : (
                  <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                    This book has no table of contents.
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
                    <EpubHighlightTreeView
                      tree={sidebarMarkTree}
                      moving={moving}
                      onSelect={displayHighlight}
                      onDelete={deleteHighlight}
                    />
                  ) : (
                    <div className="px-5 py-10 text-center">
                      {showingReferences
                        ? <MessageSquareQuote className="mx-auto size-5 text-blue-400/80" />
                        : <Highlighter className="mx-auto size-5 text-red-400/80" />}
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
          ref={readerViewportRef}
          className={cn(
            'relative min-h-0 overflow-hidden',
            isDark ? 'bg-[#151821]' : 'bg-[#f8fafc]',
          )}
          aria-label={metadata.name}
        >
          <div ref={mountRef} className="h-full w-full overflow-hidden" />

          {pendingSelection && status === 'ready' && (
            <EpubSelectionToolbar
              anchorRect={pendingSelection.anchorRect}
              collisionBoundary={readerViewportRef.current}
              addingReferenceTo={addingReferenceTo}
              addingNote={addingNote}
              onCreateHighlight={() => void createRedWavyHighlight()}
              onAddNote={() => void addSelectionToNote()}
              onAddNoteTo={() => void addSelectionToNote('choose-target')}
              onAddChat={() => void addSelectionToChat('current')}
              onAddNewChat={() => void addSelectionToChat('new')}
              onDismiss={dismissSelection}
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
                  <p className="mt-3 text-sm font-medium text-foreground">
                    Couldn’t open this EPUB
                  </p>
                  {errorMessage && (
                    <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                      {errorMessage}
                    </p>
                  )}
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
            Unrecognized chapter
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
  if (nodes.length === 0) return null
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
      {highlights.map(highlight => {
        const isReference = highlight.style.type === 'solid'
        return (
          <div
            key={highlight.id}
            className="group relative flex min-h-10 items-start gap-1 pr-1 hover:bg-foreground/[0.025]"
            style={{ paddingLeft: `${19 + depth * 12}px` }}
          >
            <span
              className={cn(
                'mt-3.5 size-1.5 shrink-0 rounded-full',
                isReference ? 'bg-blue-500/80' : 'bg-red-500/80',
              )}
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
              className={cn(
                'mt-1.5 grid size-7 shrink-0 place-items-center rounded text-muted-foreground opacity-0 focus:opacity-100 group-hover:opacity-100',
                isReference
                  ? 'hover:bg-blue-500/10 hover:text-blue-500'
                  : 'hover:bg-red-500/10 hover:text-red-500',
              )}
              aria-label={
                isReference
                  ? `Remove reference underline: ${highlight.quote}`
                  : `Delete highlight: ${highlight.quote}`
              }
              onClick={() => onDelete(highlight)}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )
      })}
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

  if (nodes.length === 0) return null
  return (
    <ul className={cn(depth === 0 && 'py-2')} role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map(node => {
        const active = node.key === activeKey
        const hasChildren = node.children.length > 0
        const expanded = hasChildren && !collapsed.has(node.key)
        return (
          <li key={node.key} role="treeitem" aria-current={active ? 'location' : undefined}>
            <div
              className={cn(
                'relative flex min-h-8 items-center pr-2 text-sm',
                active
                  ? 'bg-foreground/[0.055] text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.025] hover:text-foreground',
              )}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
            >
              {active && (
                <span
                  className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-foreground/70"
                  aria-hidden="true"
                />
              )}
              {hasChildren ? (
                <button
                  type="button"
                  className="mr-0.5 grid size-7 shrink-0 place-items-center rounded hover:bg-foreground/5"
                  aria-label={expanded ? `Collapse ${node.title}` : `Expand ${node.title}`}
                  aria-expanded={expanded}
                  onClick={() => {
                    setCollapsed(current => {
                      const next = new Set(current)
                      if (next.has(node.key)) next.delete(node.key)
                      else next.add(node.key)
                      return next
                    })
                  }}
                >
                  <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
                </button>
              ) : (
                <span className="mr-0.5 size-7 shrink-0" aria-hidden="true" />
              )}
              <button
                type="button"
                className="min-w-0 flex-1 truncate py-1 text-left"
                title={node.title}
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
