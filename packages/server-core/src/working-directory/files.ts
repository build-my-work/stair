import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'

export const MAX_WORKING_TEXT_BYTES = 5 * 1024 * 1024
export const MAX_WORKING_BINARY_BYTES = 50 * 1024 * 1024
export const MAX_WORKING_DATA_URL_BYTES = 20 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 10_000
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

export interface WorkingDirectoryEntry {
  name: string
  relativePath: string
  type: 'file' | 'directory'
  sizeBytes?: number
  modifiedAt: number
  isSymlink: boolean
}

export interface ResolvedWorkingDirectoryPath {
  /** Normalized, project-relative POSIX path used as the durable file identity. */
  relativePath: string
  /** Requested path under the root. May itself be an in-root symlink. */
  absolutePath: string
  /** Canonical target after resolving symlinks. Always contained by rootRealPath. */
  realPath: string
  rootRealPath: string
  isSymlink: boolean
  sizeBytes: number
  modifiedAt: number
  device: number
  inode: number
  type: 'file' | 'directory'
}

export async function resolveSafeWorkingDirectoryPath(
  workingDirectory: string,
  inputPath: string | undefined,
  expectedType?: 'file' | 'directory',
): Promise<ResolvedWorkingDirectoryPath> {
  if (typeof workingDirectory !== 'string' || !isAbsolute(workingDirectory)) {
    throw new Error('Project working directory must be an absolute path')
  }

  const relativePath = normalizeRelativeWorkingPath(inputPath ?? '')
  const rootRealPath = await realpath(workingDirectory)
  const rootInfo = await stat(rootRealPath)
  if (!rootInfo.isDirectory()) throw new Error('Project working directory is not a directory')

  const absolutePath = relativePath
    ? resolve(rootRealPath, ...relativePath.split('/'))
    : rootRealPath
  const targetRealPath = await realpath(absolutePath)
  assertContained(rootRealPath, targetRealPath)

  const [targetInfo, linkInfo] = await Promise.all([
    stat(targetRealPath),
    lstat(absolutePath),
  ])
  let type: ResolvedWorkingDirectoryPath['type']
  if (targetInfo.isDirectory()) {
    type = 'directory'
  } else if (targetInfo.isFile()) {
    type = 'file'
  } else {
    throw new Error('Working-directory entry must be a regular file or directory')
  }
  if (expectedType && type !== expectedType) {
    throw new Error(`Working-directory entry must be a ${expectedType}`)
  }

  return {
    relativePath,
    absolutePath,
    realPath: targetRealPath,
    rootRealPath,
    isSymlink: linkInfo.isSymbolicLink(),
    sizeBytes: targetInfo.size,
    modifiedAt: targetInfo.mtimeMs,
    device: targetInfo.dev,
    inode: targetInfo.ino,
    type,
  }
}

export async function listSafeWorkingDirectoryEntries(
  workingDirectory: string,
  relativeDirectory = '',
): Promise<WorkingDirectoryEntry[]> {
  const directory = await resolveSafeWorkingDirectoryPath(
    workingDirectory,
    relativeDirectory,
    'directory',
  )
  const names: string[] = []
  const handle = await opendir(directory.realPath)
  for await (const entry of handle) {
    names.push(entry.name)
    if (names.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error(`Directory contains too many entries (limit ${MAX_DIRECTORY_ENTRIES})`)
    }
  }

  const entries: WorkingDirectoryEntry[] = []
  for (const name of names) {
    const childPath = directory.relativePath ? `${directory.relativePath}/${name}` : name
    try {
      const child = await resolveSafeWorkingDirectoryPath(workingDirectory, childPath)
      entries.push({
        name,
        relativePath: child.relativePath,
        type: child.type,
        ...(child.type === 'file' ? { sizeBytes: child.sizeBytes } : {}),
        modifiedAt: child.modifiedAt,
        isSymlink: child.isSymlink,
      })
    } catch {
      // Broken and out-of-root symlinks are intentionally invisible. Every
      // navigation/read performs its own containment check as well.
    }
  }

  return entries.sort((left, right) => (
    (left.type === right.type ? 0 : left.type === 'directory' ? -1 : 1)
    || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  ))
}

export async function readSafeWorkingDirectoryText(
  workingDirectory: string,
  relativePath: string,
): Promise<string> {
  const file = await resolveSafeWorkingDirectoryPath(workingDirectory, relativePath, 'file')
  const bytes = await readResolvedWorkingFile(file, MAX_WORKING_TEXT_BYTES)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    throw new Error('Working-directory text file must use UTF-8 encoding')
  }
}

export async function readSafeWorkingDirectoryBinary(
  workingDirectory: string,
  relativePath: string,
  maxBytes = MAX_WORKING_BINARY_BYTES,
): Promise<Uint8Array> {
  const file = await resolveSafeWorkingDirectoryPath(workingDirectory, relativePath, 'file')
  return new Uint8Array(await readResolvedWorkingFile(file, maxBytes))
}

export async function readSafeWorkingDirectoryDataUrl(
  workingDirectory: string,
  relativePath: string,
): Promise<string> {
  const bytes = await readSafeWorkingDirectoryBinary(
    workingDirectory,
    relativePath,
    MAX_WORKING_DATA_URL_BYTES,
  )
  return `data:${mimeTypeForPath(relativePath)};base64,${Buffer.from(bytes).toString('base64')}`
}

export function fingerprintWorkingFile(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function normalizeRelativeWorkingPath(inputPath: string): string {
  if (typeof inputPath !== 'string') throw new Error('Working-directory path must be a string')
  if (inputPath.includes('\0')) throw new Error('Working-directory path must not contain NUL bytes')
  if (inputPath.includes('\\')) throw new Error('Working-directory path must use forward-slash separators')
  if (isAbsolute(inputPath) || win32.isAbsolute(inputPath) || /^[A-Za-z]:/.test(inputPath)) {
    throw new Error('Working-directory path must be relative')
  }

  const segments = inputPath.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Working-directory path must stay inside the project and be relative')
  }
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/')
  return normalized
}

function assertContained(rootRealPath: string, targetRealPath: string): void {
  const pathFromRoot = relative(rootRealPath, targetRealPath)
  if (pathFromRoot === '') return
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error('Working-directory path resolves outside the project working directory')
  }
}

function assertSize(actualBytes: number, maxBytes: number): void {
  if (actualBytes > maxBytes) {
    throw new Error(`Working-directory file is too large (limit ${Math.floor(maxBytes / 1024 / 1024)} MB)`)
  }
}

async function readResolvedWorkingFile(
  file: ResolvedWorkingDirectoryPath,
  maxBytes: number,
): Promise<Buffer> {
  assertSize(file.sizeBytes, maxBytes)
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(file.realPath, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== file.device || opened.ino !== file.inode) {
      throw new Error('Working-directory file changed while it was being opened')
    }
    assertSize(opened.size, maxBytes)

    const chunks: Buffer[] = []
    let total = 0
    while (total <= maxBytes) {
      const nextSize = Math.min(64 * 1024, maxBytes + 1 - total)
      if (nextSize <= 0) break
      const chunk = Buffer.allocUnsafe(nextSize)
      const { bytesRead } = await handle.read(chunk, 0, nextSize, null)
      if (bytesRead === 0) break
      total += bytesRead
      assertSize(total, maxBytes)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }
}

function mimeTypeForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase()
  return extension
    ? MIME_TYPES_BY_EXTENSION[extension] ?? 'application/octet-stream'
    : 'application/octet-stream'
}
