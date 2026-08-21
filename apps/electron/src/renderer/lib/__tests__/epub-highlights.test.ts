import { describe, expect, it } from 'bun:test'
import type {
  EpubHighlightV1,
  EpubTocNode,
} from '@craft-agent/shared/project-files'

import {
  buildEpubHighlightTree,
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

describe('EPUB highlight grouping and export', () => {
  it('按 spine、CFI、创建时间和 id 稳定排序', () => {
    const values = [
      mark('3', { spineIndex: 2 }),
      mark('2', { cfiRange: 'b', createdAt: 2 }),
      mark('1', { cfiRange: 'a', createdAt: 3 }),
    ]
    expect(values.sort((left, right) => compareEpubHighlights(
      left,
      right,
      (a, b) => a.localeCompare(b),
    )).map(value => value.id)).toEqual(['1', '2', '3'])
  })

  it('按最深匹配目录分组，并把无法匹配的高亮单独保留', () => {
    const tree = buildEpubHighlightTree(toc, [
      mark('2', {
        cfiRange: 'b',
        tocPath: [
          { key: 'toc:0', title: 'Part *One*', orderPath: [0] },
          { key: 'toc:0.0', title: 'Chapter 1', orderPath: [0, 0] },
        ],
      }),
      mark('1', {
        cfiRange: 'a',
        tocPath: [
          { key: 'toc:0', title: 'Part *One*', orderPath: [0] },
          { key: 'toc:0.0', title: 'Chapter 1', orderPath: [0, 0] },
        ],
      }),
      mark('3'),
    ], (a, b) => a.localeCompare(b))

    expect(tree.nodes[0]?.children[0]?.highlights.map(value => value.id))
      .toEqual(['1', '2'])
    expect(tree.unmatched.map(value => value.id)).toEqual(['3'])
  })

  it('保留目录层级、转义标题并逐行引用多行文本', () => {
    expect(buildEpubHighlightsMarkdown({
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
    })).toBe(
      '# OS \\#Book\n\n'
      + '## Part \\*One\\*\n\n'
      + '### Chapter 1\n\n'
      + '> line one\n> line two\n',
    )
  })
})
