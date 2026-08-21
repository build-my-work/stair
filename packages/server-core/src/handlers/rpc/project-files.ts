import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
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
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  isCanonicalProjectRelativePath,
  isEditableProjectTextFile,
  isProjectFileFingerprint,
  MAX_EDITABLE_PROJECT_FILE_BYTES,
  MAX_PROJECT_FILE_BINARY_BYTES,
  MAX_PROJECT_FILE_TEXT_BYTES,
  type ProjectDirectoryEntriesRequest,
  type ProjectDirectoryEntriesResult,
  type ProjectDirectoryEntry,
  type ProjectFileSearchRequest,
  type ProjectFileSearchResult,
  type CreateProjectEntryRequest,
  type ProjectFileFingerprint,
  type ProjectFileBinaryResponse,
  type ProjectFileMetadata,
  type ProjectFileRequest,
  type ProjectFileTextResponse,
  type SaveProjectTextFileRequest,
  type SaveProjectTextFileResponse,
} from '@craft-agent/shared/project-files'
import { loadProjectById } from '@craft-agent/shared/projects'
import { RPC_CHANNELS, type ErrorCode } from '@craft-agent/shared/protocol'
import { getMimeType } from '@craft-agent/shared/utils'
import { validatePathFormat } from '../../utils/path-validation'
import type { RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import {
  EpubArchiveValidationError,
  validateEpubArchive,
} from '../../project-files/epub-archive-validator'

const MAX_DIRECTORY_ENTRIES = 500
const MAX_PROJECT_FILE_SEARCH_RESULTS = 50
const MAX_PROJECT_FILE_NAME_BYTES = 255
const SKIPPED_SEARCH_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt',
  '.cache', '__pycache__', 'vendor', '.idea', '.vscode', 'coverage',
  '.nyc_output', '.turbo', 'out',
])
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const PROJECT_FILE_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.xml': 'application/xml',
  '.webp': 'image/webp',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}
const PROJECT_FILE_BINARY_EXTENSIONS = new Set([
  '.epub', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.bmp', '.ico', '.avif',
])

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projectFiles.SEARCH,
  RPC_CHANNELS.projectFiles.LIST_DIRECTORY_ENTRIES,
  RPC_CHANNELS.projectFiles.CREATE_FILE,
  RPC_CHANNELS.projectFiles.CREATE_DIRECTORY,
  RPC_CHANNELS.projectFiles.READ_TEXT,
  RPC_CHANNELS.projectFiles.READ_BINARY,
  RPC_CHANNELS.projectFiles.SAVE_TEXT_FILE,
  RPC_CHANNELS.projectFiles.FLUSH_COMPLETED,
] as const

type ProjectFileErrorCode = Extract<ErrorCode, `PROJECT_FILE_${string}`>

type FileStatSnapshot = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>

interface StableProjectFile {
  bytes: Buffer
  stat: Stats
  targetPath: string
}

function projectFileError(code: ProjectFileErrorCode, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function validateProjectId(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > 256
  ) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Invalid Project id')
  }
  return value
}

function canonicalProjectRelativePath(value: unknown): string {
  if (!isCanonicalProjectRelativePath(value)) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Path must be a canonical Project-relative POSIX path',
    )
  }
  return value
}

function validateFileRequest(value: unknown): ProjectFileRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Project File request is required')
  }
  const request = value as Partial<ProjectFileRequest>
  return {
    projectId: validateProjectId(request.projectId),
    relativePath: canonicalProjectRelativePath(request.relativePath),
  }
}

function validateDirectoryRequest(value: unknown): ProjectDirectoryEntriesRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Project directory request is required')
  }
  const request = value as Partial<ProjectDirectoryEntriesRequest>
  if (
    request.relativePath !== undefined
    && request.relativePath !== ''
    && !isCanonicalProjectRelativePath(request.relativePath)
  ) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Directory path must be a canonical Project-relative POSIX path',
    )
  }
  return {
    projectId: validateProjectId(request.projectId),
    ...(request.relativePath ? { relativePath: request.relativePath } : {}),
  }
}

function validateSearchRequest(value: unknown): ProjectFileSearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Project File search request is required')
  }
  const request = value as Partial<ProjectFileSearchRequest>
  if (
    typeof request.query !== 'string'
    || request.query !== request.query.trim()
    || request.query.length === 0
    || Buffer.byteLength(request.query, 'utf8') > 256
  ) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Invalid Project File search query')
  }
  return { projectId: validateProjectId(request.projectId), query: request.query }
}

function validateCreateRequest(value: unknown): CreateProjectEntryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Project entry request is required')
  }
  const request = value as Partial<CreateProjectEntryRequest>
  if (
    request.parentRelativePath !== undefined
    && request.parentRelativePath !== ''
    && !isCanonicalProjectRelativePath(request.parentRelativePath)
  ) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Invalid Project parent directory')
  }
  if (
    typeof request.name !== 'string'
    || request.name.length === 0
    || request.name !== request.name.trim()
    || request.name === '.'
    || request.name === '..'
    || request.name.includes('\0')
    || request.name.includes('/')
    || request.name.includes('\\')
    || Buffer.byteLength(request.name, 'utf8') > MAX_PROJECT_FILE_NAME_BYTES
  ) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Name must be one valid path segment')
  }
  return {
    projectId: validateProjectId(request.projectId),
    ...(request.parentRelativePath
      ? { parentRelativePath: request.parentRelativePath }
      : {}),
    name: request.name,
  }
}

function validateSaveRequest(value: unknown): SaveProjectTextFileRequest {
  const request = validateFileRequest(value)
  const save = value as Partial<SaveProjectTextFileRequest>
  if (!isProjectFileFingerprint(save.expectedFingerprint) || typeof save.content !== 'string') {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Invalid text save request')
  }
  if (!isEditableProjectTextFile(request.relativePath)) {
    throw projectFileError('PROJECT_FILE_INVALID_TEXT', 'This Project File type is not editable')
  }
  if (save.content.includes('\0')) {
    throw projectFileError('PROJECT_FILE_INVALID_TEXT', 'Project File text cannot contain NUL bytes')
  }
  if (Buffer.byteLength(save.content, 'utf8') > MAX_EDITABLE_PROJECT_FILE_BYTES) {
    throw projectFileError(
      'PROJECT_FILE_TOO_LARGE',
      `Editable Project Files are limited to ${MAX_EDITABLE_PROJECT_FILE_BYTES} bytes`,
    )
  }
  return { ...request, expectedFingerprint: save.expectedFingerprint, content: save.content }
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath)
  return child === '' || (
    child !== '..'
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child)
  )
}

async function canonicalRoot(rootPath: string): Promise<string> {
  try {
    const result = await realpath(resolve(rootPath))
    if (!(await stat(result)).isDirectory()) throw new Error('not a directory')
    return result
  } catch {
    throw projectFileError('PROJECT_FILE_NOT_FOUND', 'Project working directory is unavailable')
  }
}

async function resolveProjectPath(
  rootPath: string,
  relativePath: string,
  expectedType: 'file' | 'directory',
): Promise<{ rootPath: string; targetPath: string; entryStat: Stats }> {
  const root = await canonicalRoot(rootPath)
  let targetPath = root
  let entryStat: Stats = await lstat(root)
  const segments = relativePath ? relativePath.split('/') : []

  for (let index = 0; index < segments.length; index += 1) {
    targetPath = join(targetPath, segments[index])
    try {
      entryStat = await lstat(targetPath)
    } catch {
      throw projectFileError('PROJECT_FILE_NOT_FOUND', 'Project path was not found')
    }
    if (entryStat.isSymbolicLink()) {
      throw projectFileError('PROJECT_FILE_ACCESS_DENIED', 'Symbolic links are not accessible')
    }
    if (index < segments.length - 1 && !entryStat.isDirectory()) {
      throw projectFileError('PROJECT_FILE_NOT_FOUND', 'Project path was not found')
    }
  }

  if (!isPathWithinRoot(root, targetPath)) {
    throw projectFileError('PROJECT_FILE_ACCESS_DENIED', 'Project path is outside the working directory')
  }
  if (expectedType === 'file' ? !entryStat.isFile() : !entryStat.isDirectory()) {
    throw projectFileError(
      expectedType === 'file' ? 'PROJECT_FILE_NOT_REGULAR' : 'PROJECT_FILE_NOT_FOUND',
      expectedType === 'file' ? 'Project File APIs only access regular files' : 'Directory was not found',
    )
  }
  return { rootPath: root, targetPath, entryStat }
}

function toProjectRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join('/')
}

export async function listProjectDirectoryEntriesWithinRoot(
  rootPath: string,
  relativeDirectory = '',
): Promise<ProjectDirectoryEntriesResult> {
  if (relativeDirectory && !isCanonicalProjectRelativePath(relativeDirectory)) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Directory path must be a canonical Project-relative POSIX path',
    )
  }
  const directory = await resolveProjectPath(rootPath, relativeDirectory, 'directory')
  let rawEntries
  try {
    rawEntries = await readdir(directory.targetPath, { withFileTypes: true })
  } catch {
    throw projectFileError('PROJECT_FILE_ACCESS_DENIED', 'Project directory could not be read')
  }

  const entries: ProjectDirectoryEntry[] = []
  for (const entry of rawEntries) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue
    const targetPath = join(directory.targetPath, entry.name)
    let entryStat: Stats
    try {
      entryStat = await lstat(targetPath)
    } catch {
      continue
    }
    if (entryStat.isSymbolicLink()) continue
    entries.push({
      name: entry.name,
      relativePath: toProjectRelativePath(directory.rootPath, targetPath),
      type: entryStat.isDirectory() ? 'directory' : 'file',
      ...(entryStat.isFile()
        ? { byteLength: entryStat.size, lastModifiedMs: entryStat.mtimeMs }
        : {}),
    })
  }

  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })
  const truncated = entries.length > MAX_DIRECTORY_ENTRIES
  if (truncated) entries.length = MAX_DIRECTORY_ENTRIES
  return { entries, truncated }
}

export async function searchProjectFilesWithinRoot(
  rootPath: string,
  query: string,
): Promise<ProjectFileSearchResult[]> {
  const root = await canonicalRoot(rootPath)
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []
  const results: ProjectFileSearchResult[] = []
  let queue = ['']

  while (queue.length > 0 && results.length < MAX_PROJECT_FILE_SEARCH_RESULTS) {
    const nextQueue: string[] = []
    for (const relativeDirectory of queue) {
      let entries
      try {
        entries = await readdir(
          relativeDirectory ? join(root, relativeDirectory) : root,
          { withFileTypes: true },
        )
      } catch {
        continue
      }
      for (const entry of entries) {
        if (results.length >= MAX_PROJECT_FILE_SEARCH_RESULTS) break
        if (entry.isSymbolicLink() || SKIPPED_SEARCH_DIRECTORIES.has(entry.name)) continue
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name
        if (entry.isDirectory()) {
          nextQueue.push(relativePath)
        } else if (
          entry.isFile()
          && relativePath.toLowerCase().includes(normalizedQuery)
        ) {
          results.push({ name: entry.name, relativePath })
        }
      }
    }
    queue = nextQueue
  }
  return results.sort((left, right) => (
    left.name.length - right.name.length
    || left.relativePath.localeCompare(right.relativePath)
  ))
}

export async function createProjectEntryWithinRoot(
  rootPath: string,
  request: CreateProjectEntryRequest,
  type: ProjectDirectoryEntry['type'],
): Promise<ProjectDirectoryEntry> {
  const validated = validateCreateRequest(request)
  const parent = await resolveProjectPath(
    rootPath,
    validated.parentRelativePath ?? '',
    'directory',
  )
  const relativePath = validated.parentRelativePath
    ? posix.join(validated.parentRelativePath, validated.name)
    : validated.name
  if (!isCanonicalProjectRelativePath(relativePath)) {
    throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Created Project path is invalid')
  }
  const targetPath = join(parent.targetPath, validated.name)
  if (!isPathWithinRoot(parent.rootPath, targetPath)) {
    throw projectFileError('PROJECT_FILE_ACCESS_DENIED', 'Project entry is outside the working directory')
  }

  try {
    if (type === 'directory') {
      await mkdir(targetPath)
    } else {
      const handle = await open(targetPath, 'wx')
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw projectFileError('PROJECT_FILE_ALREADY_EXISTS', 'A file or directory with this name already exists')
    }
    throw projectFileError('PROJECT_FILE_ACCESS_DENIED', 'Project entry could not be created')
  }
  return { name: validated.name, relativePath, type }
}

function statSnapshotsMatch(left: FileStatSnapshot, right: FileStatSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

async function readFixedSize(handle: FileHandle, expectedSize: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(expectedSize)
  let offset = 0
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(bytes, offset, expectedSize - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  const growthProbe = Buffer.allocUnsafe(1)
  const grew = (await handle.read(growthProbe, 0, 1, expectedSize)).bytesRead !== 0
  if (offset !== expectedSize || grew) {
    throw projectFileError('PROJECT_FILE_CHANGED', 'Project File changed while being read')
  }
  return bytes
}

async function readStableProjectFile(
  rootPath: string,
  relativePath: string,
  maxBytes: number,
): Promise<StableProjectFile> {
  const resolved = await resolveProjectPath(rootPath, relativePath, 'file')
  let handle: FileHandle
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
    handle = await open(resolved.targetPath, constants.O_RDONLY | noFollow)
  } catch {
    throw projectFileError('PROJECT_FILE_ACCESS_DENIED', 'Project File could not be opened safely')
  }

  try {
    const before = await handle.stat()
    if (!before.isFile()) {
      throw projectFileError('PROJECT_FILE_NOT_REGULAR', 'Project File APIs only access regular files')
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      throw projectFileError('PROJECT_FILE_TOO_LARGE', `Project File exceeds the ${maxBytes}-byte limit`)
    }
    const bytes = await readFixedSize(handle, before.size)
    const afterHandle = await handle.stat()
    let afterPath: Stats
    let finalPath: string
    try {
      afterPath = await stat(resolved.targetPath)
      finalPath = await realpath(resolved.targetPath)
    } catch {
      throw projectFileError('PROJECT_FILE_CHANGED', 'Project File changed while being read')
    }
    if (
      !isPathWithinRoot(resolved.rootPath, finalPath)
      || !statSnapshotsMatch(before, afterHandle)
      || !statSnapshotsMatch(before, afterPath)
    ) {
      throw projectFileError('PROJECT_FILE_CHANGED', 'Project File changed while being read')
    }
    return { bytes, stat: afterHandle, targetPath: resolved.targetPath }
  } finally {
    await handle.close()
  }
}

function fingerprint(bytes: Buffer): ProjectFileFingerprint {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function projectFileMimeType(relativePath: string): string {
  return PROJECT_FILE_MIME_TYPES[extname(relativePath).toLowerCase()] ?? getMimeType(relativePath)
}

function metadata(
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

function decodeUtf8(bytes: Buffer): string {
  if (bytes.includes(0)) {
    throw projectFileError('PROJECT_FILE_INVALID_TEXT', 'Project File contains binary data')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw projectFileError('PROJECT_FILE_INVALID_TEXT', 'Project File is not valid UTF-8 text')
  }
}

export async function readProjectTextFileWithinRoot(
  rootPath: string,
  request: ProjectFileRequest,
): Promise<ProjectFileTextResponse> {
  const validated = validateFileRequest(request)
  const stable = await readStableProjectFile(
    rootPath,
    validated.relativePath,
    MAX_PROJECT_FILE_TEXT_BYTES,
  )
  return {
    metadata: metadata(validated.projectId, validated.relativePath, stable.stat),
    text: decodeUtf8(stable.bytes),
    sourceFingerprint: fingerprint(stable.bytes),
  }
}

export async function readProjectFileBinaryWithinRoot(
  rootPath: string,
  request: ProjectFileRequest,
): Promise<ProjectFileBinaryResponse> {
  const validated = validateFileRequest(request)
  const extension = extname(validated.relativePath).toLowerCase()
  if (!PROJECT_FILE_BINARY_EXTENSIONS.has(extension)) {
    throw projectFileError(
      'PROJECT_FILE_INVALID_REQUEST',
      'Binary Project File reading is limited to EPUB, PDF, and image readers',
    )
  }
  const stable = await readStableProjectFile(
    rootPath,
    validated.relativePath,
    MAX_PROJECT_FILE_BINARY_BYTES,
  )
  if (extension === '.epub') {
    try {
      await validateEpubArchive(stable.bytes)
    } catch (error) {
      if (error instanceof EpubArchiveValidationError) {
        throw projectFileError(
          error.code === 'EPUB_ARCHIVE_TOO_LARGE'
            || error.code === 'EPUB_ARCHIVE_TOO_MANY_ENTRIES'
            || error.code === 'EPUB_ARCHIVE_ENTRY_TOO_LARGE'
            || error.code === 'EPUB_ARCHIVE_COMPRESSION_RATIO_EXCEEDED'
            ? 'PROJECT_FILE_TOO_LARGE'
            : 'PROJECT_FILE_INVALID_REQUEST',
          error.message,
        )
      }
      throw error
    }
  }
  return {
    metadata: metadata(validated.projectId, validated.relativePath, stable.stat),
    bytes: stable.bytes,
    sourceFingerprint: fingerprint(stable.bytes),
  }
}

const projectFileWriteQueues = new Map<string, Promise<void>>()

interface PendingRendererFlush {
  clientId: string
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const pendingRendererFlushes = new Map<string, PendingRendererFlush>()

/** Ask one renderer client to flush every open Project document before app exit. */
export function requestClientProjectFilesFlush(
  server: RpcServer,
  clientId: string,
  timeoutMs = 2_500,
): Promise<void> {
  const requestId = randomUUID()
  return new Promise<void>((resolveRequest, rejectRequest) => {
    const timeout = setTimeout(() => {
      pendingRendererFlushes.delete(requestId)
      rejectRequest(new Error('PROJECT_FILE_FLUSH_TIMEOUT: Renderer did not finish saving'))
    }, timeoutMs)
    pendingRendererFlushes.set(requestId, {
      clientId,
      resolve: resolveRequest,
      reject: rejectRequest,
      timeout,
    })
    server.push(
      RPC_CHANNELS.projectFiles.FLUSH_REQUESTED,
      { to: 'client', clientId },
      requestId,
    )
  })
}

async function withProjectFileWriteQueue<T>(
  rootPath: string,
  relativePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${await canonicalRoot(rootPath)}\0${relativePath}`
  const previous = projectFileWriteQueues.get(key) ?? Promise.resolve()
  const result = previous.catch(() => {}).then(operation)
  const settled = result.then(() => {}, () => {})
  projectFileWriteQueues.set(key, settled)
  void settled.finally(() => {
    if (projectFileWriteQueues.get(key) === settled) projectFileWriteQueues.delete(key)
  })
  return result
}

function encodeWithExistingStyle(content: string, existingBytes: Buffer): Buffer {
  const hadBom = existingBytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
  const existingText = decodeUtf8(existingBytes)
  const lineEnding = existingText.includes('\r\n') ? '\r\n' : '\n'
  let normalized = content.replace(/\r\n?/g, '\n')
  if (lineEnding === '\r\n') normalized = normalized.replaceAll('\n', '\r\n')
  const contentBytes = Buffer.from(normalized, 'utf8')
  return hadBom ? Buffer.concat([UTF8_BOM, contentBytes]) : contentBytes
}

async function atomicReplace(targetPath: string, bytes: Buffer, mode: number): Promise<void> {
  const tempPath = join(dirname(targetPath), `.${posix.basename(targetPath)}.${randomUUID()}.tmp`)
  let handle: FileHandle | null = null
  try {
    handle = await open(tempPath, 'wx', mode)
    await handle.writeFile(bytes)
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tempPath, targetPath)

    try {
      const directory = await open(dirname(targetPath), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch {
      // Some platforms do not permit syncing directories; the atomic rename still succeeded.
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

export async function saveProjectTextFileWithinRoot(
  rootPath: string,
  request: SaveProjectTextFileRequest,
): Promise<SaveProjectTextFileResponse> {
  const validated = validateSaveRequest(request)
  return withProjectFileWriteQueue(rootPath, validated.relativePath, async () => {
    const current = await readStableProjectFile(
      rootPath,
      validated.relativePath,
      MAX_EDITABLE_PROJECT_FILE_BYTES,
    )
    if (fingerprint(current.bytes) !== validated.expectedFingerprint) {
      throw projectFileError('PROJECT_FILE_CHANGED', 'Project File changed on disk')
    }

    const nextBytes = encodeWithExistingStyle(validated.content, current.bytes)
    if (nextBytes.byteLength > MAX_EDITABLE_PROJECT_FILE_BYTES) {
      throw projectFileError(
        'PROJECT_FILE_TOO_LARGE',
        `Editable Project Files are limited to ${MAX_EDITABLE_PROJECT_FILE_BYTES} bytes`,
      )
    }

    // Re-read immediately before replace so an external writer cannot be silently overwritten.
    const latest = await readStableProjectFile(
      rootPath,
      validated.relativePath,
      MAX_EDITABLE_PROJECT_FILE_BYTES,
    )
    if (fingerprint(latest.bytes) !== validated.expectedFingerprint) {
      throw projectFileError('PROJECT_FILE_CHANGED', 'Project File changed on disk')
    }
    await atomicReplace(latest.targetPath, nextBytes, latest.stat.mode)
    const savedStat = await stat(latest.targetPath)
    return {
      metadata: metadata(validated.projectId, validated.relativePath, savedStat),
      sourceFingerprint: fingerprint(nextBytes),
    }
  })
}

export async function resolveProjectWorkingDirectory(
  workspaceRootPath: string,
  projectId: string,
): Promise<string> {
  const validatedProjectId = validateProjectId(projectId)
  const project = loadProjectById(workspaceRootPath, validatedProjectId)
  const workingDirectory = project?.config.workingDirectory
  if (!workingDirectory || !validatePathFormat(workingDirectory).valid) {
    throw projectFileError(
      'PROJECT_FILE_NOT_FOUND',
      'Project is unavailable in the active Workspace or has no working directory',
    )
  }
  return canonicalRoot(workingDirectory)
}

async function resolveAuthorizedProjectRoot(
  context: RequestContext,
  deps: HandlerDeps,
  projectId: string,
): Promise<string> {
  const workspaceId = context.workspaceId
    ?? (context.webContentsId == null
      ? null
      : deps.windowManager?.getWorkspaceForWindow(context.webContentsId))
  if (!workspaceId) {
    throw projectFileError('PROJECT_FILE_NO_WORKSPACE', 'No active Workspace is associated with this request')
  }
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw projectFileError('PROJECT_FILE_NO_WORKSPACE', 'Active Workspace is unavailable')
  }
  return resolveProjectWorkingDirectory(workspace.rootPath, projectId)
}

export function registerProjectFileHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.projectFiles.SEARCH,
    async (context, rawRequest: unknown) => {
      const request = validateSearchRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(context, deps, request.projectId)
      return searchProjectFilesWithinRoot(rootPath, request.query)
    },
  )
  server.handle(
    RPC_CHANNELS.projectFiles.LIST_DIRECTORY_ENTRIES,
    async (context, rawRequest: unknown) => {
      const request = validateDirectoryRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(context, deps, request.projectId)
      return listProjectDirectoryEntriesWithinRoot(rootPath, request.relativePath)
    },
  )
  server.handle(
    RPC_CHANNELS.projectFiles.READ_TEXT,
    async (context, rawRequest: unknown) => {
      const request = validateFileRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(context, deps, request.projectId)
      return readProjectTextFileWithinRoot(rootPath, request)
    },
  )
  server.handle(
    RPC_CHANNELS.projectFiles.CREATE_FILE,
    async (context, rawRequest: unknown) => {
      const request = validateCreateRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(context, deps, request.projectId)
      return createProjectEntryWithinRoot(rootPath, request, 'file')
    },
  )
  server.handle(
    RPC_CHANNELS.projectFiles.CREATE_DIRECTORY,
    async (context, rawRequest: unknown) => {
      const request = validateCreateRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(context, deps, request.projectId)
      return createProjectEntryWithinRoot(rootPath, request, 'directory')
    },
  )
  server.handle(
    RPC_CHANNELS.projectFiles.READ_BINARY,
    async (context, rawRequest: unknown) => {
      const request = validateFileRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(context, deps, request.projectId)
      return readProjectFileBinaryWithinRoot(rootPath, request)
    },
  )
  server.handle(
    RPC_CHANNELS.projectFiles.SAVE_TEXT_FILE,
    async (context, rawRequest: unknown) => {
      const request = validateSaveRequest(rawRequest)
      const rootPath = await resolveAuthorizedProjectRoot(context, deps, request.projectId)
      return saveProjectTextFileWithinRoot(rootPath, request)
    },
  )
  server.handle(
    RPC_CHANNELS.projectFiles.FLUSH_COMPLETED,
    (context, requestId: unknown, error: unknown) => {
      if (typeof requestId !== 'string' || (error !== undefined && typeof error !== 'string')) {
        throw projectFileError('PROJECT_FILE_INVALID_REQUEST', 'Invalid renderer flush response')
      }
      const pending = pendingRendererFlushes.get(requestId)
      if (!pending || pending.clientId !== context.clientId) return
      clearTimeout(pending.timeout)
      pendingRendererFlushes.delete(requestId)
      if (error) pending.reject(new Error(error))
      else pending.resolve()
    },
  )
}
