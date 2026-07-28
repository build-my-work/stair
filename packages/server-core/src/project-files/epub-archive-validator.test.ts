import { describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import { deflateRawSync } from 'node:zlib'

import {
  EPUB_ARCHIVE_LIMITS,
  EpubArchiveOutputBudget,
  validateEpubArchive,
} from './epub-archive-validator'

interface ZipFixtureEntry {
  name: string
  content: string | Uint8Array
  compression?: 0 | 8
  flags?: number
  centralCompressedSize?: number
  centralUncompressedSize?: number
  localCompressedSize?: number
  localUncompressedSize?: number
  centralExtra?: Uint8Array
  localExtra?: Uint8Array
}

interface ZipFixtureOptions {
  eocdEntryCount?: number
}

function zipEntry(
  entry: ZipFixtureEntry,
  localHeaderOffset: number,
): { local: Buffer; central: Buffer } {
  const name = Buffer.from(entry.name, 'utf8')
  const content = typeof entry.content === 'string'
    ? Buffer.from(entry.content, 'utf8')
    : Buffer.from(entry.content)
  const compression = entry.compression ?? 8
  const compressed = compression === 0 ? content : deflateRawSync(content)
  const flags = (entry.flags ?? 0) | 0x800
  const centralCompressedSize = entry.centralCompressedSize ?? compressed.byteLength
  const centralUncompressedSize = entry.centralUncompressedSize ?? content.byteLength
  const localCompressedSize = entry.localCompressedSize ?? centralCompressedSize
  const localUncompressedSize = entry.localUncompressedSize ?? centralUncompressedSize
  const localExtra = Buffer.from(entry.localExtra ?? [])
  const centralExtra = Buffer.from(entry.centralExtra ?? [])

  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(flags, 6)
  localHeader.writeUInt16LE(compression, 8)
  localHeader.writeUInt32LE(0, 14)
  localHeader.writeUInt32LE(localCompressedSize, 18)
  localHeader.writeUInt32LE(localUncompressedSize, 22)
  localHeader.writeUInt16LE(name.byteLength, 26)
  localHeader.writeUInt16LE(localExtra.byteLength, 28)

  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(0x02014b50, 0)
  centralHeader.writeUInt16LE(20, 4)
  centralHeader.writeUInt16LE(20, 6)
  centralHeader.writeUInt16LE(flags, 8)
  centralHeader.writeUInt16LE(compression, 10)
  centralHeader.writeUInt32LE(0, 16)
  centralHeader.writeUInt32LE(centralCompressedSize, 20)
  centralHeader.writeUInt32LE(centralUncompressedSize, 24)
  centralHeader.writeUInt16LE(name.byteLength, 28)
  centralHeader.writeUInt16LE(centralExtra.byteLength, 30)
  centralHeader.writeUInt16LE(0, 32)
  centralHeader.writeUInt16LE(0, 34)
  centralHeader.writeUInt32LE(0, 38)
  centralHeader.writeUInt32LE(localHeaderOffset, 42)

  return {
    local: Buffer.concat([localHeader, name, localExtra, compressed]),
    central: Buffer.concat([centralHeader, name, centralExtra]),
  }
}

function makeZip(
  entries: ZipFixtureEntry[],
  options: ZipFixtureOptions = {},
): Uint8Array {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localHeaderOffset = 0

  for (const entry of entries) {
    const encoded = zipEntry(entry, localHeaderOffset)
    localParts.push(encoded.local)
    centralParts.push(encoded.central)
    localHeaderOffset += encoded.local.byteLength
  }

  const centralDirectory = Buffer.concat(centralParts)
  const entryCount = options.eocdEntryCount ?? entries.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entryCount, 8)
  eocd.writeUInt16LE(entryCount, 10)
  eocd.writeUInt32LE(centralDirectory.byteLength, 12)
  eocd.writeUInt32LE(localHeaderOffset, 16)

  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function validEntries(extra: ZipFixtureEntry[] = []): ZipFixtureEntry[] {
  return [
    {
      name: 'mimetype',
      content: 'application/epub+zip',
      compression: 0,
    },
    {
      name: 'META-INF/container.xml',
      content: '<container/>',
    },
    ...extra,
  ]
}

async function expectValidationCode(
  bytes: Uint8Array,
  code: string,
): Promise<void> {
  try {
    await validateEpubArchive(bytes)
    throw new Error('Expected EPUB validation to fail')
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

describe('validateEpubArchive', () => {
  it('accepts a bounded EPUB and reports actual output bytes', async () => {
    const entries = validEntries([
      {
        name: 'OPS/chapter.xhtml',
        content: '<html><body>Chapter</body></html>',
      },
    ])
    const result = await validateEpubArchive(makeZip(entries))
    const expectedBytes = entries.reduce(
      (total, entry) => total + Buffer.byteLength(entry.content),
      0,
    )

    expect(result).toEqual({
      entryCount: 3,
      uncompressedBytes: expectedBytes,
    })
  })

  it('rejects corrupt ZIP data', async () => {
    await expectValidationCode(
      Buffer.alloc(22),
      'EPUB_ARCHIVE_INVALID',
    )
  })

  it('requires the EPUB mimetype entry first, stored, and exact', async () => {
    await expectValidationCode(
      makeZip([
        {
          name: 'META-INF/container.xml',
          content: '<container/>',
        },
        {
          name: 'mimetype',
          content: 'application/epub+zip',
          compression: 0,
        },
      ]),
      'EPUB_ARCHIVE_INVALID_MIMETYPE',
    )
    await expectValidationCode(
      makeZip(validEntries().map(entry => (
        entry.name === 'mimetype'
          ? { ...entry, content: 'text/plain' }
          : entry
      ))),
      'EPUB_ARCHIVE_INVALID_MIMETYPE',
    )
  })

  it('requires META-INF/container.xml', async () => {
    await expectValidationCode(
      makeZip([validEntries()[0]]),
      'EPUB_ARCHIVE_MISSING_CONTAINER',
    )
  })

  it('rejects traversal, encrypted entries, and ZIP64 markers', async () => {
    await expectValidationCode(
      makeZip(validEntries([{ name: '../outside.xhtml', content: 'bad' }])),
      'EPUB_ARCHIVE_TRAVERSAL',
    )
    await expectValidationCode(
      makeZip(validEntries([{ name: 'OPS/private.xhtml', content: 'secret', flags: 0x1 }])),
      'EPUB_ARCHIVE_ENCRYPTED',
    )
    await expectValidationCode(
      makeZip(validEntries([{
        name: 'OPS/zip64.xhtml',
        content: 'zip64',
        centralExtra: Buffer.from([0x01, 0x00, 0x00, 0x00]),
      }])),
      'EPUB_ARCHIVE_ZIP64',
    )
  })

  it('rejects declared entry, total, count, and compressed-size limits', async () => {
    await expectValidationCode(
      makeZip(validEntries([{
        name: 'OPS/large.xhtml',
        content: 'x',
        centralUncompressedSize: EPUB_ARCHIVE_LIMITS.entryBytes + 1,
      }])),
      'EPUB_ARCHIVE_ENTRY_TOO_LARGE',
    )

    const declaredTotalEntries = validEntries(
      Array.from({ length: 9 }, (_, index) => ({
        name: `OPS/${index}.xhtml`,
        content: 'x',
        centralCompressedSize: 1024 * 1024,
        centralUncompressedSize: 32 * 1024 * 1024,
      })),
    )
    await expectValidationCode(
      makeZip(declaredTotalEntries),
      'EPUB_ARCHIVE_TOO_LARGE',
    )

    await expectValidationCode(
      makeZip(validEntries(), { eocdEntryCount: EPUB_ARCHIVE_LIMITS.entries + 1 }),
      'EPUB_ARCHIVE_TOO_MANY_ENTRIES',
    )

    await expectValidationCode(
      new Uint8Array(EPUB_ARCHIVE_LIMITS.compressedBytes + 1),
      'EPUB_ARCHIVE_TOO_LARGE',
    )
  })

  it('counts inflate output instead of trusting a forged declared size', async () => {
    const actualContent = Buffer.alloc(512 * 1024, 0x41)
    const bytes = makeZip(validEntries([{
      name: 'OPS/forged.xhtml',
      content: actualContent,
      centralUncompressedSize: 1,
      localUncompressedSize: 1,
    }]))

    await expectValidationCode(
      bytes,
      'EPUB_ARCHIVE_COMPRESSION_RATIO_EXCEEDED',
    )
  })
})

describe('EpubArchiveOutputBudget', () => {
  it('enforces actual per-entry, cumulative, and ratio limits', () => {
    const perEntry = new EpubArchiveOutputBudget({
      entryBytes: 8,
      uncompressedBytes: 100,
      compressionRatio: 100,
    })
    perEntry.beginEntry()
    expect(() => perEntry.addChunk(9, 9)).toThrow(
      expect.objectContaining({ code: 'EPUB_ARCHIVE_ENTRY_TOO_LARGE' }),
    )

    const cumulative = new EpubArchiveOutputBudget({
      entryBytes: 100,
      uncompressedBytes: 10,
      compressionRatio: 100,
    })
    cumulative.beginEntry()
    cumulative.addChunk(6, 6)
    cumulative.beginEntry()
    expect(() => cumulative.addChunk(5, 5)).toThrow(
      expect.objectContaining({ code: 'EPUB_ARCHIVE_TOO_LARGE' }),
    )

    const ratio = new EpubArchiveOutputBudget({
      entryBytes: 100,
      uncompressedBytes: 100,
      compressionRatio: 10,
    })
    ratio.beginEntry()
    expect(() => ratio.addChunk(11, 1)).toThrow(
      expect.objectContaining({ code: 'EPUB_ARCHIVE_COMPRESSION_RATIO_EXCEEDED' }),
    )
  })
})
