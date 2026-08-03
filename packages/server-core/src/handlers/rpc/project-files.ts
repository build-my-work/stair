import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'
import {
  isCanonicalProjectRelativePath,
  type SourceFingerprint,
} from '@craft-agent/core/types'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  RPC_CHANNELS,
  type CreateProjectEntryRequest,
  type ProjectDirectoryEntriesRequest,
  type ProjectDirectoryEntriesResult,
  type ProjectDirectoryEntry,
  type ProjectFileBinaryResponse,
  type ProjectFileMetadata,
  type ProjectFileRequest,
  type ProjectFileSearchRequest,
  type ProjectFileSearchResult,
  type ProjectFileTextResponse,
  type SaveProjectTextFileRequest,
  type SaveProjectTextFileResponse,
  type SaveDrawnixProjectFileRequest,
  type SaveDrawnixProjectFileResponse,
} from '@craft-agent/shared/protocol'
import {
  MAX_EDITABLE_PROJECT_FILE_BYTES,
  isEditableProjectTextFile,
} from '@craft-agent/shared/file-classification'
import { loadProjectById } from '@craft-agent/shared/projects'
import { getMimeType } from '@craft-agent/shared/utils'
import { validatePathFormat } from '../../utils/path-validation'
import type { RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { validateEpubArchive } from '../../project-files/epub-archive-validator'
import { searchFilesWithinRoot } from './files'

export const MAX_PROJECT_FILE_PATH_BYTES = 2_048
export const MAX_PROJECT_FILE_NAME_BYTES = 255
export const MAX_PROJECT_FILE_TEXT_BYTES = 8 * 1024 * 1024
export const MAX_PROJECT_FILE_BINARY_BYTES = 32 * 1024 * 1024
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export const EMPTY_DRAWNIX_DOCUMENT = `${JSON.stringify({
  type: 'drawnix',
  version: 1,
  source: 'web',
  elements: [],
  viewport: { zoom: 1 },
  theme: { themeColorMode: 'default' },
}, null, 2)}\n`

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projectFiles.READ_TEXT,
  RPC_CHANNELS.projectFiles.READ_BINARY,
  RPC_CHANNELS.projectFiles.SEARCH,
  RPC_CHANNELS.projectFiles.LIST_DIRECTORY_ENTRIES,
  RPC_CHANNELS.projectFiles.CREATE_FILE,
  RPC_CHANNELS.projectFiles.CREATE_DRAWNIX_FILE,
  RPC_CHANNELS.projectFiles.CREATE_DIRECTORY,
  RPC_CHANNELS.projectFiles.SAVE_TEXT_FILE,
  RPC_CHANNELS.projectFiles.SAVE_DRAWNIX_FILE,
] as const

type ProjectFileErrorCode =
  | 'PROJECT_FILE_INVALID_REQUEST'
  | 'PROJECT_FILE_NO_WORKSPACE'
  | 'PROJECT_FILE_NOT_FOUND'
  | 'PROJECT_FILE_ACCESS_DENIED'
  | 'PROJECT_FILE_ALREADY_EXISTS'
  | 'PROJECT_FILE_NOT_REGULAR'
  | 'PROJECT_FILE_TOO_LARGE'
  | 'PROJECT_FILE_CHANGED'
  | 'PROJECT_FILE_INVALID_TEXT'

type FileStatSnapshot = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>

interface StableProjectFile {
  bytes: Buffer
  stat: Stats
}

function projectFileError(code: ProjectFileErrorCode, message: string): Error {
  const error = new Error(`${code}: ${message}`)
  Object.assign(error, { code })
  return error
}

const projectFileWriteQueues = new Map<string, Promise<void>>()

/** Serialize renderer edits and Add Note appends targeting the same Project File. */
export async function withProjectFileWriteQueue<T>(
  rootPath: string,
  relativePath: string,
  operation: (canonicalRoot: string, canonicalPath: string) => Promise<T>,
): Promise<T> {
  const canonicalRoot = await realpath(resolve(rootPath))
  const canonicalPath = canonicalizeProjectFileRelativePath(relativePath)
  const targetKey = `${canonicalRoot}\0${canonicalPath}`
  const previous = projectFileWriteQueues.get(targetKey) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>(resolveCurrent => {
    release = resolveCurrent
  })
  const queued = previous.catch(() => {}).then(() => current)
  projectFileWriteQueues.set(targetKey, queued)

  await previous.catch(() => {})
  try {
    return await operation(canonicalRoot, canonicalPath)
  } finally {
    release()
    if (projectFileWriteQueues.get(targetKey) === queued) {
      projectFileWriteQueues.delete(targetKey)
    }
  }
}

/** @internal Exported so the read-during-change invariant can be tested deterministically. */
export function projectFileStatSnapshotsMatch(
  left: FileStatSnapshot,
  right: FileStatSnapshot,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function assertStableFile(
  before: FileStatSnapshot,
  ...after: FileStatSnapshot[]
): void {
  if (after.some(snapshot => !projectFileStatSnapshotsMatch(before, snapshot))) {
    throw projectFileError('PROJECT_FILE_CHANGED', 'File changed while it was being read')
  }
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath === ''
    || (
      relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
    )
}

export function toProjectRelativePath(relativePath: string): string {
  return relativePath.replaceAll(sep, '/')
}

function isValidCreateParentPath(value: unknown): value is string | undefined {
  return value === undefined
    || (
      typeof value === 'string'
      && Buffer.byteLength(value, 'utf8') <= MAX_PROJECT_FILE_PATH_BYTES
      && (value.length === 0 || isCanonicalProjectRelativePath(value))
    )
}

function isValidProjectEntryName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && value !== '.'
    && value !== '..'
    && !value.includes('\0')
    && !value.includes('/')
    && !value.includes('\\')
    && Buffer.byteLength(value, 'utf8') <= MAX_PROJECT_FILE_NAME_BYTES
}

function validateCreateEntryRequest(value: unknown): CreateProjectEntryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Project entry request is required',
    )
  }

  const request = value as Partial<CreateProjectEntryRequest>
  const projectId = validateProjectId(request.projectId)
  const parentRelativePath = request.parentRelativePath
  if (!isValidCreateParentPath(parentRelativePath)) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Parent directory must be a canonical Project-relative path',
    )
  }

  const name = request.name
  if (!isValidProjectEntryName(name)) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Name must be one valid path segment',
    )
  }

  return {
    projectId,
    ...(parentRelativePath ? { parentRelativePath } : {}),
    name,
  }
}

async function resolveCreateParent(
  rootPath: string,
  parentRelativePath = '',
): Promise<{ rootPath: string; parentPath: string }> {
  const canonicalRoot = await realpath(resolve(rootPath))
  let currentPath = canonicalRoot

  for (const segment of parentRelativePath ? parentRelativePath.split('/') : []) {
    currentPath = resolve(currentPath, segment)
    let entry: Stats
    try {
      entry = await lstat(currentPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw projectFileError(
          'PROJECT_FILE_NOT_FOUND',
          'Parent directory was not found',
        )
      }
      throw projectFileError(
        'PROJECT_FILE_ACCESS_DENIED',
        'Parent directory could not be accessed',
      )
    }
    if (entry.isSymbolicLink()) {
      throw projectFileError(
        'PROJECT_FILE_ACCESS_DENIED',
        'Symbolic links cannot be used as creation parents',
      )
    }
    if (!entry.isDirectory()) {
      throw projectFileError(
        'PROJECT_FILE_NOT_FOUND',
        'Parent path is not a directory',
      )
    }
  }

  const canonicalParent = await realpath(currentPath)
  if (!isPathWithinRoot(canonicalRoot, canonicalParent)) {
    throw projectFileError(
      'PROJECT_FILE_ACCESS_DENIED',
      'Parent directory is outside the Project root',
    )
  }
  return { rootPath: canonicalRoot, parentPath: canonicalParent }
}

function createdRelativePath(request: CreateProjectEntryRequest): string {
  const relativePath = request.parentRelativePath
    ? posix.join(request.parentRelativePath, request.name)
    : request.name
  if (Buffer.byteLength(relativePath, 'utf8') > MAX_PROJECT_FILE_PATH_BYTES) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Created path exceeds the Project path limit',
    )
  }
  return relativePath
}

function throwCreateError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EEXIST') {
    throw projectFileError(
      'PROJECT_FILE_ALREADY_EXISTS',
      'A file or directory with this name already exists',
    )
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    throw projectFileError(
      'PROJECT_FILE_NOT_FOUND',
      'Parent directory was not found',
    )
  }
  throw projectFileError(
    'PROJECT_FILE_ACCESS_DENIED',
    'Project entry could not be created',
  )
}

export async function createProjectEntryWithinRoot(
  rootPath: string,
  request: CreateProjectEntryRequest,
  type: ProjectDirectoryEntry['type'],
  fileContent = '',
): Promise<ProjectDirectoryEntry> {
  const validated = validateCreateEntryRequest(request)
  const parent = await resolveCreateParent(
    rootPath,
    validated.parentRelativePath,
  )
  const relativePath = createdRelativePath(validated)
  const targetPath = resolve(parent.parentPath, validated.name)
  if (!isPathWithinRoot(parent.rootPath, targetPath)) {
    throw projectFileError(
      'PROJECT_FILE_ACCESS_DENIED',
      'Project entry is outside the Project root',
    )
  }

  try {
    if (type === 'directory') {
      await mkdir(targetPath)
    } else {
      const handle = await open(targetPath, 'wx')
      try {
        if (fileContent) await handle.writeFile(fileContent, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  } catch (error) {
    throwCreateError(error)
  }

  return {
    name: validated.name,
    relativePath,
    type,
    isSymlink: false,
  }
}

export async function createDrawnixProjectFileWithinRoot(
  rootPath: string,
  request: CreateProjectEntryRequest,
): Promise<ProjectDirectoryEntry> {
  const validated = validateCreateEntryRequest(request)
  if (extname(validated.name).toLowerCase() !== '.drawnix') {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'A Drawnix file name must end in .drawnix',
    )
  }
  return createProjectEntryWithinRoot(
    rootPath,
    validated,
    'file',
    EMPTY_DRAWNIX_DOCUMENT,
  )
}

/**
 * List one directory level below a canonical Project root.
 *
 * Symlinks that resolve outside the Project are omitted so a tree entry can
 * never become a cross-root read.
 */
export async function listDirectoryEntriesWithinRoot(
  rootPath: string,
  relativeDirectory = '',
): Promise<ProjectDirectoryEntriesResult> {
  if (
    relativeDirectory
    && !isCanonicalProjectRelativePath(relativeDirectory)
  ) {
    throw new Error('Access denied: directory is outside project root')
  }

  const resolvedRoot = await realpath(resolve(rootPath))
  const requestedPath = relativeDirectory
    ? resolve(resolvedRoot, ...relativeDirectory.split('/'))
    : resolvedRoot
  const resolvedDirectory = await realpath(requestedPath)
  if (!isPathWithinRoot(resolvedRoot, resolvedDirectory)) {
    throw new Error('Access denied: directory is outside project root')
  }

  const raw = await readdir(resolvedDirectory, { withFileTypes: true })
  const entries: ProjectDirectoryEntry[] = []

  for (const entry of raw) {
    const fullPath = join(resolvedDirectory, entry.name)
    const relativePath = toProjectRelativePath(relative(resolvedRoot, fullPath))

    if (entry.isDirectory()) {
      entries.push({
        name: entry.name,
        relativePath,
        type: 'directory',
        isSymlink: false,
      })
      continue
    }
    if (entry.isFile()) {
      entries.push({
        name: entry.name,
        relativePath,
        type: 'file',
        isSymlink: false,
      })
      continue
    }
    if (!entry.isSymbolicLink()) continue

    try {
      const resolvedTarget = await realpath(fullPath)
      if (!isPathWithinRoot(resolvedRoot, resolvedTarget)) continue

      const target = await stat(resolvedTarget)
      if (target.isDirectory() || target.isFile()) {
        entries.push({
          name: entry.name,
          relativePath,
          type: target.isDirectory() ? 'directory' : 'file',
          isSymlink: true,
        })
      }
    } catch {
      // Broken symlink — omit it from the tree.
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  const truncated = entries.length > 500
  if (truncated) entries.length = 500
  return { truncated, entries }
}

function validateProjectId(projectId: unknown): string {
  if (
    typeof projectId !== 'string'
    || projectId.length === 0
    || projectId !== projectId.trim()
    || projectId.includes('\0')
    || Buffer.byteLength(projectId, 'utf8') > 256
  ) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Invalid Project id')
  }
  return projectId
}

/**
 * Accept only a single canonical representation so routes, state and
 * references cannot identify the same file with multiple path spellings.
 */
export function canonicalizeProjectFileRelativePath(relativePath: unknown): string {
  if (
    typeof relativePath !== 'string'
    || Buffer.byteLength(relativePath, 'utf8') > MAX_PROJECT_FILE_PATH_BYTES
    || !isCanonicalProjectRelativePath(relativePath)
  ) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'File path must be a canonical root-relative POSIX path',
    )
  }

  return relativePath
}

function validateProjectFileRequest(request: unknown): ProjectFileRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Project File request is required')
  }

  const value = request as Partial<ProjectFileRequest>
  return {
    projectId: validateProjectId(value.projectId),
    relativePath: canonicalizeProjectFileRelativePath(value.relativePath),
  }
}

function validateProjectFileSearchRequest(
  value: unknown,
): ProjectFileSearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Project file search request is required',
    )
  }

  const request = value as Partial<ProjectFileSearchRequest>
  const projectId = validateProjectId(request.projectId)
  if (typeof request.query !== 'string') {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Project file search query is required',
    )
  }

  const extensions = request.extensions
  if (
    extensions !== undefined
    && (
      !Array.isArray(extensions)
      || extensions.length === 0
      || extensions.length > 16
      || extensions.some(extension =>
        typeof extension !== 'string'
        || extension.length > 32
        || !/^[a-z0-9]+$/.test(extension))
    )
  ) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Project file search extensions are invalid',
    )
  }

  return { projectId, query: request.query, extensions }
}

function validateProjectDirectoryEntriesRequest(
  value: unknown,
): ProjectDirectoryEntriesRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Project directory request is required',
    )
  }

  const request = value as Partial<ProjectDirectoryEntriesRequest>
  const projectId = validateProjectId(request.projectId)
  if (
    request.relativePath !== undefined
    && typeof request.relativePath !== 'string'
  ) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Project directory path must be a string',
    )
  }

  return { projectId, relativePath: request.relativePath }
}

/**
 * Resolve a Project only inside the workspace selected by the RPC context.
 * A Project id from another workspace therefore cannot authorize a file read.
 */
export async function resolveProjectWorkingDirectory(
  workspaceRootPath: string,
  projectId: string,
): Promise<string> {
  const validatedProjectId = validateProjectId(projectId)
  let project: ReturnType<typeof loadProjectById>
  try {
    project = loadProjectById(workspaceRootPath, validatedProjectId)
  } catch {
    throw projectFileError(
      'PROJECT_FILE_NOT_FOUND',
      'Project is not available in the active workspace',
    )
  }

  const workingDirectory = project?.config.workingDirectory
  if (!workingDirectory) {
    throw projectFileError(
      'PROJECT_FILE_NOT_FOUND',
      'Project working directory is not configured',
    )
  }

  const pathCheck = validatePathFormat(workingDirectory)
  if (!pathCheck.valid) {
    throw projectFileError(
      'PROJECT_FILE_NOT_FOUND',
      'Project working directory is unavailable',
    )
  }

  try {
    const canonicalRoot = await realpath(resolve(workingDirectory))
    const rootStat = await stat(canonicalRoot)
    if (!rootStat.isDirectory()) {
      throw projectFileError(
        'PROJECT_FILE_NOT_FOUND',
        'Project working directory is unavailable',
      )
    }
    return canonicalRoot
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PROJECT_FILE_')) {
      throw error
    }
    throw projectFileError(
      'PROJECT_FILE_NOT_FOUND',
      'Project working directory is unavailable',
    )
  }
}

async function resolveProjectFile(
  rootPath: string,
  canonicalRelativePath: string,
): Promise<string> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(resolve(rootPath))
  } catch {
    throw projectFileError(
      'PROJECT_FILE_NOT_FOUND',
      'Project working directory is unavailable',
    )
  }

  const requestedPath = resolve(canonicalRoot, ...canonicalRelativePath.split('/'))
  let targetPath: string
  try {
    targetPath = await realpath(requestedPath)
  } catch {
    throw projectFileError('PROJECT_FILE_NOT_FOUND', 'Project file was not found')
  }

  if (!isPathWithinRoot(canonicalRoot, targetPath)) {
    throw projectFileError(
      'PROJECT_FILE_ACCESS_DENIED',
      'Project file is outside the working directory',
    )
  }

  return targetPath
}

function projectFileMimeType(relativePath: string): string {
  const extension = extname(relativePath).toLowerCase()
  const overrides: Record<string, string> = {
    '.drawnix': 'application/vnd.drawnix+json',
    '.epub': 'application/epub+zip',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.jsx': 'text/jsx',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.toml': 'application/toml',
    '.csv': 'text/csv',
  }
  return overrides[extension] ?? getMimeType(relativePath)
}

function toMetadata(
  projectId: string,
  relativePath: string,
  fileStat: Stats,
): ProjectFileMetadata {
  return {
    projectId,
    relativePath,
    name: posix.basename(relativePath),
    mimeType: projectFileMimeType(relativePath),
    byteLength: fileStat.size,
    lastModifiedMs: fileStat.mtimeMs,
  }
}

async function openRegularFile(targetPath: string): Promise<{
  handle: FileHandle
  before: Stats
}> {
  let handle: FileHandle
  try {
    handle = await open(targetPath, 'r')
  } catch {
    throw projectFileError('PROJECT_FILE_NOT_FOUND', 'Project file was not found')
  }

  try {
    const before = await handle.stat()
    if (!before.isFile()) {
      throw projectFileError(
        'PROJECT_FILE_NOT_REGULAR',
        'Project File APIs only read regular files',
      )
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      throw projectFileError(
        'PROJECT_FILE_TOO_LARGE',
        'Project file size is unsupported',
      )
    }
    return { handle, before }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readFixedSize(
  handle: FileHandle,
  expectedSize: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(expectedSize)
  let offset = 0

  while (offset < expectedSize) {
    const result = await handle.read(bytes, offset, expectedSize - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }

  if (offset !== expectedSize) {
    throw projectFileError('PROJECT_FILE_CHANGED', 'File changed while it was being read')
  }

  // Detect growth without letting a racing writer make this request allocate
  // beyond the size that was checked before reading.
  const growthProbe = Buffer.allocUnsafe(1)
  const probe = await handle.read(growthProbe, 0, 1, expectedSize)
  if (probe.bytesRead !== 0) {
    throw projectFileError('PROJECT_FILE_CHANGED', 'File changed while it was being read')
  }

  return bytes
}

async function readStableProjectFile(
  targetPath: string,
  maxBytes: number,
): Promise<StableProjectFile> {
  const { handle, before } = await openRegularFile(targetPath)
  try {
    if (before.size > maxBytes) {
      throw projectFileError(
        'PROJECT_FILE_TOO_LARGE',
        `Project file exceeds the ${maxBytes}-byte limit`,
      )
    }

    const bytes = await readFixedSize(handle, before.size)
    const afterHandle = await handle.stat()
    let afterPath: Stats
    try {
      afterPath = await stat(targetPath)
    } catch {
      throw projectFileError('PROJECT_FILE_CHANGED', 'File changed while it was being read')
    }
    assertStableFile(before, afterHandle, afterPath)
    return { bytes, stat: afterHandle }
  } finally {
    await handle.close()
  }
}

function fingerprint(bytes: Buffer): SourceFingerprint {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export async function readProjectFileBinaryWithinRoot(
  rootPath: string,
  request: ProjectFileRequest,
): Promise<ProjectFileBinaryResponse> {
  const validated = validateProjectFileRequest(request)
  const targetPath = await resolveProjectFile(rootPath, validated.relativePath)
  const stable = await readStableProjectFile(
    targetPath,
    MAX_PROJECT_FILE_BINARY_BYTES,
  )
  return {
    metadata: toMetadata(validated.projectId, validated.relativePath, stable.stat),
    bytes: stable.bytes,
    sourceFingerprint: fingerprint(stable.bytes),
  }
}

export async function readProjectFileTextWithinRoot(
  rootPath: string,
  request: ProjectFileRequest,
): Promise<ProjectFileTextResponse> {
  const validated = validateProjectFileRequest(request)
  const targetPath = await resolveProjectFile(rootPath, validated.relativePath)
  const stable = await readStableProjectFile(
    targetPath,
    MAX_PROJECT_FILE_TEXT_BYTES,
  )

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stable.bytes)
  } catch {
    throw projectFileError(
      'PROJECT_FILE_INVALID_TEXT',
      'Project file is not valid UTF-8 text',
    )
  }

  return {
    metadata: toMetadata(validated.projectId, validated.relativePath, stable.stat),
    text,
    sourceFingerprint: fingerprint(stable.bytes),
  }
}

function validateSaveProjectTextRequest(
  value: unknown,
): SaveProjectTextFileRequest {
  const request = validateProjectFileRequest(value)
  if (!isEditableProjectTextFile(request.relativePath)) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'This Project File type is not editable as ordinary text',
    )
  }

  const raw = value as Partial<SaveProjectTextFileRequest>
  if (
    typeof raw.expectedFingerprint !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(raw.expectedFingerprint)
  ) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'A valid expected text fingerprint is required',
    )
  }
  if (typeof raw.content !== 'string') {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Project text content must be a string',
    )
  }
  if (Buffer.byteLength(raw.content, 'utf8') > MAX_EDITABLE_PROJECT_FILE_BYTES) {
    throw projectFileError(
      'PROJECT_FILE_TOO_LARGE',
      `Editable Project text exceeds the ${MAX_EDITABLE_PROJECT_FILE_BYTES}-byte limit`,
    )
  }

  return {
    ...request,
    expectedFingerprint: raw.expectedFingerprint as SourceFingerprint,
    content: raw.content,
  }
}

function encodeProjectTextContent(currentBytes: Buffer, content: string): Buffer {
  const hasUtf8Bom = currentBytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)

  let currentText: string
  try {
    currentText = new TextDecoder('utf-8', { fatal: true }).decode(currentBytes)
  } catch {
    throw projectFileError(
      'PROJECT_FILE_INVALID_TEXT',
      'Project file is not valid UTF-8 text',
    )
  }

  const withoutCrLf = currentText.replaceAll('\r\n', '')
  const hasCrLf = currentText.includes('\r\n')
  const hasLoneLf = withoutCrLf.includes('\n')
  const hasLoneCr = withoutCrLf.includes('\r')
  let persistedContent = content

  let preservedLineEnding: '\r\n' | '\r' | null = null
  if (hasCrLf && !hasLoneLf && !hasLoneCr) {
    preservedLineEnding = '\r\n'
  } else if (hasLoneCr && !hasCrLf && !hasLoneLf) {
    preservedLineEnding = '\r'
  }

  if (preservedLineEnding) {
    persistedContent = content
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .replaceAll('\n', preservedLineEnding)
  }

  const contentBytes = Buffer.from(persistedContent, 'utf8')
  const bytes = hasUtf8Bom
    ? Buffer.concat([UTF8_BOM, contentBytes])
    : contentBytes
  if (bytes.length > MAX_EDITABLE_PROJECT_FILE_BYTES) {
    throw projectFileError(
      'PROJECT_FILE_TOO_LARGE',
      `Editable Project text exceeds the ${MAX_EDITABLE_PROJECT_FILE_BYTES}-byte limit`,
    )
  }
  return bytes
}

export async function saveProjectTextFileWithinRoot(
  rootPath: string,
  rawRequest: SaveProjectTextFileRequest,
): Promise<SaveProjectTextFileResponse> {
  const request = validateSaveProjectTextRequest(rawRequest)

  return withProjectFileWriteQueue(
    rootPath,
    request.relativePath,
    async (canonicalRoot, canonicalPath) => {
      const targetPath = await resolveProjectFile(canonicalRoot, canonicalPath)
      const current = await readStableProjectFile(
        targetPath,
        MAX_EDITABLE_PROJECT_FILE_BYTES,
      )
      if (fingerprint(current.bytes) !== request.expectedFingerprint) {
        throw projectFileError(
          'PROJECT_FILE_CHANGED',
          'Project text file changed since it was opened; reload it before saving',
        )
      }

      const bytes = encodeProjectTextContent(current.bytes, request.content)
      const temporaryPath = join(
        dirname(targetPath),
        `.${basename(targetPath)}.${randomUUID()}.tmp`,
      )
      let temporaryExists = false

      try {
        const handle = await open(temporaryPath, 'wx', current.stat.mode & 0o777)
        temporaryExists = true
        try {
          await handle.writeFile(bytes)
          await handle.chmod(current.stat.mode & 0o777)
          await handle.sync()
        } finally {
          await handle.close()
        }

        let beforeRename: Stats
        try {
          beforeRename = await stat(targetPath)
        } catch {
          throw projectFileError(
            'PROJECT_FILE_CHANGED',
            'Project text file changed while it was being saved',
          )
        }
        assertStableFile(current.stat, beforeRename)

        await rename(temporaryPath, targetPath)
        temporaryExists = false
        const savedStat = await stat(targetPath)
        return {
          metadata: toMetadata(
            request.projectId,
            request.relativePath,
            savedStat,
          ),
          sourceFingerprint: fingerprint(bytes),
        }
      } finally {
        if (temporaryExists) {
          await unlink(temporaryPath).catch(() => undefined)
        }
      }
    },
  )
}

function validateDrawnixDocument(content: unknown): string {
  if (typeof content !== 'string') {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Drawnix content must be UTF-8 text',
    )
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_PROJECT_FILE_TEXT_BYTES) {
    throw projectFileError(
      'PROJECT_FILE_TOO_LARGE',
      `Drawnix content exceeds the ${MAX_PROJECT_FILE_TEXT_BYTES}-byte limit`,
    )
  }

  let document: unknown
  try {
    document = JSON.parse(content)
  } catch {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Drawnix content must be valid JSON',
    )
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Drawnix content must be a native Drawnix document',
    )
  }

  const value = document as Record<string, unknown>
  const viewport = value.viewport
  let viewportZoom: unknown
  if (
    viewport
    && typeof viewport === 'object'
    && !Array.isArray(viewport)
  ) {
    viewportZoom = (viewport as Record<string, unknown>).zoom
  }
  const hasInvalidTheme = value.theme !== undefined && (
    !value.theme
    || typeof value.theme !== 'object'
    || Array.isArray(value.theme)
  )
  if (
    value.type !== 'drawnix'
    || typeof value.version !== 'number'
    || value.source !== 'web'
    || !Array.isArray(value.elements)
    || typeof viewportZoom !== 'number'
    || !Number.isFinite(viewportZoom)
    || viewportZoom <= 0
    || hasInvalidTheme
  ) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Drawnix content must be a native Drawnix document',
    )
  }
  return content
}

function validateSaveDrawnixRequest(
  value: unknown,
): SaveDrawnixProjectFileRequest {
  const request = validateProjectFileRequest(value)
  if (extname(request.relativePath).toLowerCase() !== '.drawnix') {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Only .drawnix Project Files can be saved through this API',
    )
  }

  const raw = value as Partial<SaveDrawnixProjectFileRequest>
  if (
    typeof raw.expectedFingerprint !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(raw.expectedFingerprint)
  ) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'A valid expected Drawnix fingerprint is required',
    )
  }

  return {
    ...request,
    expectedFingerprint: raw.expectedFingerprint as SourceFingerprint,
    content: validateDrawnixDocument(raw.content),
  }
}

export async function saveDrawnixProjectFileWithinRoot(
  rootPath: string,
  rawRequest: SaveDrawnixProjectFileRequest,
): Promise<SaveDrawnixProjectFileResponse> {
  const request = validateSaveDrawnixRequest(rawRequest)
  const targetPath = await resolveProjectFile(rootPath, request.relativePath)
  const current = await readStableProjectFile(
    targetPath,
    MAX_PROJECT_FILE_TEXT_BYTES,
  )
  if (fingerprint(current.bytes) !== request.expectedFingerprint) {
    throw projectFileError(
      'PROJECT_FILE_CHANGED',
      'Drawnix file changed since it was opened; reload it before saving',
    )
  }

  const bytes = Buffer.from(request.content, 'utf8')
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${randomUUID()}.tmp`,
  )
  let temporaryExists = false

  try {
    const handle = await open(temporaryPath, 'wx', current.stat.mode & 0o777)
    temporaryExists = true
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }

    let beforeRename: Stats
    try {
      beforeRename = await stat(targetPath)
    } catch {
      throw projectFileError(
        'PROJECT_FILE_CHANGED',
        'Drawnix file changed while it was being saved',
      )
    }
    assertStableFile(current.stat, beforeRename)

    await rename(temporaryPath, targetPath)
    temporaryExists = false
    const savedStat = await stat(targetPath)
    return {
      metadata: toMetadata(
        request.projectId,
        request.relativePath,
        savedStat,
      ),
      sourceFingerprint: fingerprint(bytes),
    }
  } finally {
    if (temporaryExists) {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }
}

async function resolveAuthorizedProjectRoot(
  ctx: RequestContext,
  deps: HandlerDeps,
  projectId: string,
): Promise<string> {
  const workspaceId = ctx.workspaceId
    ?? (ctx.webContentsId == null
      ? null
      : deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId))
  if (!workspaceId) {
    throw projectFileError(
      'PROJECT_FILE_NO_WORKSPACE',
      'No active workspace is associated with this request',
    )
  }

  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw projectFileError(
      'PROJECT_FILE_NO_WORKSPACE',
      'Active workspace is unavailable',
    )
  }

  return resolveProjectWorkingDirectory(workspace.rootPath, projectId)
}

export async function searchProjectFilesWithinRoot(
  rootPath: string,
  query: string,
  extensions?: string[],
): Promise<ProjectFileSearchResult[]> {
  const results = await searchFilesWithinRoot(rootPath, query, {
    includeHidden: true,
    skipSymlinks: true,
    filesOnly: true,
    extensions: extensions ? new Set(extensions) : undefined,
  })
  return results.map(({ name, relativePath }) => ({
    name,
    relativePath,
  }))
}

export function registerProjectFileHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.projectFiles.READ_TEXT,
    async (ctx, rawRequest: unknown) => {
      const request = validateProjectFileRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(ctx, deps, request.projectId)
      return readProjectFileTextWithinRoot(rootPath, request)
    },
  )

  server.handle(
    RPC_CHANNELS.projectFiles.READ_BINARY,
    async (ctx, rawRequest: unknown) => {
      const request = validateProjectFileRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(ctx, deps, request.projectId)
      const response = await readProjectFileBinaryWithinRoot(rootPath, request)
      if (extname(response.metadata.relativePath).toLowerCase() === '.epub') {
        await validateEpubArchive(response.bytes)
      }
      return response
    },
  )

  server.handle(
    RPC_CHANNELS.projectFiles.SEARCH,
    async (ctx, rawRequest: unknown) => {
      const request = validateProjectFileSearchRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(
        ctx,
        deps,
        request.projectId,
      )
      return searchProjectFilesWithinRoot(
        rootPath,
        request.query,
        request.extensions,
      )
    },
  )

  server.handle(
    RPC_CHANNELS.projectFiles.LIST_DIRECTORY_ENTRIES,
    async (ctx, rawRequest: unknown) => {
      const request = validateProjectDirectoryEntriesRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(
        ctx,
        deps,
        request.projectId,
      )
      return listDirectoryEntriesWithinRoot(rootPath, request.relativePath)
    },
  )

  server.handle(
    RPC_CHANNELS.projectFiles.CREATE_FILE,
    async (ctx, rawRequest: unknown) => {
      const request = validateCreateEntryRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(ctx, deps, request.projectId)
      return createProjectEntryWithinRoot(rootPath, request, 'file')
    },
  )

  server.handle(
    RPC_CHANNELS.projectFiles.CREATE_DRAWNIX_FILE,
    async (ctx, rawRequest: unknown) => {
      const request = validateCreateEntryRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(ctx, deps, request.projectId)
      return createDrawnixProjectFileWithinRoot(rootPath, request)
    },
  )

  server.handle(
    RPC_CHANNELS.projectFiles.CREATE_DIRECTORY,
    async (ctx, rawRequest: unknown) => {
      const request = validateCreateEntryRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(ctx, deps, request.projectId)
      return createProjectEntryWithinRoot(rootPath, request, 'directory')
    },
  )

  server.handle(
    RPC_CHANNELS.projectFiles.SAVE_TEXT_FILE,
    async (ctx, rawRequest: unknown) => {
      const request = validateSaveProjectTextRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(ctx, deps, request.projectId)
      return saveProjectTextFileWithinRoot(rootPath, request)
    },
  )

  server.handle(
    RPC_CHANNELS.projectFiles.SAVE_DRAWNIX_FILE,
    async (ctx, rawRequest: unknown) => {
      const request = validateSaveDrawnixRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(ctx, deps, request.projectId)
      return saveDrawnixProjectFileWithinRoot(rootPath, request)
    },
  )
}
