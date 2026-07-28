import { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'

import {
  fromBuffer,
  type Entry,
  type ZipFile,
} from 'yauzl'

export const EPUB_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 32 * 1024 * 1024,
  uncompressedBytes: 256 * 1024 * 1024,
  entryBytes: 32 * 1024 * 1024,
  entries: 5_000,
  compressionRatio: 100,
})

export type EpubArchiveValidationErrorCode =
  | 'EPUB_ARCHIVE_INVALID'
  | 'EPUB_ARCHIVE_TOO_LARGE'
  | 'EPUB_ARCHIVE_TOO_MANY_ENTRIES'
  | 'EPUB_ARCHIVE_ENTRY_TOO_LARGE'
  | 'EPUB_ARCHIVE_COMPRESSION_RATIO_EXCEEDED'
  | 'EPUB_ARCHIVE_TRAVERSAL'
  | 'EPUB_ARCHIVE_ENCRYPTED'
  | 'EPUB_ARCHIVE_ZIP64'
  | 'EPUB_ARCHIVE_INVALID_MIMETYPE'
  | 'EPUB_ARCHIVE_MISSING_CONTAINER'

export class EpubArchiveValidationError extends Error {
  constructor(
    readonly code: EpubArchiveValidationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'EpubArchiveValidationError'
  }
}

export interface EpubArchiveValidationResult {
  entryCount: number
  uncompressedBytes: number
}

interface ArchiveLimits {
  compressedBytes: number
  uncompressedBytes: number
  entryBytes: number
  entries: number
  compressionRatio: number
}

interface CentralDirectoryEntry {
  compressionMethod: number
  flags: number
  localHeaderOffset: number
  fileName: string
}

interface CentralDirectorySummary {
  entryCount: number
}

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const ZIP64_EXTRA_FIELD_ID = 0x0001
const ZIP64_SENTINEL_16 = 0xffff
const ZIP64_SENTINEL_32 = 0xffffffff
const MAX_ZIP_COMMENT_BYTES = 0xffff
const EPUB_MIMETYPE = 'application/epub+zip'
const EPUB_MIMETYPE_ENTRY = 'mimetype'
const EPUB_CONTAINER_ENTRY = 'META-INF/container.xml'

function validationError(
  code: EpubArchiveValidationErrorCode,
  message: string,
  cause?: unknown,
): EpubArchiveValidationError {
  return new EpubArchiveValidationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function readUInt16(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) {
    throw validationError('EPUB_ARCHIVE_INVALID', 'Truncated EPUB archive')
  }
  return buffer.readUInt16LE(offset)
}

function readUInt32(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw validationError('EPUB_ARCHIVE_INVALID', 'Truncated EPUB archive')
  }
  return buffer.readUInt32LE(offset)
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const lowerBound = Math.max(0, buffer.length - (22 + MAX_ZIP_COMMENT_BYTES))
  for (let offset = buffer.length - 22; offset >= lowerBound; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue
    const commentLength = readUInt16(buffer, offset + 20)
    if (offset + 22 + commentLength === buffer.length) return offset
  }
  throw validationError('EPUB_ARCHIVE_INVALID', 'Missing ZIP end-of-central-directory record')
}

function hasZip64ExtraField(buffer: Buffer, start: number, length: number): boolean {
  const end = start + length
  if (start < 0 || length < 0 || end > buffer.length) {
    throw validationError('EPUB_ARCHIVE_INVALID', 'Truncated ZIP extra field')
  }

  let offset = start
  while (offset < end) {
    if (offset + 4 > end) {
      throw validationError('EPUB_ARCHIVE_INVALID', 'Malformed ZIP extra field')
    }
    const id = readUInt16(buffer, offset)
    const dataLength = readUInt16(buffer, offset + 2)
    offset += 4
    if (offset + dataLength > end) {
      throw validationError('EPUB_ARCHIVE_INVALID', 'Malformed ZIP extra field')
    }
    if (id === ZIP64_EXTRA_FIELD_ID) return true
    offset += dataLength
  }
  return false
}

function decodeEntryName(buffer: Buffer, utf8: boolean): string {
  // The security-sensitive EPUB names are ASCII. latin1 preserves byte boundaries
  // for legacy ZIP names until yauzl performs its canonical CP437 decoding.
  return buffer.toString(utf8 ? 'utf8' : 'latin1')
}

function assertSafeEntryPath(fileName: string): void {
  if (
    !fileName
    || fileName.includes('\0')
    || fileName.includes('\\')
    || fileName.startsWith('/')
    || /^[A-Za-z]:/.test(fileName)
  ) {
    throw validationError('EPUB_ARCHIVE_TRAVERSAL', `Unsafe EPUB entry path: ${fileName}`)
  }

  const path = fileName.endsWith('/') ? fileName.slice(0, -1) : fileName
  if (path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw validationError('EPUB_ARCHIVE_TRAVERSAL', `Unsafe EPUB entry path: ${fileName}`)
  }
}

function ratioExceedsLimit(
  uncompressedBytes: number,
  compressedBytes: number,
  limit: number,
): boolean {
  if (uncompressedBytes === 0) return false
  if (compressedBytes === 0) return true
  return uncompressedBytes > compressedBytes * limit
}

function inspectLocalHeader(
  buffer: Buffer,
  entry: CentralDirectoryEntry,
): void {
  const offset = entry.localHeaderOffset
  if (readUInt32(buffer, offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw validationError('EPUB_ARCHIVE_INVALID', 'Invalid ZIP local file header')
  }

  const flags = readUInt16(buffer, offset + 6)
  const compressionMethod = readUInt16(buffer, offset + 8)
  const compressedSize = readUInt32(buffer, offset + 18)
  const uncompressedSize = readUInt32(buffer, offset + 22)
  const fileNameLength = readUInt16(buffer, offset + 26)
  const extraLength = readUInt16(buffer, offset + 28)
  const variableStart = offset + 30
  const extraStart = variableStart + fileNameLength

  if (
    compressedSize === ZIP64_SENTINEL_32
    || uncompressedSize === ZIP64_SENTINEL_32
    || hasZip64ExtraField(buffer, extraStart, extraLength)
  ) {
    throw validationError('EPUB_ARCHIVE_ZIP64', 'ZIP64 EPUB archives are not supported')
  }
  if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
    throw validationError('EPUB_ARCHIVE_ENCRYPTED', 'Encrypted EPUB entries are not supported')
  }
  if (flags !== entry.flags || compressionMethod !== entry.compressionMethod) {
    throw validationError('EPUB_ARCHIVE_INVALID', 'ZIP local and central headers disagree')
  }
}

function inspectCentralDirectory(
  buffer: Buffer,
  limits: ArchiveLimits,
): CentralDirectorySummary {
  const eocdOffset = findEndOfCentralDirectory(buffer)
  const diskNumber = readUInt16(buffer, eocdOffset + 4)
  const centralDirectoryDisk = readUInt16(buffer, eocdOffset + 6)
  const entriesOnDisk = readUInt16(buffer, eocdOffset + 8)
  const entryCount = readUInt16(buffer, eocdOffset + 10)
  const centralDirectorySize = readUInt32(buffer, eocdOffset + 12)
  const centralDirectoryOffset = readUInt32(buffer, eocdOffset + 16)

  if (
    entriesOnDisk === ZIP64_SENTINEL_16
    || entryCount === ZIP64_SENTINEL_16
    || centralDirectorySize === ZIP64_SENTINEL_32
    || centralDirectoryOffset === ZIP64_SENTINEL_32
  ) {
    throw validationError('EPUB_ARCHIVE_ZIP64', 'ZIP64 EPUB archives are not supported')
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw validationError('EPUB_ARCHIVE_INVALID', 'Multi-disk EPUB archives are not supported')
  }
  if (entryCount > limits.entries) {
    throw validationError(
      'EPUB_ARCHIVE_TOO_MANY_ENTRIES',
      `EPUB archive has more than ${limits.entries} entries`,
    )
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  if (centralDirectoryEnd > eocdOffset) {
    throw validationError('EPUB_ARCHIVE_INVALID', 'Invalid ZIP central-directory bounds')
  }

  let firstEntry: CentralDirectoryEntry | undefined
  let declaredUncompressedBytes = 0
  let offset = centralDirectoryOffset

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(buffer, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw validationError('EPUB_ARCHIVE_INVALID', 'Invalid ZIP central-directory entry')
    }

    const flags = readUInt16(buffer, offset + 8)
    const compressionMethod = readUInt16(buffer, offset + 10)
    const compressedSize = readUInt32(buffer, offset + 20)
    const uncompressedSize = readUInt32(buffer, offset + 24)
    const fileNameLength = readUInt16(buffer, offset + 28)
    const extraLength = readUInt16(buffer, offset + 30)
    const commentLength = readUInt16(buffer, offset + 32)
    const diskStart = readUInt16(buffer, offset + 34)
    const localHeaderOffset = readUInt32(buffer, offset + 42)
    const variableStart = offset + 46
    const extraStart = variableStart + fileNameLength
    const nextOffset = extraStart + extraLength + commentLength

    if (nextOffset > centralDirectoryEnd) {
      throw validationError('EPUB_ARCHIVE_INVALID', 'Truncated ZIP central-directory entry')
    }
    if (
      compressedSize === ZIP64_SENTINEL_32
      || uncompressedSize === ZIP64_SENTINEL_32
      || localHeaderOffset === ZIP64_SENTINEL_32
      || diskStart === ZIP64_SENTINEL_16
      || hasZip64ExtraField(buffer, extraStart, extraLength)
    ) {
      throw validationError('EPUB_ARCHIVE_ZIP64', 'ZIP64 EPUB archives are not supported')
    }
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
      throw validationError('EPUB_ARCHIVE_ENCRYPTED', 'Encrypted EPUB entries are not supported')
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw validationError(
        'EPUB_ARCHIVE_INVALID',
        `Unsupported EPUB compression method: ${compressionMethod}`,
      )
    }

    const fileName = decodeEntryName(
      buffer.subarray(variableStart, extraStart),
      (flags & 0x800) !== 0,
    )
    assertSafeEntryPath(fileName)

    if (uncompressedSize > limits.entryBytes) {
      throw validationError(
        'EPUB_ARCHIVE_ENTRY_TOO_LARGE',
        `EPUB entry exceeds ${limits.entryBytes} bytes`,
      )
    }
    declaredUncompressedBytes += uncompressedSize
    if (declaredUncompressedBytes > limits.uncompressedBytes) {
      throw validationError(
        'EPUB_ARCHIVE_TOO_LARGE',
        `EPUB expands beyond ${limits.uncompressedBytes} bytes`,
      )
    }
    if (ratioExceedsLimit(uncompressedSize, compressedSize, limits.compressionRatio)) {
      throw validationError(
        'EPUB_ARCHIVE_COMPRESSION_RATIO_EXCEEDED',
        `EPUB entry exceeds compression ratio ${limits.compressionRatio}`,
      )
    }

    const entry = {
      compressionMethod,
      flags,
      localHeaderOffset,
      fileName,
    }
    inspectLocalHeader(buffer, entry)
    if (index === 0) firstEntry = entry
    offset = nextOffset
  }

  if (offset !== centralDirectoryEnd) {
    throw validationError('EPUB_ARCHIVE_INVALID', 'Unexpected ZIP central-directory data')
  }
  if (
    firstEntry?.fileName !== EPUB_MIMETYPE_ENTRY
    || firstEntry.compressionMethod !== 0
    || firstEntry.localHeaderOffset !== 0
  ) {
    throw validationError(
      'EPUB_ARCHIVE_INVALID_MIMETYPE',
      'EPUB mimetype must be the first uncompressed archive entry',
    )
  }

  return { entryCount }
}

/**
 * Mutable counter kept separate from ZIP metadata checks so actual decompressed
 * output remains the authority for byte and ratio limits.
 */
export class EpubArchiveOutputBudget {
  private currentEntryBytes = 0
  private totalBytes = 0

  constructor(
    private readonly limits: Pick<
      ArchiveLimits,
      'entryBytes' | 'uncompressedBytes' | 'compressionRatio'
    > = EPUB_ARCHIVE_LIMITS,
  ) {}

  beginEntry(): void {
    this.currentEntryBytes = 0
  }

  addChunk(byteLength: number, compressedBytes: number): void {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw validationError('EPUB_ARCHIVE_INVALID', 'Invalid decompressed EPUB byte count')
    }

    this.currentEntryBytes += byteLength
    this.totalBytes += byteLength
    if (this.currentEntryBytes > this.limits.entryBytes) {
      throw validationError(
        'EPUB_ARCHIVE_ENTRY_TOO_LARGE',
        `EPUB entry expands beyond ${this.limits.entryBytes} bytes`,
      )
    }
    if (this.totalBytes > this.limits.uncompressedBytes) {
      throw validationError(
        'EPUB_ARCHIVE_TOO_LARGE',
        `EPUB expands beyond ${this.limits.uncompressedBytes} bytes`,
      )
    }
    if (
      ratioExceedsLimit(
        this.currentEntryBytes,
        compressedBytes,
        this.limits.compressionRatio,
      )
    ) {
      throw validationError(
        'EPUB_ARCHIVE_COMPRESSION_RATIO_EXCEEDED',
        `EPUB entry exceeds compression ratio ${this.limits.compressionRatio}`,
      )
    }
  }

  get uncompressedBytes(): number {
    return this.totalBytes
  }
}

function openArchive(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromBuffer(
      buffer,
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        strictFileNames: true,
        // Declared sizes are intentionally not trusted. The stream below counts
        // the bytes produced by inflate and enforces the limits itself.
        validateEntrySizes: false,
      },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(validationError('EPUB_ARCHIVE_INVALID', 'Invalid EPUB ZIP archive', error))
          return
        }
        resolve(zipFile)
      },
    )
  })
}

function scanArchiveOutput(
  zipFile: ZipFile,
  expectedEntryCount: number,
): Promise<EpubArchiveValidationResult> {
  return new Promise((resolve, reject) => {
    const budget = new EpubArchiveOutputBudget()
    let settled = false
    let entryCount = 0
    let hasContainer = false
    let mimetype: Buffer | undefined
    let activeStream: Readable | undefined

    const close = () => {
      try {
        zipFile.close()
      } catch {
        // yauzl close is idempotent, but malformed archives can close first.
      }
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      activeStream?.destroy()
      close()
      reject(
        error instanceof EpubArchiveValidationError
          ? error
          : validationError('EPUB_ARCHIVE_INVALID', 'Failed to scan EPUB archive', error),
      )
    }

    zipFile.on('error', fail)
    zipFile.on('entry', (entry: Entry) => {
      if (settled) return
      try {
        entryCount += 1
        if (entryCount > EPUB_ARCHIVE_LIMITS.entries) {
          throw validationError(
            'EPUB_ARCHIVE_TOO_MANY_ENTRIES',
            `EPUB archive has more than ${EPUB_ARCHIVE_LIMITS.entries} entries`,
          )
        }
        assertSafeEntryPath(entry.fileName)
        if (entry.isEncrypted()) {
          throw validationError('EPUB_ARCHIVE_ENCRYPTED', 'Encrypted EPUB entries are not supported')
        }
        if (entry.extraFields.some(field => field.id === ZIP64_EXTRA_FIELD_ID)) {
          throw validationError('EPUB_ARCHIVE_ZIP64', 'ZIP64 EPUB archives are not supported')
        }
        if (entry.fileName === EPUB_CONTAINER_ENTRY) hasContainer = true
        budget.beginEntry()
      } catch (error) {
        fail(error)
        return
      }

      zipFile.openReadStream(entry, (error, stream) => {
        if (settled) {
          stream?.destroy()
          return
        }
        if (error || !stream) {
          fail(error ?? new Error('Missing EPUB entry stream'))
          return
        }

        activeStream = stream
        const mimetypeChunks: Buffer[] = []
        let mimetypeBytes = 0
        stream.on('data', (chunk: Buffer | Uint8Array | string) => {
          if (settled) return
          const byteLength = typeof chunk === 'string'
            ? Buffer.byteLength(chunk)
            : chunk.byteLength
          try {
            budget.addChunk(byteLength, entry.compressedSize)
            if (entry.fileName === EPUB_MIMETYPE_ENTRY) {
              mimetypeBytes += byteLength
              if (mimetypeBytes <= EPUB_MIMETYPE.length + 1) mimetypeChunks.push(Buffer.from(chunk))
            }
          } catch (scanError) {
            fail(scanError)
          }
        })
        stream.once('error', fail)
        stream.once('end', () => {
          if (settled) return
          activeStream = undefined
          if (entry.fileName === EPUB_MIMETYPE_ENTRY) {
            mimetype = mimetypeBytes <= EPUB_MIMETYPE.length + 1
              ? Buffer.concat(mimetypeChunks, mimetypeBytes)
              : Buffer.alloc(0)
          }
          zipFile.readEntry()
        })
      })
    })
    zipFile.on('end', () => {
      if (settled) return
      if (entryCount !== expectedEntryCount) {
        fail(validationError('EPUB_ARCHIVE_INVALID', 'ZIP entry count changed during scan'))
        return
      }
      if (!mimetype || mimetype.toString('ascii') !== EPUB_MIMETYPE) {
        fail(validationError('EPUB_ARCHIVE_INVALID_MIMETYPE', 'Invalid EPUB mimetype entry'))
        return
      }
      if (!hasContainer) {
        fail(validationError('EPUB_ARCHIVE_MISSING_CONTAINER', 'Missing META-INF/container.xml'))
        return
      }

      settled = true
      close()
      resolve({
        entryCount,
        uncompressedBytes: budget.uncompressedBytes,
      })
    })

    zipFile.readEntry()
  })
}

/**
 * Validates the exact EPUB bytes before they cross the Project File RPC boundary.
 *
 * The central directory is only an early rejection pass. Every entry is then
 * decompressed through yauzl and counted without retaining expanded contents.
 */
export async function validateEpubArchive(
  bytes: Uint8Array,
): Promise<EpubArchiveValidationResult> {
  if (bytes.byteLength > EPUB_ARCHIVE_LIMITS.compressedBytes) {
    throw validationError(
      'EPUB_ARCHIVE_TOO_LARGE',
      `EPUB archive exceeds ${EPUB_ARCHIVE_LIMITS.compressedBytes} compressed bytes`,
    )
  }
  if (bytes.byteLength < 22) {
    throw validationError('EPUB_ARCHIVE_INVALID', 'EPUB archive is too small')
  }

  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const summary = inspectCentralDirectory(buffer, EPUB_ARCHIVE_LIMITS)
  const zipFile = await openArchive(buffer)
  return scanArchiveOutput(zipFile, summary.entryCount)
}
