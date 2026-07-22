import { describe, expect, it } from 'bun:test'
import { deflateRawSync } from 'node:zlib'

import { parseEpub, xhtmlToMarkdown } from './epub'
import { parseTextbook } from './import-textbook'

describe('parseEpub', () => {
  it('uses OPF spine order and EPUB navigation titles instead of ZIP order', () => {
    const epub = makeZip([
      // Deliberately place chapter two before chapter one in the ZIP.
      ['OPS/Text/chapter-two.xhtml', xhtml('<h1>Fallback two</h1><p>Second body.</p>')],
      ['mimetype', 'application/epub+zip', false],
      ['META-INF/container.xml', `<?xml version="1.0"?>
        <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
        </container>`],
      ['OPS/nav.xhtml', xhtml(`<nav epub:type="toc">
        <ol>
          <li><a href="Text/chapter%20one.xhtml#start">The First Lesson</a></li>
          <li><a href="Text/chapter-two.xhtml">The Second Lesson</a></li>
        </ol>
      </nav>`)],
      ['OPS/Text/chapter one.xhtml', xhtml('<h1>Fallback one</h1><p>First <strong>body</strong>.</p><script>ignore me</script>')],
      ['OPS/package.opf', `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>Thinking Clearly</dc:title><dc:creator>A. Teacher</dc:creator>
            <dc:language>  en-US  </dc:language>
          </metadata>
          <manifest>
            <item id="two" href="Text/chapter-two.xhtml" media-type="application/xhtml+xml"/>
            <item id="one" href="Text/chapter%20one.xhtml" media-type="application/xhtml+xml"/>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          </manifest>
          <spine><itemref idref="one"/><itemref idref="two"/></spine>
        </package>`],
    ])

    const result = parseEpub(epub, 'thinking.epub')

    expect(result).toMatchObject({
      format: 'epub',
      sourceFilename: 'thinking.epub',
      title: 'Thinking Clearly',
      author: 'A. Teacher',
      language: 'en-US',
    })
    expect(result.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      order: chapter.order,
      locator: chapter.locator,
    }))).toEqual([
      {
        id: 'one',
        title: 'The First Lesson',
        order: 0,
        locator: { format: 'epub', href: 'OPS/Text/chapter one.xhtml', spineIndex: 0 },
      },
      {
        id: 'two',
        title: 'The Second Lesson',
        order: 1,
        locator: { format: 'epub', href: 'OPS/Text/chapter-two.xhtml', spineIndex: 1 },
      },
    ])
    expect(result.chapters[0]?.content).toContain('# Fallback one')
    expect(result.chapters[0]?.content).toContain('First body.')
    expect(result.chapters[0]?.content).not.toContain('ignore me')
  })

  it('falls back to NCX titles for EPUB 2', () => {
    const epub = makeZip([
      ['mimetype', 'application/epub+zip', false],
      ['META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'],
      ['book.opf', `<package>
        <metadata><dc:title xmlns:dc="urn:dc">Old Book</dc:title></metadata>
        <manifest>
          <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
          <item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine toc="ncx"><itemref idref="c1"/></spine>
      </package>`],
      ['toc.ncx', `<ncx><navMap><navPoint><navLabel><text>NCX Chapter</text></navLabel><content src="one.xhtml#part"/></navPoint></navMap></ncx>`],
      ['one.xhtml', xhtml('<p>Legacy content</p>')],
    ])

    expect(parseEpub(epub, 'old.epub').chapters[0]?.title).toBe('NCX Chapter')
  })

  it('rejects archive path traversal before reading package data', () => {
    const epub = makeZip([['../META-INF/container.xml', '<container/>']])
    expect(() => parseEpub(epub, 'bad.epub')).toThrow('Invalid EPUB archive path')
  })

  it('validates unused resources and caps deflate output when their extracted size is forged', () => {
    const epub = makeZip([
      ['META-INF/container.xml', '<container/>'],
      ['OPS/unused-image.jpg', ' '.repeat(8 * 1024 * 1024 + 1), true, 1],
    ])

    expect(() => parseEpub(epub, 'oversized.epub')).toThrow('failed to decompress')
  })
})

describe('textbook import', () => {
  it('normalizes Markdown and EPUB behind one result shape', () => {
    const markdown = new TextEncoder().encode('# Opening\nBody\n\n## Detail\nMore')
    const result = parseTextbook(markdown, 'course.md')

    expect(result).toMatchObject({ format: 'markdown', sourceFilename: 'course.md', title: 'Opening' })
    expect(result.chapters).toHaveLength(2)
    expect(result.chapters[0]?.locator).toEqual({ format: 'markdown', startLine: 1, endLine: 5 })
  })

  it('rejects unsupported formats', () => {
    expect(() => parseTextbook(new TextEncoder().encode('text'), 'course.txt')).toThrow('Unsupported textbook format')
  })
})

describe('xhtmlToMarkdown', () => {
  it('keeps headings, lists, and paragraph boundaries while dropping active content', () => {
    const markdown = xhtmlToMarkdown(xhtml('<h2>Title</h2><p>Hello&nbsp;world.</p><ul><li>One</li><li>Two</li></ul><style>bad</style>'))
    expect(markdown).toBe('## Title\n\nHello world.\n\n- One\n\n- Two')
  })
})

function xhtml(body: string): string {
  return `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page</title></head><body>${body}</body></html>`
}

type ZipFixtureEntry = [path: string, content: string, deflate?: boolean, declaredSize?: number]

/** Small readable ZIP builder; fixtures stay as XML strings instead of opaque binaries. */
function makeZip(entries: ZipFixtureEntry[]): Uint8Array {
  const localRecords: Buffer[] = []
  const directoryRecords: Buffer[] = []
  let localOffset = 0

  for (const [path, content, shouldDeflate = true, declaredSize] of entries) {
    const filename = Buffer.from(path, 'utf8')
    const raw = Buffer.from(content, 'utf8')
    const compressed = shouldDeflate ? deflateRawSync(raw) : raw
    const method = shouldDeflate ? 8 : 0
    const flags = 0x800
    const uncompressedSize = declaredSize ?? raw.length

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt32LE(0, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(uncompressedSize, 22)
    localHeader.writeUInt16LE(filename.length, 26)
    localRecords.push(localHeader, filename, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt32LE(0, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(uncompressedSize, 24)
    centralHeader.writeUInt16LE(filename.length, 28)
    centralHeader.writeUInt32LE(localOffset, 42)
    directoryRecords.push(centralHeader, filename)

    localOffset += localHeader.length + filename.length + compressed.length
  }

  const directory = Buffer.concat(directoryRecords)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(localOffset, 16)

  return Buffer.concat([...localRecords, directory, end])
}
