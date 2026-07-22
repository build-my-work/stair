import { describe, expect, it } from 'bun:test'

import type { EpubHighlight, ImportedChapter } from '@craft-agent/shared/learning'

import {
  buildEpubHighlightOutline,
  calculateEpubSelectionPopoverAnchor,
  createEpubUnderlineStyle,
  epubHrefsMatch,
  findChapterForEpubLocation,
  groupEpubHighlightsByChapter,
  mapEpubIframeRectToViewport,
  normalizeEpubSelectionText,
  resolveEpubHighlightRanges,
  type EpubReaderTocItem,
} from './epub-reader-utils'

const chapters: ImportedChapter[] = [
  {
    id: 'opening',
    title: 'Opening',
    level: 1,
    order: 0,
    locator: { format: 'epub', href: 'OPS/Text/chapter one.xhtml', spineIndex: 3 },
    content: 'Opening body',
  },
]

describe('EPUB reader helpers', () => {
  it('maps a rendition spine location to the imported tutor chapter', () => {
    expect(findChapterForEpubLocation(chapters, { index: 3 })?.id).toBe('opening')
  })

  it('falls back to decoded href matching when a spine index is unavailable', () => {
    expect(epubHrefsMatch('OPS/Text/chapter one.xhtml', 'Text/chapter%20one.xhtml#start')).toBe(true)
    expect(findChapterForEpubLocation(chapters, { href: 'Text/chapter%20one.xhtml#start' })?.id).toBe('opening')
  })

  it('normalizes line endings without flattening a multi-line selection', () => {
    expect(normalizeEpubSelectionText('  first\r\nsecond  ')).toBe('first\nsecond')
    expect(normalizeEpubSelectionText(' \n\t ')).toBeNull()
  })

  it('groups underlines in chapter order and sorts each chapter by creation time', () => {
    const highlights: EpubHighlight[] = [
      highlight({ chapterId: 'second', chapterTitle: 'Second', chapterOrder: 1, createdAt: 30, cfiRange: 'cfi-3' }),
      highlight({ chapterId: 'opening', chapterTitle: 'Opening', chapterOrder: 0, createdAt: 20, cfiRange: 'cfi-2' }),
      highlight({ chapterId: 'opening', chapterTitle: 'Opening', chapterOrder: 0, createdAt: 10, cfiRange: 'cfi-1' }),
    ]

    const grouped = groupEpubHighlightsByChapter(highlights)
    expect(grouped.map((group) => group.chapterId)).toEqual(['opening', 'second'])
    expect(grouped[0]?.highlights.map((item) => item.cfiRange)).toEqual(['cfi-1', 'cfi-2'])
  })

  it('keeps highlighted chapter ancestors while removing empty sibling branches', () => {
    const outline = buildEpubHighlightOutline(
      [tocItem('parent', 'Part', 'part.xhtml', [
        tocItem('empty', 'Empty', 'empty.xhtml'),
        tocItem('target', 'Target', 'target.xhtml'),
      ])],
      [chapter({ id: 'target', title: 'Target', order: 2, href: 'OPS/target.xhtml', spineIndex: 2 })],
      [highlight({ chapterId: 'target', chapterTitle: 'Target', chapterOrder: 2, spineIndex: 2 })],
    )

    expect(outline.items.map((item) => item.key)).toEqual(['parent'])
    expect(outline.items[0]?.subitems.map((item) => item.key)).toEqual(['target'])
    expect(outline.items[0]?.subitems[0]?.highlights).toHaveLength(1)
    expect(outline.unmatched).toEqual([])
  })

  it('preserves a deep ancestor chain and highlights owned by both parent and child nodes', () => {
    const outline = buildEpubHighlightOutline(
      [tocItem('root', 'Root', 'root.xhtml', [
        tocItem('part', 'Part', 'part.xhtml', [
          tocItem('chapter', 'Chapter', 'chapter.xhtml', [
            tocItem('section', 'Section', 'section.xhtml'),
          ]),
        ]),
      ])],
      [
        chapter({ id: 'chapter', title: 'Chapter', order: 2, href: 'OPS/chapter.xhtml', spineIndex: 2 }),
        chapter({ id: 'section', title: 'Section', order: 3, href: 'OPS/section.xhtml', spineIndex: 3 }),
      ],
      [
        highlight({ chapterId: 'chapter', chapterTitle: 'Chapter', chapterOrder: 2, spineIndex: 2, cfiRange: 'chapter-cfi' }),
        highlight({ chapterId: 'section', chapterTitle: 'Section', chapterOrder: 3, spineIndex: 3, cfiRange: 'section-cfi' }),
      ],
    )

    const chapterNode = outline.items[0]?.subitems[0]?.subitems[0]
    expect(chapterNode?.highlights.map((item) => item.cfiRange)).toEqual(['chapter-cfi'])
    expect(chapterNode?.subitems[0]?.key).toBe('section')
    expect(chapterNode?.subitems[0]?.highlights.map((item) => item.cfiRange)).toEqual(['section-cfi'])
  })

  it('keeps ambiguous TOC chapters in a flat fallback instead of duplicating them', () => {
    const ambiguousChapter = chapter({
      id: 'shared',
      title: 'Shared section',
      href: 'OPS/shared.xhtml',
      spineIndex: 4,
    })
    const outline = buildEpubHighlightOutline(
      [tocItem('parent', 'Parent', 'shared.xhtml#top', [
        tocItem('child', 'Child', 'shared.xhtml#child'),
      ])],
      [ambiguousChapter],
      [highlight({ chapterId: 'shared', chapterTitle: 'Shared section', spineIndex: 4 })],
    )

    expect(outline.items).toEqual([])
    expect(outline.unmatched.map((group) => group.chapterId)).toEqual(['shared'])
    expect(outline.unmatched[0]?.highlights).toHaveLength(1)
  })

  it('builds a real red wavy underline rule for iframe injection', () => {
    const css = createEpubUnderlineStyle()
    expect(css).toContain('::highlight(socratopia-epub-underline)')
    expect(css).toContain('text-decoration-line: underline')
    expect(css).toContain('text-decoration-style: wavy')
    expect(css).toContain('text-decoration-color: #ef4444')
  })

  it('skips a bad CFI without dropping other underlines in the iframe', () => {
    const highlights: EpubHighlight[] = [
      highlight({ cfiRange: 'valid-1' }),
      highlight({ cfiRange: 'broken' }),
      highlight({ cfiRange: 'other-spine', spineIndex: 4 }),
      highlight({ cfiRange: 'valid-2' }),
    ]

    const ranges = resolveEpubHighlightRanges(highlights, 3, (cfiRange) => {
      if (cfiRange === 'broken') throw new Error('bad CFI')
      return `range:${cfiRange}`
    })
    expect(ranges).toEqual(['range:valid-1', 'range:valid-2'])
  })

  it('maps iframe selection coordinates with fixed-layout scaling', () => {
    expect(mapEpubIframeRectToViewport(
      { left: 20, top: 30, width: 100, height: 20 },
      { left: 200, top: 100, width: 400, height: 600 },
      { width: 800, height: 1200 },
    )).toEqual({ left: 210, top: 115, width: 50, height: 10 })
  })

  it('places the selection toolbar above when possible and clamps it to reader edges', () => {
    const reader = { left: 100, top: 50, width: 400, height: 500 }
    expect(calculateEpubSelectionPopoverAnchor(
      { left: 102, top: 250, width: 20, height: 20 },
      reader,
    )).toEqual({ left: 8, top: 148, placement: 'above' })

    expect(calculateEpubSelectionPopoverAnchor(
      { left: 470, top: 55, width: 20, height: 20 },
      reader,
    )).toEqual({ left: 304, top: 33, placement: 'below' })
  })
})

function highlight(overrides: Partial<EpubHighlight>): EpubHighlight {
  return {
    sourceFilename: 'book.epub',
    cfiRange: 'cfi',
    text: 'Selected text',
    chapterId: 'opening',
    chapterTitle: 'Opening',
    chapterOrder: 0,
    spineIndex: 3,
    createdAt: 1,
    ...overrides,
  }
}

function chapter({
  id,
  title,
  order,
  href,
  spineIndex,
}: {
  id: string
  title: string
  order?: number
  href: string
  spineIndex: number
}): ImportedChapter {
  return {
    id,
    title,
    level: 1,
    order: order ?? spineIndex,
    locator: { format: 'epub', href, spineIndex },
    content: '',
  }
}

function tocItem(
  key: string,
  label: string,
  href: string,
  subitems: EpubReaderTocItem[] = [],
): EpubReaderTocItem {
  return { key, label, href, subitems }
}
