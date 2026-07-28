import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { SourceFingerprint } from '@craft-agent/core/types'

import {
  EPUB_DOCUMENT_CSP,
  createIdempotentEpubCleanup,
  createProjectFileEpubViewerKey,
  findCurrentEpubTocNode,
  getEpubReaderTheme,
  getEpubRenditionOptions,
  getEpubSelectionViewportRect,
  hardenEpubSerializedHtml,
  isFixedLayoutEpub,
  mapEpubNavigation,
  normalizeEpubHref,
  shouldBlockEpubLink,
} from '../project-file-epub'

describe('EPUB dependency pin', () => {
  it('pins the renderer package and lockfile to the reviewed epub.js commit', () => {
    const packageJson = readFileSync(
      fileURLToPath(new URL('../../../../../package.json', import.meta.url)),
      'utf8',
    )
    const lockfile = readFileSync(
      fileURLToPath(new URL('../../../../../../../bun.lock', import.meta.url)),
      'utf8',
    )
    const expected =
      'https://github.com/futurepress/epub.js/archive/eee359d0790002115a1156a9833c54f4bcd44c1d.tar.gz'

    expect(packageJson).toContain(`"epubjs": "${expected}"`)
    expect(lockfile).toContain(`"epubjs": "${expected}"`)
    expect(lockfile).toContain(`epubjs@${expected}`)
  })
})

describe('Project File EPUB identity and rendition', () => {
  it('keys the viewer by project, relative path, and exact bytes fingerprint', () => {
    const fingerprint = `sha256:${'a'.repeat(64)}` as SourceFingerprint
    expect(createProjectFileEpubViewerKey(
      { projectId: 'project-1', relativePath: 'books/guide.epub' },
      fingerprint,
    )).toBe(`project-1\0books/guide.epub\0${fingerprint}`)
  })

  it('uses continuous scrolled rendering without script or popup privileges', () => {
    expect(getEpubRenditionOptions(false)).toEqual({
      width: '100%',
      height: '100%',
      manager: 'continuous',
      flow: 'scrolled',
      layout: 'reflowable',
      spread: 'none',
      allowScriptedContent: false,
      allowPopups: false,
    })
    expect(getEpubRenditionOptions(true).layout).toBe('pre-paginated')
    expect(isFixedLayoutEpub('pre-paginated', undefined)).toBe(true)
    expect(isFixedLayoutEpub('reflowable', 'true')).toBe(true)
    expect(isFixedLayoutEpub('reflowable', 'false')).toBe(false)
  })
})

describe('EPUB selection geometry', () => {
  it('maps and unions iframe client rects into the outer viewport', () => {
    expect(getEpubSelectionViewportRect(
      [
        { left: 10, top: 30, width: 210, height: 20 },
        { left: 10, top: 55, width: 190, height: 20 },
      ],
      { left: 130, top: 90, width: 400, height: 600 },
      { width: 400, height: 600 },
    )).toEqual({
      x: 140,
      y: 120,
      width: 210,
      height: 45,
    })
  })

  it('accounts for scaled fixed-layout iframe contents', () => {
    expect(getEpubSelectionViewportRect(
      [{ left: 10, top: 20, width: 100, height: 30 }],
      { left: 100, top: 50, width: 800, height: 1200 },
      { width: 400, height: 600 },
    )).toEqual({
      x: 120,
      y: 90,
      width: 200,
      height: 60,
    })
  })

  it('ignores empty fragments and rejects unavailable iframe geometry', () => {
    expect(getEpubSelectionViewportRect(
      [
        { left: 0, top: 0, width: 0, height: 0 },
        { left: 5, top: 8, width: 20, height: 12 },
      ],
      { left: 10, top: 20, width: 100, height: 100 },
      { width: 100, height: 100 },
    )).toEqual({
      x: 15,
      y: 28,
      width: 20,
      height: 12,
    })
    expect(getEpubSelectionViewportRect(
      [{ left: 5, top: 8, width: 20, height: 12 }],
      { left: 10, top: 20, width: 0, height: 100 },
      { width: 100, height: 100 },
    )).toBeNull()
    expect(getEpubSelectionViewportRect(
      [{ left: 0, top: 0, width: 0, height: 0 }],
      { left: 10, top: 20, width: 100, height: 100 },
      { width: 100, height: 100 },
    )).toBeNull()
  })

  it('clips partially visible fragments and ignores offscreen fragments', () => {
    expect(getEpubSelectionViewportRect(
      [
        { left: 10, top: -20, width: 80, height: 30 },
        { left: 10, top: 120, width: 80, height: 20 },
      ],
      { left: 100, top: 50, width: 200, height: 200 },
      { width: 100, height: 100 },
    )).toEqual({
      x: 120,
      y: 50,
      width: 160,
      height: 20,
    })
    expect(getEpubSelectionViewportRect(
      [{ left: 10, top: 120, width: 80, height: 20 }],
      { left: 100, top: 50, width: 200, height: 200 },
      { width: 100, height: 100 },
    )).toBeNull()
  })
})

describe('EPUB table of contents', () => {
  const toc = mapEpubNavigation([
    {
      label: 'Chapter one',
      href: 'OPS/chapter.xhtml',
      subitems: [
        { label: ' Part one ', href: 'OPS/chapter.xhtml#part-1' },
        { label: 'Part two', href: 'OPS/chapter.xhtml#part-2' },
      ],
    },
    { label: 'Chapter two', href: 'OPS/chapter-2.xhtml' },
  ])

  it('preserves hierarchy and order with IDs independent of optional EPUB IDs', () => {
    expect(toc).toEqual([
      {
        key: 'toc:0',
        title: 'Chapter one',
        href: 'OPS/chapter.xhtml',
        orderPath: [0],
        children: [
          {
            key: 'toc:0.0',
            title: 'Part one',
            href: 'OPS/chapter.xhtml#part-1',
            orderPath: [0, 0],
            children: [],
          },
          {
            key: 'toc:0.1',
            title: 'Part two',
            href: 'OPS/chapter.xhtml#part-2',
            orderPath: [0, 1],
            children: [],
          },
        ],
      },
      {
        key: 'toc:1',
        title: 'Chapter two',
        href: 'OPS/chapter-2.xhtml',
        orderPath: [1],
        children: [],
      },
    ])
  })

  it('matches exact document plus fragment, then the deepest same-document node', () => {
    expect(findCurrentEpubTocNode(toc, 'OPS/chapter.xhtml#part-2')?.key).toBe('toc:0.1')
    expect(findCurrentEpubTocNode(toc, 'chapter.xhtml')?.key).toBe('toc:0')
    expect(findCurrentEpubTocNode(toc, 'book/OPS/chapter.xhtml#missing')?.key).toBe('toc:0.0')
    expect(findCurrentEpubTocNode(toc, 'OPS/missing.xhtml')).toBeNull()
  })

  it('normalizes encoded paths, query strings, dot segments, and fragments', () => {
    expect(normalizeEpubHref('./OPS/Part%201.xhtml?cache=1#section%202')).toEqual({
      document: 'OPS/Part 1.xhtml',
      fragment: 'section 2',
    })
  })
})

describe('EPUB document containment', () => {
  it('injects CSP before iframe write and strips executable navigation elements', () => {
    const hardened = hardenEpubSerializedHtml(`
      <html>
        <head>
          <base href="https://example.com/">
          <meta http-equiv='refresh' content='0;url=https://example.com'>
          <meta http-equiv="Content-Security-Policy" content="default-src *">
          <meta name="viewport" content="width=device-width">
          <script src="https://example.com/evil.js"></script>
        </head>
        <body><SCRIPT>alert(1)</SCRIPT><p>Safe text</p></body>
      </html>
    `)

    expect(hardened).toContain(`content="${EPUB_DOCUMENT_CSP}"`)
    expect(hardened.match(/Content-Security-Policy/g)).toHaveLength(1)
    expect(hardened).toContain('name="viewport"')
    expect(hardened).toContain('<p>Safe text</p>')
    expect(hardened).not.toMatch(/<script/i)
    expect(hardened).not.toMatch(/<base/i)
    expect(hardened).not.toMatch(/http-equiv=['"]refresh/i)
    expect(EPUB_DOCUMENT_CSP).toContain("connect-src 'none'")
    expect(EPUB_DOCUMENT_CSP).toContain("form-action 'none'")
  })

  it('blocks external protocols and top-frame targets but keeps in-book navigation', () => {
    for (const href of [
      'https://example.com',
      'http://example.com',
      'file:///etc/passwd',
      'data:text/html,evil',
      'javascript:alert(1)',
      'mailto:reader@example.com',
      '//example.com/path',
    ]) {
      expect(shouldBlockEpubLink(href)).toBe(true)
    }

    expect(shouldBlockEpubLink('chapter-2.xhtml#section')).toBe(false)
    expect(shouldBlockEpubLink('#footnote')).toBe(false)
    expect(shouldBlockEpubLink('epubcfi(/6/2!/4/1:0)')).toBe(false)
    expect(shouldBlockEpubLink('chapter.xhtml', '_top')).toBe(true)
    expect(shouldBlockEpubLink('chapter.xhtml', '_blank')).toBe(true)
  })
})

describe('EPUB theme and cleanup', () => {
  it('provides explicit light and dark document themes', () => {
    expect(getEpubReaderTheme('light').body.color).toBe('#20242b')
    expect(getEpubReaderTheme('dark').body.color).toBe('#e5e7eb')
    expect(getEpubReaderTheme('light')['html, body']['background-color'])
      .not.toBe(getEpubReaderTheme('dark')['html, body']['background-color'])
  })

  it('runs every disposer exactly once even when one fails', () => {
    const calls: string[] = []
    const cleanup = createIdempotentEpubCleanup([
      () => calls.push('listeners'),
      () => {
        calls.push('third-party')
        throw new Error('already destroyed')
      },
      () => calls.push('observer'),
    ])

    cleanup()
    cleanup()
    expect(calls).toEqual(['listeners', 'third-party', 'observer'])
  })
})
