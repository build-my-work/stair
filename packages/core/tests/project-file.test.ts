import { describe, expect, it } from 'bun:test'

import {
  isCanonicalProjectRelativePath,
  isChatMessageSelectionReferenceV1,
  isMessageReference,
  isProjectFileSelectionReferenceV1,
  isProjectFileReferenceV1,
  isSelectionReference,
  isWebSelectionReferenceV1,
  messageReferenceKey,
  type ProjectFileReferenceV1,
  type ProjectFileSelectionReferenceV1,
  type ChatMessageSelectionReferenceV1,
  type WebSelectionReferenceV1,
} from '../src/types/project-file'

function reference(): ProjectFileReferenceV1 {
  return {
    version: 1,
    kind: 'project-file',
    projectId: 'project-1',
    relativePath: 'books/os.epub',
    sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    fileName: 'os.epub',
    quote: 'selected text',
    chapterKey: 'chapter-1',
    chapterTitle: 'Chapter 1',
    tocPath: [{
      key: 'chapter-1',
      title: 'Chapter 1',
      href: 'chapter-1.xhtml',
      orderPath: [0],
    }],
    locator: {
      type: 'epub-cfi',
      cfiRange: 'epubcfi(/6/4!/4/2:0)',
    },
  }
}

function textFileSelection(): ProjectFileSelectionReferenceV1 {
  return {
    version: 1,
    kind: 'project-file',
    projectId: 'project-1',
    relativePath: 'notes/source.md',
    sourceFingerprint: `sha256:${'b'.repeat(64)}`,
    fileName: 'source.md',
    quote: 'selected text',
    contextBefore: 'before',
    contextAfter: 'after',
    locator: {
      type: 'text-quote',
      exact: 'selected text',
      prefix: 'before',
      suffix: 'after',
      start: 10,
      end: 23,
    },
  }
}

function chatSelection(): ChatMessageSelectionReferenceV1 {
  return {
    version: 1,
    kind: 'chat-message',
    sessionId: 'session-1',
    messageId: 'message-1',
    role: 'assistant',
    quote: 'selected text',
    locator: {
      type: 'text-quote',
      exact: 'selected text',
      prefix: 'before',
      suffix: 'after',
      start: 10,
      end: 23,
    },
  }
}

function webReference(): WebSelectionReferenceV1 {
  return {
    version: 1,
    kind: 'web-selection',
    url: 'https://example.com/article',
    title: 'Example article',
    quote: 'selected text',
    locator: {
      type: 'text-quote',
      exact: 'selected text',
      prefix: 'before',
      suffix: 'after',
    },
  }
}

describe('isCanonicalProjectRelativePath', () => {
  it('accepts canonical root-relative POSIX paths', () => {
    expect(isCanonicalProjectRelativePath('文档/My file.epub')).toBe(true)
  })

  it.each([
    '',
    '.',
    '..',
    '/absolute.epub',
    'C:/absolute.epub',
    'C:relative.epub',
    'books\\example.epub',
    'books/../example.epub',
    'books/./example.epub',
    'books//example.epub',
    'books/example.epub/',
    'books/\0example.epub',
  ])('rejects non-canonical path %j', (value) => {
    expect(isCanonicalProjectRelativePath(value)).toBe(false)
  })
})

describe('isProjectFileReferenceV1', () => {
  it('accepts valid optional chapter and TOC href fields', () => {
    expect(isProjectFileReferenceV1(reference())).toBe(true)
  })

  it('rejects non-string optional chapter and TOC href fields', () => {
    for (const invalid of [
      { ...reference(), chapterKey: 1 },
      { ...reference(), chapterTitle: false },
      {
        ...reference(),
        tocPath: [{
          key: 'chapter-1',
          title: 'Chapter 1',
          href: { unsafe: true },
          orderPath: [0],
        }],
      },
    ]) {
      expect(isProjectFileReferenceV1(invalid)).toBe(false)
    }
  })

  it('rejects identities and TOC data that are not safe to persist', () => {
    for (const invalid of [
      { ...reference(), projectId: ' project-1' },
      { ...reference(), projectId: 'project-\0' },
      { ...reference(), fileName: 'os\0.epub' },
      {
        ...reference(),
        tocPath: [{
          key: '',
          title: 'Chapter 1',
          orderPath: [0],
        }],
      },
      {
        ...reference(),
        tocPath: [{
          key: 'chapter-1',
          title: 'Chapter\0 1',
          orderPath: [0],
        }],
      },
    ]) {
      expect(isProjectFileReferenceV1(invalid)).toBe(false)
    }
  })
})

describe('WebSelectionReferenceV1', () => {
  it('accepts bounded HTTPS text-quote references', () => {
    expect(isWebSelectionReferenceV1(webReference())).toBe(true)
    expect(isMessageReference(webReference())).toBe(true)
  })

  it.each([
    { ...webReference(), version: 2 },
    { ...webReference(), url: 'file:///tmp/private.txt' },
    { ...webReference(), url: ' https://example.com/article' },
    { ...webReference(), title: '' },
    { ...webReference(), quote: 'different' },
    {
      ...webReference(),
      locator: {
        type: 'text-quote',
        exact: 'selected text',
        prefix: ' before',
      },
    },
  ])('rejects malformed or unsupported references', (value) => {
    expect(isWebSelectionReferenceV1(value)).toBe(false)
  })

  it('builds stable kind-specific message reference keys', () => {
    const first = webReference()
    const second = {
      ...webReference(),
      title: 'A changed page title',
    }
    expect(messageReferenceKey(first))
      .toBe(messageReferenceKey(second))
    expect(messageReferenceKey(first))
      .not.toBe(messageReferenceKey(reference()))
  })
})

describe('SelectionReference', () => {
  it('unifies web, Project File, EPUB, and chat selections', () => {
    expect(isSelectionReference(webReference())).toBe(true)
    expect(isSelectionReference(reference())).toBe(true)
    expect(isSelectionReference(textFileSelection())).toBe(true)
    expect(isSelectionReference(chatSelection())).toBe(true)
  })

  it('keeps non-EPUB Project File selections out of MessageReference', () => {
    expect(isProjectFileSelectionReferenceV1(textFileSelection())).toBe(true)
    expect(isProjectFileReferenceV1(textFileSelection())).toBe(false)
    expect(isMessageReference(textFileSelection())).toBe(false)
  })

  it('validates PDF page locators', () => {
    const pdf: ProjectFileSelectionReferenceV1 = {
      ...textFileSelection(),
      relativePath: 'paper.pdf',
      fileName: 'paper.pdf',
      locator: {
        type: 'pdf-text-quote',
        exact: 'selected text',
        startPage: 2,
        endPage: 3,
      },
    }
    expect(isProjectFileSelectionReferenceV1(pdf)).toBe(true)
    expect(isProjectFileSelectionReferenceV1({
      ...pdf,
      locator: { ...pdf.locator, startPage: 0 },
    })).toBe(false)
  })

  it('requires chat selections to point to an existing non-empty range', () => {
    expect(isChatMessageSelectionReferenceV1(chatSelection())).toBe(true)
    expect(isChatMessageSelectionReferenceV1({
      ...chatSelection(),
      locator: { ...chatSelection().locator, end: 10 },
    })).toBe(false)
    expect(isSelectionReference({
      version: 1,
      kind: 'manual-note',
      text: 'free-form text',
    })).toBe(false)
  })
})
