import type { ImportedChapter, WorkingFileEpubHighlight } from '@craft-agent/shared/learning'

export const EPUB_UNDERLINE_HIGHLIGHT_NAME = 'socratopia-epub-underline'

export interface EpubHighlightChapterGroup {
  chapterId: string
  chapterTitle: string
  chapterOrder: number
  highlights: WorkingFileEpubHighlight[]
}

export interface EpubReaderTocItem {
  key: string
  label: string
  href: string
  spineIndex?: number
  subitems: EpubReaderTocItem[]
}

export interface EpubHighlightOutlineItem extends Omit<EpubReaderTocItem, 'subitems'> {
  highlights: WorkingFileEpubHighlight[]
  subitems: EpubHighlightOutlineItem[]
}

export interface EpubHighlightOutline {
  items: EpubHighlightOutlineItem[]
  unmatched: EpubHighlightChapterGroup[]
}

export interface EpubReaderRect {
  left: number
  top: number
  width: number
  height: number
}

export interface EpubSelectionPopoverAnchor {
  left: number
  top: number
  placement: 'above' | 'below'
}

export function getEpubRenditionOptions(fixedLayout: boolean) {
  return {
    width: '100%',
    height: '100%',
    manager: 'continuous',
    flow: 'scrolled',
    layout: fixedLayout ? 'pre-paginated' : 'reflowable',
    spread: 'none',
    allowScriptedContent: false,
  }
}

const SELECTION_POPOVER_WIDTH = 88
const SELECTION_POPOVER_HEIGHT = 44
const SELECTION_POPOVER_GAP = 8
const SELECTION_POPOVER_EDGE = 8

interface EpubLocationStart {
  index?: number
  href?: string
}

export function findChapterForEpubLocation(
  chapters: ImportedChapter[],
  location: EpubLocationStart,
): ImportedChapter | null {
  if (Number.isInteger(location.index)) {
    const bySpine = chapters.find(
      (chapter) => chapter.locator.format === 'epub' && chapter.locator.spineIndex === location.index,
    )
    if (bySpine) return bySpine
  }

  const href = location.href
  if (!href) return null
  return chapters.find(
    (chapter) => chapter.locator.format === 'epub' && epubHrefsMatch(chapter.locator.href, href),
  ) ?? null
}

export function epubHrefsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeEpubHref(left)
  const normalizedRight = normalizeEpubHref(right)
  if (!normalizedLeft || !normalizedRight) return false
  return normalizedLeft === normalizedRight
    || normalizedLeft.endsWith(`/${normalizedRight}`)
    || normalizedRight.endsWith(`/${normalizedLeft}`)
}

/** Preserve intentional line breaks while rejecting collapsed/blank selections. */
export function normalizeEpubSelectionText(text: string): string | null {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  return normalized || null
}

/** Stable book order for the all-underlines navigator and Markdown export preview. */
export function groupEpubHighlightsByChapter(
  highlights: WorkingFileEpubHighlight[],
): EpubHighlightChapterGroup[] {
  const groups = new Map<string, EpubHighlightChapterGroup>()

  for (const highlight of highlights) {
    const key = `${highlight.chapterOrder}:${highlight.chapterId}`
    const group = groups.get(key) ?? {
      chapterId: highlight.chapterId,
      chapterTitle: highlight.chapterTitle,
      chapterOrder: highlight.chapterOrder,
      highlights: [],
    }
    group.highlights.push(highlight)
    groups.set(key, group)
  }

  return [...groups.values()]
    .sort((left, right) => left.chapterOrder - right.chapterOrder
      || left.chapterTitle.localeCompare(right.chapterTitle))
    .map((group) => ({
      ...group,
      highlights: [...group.highlights].sort(compareEpubHighlights),
    }))
}

/** Keep only TOC branches that contain underlines, preserving every ancestor. */
export function buildEpubHighlightOutline(
  toc: EpubReaderTocItem[],
  chapters: ImportedChapter[],
  highlights: WorkingFileEpubHighlight[],
): EpubHighlightOutline {
  const groups = groupEpubHighlightsByChapter(highlights)
  const flatTocItems = flattenEpubToc(toc)
  const highlightsByTocKey = new Map<string, WorkingFileEpubHighlight[]>()
  const unmatched: EpubHighlightChapterGroup[] = []

  for (const group of groups) {
    const chapter = chapters.find((item) => item.id === group.chapterId)
      ?? chapters.find((item) => item.order === group.chapterOrder
        && item.locator.format === 'epub'
        && item.locator.spineIndex === group.highlights[0]?.spineIndex)

    if (!chapter || chapter.locator.format !== 'epub') {
      unmatched.push(group)
      continue
    }
    const locator = chapter.locator

    const matches = flatTocItems.filter((item) => (
      (item.spineIndex !== undefined && item.spineIndex === locator.spineIndex)
      || (Boolean(item.href) && epubHrefsMatch(item.href, locator.href))
    ))

    // A single XHTML may back multiple fragment-only TOC nodes. Without a
    // persisted TOC target, assigning that underline to one node would guess.
    if (matches.length !== 1) {
      unmatched.push(group)
      continue
    }

    const match = matches[0]!
    const existing = highlightsByTocKey.get(match.key) ?? []
    highlightsByTocKey.set(match.key, [...existing, ...group.highlights].sort(compareEpubHighlights))
  }

  return {
    items: mapHighlightedTocItems(toc, highlightsByTocKey),
    unmatched,
  }
}

function flattenEpubToc(items: EpubReaderTocItem[]): EpubReaderTocItem[] {
  return items.flatMap((item) => [item, ...flattenEpubToc(item.subitems)])
}

function mapHighlightedTocItems(
  items: EpubReaderTocItem[],
  highlightsByTocKey: Map<string, WorkingFileEpubHighlight[]>,
): EpubHighlightOutlineItem[] {
  return items.flatMap((item) => {
    const subitems = mapHighlightedTocItems(item.subitems, highlightsByTocKey)
    const highlights = highlightsByTocKey.get(item.key) ?? []
    if (highlights.length === 0 && subitems.length === 0) return []
    return [{
      key: item.key,
      label: item.label,
      href: item.href,
      spineIndex: item.spineIndex,
      highlights,
      subitems,
    }]
  })
}

function compareEpubHighlights(left: WorkingFileEpubHighlight, right: WorkingFileEpubHighlight): number {
  return left.createdAt - right.createdAt || left.cfiRange.localeCompare(right.cfiRange)
}

/** Injected into each EPUB iframe; parent-document styles cannot reach rendition contents. */
export function createEpubUnderlineStyle(color = '#ef4444'): string {
  return `
    ::highlight(${EPUB_UNDERLINE_HIGHLIGHT_NAME}) {
      text-decoration-line: underline;
      text-decoration-style: wavy;
      text-decoration-color: ${color};
      text-decoration-thickness: 1.5px;
    }
  `
}

/** Resolve only the current iframe's saved CFIs; one corrupt entry must not hide the rest. */
export function resolveEpubHighlightRanges<T>(
  highlights: WorkingFileEpubHighlight[],
  spineIndex: number,
  resolve: (cfiRange: string) => T | null,
): T[] {
  const ranges: T[] = []
  for (const highlight of highlights) {
    if (highlight.spineIndex !== spineIndex) continue
    try {
      const range = resolve(highlight.cfiRange)
      if (range) ranges.push(range)
    } catch {
      // A book may have changed on disk; keep rendering every other valid CFI.
    }
  }
  return ranges
}

/** Map a selection rect from the EPUB iframe viewport into the parent viewport. */
export function mapEpubIframeRectToViewport(
  selectionRect: EpubReaderRect,
  iframeRect: EpubReaderRect,
  iframeClientSize: { width: number; height: number },
): EpubReaderRect {
  const scaleX = iframeClientSize.width > 0 ? iframeRect.width / iframeClientSize.width : 1
  const scaleY = iframeClientSize.height > 0 ? iframeRect.height / iframeClientSize.height : 1
  return {
    left: iframeRect.left + selectionRect.left * scaleX,
    top: iframeRect.top + selectionRect.top * scaleY,
    width: selectionRect.width * scaleX,
    height: selectionRect.height * scaleY,
  }
}

/** Position the fixed-size action bar near the selection and clamp it to the reader. */
export function calculateEpubSelectionPopoverAnchor(
  selectionRect: EpubReaderRect,
  readerRect: EpubReaderRect,
  popoverWidth = SELECTION_POPOVER_WIDTH,
): EpubSelectionPopoverAnchor {
  const minLeft = SELECTION_POPOVER_EDGE
  const maxLeft = Math.max(
    minLeft,
    readerRect.width - popoverWidth - SELECTION_POPOVER_EDGE,
  )
  const centeredLeft = selectionRect.left - readerRect.left
    + selectionRect.width / 2
    - popoverWidth / 2
  const left = Math.min(Math.max(centeredLeft, minLeft), maxLeft)

  const selectionTop = selectionRect.top - readerRect.top
  const selectionBottom = selectionTop + selectionRect.height
  const hasRoomAbove = selectionTop >= SELECTION_POPOVER_HEIGHT
    + SELECTION_POPOVER_GAP
    + SELECTION_POPOVER_EDGE
  const placement = hasRoomAbove ? 'above' : 'below'
  const idealTop = hasRoomAbove
    ? selectionTop - SELECTION_POPOVER_HEIGHT - SELECTION_POPOVER_GAP
    : selectionBottom + SELECTION_POPOVER_GAP
  const maxTop = Math.max(
    SELECTION_POPOVER_EDGE,
    readerRect.height - SELECTION_POPOVER_HEIGHT - SELECTION_POPOVER_EDGE,
  )
  const top = Math.min(Math.max(idealTop, SELECTION_POPOVER_EDGE), maxTop)

  return { left, top, placement }
}

function normalizeEpubHref(href: string): string {
  const path = href.split(/[?#]/, 1)[0]?.replaceAll('\\', '/').replace(/^\/+/, '') ?? ''
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}
