import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import {
  isSelectionReference,
  type ChatMessageSelectionReferenceV1,
  type ProjectFileSelectionReferenceV1,
  type SelectionReference,
  type Workspace,
} from '@craft-agent/core/types'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  getSessionFilePath,
  readSessionHeader,
} from '@craft-agent/shared/sessions'
import {
  isProjectNoteTargetPath,
  RPC_CHANNELS,
  type AppendProjectNoteRequest,
  type AppendProjectNoteResponse,
  type ConfigureProjectNoteTargetRequest,
  type ConfigureProjectNoteTargetResponse,
  type Session,
} from '@craft-agent/shared/protocol'
import type { RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import {
  MAX_PROJECT_FILE_TEXT_BYTES,
  canonicalizeProjectFileRelativePath,
  readProjectFileBinaryWithinRoot,
  resolveProjectWorkingDirectory,
  withProjectFileWriteQueue,
} from './project-files'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projectNotes.CONFIGURE_TARGET,
  RPC_CHANNELS.projectNotes.APPEND,
] as const

const MAX_REQUEST_ID_BYTES = 256
const MAX_SESSION_ID_BYTES = 256
const MAX_PROJECT_ID_BYTES = 256
const IDEMPOTENCY_CACHE_LIMIT = 512
const CHAT_SOURCE_ROLE_LABELS: Record<
  ChatMessageSelectionReferenceV1['role'],
  string
> = {
  user: 'User',
  assistant: 'Assistant',
  plan: 'Plan',
}

type ProjectNoteErrorCode =
  | 'PROJECT_NOTE_INVALID_REQUEST'
  | 'PROJECT_NOTE_NO_WORKSPACE'
  | 'PROJECT_NOTE_SESSION_NOT_FOUND'
  | 'PROJECT_NOTE_SESSION_WORKSPACE_MISMATCH'
  | 'PROJECT_NOTE_SESSION_UNBOUND'
  | 'PROJECT_NOTE_SESSION_PROJECT_CHANGED'
  | 'PROJECT_NOTE_TARGET_REQUIRED'
  | 'PROJECT_NOTE_TARGET_CHANGED'
  | 'PROJECT_NOTE_TARGET_INVALID'
  | 'PROJECT_NOTE_TARGET_NOT_FOUND'
  | 'PROJECT_NOTE_TARGET_ACCESS_DENIED'
  | 'PROJECT_NOTE_TARGET_NOT_REGULAR'
  | 'PROJECT_NOTE_TARGET_TOO_LARGE'
  | 'PROJECT_NOTE_TARGET_INVALID_TEXT'
  | 'PROJECT_NOTE_SOURCE_CHANGED'
  | 'PROJECT_NOTE_SOURCE_INVALID'
  | 'PROJECT_NOTE_REQUEST_CONFLICT'

function projectNoteError(code: ProjectNoteErrorCode, message: string): Error {
  return new Error(`${code}: ${message}`)
}

function validateBoundedId(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw projectNoteError('PROJECT_NOTE_INVALID_REQUEST', `Invalid ${label}`)
  }
  return value
}

function validateSessionId(value: unknown): string {
  return validateBoundedId(value, 'Session id', MAX_SESSION_ID_BYTES)
}

function validateRequestId(value: unknown): string {
  return validateBoundedId(value, 'request id', MAX_REQUEST_ID_BYTES)
}

function validateProjectId(value: unknown): string {
  return validateBoundedId(value, 'Project id', MAX_PROJECT_ID_BYTES)
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

function validateProjectNoteTargetPath(value: unknown): string {
  let relativePath: string
  try {
    relativePath = canonicalizeProjectFileRelativePath(value)
  } catch {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_INVALID',
      'Note target must be a canonical Project-relative path',
    )
  }

  if (!isProjectNoteTargetPath(relativePath)) {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_INVALID',
      'Note target must be a .md, .markdown, or .txt file',
    )
  }
  return relativePath
}

function validateConfigureRequest(value: unknown): ConfigureProjectNoteTargetRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectNoteError(
      'PROJECT_NOTE_INVALID_REQUEST',
      'Configure target request is required',
    )
  }
  const candidate = value as Partial<ConfigureProjectNoteTargetRequest>
  return {
    sessionId: validateSessionId(candidate.sessionId),
    relativePath: candidate.relativePath === null
      ? null
      : validateProjectNoteTargetPath(candidate.relativePath),
    projectId: validateProjectId(candidate.projectId),
  }
}

function validateAppendRequest(value: unknown): AppendProjectNoteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectNoteError('PROJECT_NOTE_INVALID_REQUEST', 'Append request is required')
  }
  const candidate = value as Partial<AppendProjectNoteRequest>
  if (!isSelectionReference(candidate.selection)) {
    throw projectNoteError(
      'PROJECT_NOTE_INVALID_REQUEST',
      'A valid SelectionReference is required',
    )
  }
  return {
    requestId: validateRequestId(candidate.requestId),
    sessionId: validateSessionId(candidate.sessionId),
    projectId: validateProjectId(candidate.projectId),
    expectedTargetPath: validateProjectNoteTargetPath(candidate.expectedTargetPath),
    selection: candidate.selection,
  }
}

function resolveAuthorizedWorkspace(
  ctx: RequestContext,
  deps: HandlerDeps,
): Workspace {
  const workspaceId = ctx.workspaceId
    ?? (ctx.webContentsId == null
      ? null
      : deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId))
  if (!workspaceId) {
    throw projectNoteError(
      'PROJECT_NOTE_NO_WORKSPACE',
      'No active workspace is associated with this request',
    )
  }

  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw projectNoteError(
      'PROJECT_NOTE_NO_WORKSPACE',
      'Active workspace is unavailable',
    )
  }
  return workspace
}

async function resolveAuthorizedSession(
  ctx: RequestContext,
  deps: HandlerDeps,
  sessionId: string,
): Promise<{ session: Session; workspace: Workspace }> {
  const workspace = resolveAuthorizedWorkspace(ctx, deps)
  const session = await deps.sessionManager.getSession(sessionId)
  if (!session) {
    throw projectNoteError('PROJECT_NOTE_SESSION_NOT_FOUND', 'Session was not found')
  }
  if (session.workspaceId !== workspace.id) {
    throw projectNoteError(
      'PROJECT_NOTE_SESSION_WORKSPACE_MISMATCH',
      'Session does not belong to the active workspace',
    )
  }
  return { session, workspace }
}

async function assertNoSymlinkSegments(
  rootPath: string,
  relativePath: string,
): Promise<void> {
  const segments = relativePath.split('/')
  let currentPath = rootPath

  for (let index = 0; index < segments.length; index += 1) {
    currentPath = resolve(currentPath, segments[index]!)
    let entry
    try {
      entry = await lstat(currentPath)
    } catch {
      throw projectNoteError(
        'PROJECT_NOTE_TARGET_NOT_FOUND',
        index === segments.length - 1
          ? 'Note target was not found'
          : 'Note target directory was not found',
      )
    }
    if (entry.isSymbolicLink()) {
      throw projectNoteError(
        'PROJECT_NOTE_TARGET_ACCESS_DENIED',
        'Symbolic links cannot be used as note targets',
      )
    }
    if (index < segments.length - 1 && !entry.isDirectory()) {
      throw projectNoteError(
        'PROJECT_NOTE_TARGET_NOT_FOUND',
        'Note target directory was not found',
      )
    }
  }
}

async function resolveTargetPath(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const canonicalRoot = await realpath(resolve(rootPath))
  await assertNoSymlinkSegments(canonicalRoot, relativePath)
  const targetPath = resolve(canonicalRoot, ...relativePath.split('/'))
  let resolvedPath: string
  try {
    resolvedPath = await realpath(targetPath)
  } catch {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_NOT_FOUND',
      'Note target was not found',
    )
  }
  if (!isPathWithinRoot(canonicalRoot, resolvedPath)) {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_ACCESS_DENIED',
      'Note target is outside the Project root',
    )
  }
  return targetPath
}

function assertValidProjectNoteText(bytes: Uint8Array): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_INVALID_TEXT',
      'Note target is not valid UTF-8 text',
    )
  }
}

async function openExistingTarget(
  rootPath: string,
  relativePath: string,
): Promise<{ handle: FileHandle; bytes: Buffer }> {
  const targetPath = await resolveTargetPath(rootPath, relativePath)
  let pathStat
  try {
    pathStat = await stat(targetPath)
  } catch {
    throw projectNoteError('PROJECT_NOTE_TARGET_NOT_FOUND', 'Note target was not found')
  }
  if (!pathStat.isFile()) {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_NOT_REGULAR',
      'Note target must be a regular file',
    )
  }
  if (!Number.isSafeInteger(pathStat.size) || pathStat.size > MAX_PROJECT_FILE_TEXT_BYTES) {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_TOO_LARGE',
      `Note target exceeds the ${MAX_PROJECT_FILE_TEXT_BYTES}-byte limit`,
    )
  }

  let handle: FileHandle
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW
    handle = await open(
      targetPath,
      fsConstants.O_RDWR | fsConstants.O_APPEND | noFollow,
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw projectNoteError(
        'PROJECT_NOTE_TARGET_NOT_FOUND',
        'Note target was not found',
      )
    }
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_ACCESS_DENIED',
      'Note target could not be opened safely',
    )
  }

  try {
    const openedStat = await handle.stat()
    if (
      !openedStat.isFile()
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino
    ) {
      throw projectNoteError(
        'PROJECT_NOTE_TARGET_ACCESS_DENIED',
        'Note target changed while it was being opened',
      )
    }
    if (openedStat.size > MAX_PROJECT_FILE_TEXT_BYTES) {
      throw projectNoteError(
        'PROJECT_NOTE_TARGET_TOO_LARGE',
        `Note target exceeds the ${MAX_PROJECT_FILE_TEXT_BYTES}-byte limit`,
      )
    }
    const bytes = await handle.readFile()
    const afterRead = await handle.stat()
    if (afterRead.size !== bytes.length || afterRead.ino !== openedStat.ino) {
      throw projectNoteError(
        'PROJECT_NOTE_TARGET_ACCESS_DENIED',
        'Note target changed while it was being read',
      )
    }
    assertValidProjectNoteText(bytes)
    return { handle, bytes }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function ensureProjectNoteTarget(
  rootPath: string,
  relativePath: string,
): Promise<void> {
  const { handle } = await openExistingTarget(
    rootPath,
    validateProjectNoteTargetPath(relativePath),
  )
  await handle.close()
}

function escapeBlockQuoteLine(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]|~])/g, '\\$1')
    .replace(/^(\s*)([#\-+])(?=\s)/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s)/, '$1\\$2')
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function escapeMarkdownLabel(value: string): string {
  return normalizeInlineText(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('`', '\\`')
}

function markdownUrl(value: string): string {
  return new URL(value).href
    .replaceAll('<', '%3C')
    .replaceAll('>', '%3E')
}

function markdownInlineCode(value: string): string {
  const normalized = normalizeInlineText(value)
  const longestBacktickRun = Math.max(
    0,
    ...[...normalized.matchAll(/`+/g)].map(match => match[0].length),
  )
  const fence = '`'.repeat(longestBacktickRun + 1)
  const content = normalized.startsWith('`') || normalized.endsWith('`')
    ? ` ${normalized} `
    : normalized
  return `${fence}${content}${fence}`
}

function projectSourceLabel(reference: ProjectFileSelectionReferenceV1): string {
  const parts = [markdownInlineCode(reference.relativePath)]
  if (reference.chapterTitle) {
    parts.push(escapeMarkdownLabel(reference.chapterTitle))
  } else if (reference.locator.type === 'pdf-text-quote') {
    const pages = reference.locator.startPage === reference.locator.endPage
      ? `page ${reference.locator.startPage}`
      : `pages ${reference.locator.startPage}-${reference.locator.endPage}`
    parts.push(pages)
  }
  return parts.join(' · ')
}

function selectionSourceLabel(
  selection: SelectionReference,
  session: Pick<Session, 'id' | 'name'>,
): string {
  switch (selection.kind) {
    case 'web-selection':
      return `[${escapeMarkdownLabel(selection.title)}](<${markdownUrl(selection.url)}>)`
    case 'project-file':
      return projectSourceLabel(selection)
    case 'chat-message':
      return [
        'Chat',
        CHAT_SOURCE_ROLE_LABELS[selection.role],
        escapeMarkdownLabel(session.name ?? session.id),
      ].join(' · ')
  }
}

export function serializeProjectNote(
  selection: SelectionReference,
  session: Pick<Session, 'id' | 'name'>,
): string {
  const quoteLines = selection.quote
    .trim()
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => `> ${escapeBlockQuoteLine(line)}`)

  return [
    ...quoteLines,
    '>',
    `> — ${selectionSourceLabel(selection, session)}`,
  ].join('\n') + '\n'
}

function separatorBeforeAppend(bytes: Buffer): string {
  if (bytes.length === 0) return ''
  const trailingBytes = bytes.subarray(Math.max(0, bytes.length - 2)).toString()
  if (trailingBytes === '\n\n') return ''
  if (bytes[bytes.length - 1] === 0x0a) return '\n'
  return '\n\n'
}

export async function appendProjectNoteWithinRoot(
  rootPath: string,
  relativePath: string,
  entry: string,
): Promise<void> {
  const canonicalPath = validateProjectNoteTargetPath(relativePath)
  return withProjectFileWriteQueue(rootPath, canonicalPath, async (canonicalRoot) => {
    const { handle, bytes } = await openExistingTarget(canonicalRoot, canonicalPath)
    try {
      const payload = Buffer.from(`${separatorBeforeAppend(bytes)}${entry}`, 'utf8')
      if (bytes.length + payload.length > MAX_PROJECT_FILE_TEXT_BYTES) {
        throw projectNoteError(
          'PROJECT_NOTE_TARGET_TOO_LARGE',
          `Appending this note would exceed the ${MAX_PROJECT_FILE_TEXT_BYTES}-byte limit`,
        )
      }
      await handle.writeFile(payload)
      await handle.sync()
    } finally {
      await handle.close()
    }
  })
}

async function validateSelectionSource(
  selection: SelectionReference,
  session: Session,
  workspace: Workspace,
): Promise<void> {
  if (selection.kind === 'web-selection') return

  if (selection.kind === 'chat-message') {
    if (selection.sessionId !== session.id) {
      throw projectNoteError(
        'PROJECT_NOTE_SOURCE_INVALID',
        'Chat selection belongs to a different Session',
      )
    }
    const message = session.messages.find(candidate => candidate.id === selection.messageId)
    if (!message || message.role !== selection.role) {
      throw projectNoteError(
        'PROJECT_NOTE_SOURCE_INVALID',
        'Chat selection source is unavailable',
      )
    }
    return
  }

  let sourceFingerprint: string
  try {
    const sourceRoot = await resolveProjectWorkingDirectory(
      workspace.rootPath,
      selection.projectId,
    )
    const source = await readProjectFileBinaryWithinRoot(sourceRoot, {
      projectId: selection.projectId,
      relativePath: selection.relativePath,
    })
    sourceFingerprint = source.sourceFingerprint
  } catch {
    throw projectNoteError(
      'PROJECT_NOTE_SOURCE_INVALID',
      'Project File selection source is unavailable',
    )
  }
  if (sourceFingerprint !== selection.sourceFingerprint) {
    throw projectNoteError(
      'PROJECT_NOTE_SOURCE_CHANGED',
      'Project File changed after the text was selected',
    )
  }
}

function requestSignature(request: AppendProjectNoteRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({
      sessionId: request.sessionId,
      projectId: request.projectId,
      expectedTargetPath: request.expectedTargetPath,
      selection: request.selection,
    }))
    .digest('hex')
}

export function resolveExpectedProjectNoteTarget(
  session: Pick<
    Session,
    | 'projectId'
    | 'projectNoteTargetPath'
    | 'projectNoteTargetRootFingerprint'
  >,
  projectId: string,
  expectedTargetPath: string,
  rootFingerprint: string,
): string {
  if (!session.projectId) {
    throw projectNoteError(
      'PROJECT_NOTE_SESSION_UNBOUND',
      'Session must be assigned to a Project before using Add Note',
    )
  }
  if (session.projectId !== projectId) {
    throw projectNoteError(
      'PROJECT_NOTE_SESSION_PROJECT_CHANGED',
      'Session Project changed while adding the note',
    )
  }
  if (!session.projectNoteTargetPath) {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_REQUIRED',
      'Choose a note target for this Session',
    )
  }
  if (session.projectNoteTargetPath !== expectedTargetPath) {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_CHANGED',
      'The Add Note target changed before the note was written',
    )
  }
  if (session.projectNoteTargetRootFingerprint !== rootFingerprint) {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_CHANGED',
      'The Project root changed after the note target was selected',
    )
  }
  return expectedTargetPath
}

interface IdempotencyEntry {
  signature: string
  promise: Promise<AppendProjectNoteResponse>
  settled: boolean
}

function pruneSettledIdempotencyEntries(
  cache: Map<string, IdempotencyEntry>,
): void {
  if (cache.size <= IDEMPOTENCY_CACHE_LIMIT) return

  for (const [requestId, entry] of cache) {
    if (!entry.settled) continue
    cache.delete(requestId)
    if (cache.size <= IDEMPOTENCY_CACHE_LIMIT) return
  }
}

export function registerProjectNoteHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  const idempotencyCache = new Map<string, IdempotencyEntry>()

  server.handle(
    RPC_CHANNELS.projectNotes.CONFIGURE_TARGET,
    async (ctx, rawRequest: unknown): Promise<ConfigureProjectNoteTargetResponse> => {
      const request = validateConfigureRequest(rawRequest)
      const { session, workspace } = await resolveAuthorizedSession(
        ctx,
        deps,
        request.sessionId,
      )
      if (!session.projectId) {
        throw projectNoteError(
          'PROJECT_NOTE_SESSION_UNBOUND',
          'Session must be assigned to a Project before configuring Add Note',
        )
      }
      if (session.projectId !== request.projectId) {
        throw projectNoteError(
          'PROJECT_NOTE_SESSION_PROJECT_CHANGED',
          'Session Project changed while choosing an Add Note target',
        )
      }

      let rootFingerprint: string | null = null
      if (request.relativePath) {
        const rootPath = await resolveProjectWorkingDirectory(
          workspace.rootPath,
          request.projectId,
        )
        await ensureProjectNoteTarget(rootPath, request.relativePath)
        const currentRootPath = await resolveProjectWorkingDirectory(
          workspace.rootPath,
          request.projectId,
        )
        if (currentRootPath !== rootPath) {
          throw projectNoteError(
            'PROJECT_NOTE_TARGET_CHANGED',
            'Project root changed while choosing an Add Note target',
          )
        }
        rootFingerprint = createHash('sha256')
          .update(currentRootPath)
          .digest('hex')
      }
      const configured = await deps.sessionManager.setSessionProjectNoteTarget(
        session.id,
        request.projectId,
        request.relativePath,
        rootFingerprint,
      )
      if (!configured) {
        const currentSession = await deps.sessionManager.getSession(session.id)
        if (currentSession?.projectId === request.projectId) {
          throw projectNoteError(
            'PROJECT_NOTE_TARGET_CHANGED',
            'Add Note target changed while it was being configured',
          )
        }
        throw projectNoteError(
          'PROJECT_NOTE_SESSION_PROJECT_CHANGED',
          'Session Project changed while choosing an Add Note target',
        )
      }
      if (request.relativePath && rootFingerprint) {
        try {
          const latestRootPath = await resolveProjectWorkingDirectory(
            workspace.rootPath,
            request.projectId,
          )
          if (
            createHash('sha256').update(latestRootPath).digest('hex')
            !== rootFingerprint
          ) {
            throw projectNoteError(
              'PROJECT_NOTE_TARGET_CHANGED',
              'Project root changed while choosing an Add Note target',
            )
          }
        } catch (error) {
          await deps.sessionManager.clearSessionProjectNoteTargetsIfMatches(
            session.id,
            request.projectId,
            request.relativePath,
            rootFingerprint,
          )
          throw error
        }
      }
      return {
        projectId: request.projectId,
        ...configured,
      }
    },
  )

  server.handle(
    RPC_CHANNELS.projectNotes.APPEND,
    async (ctx, rawRequest: unknown): Promise<AppendProjectNoteResponse> => {
      const request = validateAppendRequest(rawRequest)
      const { session, workspace } = await resolveAuthorizedSession(
        ctx,
        deps,
        request.sessionId,
      )
      const signature = requestSignature(request)
      const cached = idempotencyCache.get(request.requestId)
      if (cached) {
        if (cached.signature !== signature) {
          throw projectNoteError(
            'PROJECT_NOTE_REQUEST_CONFLICT',
            'Request id was already used for a different note',
          )
        }
        return cached.promise
      }

      const operation = (async (): Promise<AppendProjectNoteResponse> => {
        await validateSelectionSource(request.selection, session, workspace)
        const rootPath = await resolveProjectWorkingDirectory(
          workspace.rootPath,
          request.projectId,
        )
        const persistedSession = readSessionHeader(
          getSessionFilePath(workspace.rootPath, session.id),
        )
        if (!persistedSession) {
          throw projectNoteError(
            'PROJECT_NOTE_TARGET_CHANGED',
            'Session note target metadata is unavailable',
          )
        }
        const targetPath = resolveExpectedProjectNoteTarget(
          persistedSession,
          request.projectId,
          request.expectedTargetPath,
          createHash('sha256').update(rootPath).digest('hex'),
        )

        const appendedAt = new Date().toISOString()
        const entry = serializeProjectNote(request.selection, session)
        await appendProjectNoteWithinRoot(
          rootPath,
          targetPath,
          entry,
        )

        return {
          projectId: request.projectId,
          relativePath: targetPath,
          appendedAt,
        }
      })()

      const entry: IdempotencyEntry = {
        signature,
        promise: operation,
        settled: false,
      }
      idempotencyCache.set(request.requestId, entry)
      pruneSettledIdempotencyEntries(idempotencyCache)
      try {
        const response = await operation
        entry.settled = true
        pruneSettledIdempotencyEntries(idempotencyCache)
        return response
      } catch (error) {
        const current = idempotencyCache.get(request.requestId)
        if (current?.promise === operation) {
          idempotencyCache.delete(request.requestId)
        }
        throw error
      }
    },
  )
}
