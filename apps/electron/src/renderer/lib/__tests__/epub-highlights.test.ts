import { describe, expect, it } from 'bun:test'
import type { EpubHighlightV1, EpubTocNode } from '@craft-agent/core/types'

import {
  buildEpubHighlightsMarkdown,
  compareEpubHighlights,
} from '../epub-highlights'

function mark(
  id: string,
  options: Partial<EpubHighlightV1> = {},
): EpubHighlightV1 {
  return {
    id,
    cfiRange: `epubcfi(/6/4!/4/${id})`,
    quote: `quote ${id}`,
    tocPath: [],
    spineIndex: 0,
    style: { type: 'wavy', color: 'red' },
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    updatedAt: 1,
    ...options,
  }
}

const toc: EpubTocNode[] = [{
  key: 'toc:0',
  title: 'Part *One*',
  orderPath: [0],
  children: [{
    key: 'toc:0.0',
    title: 'Chapter 1',
    orderPath: [0, 0],
    children: [],
  }],
}]

describe('epub highlight ordering', () => {
  it('uses spine, CFI, createdAt and id in that order', () => {
    const values = [
      mark('3', { spineIndex: 2 }),
      mark('2', { cfiRange: 'b', createdAt: 2 }),
      mark('1', { cfiRange: 'a', createdAt: 3 }),
    ]
    expect(values.sort((a, b) => compareEpubHighlights(a, b, (x, y) => x.localeCompare(y)))
      .map(value => value.id)).toEqual(['1', '2', '3'])
  })

  it('falls back when the CFI comparator rejects malformed input', () => {
    const values = [mark('2', { createdAt: 2 }), mark('1', { createdAt: 1 })]
    expect(values.sort((a, b) => compareEpubHighlights(a, b, () => {
      throw new Error('bad cfi')
    })).map(value => value.id)).toEqual(['1', '2'])
  })
})

describe('buildEpubHighlightsMarkdown', () => {
  it('keeps TOC hierarchy, escapes titles, quotes multiline text and ends once', () => {
    const output = buildEpubHighlightsMarkdown({
      bookTitle: 'OS #Book',
      fileName: 'os.epub',
      toc,
      highlights: [mark('1', {
        quote: 'line one\nline two',
        tocPath: [
          { key: 'toc:0', title: 'Part *One*', orderPath: [0] },
          { key: 'toc:0.0', title: 'Chapter 1', orderPath: [0, 0] },
        ],
      })],
      compareCfi: (a, b) => a.localeCompare(b),
    })
    expect(output).toBe(
      '# OS \\#Book\n\n'
      + '## Part \\*One\\*\n\n'
      + '### Chapter 1\n\n'
      + '> line one\n> line two\n',
    )
  })

  it('puts unmatched highlights last and does not create empty output', () => {
    expect(buildEpubHighlightsMarkdown({
      fileName: 'os.epub',
      toc,
      highlights: [],
      compareCfi: () => 0,
    })).toBe('')

    const output = buildEpubHighlightsMarkdown({
      fileName: 'os.epub',
      toc,
      highlights: [mark('1')],
      compareCfi: () => 0,
    })
    expect(output).toContain('## 未识别章节')
    expect(output.endsWith('\n')).toBe(true)
    expect(output.endsWith('\n\n')).toBe(false)
  })
})
