import { describe, expect, it } from 'bun:test'

import {
  isReference,
  referenceKey,
  type Reference,
} from '../src/types/reference'

const fingerprint = `sha256:${'a'.repeat(64)}` as const

const references: Reference[] = [
  {
    version: 1,
    kind: 'project-file',
    projectId: 'project-a',
    relativePath: 'notes/chapter.md',
    sourceFingerprint: fingerprint,
    fileName: 'chapter.md',
    quote: '文本选区',
    locator: {
      type: 'text-quote',
      exact: '文本选区',
      start: 10,
      end: 14,
    },
  },
  {
    version: 1,
    kind: 'project-file',
    projectId: 'project-a',
    relativePath: 'books/book.epub',
    sourceFingerprint: fingerprint,
    fileName: 'book.epub',
    quote: 'EPUB 选区',
    tocPath: [],
    locator: {
      type: 'epub-cfi',
      cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:7)',
    },
  },
  {
    version: 1,
    kind: 'project-file',
    projectId: 'project-a',
    relativePath: 'papers/paper.pdf',
    sourceFingerprint: fingerprint,
    fileName: 'paper.pdf',
    quote: 'PDF 选区',
    locator: {
      type: 'pdf-text-quote',
      exact: 'PDF 选区',
      startPage: 2,
      endPage: 2,
      anchor: {
        pageNumber: 2,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.04,
      },
    },
  },
  {
    version: 1,
    kind: 'chat-message',
    projectId: 'project-a',
    sessionId: 'session-source',
    messageId: 'message-source',
    role: 'assistant',
    quote: '聊天选区',
    locator: {
      type: 'text-quote',
      exact: '聊天选区',
      start: 4,
      end: 8,
    },
  },
]

describe('阶段 5 统一引用协议', () => {
  it('文本、EPUB、PDF 和聊天引用共用同一校验入口', () => {
    for (const reference of references) {
      expect(isReference(reference)).toBe(true)
      expect(referenceKey(reference)).toBeString()
    }
    expect(new Set(references.map(referenceKey)).size).toBe(references.length)
  })

  it('拒绝越出 Project、来源不一致和不可靠 locator', () => {
    expect(isReference({
      ...references[0],
      relativePath: '../outside.md',
    })).toBe(false)
    expect(isReference({
      ...references[0],
      locator: { type: 'text-quote', exact: '另一段文字', start: 10, end: 14 },
    })).toBe(false)
    expect(isReference({
      ...references[2],
      locator: {
        type: 'pdf-text-quote',
        exact: 'PDF 选区',
        startPage: 2,
        endPage: 1,
      },
    })).toBe(false)
    expect(isReference({
      ...references[3],
      projectId: '',
    })).toBe(false)

    expect(isReference({
      ...references[3],
      projectId: ' project-a',
    })).toBe(false)
    expect(isReference({
      ...references[3],
      sessionId: 'source-session ',
    })).toBe(false)
    expect(isReference({
      ...references[3],
      messageId: ' message-source',
    })).toBe(false)
  })

  it('限制 Project 相对路径和 EPUB 目录顺序路径的体积', () => {
    expect(isReference({
      ...references[0],
      relativePath: `${'路'.repeat(683)}.md`,
    })).toBe(false)
    expect(isReference({
      ...references[1],
      tocPath: [{
        key: 'chapter',
        title: 'Chapter',
        orderPath: Array.from({ length: 33 }, (_, index) => index),
      }],
    })).toBe(false)
  })
})
