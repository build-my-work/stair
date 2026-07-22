import { posix } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import type { ImportedChapter, ImportedTextbook } from '@craft-agent/shared/learning'

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_HEADER = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50
const MAX_ZIP_ENTRIES = 5_000
const MAX_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024
const MAX_SPINE_ITEMS = 2_000
const MAX_TUTOR_TEXT_CHARS = 16 * 1024 * 1024

interface ZipEntry {
  path: string
  compressionMethod: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

interface ManifestItem {
  id: string
  href: string
  path: string
  mediaType?: string
  properties: string[]
}

/** Parse an EPUB in package reading order (OPF spine), not ZIP entry order. */
export function parseEpub(bytes: Uint8Array, sourceFilename: string): ImportedTextbook {
  const archive = new ZipArchive(bytes)
  const containerXml = archive.readText('META-INF/container.xml')
  const rootfileTag = firstTag(containerXml, 'rootfile')
  const opfPathValue = rootfileTag ? readAttributes(rootfileTag)['full-path'] : undefined
  if (!opfPathValue) throw new Error('Invalid EPUB: META-INF/container.xml has no rootfile')

  const opfPath = normalizeArchivePath(decodeUriPath(opfPathValue))
  const opfXml = archive.readText(opfPath)
  const manifest = parseManifest(opfXml, opfPath)
  const manifestById = new Map(manifest.map((item) => [item.id, item]))
  const spineTags = allTags(opfXml, 'itemref')
  if (spineTags.length === 0) throw new Error('Invalid EPUB: package document has no spine')
  if (spineTags.length > MAX_SPINE_ITEMS) {
    throw new Error(`EPUB contains too many spine items (limit ${MAX_SPINE_ITEMS})`)
  }

  const navigationTitles = parseNavigationTitles(archive, opfXml, opfPath, manifest, manifestById)
  const usedIds = new Set<string>()
  const chapters: ImportedChapter[] = []
  let tutorTextChars = 0

  for (const [spineIndex, tag] of spineTags.entries()) {
    const attrs = readAttributes(tag)
    const idref = attrs.idref
    if (!idref) continue
    const item = manifestById.get(idref)
    if (!item) throw new Error(`Invalid EPUB: spine item "${idref}" is missing from the manifest`)
    if (!isHtmlItem(item)) continue

    const xhtml = archive.readText(item.path)
    const title = navigationTitles.get(item.path)
      ?? extractElementText(xhtml, ['h1', 'h2', 'h3'])
      ?? extractElementText(xhtml, ['title'])
      ?? filenameTitle(item.href)
    const markdown = xhtmlToMarkdown(xhtml)
    const content = markdown || `# ${title}`
    tutorTextChars += content.length
    if (tutorTextChars > MAX_TUTOR_TEXT_CHARS) {
      throw new Error('EPUB contains too much text for tutoring')
    }

    chapters.push({
      id: uniqueId(slugify(item.id || title || item.href), usedIds),
      title,
      level: 1,
      order: chapters.length,
      locator: { format: 'epub', href: item.path, spineIndex },
      content,
    })
  }

  if (chapters.length === 0) throw new Error('Invalid EPUB: spine contains no readable HTML chapters')

  return {
    format: 'epub',
    sourceFilename,
    title: extractElementText(opfXml, ['title']) ?? filenameTitle(sourceFilename),
    author: extractElementText(opfXml, ['creator']),
    language: extractElementText(opfXml, ['language']),
    chapters,
  }
}

class ZipArchive {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private readonly entries = new Map<string, ZipEntry>()

  constructor(input: Uint8Array) {
    this.bytes = input
    this.view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    this.readDirectory()
    this.validateEntries()
  }

  readText(path: string): string {
    const normalized = normalizeArchivePath(path)
    const entry = this.entries.get(normalized)
    if (!entry) throw new Error(`Invalid EPUB: missing archive entry ${normalized}`)
    return new TextDecoder('utf-8', { fatal: true }).decode(this.readEntry(entry)).replace(/^\uFEFF/, '')
  }

  private readDirectory(): void {
    const eocdOffset = findEndOfCentralDirectory(this.view)
    const diskNumber = this.view.getUint16(eocdOffset + 4, true)
    const directoryDisk = this.view.getUint16(eocdOffset + 6, true)
    const entryCount = this.view.getUint16(eocdOffset + 10, true)
    const directorySize = this.view.getUint32(eocdOffset + 12, true)
    const directoryOffset = this.view.getUint32(eocdOffset + 16, true)

    if (diskNumber !== 0 || directoryDisk !== 0) throw new Error('Unsupported EPUB: multi-disk ZIP')
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new Error('Unsupported EPUB: ZIP64 archives are not supported')
    }
    if (entryCount > MAX_ZIP_ENTRIES) throw new Error(`EPUB contains too many files (limit ${MAX_ZIP_ENTRIES})`)
    assertRange(this.bytes, directoryOffset, directorySize, 'central directory')

    let offset = directoryOffset
    let expandedBytes = 0
    for (let index = 0; index < entryCount; index += 1) {
      if (this.view.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER) {
        throw new Error('Invalid EPUB: corrupt ZIP central directory')
      }

      const flags = this.view.getUint16(offset + 8, true)
      const compressionMethod = this.view.getUint16(offset + 10, true)
      const compressedSize = this.view.getUint32(offset + 20, true)
      const uncompressedSize = this.view.getUint32(offset + 24, true)
      const filenameLength = this.view.getUint16(offset + 28, true)
      const extraLength = this.view.getUint16(offset + 30, true)
      const commentLength = this.view.getUint16(offset + 32, true)
      const localHeaderOffset = this.view.getUint32(offset + 42, true)
      const recordSize = 46 + filenameLength + extraLength + commentLength
      assertRange(this.bytes, offset, recordSize, 'central directory entry')

      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new Error('Unsupported EPUB: ZIP64 entry')
      }
      if ((flags & 0x1) !== 0) throw new Error('Unsupported EPUB: encrypted content')
      if (uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`EPUB file is too large after extraction: ${uncompressedSize} bytes`)
      expandedBytes += uncompressedSize
      if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('EPUB expands beyond the allowed size')

      const rawName = this.bytes.subarray(offset + 46, offset + 46 + filenameLength)
      const name = new TextDecoder('utf-8', { fatal: true }).decode(rawName)
      const path = normalizeArchivePath(name)
      if (!path.endsWith('/')) {
        if (this.entries.has(path)) throw new Error(`Invalid EPUB: duplicate archive entry ${path}`)
        this.entries.set(path, {
          path,
          compressionMethod,
          flags,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
        })
      }
      offset += recordSize
    }
  }

  private validateEntries(): void {
    let expandedBytes = 0
    for (const entry of this.entries.values()) {
      expandedBytes += this.readEntry(entry).byteLength
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error('EPUB expands beyond the allowed size')
      }
    }
  }

  private readEntry(entry: ZipEntry): Uint8Array {
    const offset = entry.localHeaderOffset
    assertRange(this.bytes, offset, 30, `local header for ${entry.path}`)
    if (this.view.getUint32(offset, true) !== LOCAL_FILE_HEADER) {
      throw new Error(`Invalid EPUB: corrupt local header for ${entry.path}`)
    }
    const filenameLength = this.view.getUint16(offset + 26, true)
    const extraLength = this.view.getUint16(offset + 28, true)
    const dataOffset = offset + 30 + filenameLength + extraLength
    assertRange(this.bytes, dataOffset, entry.compressedSize, `data for ${entry.path}`)
    const compressed = this.bytes.subarray(dataOffset, dataOffset + entry.compressedSize)

    let output: Uint8Array
    if (entry.compressionMethod === 0) {
      output = compressed
    } else if (entry.compressionMethod === 8) {
      try {
        output = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES })
      } catch (error) {
        throw new Error(`Invalid EPUB: failed to decompress ${entry.path} within the size limit`, { cause: error })
      }
    } else {
      throw new Error(`Unsupported EPUB compression method ${entry.compressionMethod}`)
    }
    if (output.byteLength !== entry.uncompressedSize) {
      throw new Error(`Invalid EPUB: extracted size mismatch for ${entry.path}`)
    }
    return output
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557)
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset
  }
  throw new Error('Invalid EPUB: ZIP end record not found')
}

function assertRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new Error(`Invalid EPUB: ${label} is outside the archive`)
  }
}

function parseManifest(opfXml: string, opfPath: string): ManifestItem[] {
  return allTags(opfXml, 'item').map((tag) => {
    const attrs = readAttributes(tag)
    const id = attrs.id
    const href = attrs.href
    if (!id || !href) throw new Error('Invalid EPUB: manifest item is missing id or href')
    return {
      id,
      href,
      path: resolveArchiveHref(opfPath, href),
      mediaType: attrs['media-type'],
      properties: (attrs.properties ?? '').split(/\s+/).filter(Boolean),
    }
  })
}

function parseNavigationTitles(
  archive: ZipArchive,
  opfXml: string,
  opfPath: string,
  manifest: ManifestItem[],
  manifestById: Map<string, ManifestItem>,
): Map<string, string> {
  const titles = new Map<string, string>()
  const navItem = manifest.find((item) => item.properties.includes('nav'))
  if (navItem) {
    const navXml = archive.readText(navItem.path)
    for (const link of navXml.matchAll(/<(?:[\w.-]+:)?a\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?a\s*>/gi)) {
      const href = readAttributes(link[1] ?? '').href
      const title = plainText(link[2] ?? '')
      if (!href || !title) continue
      titles.set(resolveArchiveHref(navItem.path, href), title)
    }
  }

  if (titles.size === 0) {
    const spineTag = firstTag(opfXml, 'spine')
    const tocId = spineTag ? readAttributes(spineTag).toc : undefined
    const ncxItem = (tocId ? manifestById.get(tocId) : undefined)
      ?? manifest.find((item) => item.mediaType === 'application/x-dtbncx+xml')
    if (ncxItem) {
      const ncxXml = archive.readText(ncxItem.path)
      const starts = [...ncxXml.matchAll(/<(?:[\w.-]+:)?navPoint\b/gi)].map((match) => match.index ?? 0)
      for (const [index, start] of starts.entries()) {
        const segment = ncxXml.slice(start, starts[index + 1] ?? ncxXml.length)
        const text = extractElementText(segment, ['text'])
        const contentTag = firstTag(segment, 'content')
        const src = contentTag ? readAttributes(contentTag).src : undefined
        if (text && src) titles.set(resolveArchiveHref(ncxItem.path, src), text)
      }
    }
  }
  return titles
}

function isHtmlItem(item: ManifestItem): boolean {
  return item.mediaType === 'application/xhtml+xml'
    || item.mediaType === 'text/html'
    || /\.(?:xhtml|html|htm)$/i.test(item.path)
}

function resolveArchiveHref(baseFile: string, href: string): string {
  const pathOnly = href.split('#', 1)[0]!.split('?', 1)[0]!
  const decoded = decodeUriPath(pathOnly)
  if (decoded.startsWith('/') || decoded.includes('\\')) throw new Error(`Invalid EPUB path: ${href}`)
  return normalizeArchivePath(posix.join(posix.dirname(baseFile), decoded))
}

function normalizeArchivePath(input: string): string {
  const normalized = posix.normalize(input.replaceAll('\\', '/')).replace(/^\.\//, '')
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid EPUB archive path: ${input}`)
  }
  return normalized
}

function decodeUriPath(value: string): string {
  try {
    return decodeURIComponent(decodeXmlEntities(value))
  } catch {
    throw new Error(`Invalid EPUB URI: ${value}`)
  }
}

function allTags(xml: string, localName: string): string[] {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*>`, 'gi')
  return xml.match(pattern) ?? []
}

function firstTag(xml: string, localName: string): string | undefined {
  return allTags(xml, localName)[0]
}

function readAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (const match of tag.matchAll(pattern)) {
    const name = match[1]!.toLowerCase()
    const value = decodeXmlEntities(match[2] ?? match[3] ?? '')
    attributes[name] = value
    const localName = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
    attributes[localName] ??= value
  }
  return attributes
}

function extractElementText(xml: string, localNames: string[]): string | undefined {
  for (const localName of localNames) {
    const pattern = new RegExp(
      `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}\\s*>`,
      'i',
    )
    const match = pattern.exec(xml)
    const text = match?.[1] ? plainText(match[1]) : ''
    if (text) return text
  }
  return undefined
}

/** Conservative XHTML-to-Markdown conversion for tutor-readable chapter text. */
export function xhtmlToMarkdown(xhtml: string): string {
  let body = /<(?:[\w.-]+:)?body\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?body\s*>/i.exec(xhtml)?.[1] ?? xhtml
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:[\w.-]+:)?(?:script|style|svg|iframe|head)\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?(?:script|style|svg|iframe|head)\s*>/gi, '')
    .replace(/<(?:[\w.-]+:)?h([1-6])\b[^>]*>/gi, (_match, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/(?:[\w.-]+:)?h[1-6]\s*>/gi, '\n\n')
    .replace(/<(?:[\w.-]+:)?(?:br|hr)\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<(?:[\w.-]+:)?li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:[\w.-]+:)?li\s*>/gi, '\n')
    .replace(/<(?:[\w.-]+:)?blockquote\b[^>]*>/gi, '\n> ')
    .replace(/<\/(?:[\w.-]+:)?blockquote\s*>/gi, '\n')
    .replace(/<(?:[\w.-]+:)?pre\b[^>]*>/gi, '\n\n```\n')
    .replace(/<\/(?:[\w.-]+:)?pre\s*>/gi, '\n```\n\n')
    .replace(/<\/(?:[\w.-]+:)?(?:p|div|section|article|aside|nav|ol|ul|table|tr)\s*>/gi, '\n\n')
    .replace(/<\/(?:[\w.-]+:)?(?:td|th)\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')

  return decodeXmlEntities(body)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function plainText(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: '\u00a0', quot: '"',
    ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®',
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, key: string) => {
    if (key.startsWith('#x') || key.startsWith('#X')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16))
    if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10))
    return named[key.toLowerCase()] ?? entity
  })
}

function filenameTitle(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.(?:epub|xhtml|html?|md|markdown)$/i, '').replace(/[-_]+/g, ' ').trim() || 'Imported textbook'
}

function slugify(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'chapter'
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  const id = `${base}-${suffix}`
  used.add(id)
  return id
}
