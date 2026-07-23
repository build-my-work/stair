import { describe, expect, it } from 'bun:test'

import {
  appendFileReferenceToDraft,
  filterFileReferencesForComposerText,
  formatFileReferenceForComposer,
} from '../file-reference-draft'

const reference = {
  projectId: 'project-1',
  path: 'books/操作系统导论 .epub',
  quote: '进程就是运行中的程序。\n它拥有自己的地址空间。',
  locator: {
    type: 'epub-cfi' as const,
    cfiRange: 'epubcfi(/6/4!/4/2/2:0,/4/2/2:8)',
  },
}

describe('file reference composer drafts', () => {
  it('formats a readable quote while keeping its source concise', () => {
    expect(formatFileReferenceForComposer(reference)).toBe(
      '> 进程就是运行中的程序。\n> 它拥有自己的地址空间。\n\n— 操作系统导论 .epub',
    )
  })

  it('appends the reference without losing attachments or existing text', () => {
    expect(appendFileReferenceToDraft({
      text: '请解释这里：',
      attachments: [{ path: '/tmp/diagram.png', name: 'diagram.png' }],
    }, reference)).toEqual({
      text: '请解释这里：\n\n> 进程就是运行中的程序。\n> 它拥有自己的地址空间。\n\n— 操作系统导论 .epub',
      attachments: [{ path: '/tmp/diagram.png', name: 'diagram.png' }],
      references: [reference],
    })
  })

  it('does not append the same locator twice', () => {
    const once = appendFileReferenceToDraft({ text: '' }, reference)
    expect(appendFileReferenceToDraft(once, { ...reference, quote: '重复文案' })).toEqual(once)
  })

  it('drops a structured reference after its visible citation is removed', () => {
    expect(filterFileReferencesForComposerText([reference], '我改成了一个普通问题')).toEqual([])
    expect(filterFileReferencesForComposerText(
      [reference],
      '我编辑了引文内容，但保留来源\n\n— 操作系统导论 .epub',
    )).toEqual([reference])
  })
})
