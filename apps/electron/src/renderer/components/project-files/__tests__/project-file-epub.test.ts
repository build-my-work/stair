import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EPUB_DOCUMENT_CSP,
  EPUB_RESOURCE_REPLACEMENTS,
  attachEpubContentsSelectionLifecycle,
  createEpubSerializeHook,
  createIdempotentEpubCleanup,
  createEpubResizeScheduler,
  findCurrentEpubTocNode,
  getEpubReaderTheme,
  getEpubRenditionOptions,
  getEpubNavigationLayout,
  getEpubSelectionViewportRect,
  hardenEpubSerializedHtml,
  isFixedLayoutEpub,
  mapEpubNavigation,
  normalizeEpubHref,
  shouldBlockEpubLink,
} from '../project-file-epub'

function keyEvent(key: string): Event {
  const event = new Event('keydown')
  Object.defineProperty(event, 'key', { value: key })
  return event
}

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

  it('keeps the Vite module entry present in the source tarball', () => {
    const packagePath = fileURLToPath(new URL(
      '../../../../../../../node_modules/epubjs/package.json',
      import.meta.url,
    ))
    const dependency = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      module?: string
    }
    expect(dependency.module).toBe('src/index.js')
    expect(existsSync(join(dirname(packagePath), dependency.module!))).toBe(true)
  })
})

describe('Project File EPUB rendition', () => {
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

describe('EPUB navigation layout', () => {
  it('overlays narrow readers and only joins the document grid at the old 840px boundary', () => {
    expect(getEpubNavigationLayout(839)).toBe('overlay')
    expect(getEpubNavigationLayout(840)).toBe('inline')
    expect(getEpubNavigationLayout(1_200)).toBe('inline')
  })

  it('closes compact navigation after TOC and highlight jumps', () => {
    const readerSource = readFileSync(
      new URL('../ProjectFileEpubReader.tsx', import.meta.url),
      'utf8',
    )

    expect(readerSource.match(/if \(compactNavigation\) setNavOpen\(false\)/g))
      .toHaveLength(2)
  })
})

describe('EPUB selection toolbar lifecycle', () => {
  it('keeps the transient collapsed selection while a pointer drag is active', () => {
    const documentTarget = new EventTarget() as EventTarget & {
      getSelection: () => { isCollapsed: boolean }
    }
    const windowTarget = new EventTarget()
    let collapsed = true
    let dismissals = 0
    documentTarget.getSelection = () => ({ isCollapsed: collapsed })

    const cleanup = attachEpubContentsSelectionLifecycle({
      document: documentTarget,
      window: windowTarget,
    } as never, () => { dismissals += 1 })

    documentTarget.dispatchEvent(new Event('pointerdown'))
    documentTarget.dispatchEvent(new Event('selectionchange'))
    expect(dismissals).toBe(1)

    collapsed = false
    documentTarget.dispatchEvent(new Event('pointerup'))
    documentTarget.dispatchEvent(new Event('selectionchange'))
    expect(dismissals).toBe(1)

    cleanup()
  })

  it('dismisses stale iframe selections and removes every listener on cleanup', () => {
    const documentTarget = new EventTarget() as EventTarget & {
      getSelection: () => { isCollapsed: boolean }
    }
    const windowTarget = new EventTarget()
    let collapsed = false
    let dismissals = 0
    documentTarget.getSelection = () => ({ isCollapsed: collapsed })

    const cleanup = attachEpubContentsSelectionLifecycle({
      document: documentTarget,
      window: windowTarget,
    } as never, () => { dismissals += 1 })

    documentTarget.dispatchEvent(new Event('pointerdown'))
    documentTarget.dispatchEvent(new Event('selectionchange'))
    expect(dismissals).toBe(1)

    documentTarget.dispatchEvent(new Event('pointerup'))
    collapsed = true
    documentTarget.dispatchEvent(new Event('selectionchange'))
    documentTarget.dispatchEvent(keyEvent('Enter'))
    documentTarget.dispatchEvent(keyEvent('Escape'))
    windowTarget.dispatchEvent(new Event('scroll'))
    expect(dismissals).toBe(4)

    cleanup()
    documentTarget.dispatchEvent(new Event('pointerdown'))
    documentTarget.dispatchEvent(keyEvent('Escape'))
    windowTarget.dispatchEvent(new Event('scroll'))
    expect(dismissals).toBe(4)
  })

  it('dismisses on mount scroll, view unload, and reader resize', () => {
    const readerSource = readFileSync(
      new URL('../ProjectFileEpubReader.tsx', import.meta.url),
      'utf8',
    )
    expect(readerSource).toContain("mount?.addEventListener('scroll', dismissSelection, true)")
    expect(readerSource).toMatch(/unloadedHook[\s\S]*?dismissSelection\(\)/)
    expect(readerSource).toMatch(/new ResizeObserver\(\(\) => \{\s*dismissSelection\(\)/)
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
  it('starts with fast blob replacements without widening the host CSP', () => {
    expect(EPUB_RESOURCE_REPLACEMENTS).toBe('blobUrl')
    expect(EPUB_DOCUMENT_CSP).toContain('img-src data:')
    expect(EPUB_DOCUMENT_CSP).toContain("style-src 'unsafe-inline' data:")
    expect(EPUB_DOCUMENT_CSP).not.toContain('blob:')
  })

  it('materializes only serialized-section blob resources before hardening', async () => {
    const loaded: string[] = []
    const hook = createEpubSerializeHook(async (url) => {
      loaded.push(url)
      if (url === 'blob:chapter-style') {
        return {
          dataUrl: 'data:text/css,unused',
          text: 'body { background: url(blob:chapter-image) }',
        }
      }
      if (url === 'blob:chapter-image') {
        return { dataUrl: 'data:image/png;base64,aW1hZ2U=' }
      }
      throw new Error(`Unexpected resource: ${url}`)
    })
    const section = {
      output: '<html><head><link rel="stylesheet" href="blob:chapter-style"></head><body><img src="blob:chapter-image"></body></html>',
    }

    await hook('<html><body>pre-substitution</body></html>', section)

    expect(loaded).toEqual(['blob:chapter-style', 'blob:chapter-image'])
    expect(section.output).toContain('<style>body { background: url(data:image/png;base64,aW1hZ2U=) }</style>')
    expect(section.output).toContain('src="data:image/png;base64,aW1hZ2U="')
    expect(section.output).not.toContain('blob:')
    expect(section.output).not.toContain('pre-substitution')
  })

  it('caches resources within one section and releases them before the next', async () => {
    let calls = 0
    const hook = createEpubSerializeHook(async (url) => {
      calls += 1
      if (url === 'blob:missing') throw new Error('revoked')
      return { dataUrl: 'data:image/png;base64,b2s=' }
    })
    const first = {
      output: '<html><body><img src="blob:shared"><img src="blob:shared"><img src="blob:missing"></body></html>',
    }
    const second = {
      output: '<html><body><img src="blob:shared"></body></html>',
    }

    await hook(first.output, first)
    await hook(second.output, second)

    expect(calls).toBe(3)
    expect(first.output).toContain('src="data:image/png;base64,b2s="')
    expect(first.output).toContain('src="data:,"')
    expect(second.output).toContain('src="data:image/png;base64,b2s="')
  })

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

  it('hardens tags whose attributes span lines', () => {
    const hardened = hardenEpubSerializedHtml(`
      <html
        lang="en">
        <head
          data-reader="book">
          <base
            href="https://example.com/">
          <meta
            http-equiv="refresh" content="0;url=https://example.com">
          <script
            type="text/javascript">bad()</script>
        </head>
        <body>Safe</body>
      </html>
    `)

    expect(hardened).toContain(`content="${EPUB_DOCUMENT_CSP}"`)
    expect(hardened).not.toMatch(/<script/i)
    expect(hardened).not.toMatch(/<base/i)
    expect(hardened).not.toMatch(/http-equiv="refresh"/i)
  })

  it('inlines generated data stylesheets without allowing markup escape', () => {
    const css = 'body { color: red } /* </style><script>bad()</script> */'
    const encoded = btoa(css)
    const hardened = hardenEpubSerializedHtml(
      `<html><head><link rel="stylesheet" media="screen" href="data:text/css;base64,${encoded}"></head><body>Safe</body></html>`,
    )

    expect(hardened).toContain('<style media="screen">body { color: red }')
    expect(hardened).toContain('<\\/style><script>bad()</script>')
    expect(hardened).not.toContain('<link rel="stylesheet"')
    expect(hardened).not.toMatch(/<\/style><script>/i)
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

  it('trails continuous rendition resizes and skips equal integer sizes', async () => {
    const calls: Array<[number, number]> = []
    let resolveFirstResize: (() => void) | null = null
    const firstResize = new Promise<void>(resolve => {
      resolveFirstResize = resolve
    })
    const scheduler = createEpubResizeScheduler(
      (width, height) => {
        calls.push([width, height])
        resolveFirstResize?.()
      },
      { width: 800.9, height: 600.9 },
      10,
    )

    scheduler.schedule(800.2, 600.4)
    scheduler.schedule(820.8, 600.4)
    scheduler.schedule(840.9, 600.9)
    await firstResize

    expect(calls).toEqual([[840, 600]])

    scheduler.schedule(840.1, 600.1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toEqual([[840, 600]])
    scheduler.cancel()
  })
})
