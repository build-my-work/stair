import { describe, expect, it } from 'bun:test'

import {
  isCanonicalProjectRelativePath,
  isMessageReference,
  isProjectFileReferenceV1,
  isWebSelectionReferenceV1,
  messageReferenceKey,
  type ProjectFileReferenceV1,
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
