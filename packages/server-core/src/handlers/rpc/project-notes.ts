import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  isReference,
  referencesFitSerializedLimits,
  type ChatMessageReferenceV1,
  type ProjectFileReferenceV1,
  type Reference,
  type Workspace,
} from '@craft-agent/core/types'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { classifyProjectFile, MAX_PROJECT_FILE_TEXT_BYTES } from '@craft-agent/shared/project-files'
import {
  CodedError,
  isProjectNoteTargetPath,
  RPC_CHANNELS,
  type AppendProjectNoteRequest,
  type AppendProjectNoteResponse,
  type ConfigureProjectNoteTargetRequest,
  type ConfigureProjectNoteTargetResponse,
  type ErrorCode,
  type Session,
} from '@craft-agent/shared/protocol'

import type { RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import {
  readProjectFileBinaryWithinRoot,
  readProjectTextFileWithinRoot,
  resolveProjectWorkingDirectory,
} from './project-files'
import {
  openProjectNoteFileWithinRoot,
  SecureProjectNoteOpenError,
  type SecureProjectNoteFile,
  type SecureProjectNoteOpenHooks,
} from './secure-project-note-file'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projectNotes.CONFIGURE_TARGET,
  RPC_CHANNELS.projectNotes.APPEND,
] as const

type ProjectNoteErrorCode = Extract<ErrorCode, `PROJECT_NOTE_${string}`>

function projectNoteError(code: ProjectNoteErrorCode, message: string): CodedError {
  return new CodedError(code, `${code}: ${message}`)
}

function boundedId(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > 256
  ) {
    throw projectNoteError('PROJECT_NOTE_INVALID_REQUEST', `Invalid ${label}`)
  }
  return value
}

function noteTargetPath(value: unknown): string {
  if (!isProjectNoteTargetPath(value)) {
    throw projectNoteError(
      'PROJECT_NOTE_TARGET_INVALID',
      'Note target must be a canonical Project-relative .md, .markdown, or .txt path',
    )
  }
  return value
}

function configureRequest(value: unknown): ConfigureProjectNoteTargetRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectNoteError('PROJECT_NOTE_INVALID_REQUEST', 'Configure request is required')
  }
  const request = value as Partial<ConfigureProjectNoteTargetRequest>
  return {
    sessionId: boundedId(request.sessionId, 'Session id'),
    projectId: boundedId(request.projectId, 'Project id'),
    relativePath: request.relativePath === null ? null : noteTargetPath(request.relativePath),
  }
}

function appendRequest(value: unknown): AppendProjectNoteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectNoteError('PROJECT_NOTE_INVALID_REQUEST', 'Append request is required')
  }
  const request = value as Partial<AppendProjectNoteRequest>
  if (!isReference(request.selection)) {
    throw projectNoteError('PROJECT_NOTE_INVALID_REQUEST', 'A valid Reference is required')
  }
  if (!referencesFitSerializedLimits([request.selection])) {
    throw projectNoteError('PROJECT_NOTE_INVALID_REQUEST', 'Reference exceeds the serialized size limit')
  }
  return {
    requestId: boundedId(request.requestId, 'request id'),
    sessionId: boundedId(request.sessionId, 'Session id'),
    projectId: boundedId(request.projectId, 'Project id'),
    expectedTargetPath: noteTargetPath(request.expectedTargetPath),
    selection: request.selection,
  }
}

function authorizedWorkspace(context: RequestContext, deps: HandlerDeps): Workspace {
  const workspaceId = context.workspaceId
    ?? (context.webContentsId == null
      ? null
      : deps.windowManager?.getWorkspaceForWindow(context.webContentsId))
  if (!workspaceId) {
    throw projectNoteError('PROJECT_NOTE_NO_WORKSPACE', 'No active Workspace is associated with this request')
  }
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw projectNoteError('PROJECT_NOTE_NO_WORKSPACE', 'Active Workspace is unavailable')
  }
  return workspace
}

async function authorizedSession(
  context: RequestContext,
  deps: HandlerDeps,
  sessionId: string,
): Promise<{ session: Session; workspace: Workspace }> {
  const workspace = authorizedWorkspace(context, deps)
  const session = await deps.sessionManager.getSession(sessionId)
  if (!session) {
    throw projectNoteError('PROJECT_NOTE_SESSION_NOT_FOUND', 'Session was not found')
  }
  if (session.workspaceId !== workspace.id) {
    throw projectNoteError(
      'PROJECT_NOTE_SESSION_WORKSPACE_MISMATCH',
      'Session does not belong to the active Workspace',
    )
  }
  return { session, workspace }
}

function assertUtf8(bytes: Uint8Array): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw projectNoteError('PROJECT_NOTE_TARGET_INVALID_TEXT', 'Note target is not valid UTF-8 text')
  }
}

async function openTarget(
  rootPath: string,
  relativePath: string,
  hooks: SecureProjectNoteOpenHooks = {},
): Promise<{ handle: SecureProjectNoteFile; bytes: Buffer }> {
  const canonicalPath = noteTargetPath(relativePath)
  let handle: SecureProjectNoteFile
  try {
    handle = await openProjectNoteFileWithinRoot(rootPath, canonicalPath, hooks)
  } catch (error) {
    if (error instanceof SecureProjectNoteOpenError && error.reason === 'not-found') {
      throw projectNoteError('PROJECT_NOTE_TARGET_NOT_FOUND', 'Note target was not found')
    }
    throw projectNoteError('PROJECT_NOTE_TARGET_ACCESS_DENIED', 'Note target could not be opened safely')
  }

  try {
    const opened = await handle.stat()
    if (!opened.isFile) {
      throw projectNoteError('PROJECT_NOTE_TARGET_NOT_REGULAR', 'Note target must be a regular file')
    }
    if (!Number.isSafeInteger(opened.size) || opened.size > MAX_PROJECT_FILE_TEXT_BYTES) {
      throw projectNoteError('PROJECT_NOTE_TARGET_TOO_LARGE', 'Note target exceeds the Project text limit')
    }
    const bytes = await handle.read(opened.size)
    const afterRead = await handle.stat()
    if (afterRead.identity !== opened.identity || afterRead.size !== bytes.length) {
      throw projectNoteError('PROJECT_NOTE_TARGET_ACCESS_DENIED', 'Note target changed while reading')
    }
    assertUtf8(bytes)
    return { handle, bytes }
  } catch (error) {
    await handle.close().catch(() => {})
    if (error instanceof CodedError) throw error
    throw projectNoteError('PROJECT_NOTE_TARGET_ACCESS_DENIED', 'Note target could not be read safely')
  }
}

export async function ensureProjectNoteTarget(rootPath: string, relativePath: string): Promise<void> {
  const { handle } = await openTarget(rootPath, relativePath)
  await handle.close()
}

function separatorBeforeAppend(bytes: Buffer): string {
  if (bytes.length === 0) return ''
  const tail = bytes.subarray(Math.max(0, bytes.length - 2)).toString()
  if (tail === '\n\n') return ''
  return bytes.at(-1) === 0x0a ? '\n' : '\n\n'
}

const targetWriteQueues = new Map<string, Promise<void>>()

export async function appendProjectNoteWithinRoot(
  rootPath: string,
  relativePath: string,
  entry: string,
  hooks: SecureProjectNoteOpenHooks = {},
): Promise<void> {
  const root = await realpath(resolve(rootPath))
  const path = noteTargetPath(relativePath)
  const key = `${root}\0${path}`
  const previous = targetWriteQueues.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    const { handle, bytes } = await openTarget(root, path, hooks)
    try {
      const payload = Buffer.from(`${separatorBeforeAppend(bytes)}${entry}`, 'utf8')
      if (bytes.length + payload.length > MAX_PROJECT_FILE_TEXT_BYTES) {
        throw projectNoteError('PROJECT_NOTE_TARGET_TOO_LARGE', 'Appending would exceed the Project text limit')
      }
      await handle.append(payload)
      await handle.sync()
    } finally {
      await handle.close()
    }
  })
  const settled = operation.then(() => {}, () => {})
  targetWriteQueues.set(key, settled)
  void settled.finally(() => {
    if (targetWriteQueues.get(key) === settled) targetWriteQueues.delete(key)
  })
  return operation
}

function escapeQuoteLine(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]|~])/g, '\\$1')
    .replace(/^(\s*)([#\-+])(?=\s)/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s)/, '$1\\$2')
}

function inlineCode(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  const longest = Math.max(0, ...[...normalized.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${normalized.startsWith('`') || normalized.endsWith('`') ? ` ${normalized} ` : normalized}${fence}`
}

function sourceLabel(reference: Reference, session: Pick<Session, 'id' | 'name'>): string {
  if (reference.kind === 'chat-message') {
    const role = {
      assistant: 'Assistant',
      plan: 'Plan',
      user: 'User',
    }[reference.role]
    return `Chat · ${role} · ${inlineCode(session.name ?? session.id)}`
  }
  const parts = [inlineCode(reference.relativePath)]
  if (reference.chapterTitle) {
    parts.push(escapeQuoteLine(reference.chapterTitle.replace(/\s+/g, ' ').trim()))
  }
  if (reference.locator.type === 'pdf-text-quote') {
    parts.push(reference.locator.startPage === reference.locator.endPage
      ? `page ${reference.locator.startPage}`
      : `pages ${reference.locator.startPage}-${reference.locator.endPage}`)
  }
  return parts.join(' · ')
}

export function serializeProjectNote(
  reference: Reference,
  session: Pick<Session, 'id' | 'name'>,
): string {
  const quote = reference.quote
    .trim()
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => `> ${escapeQuoteLine(line)}`)
  return [...quote, '>', `> — ${sourceLabel(reference, session)}`].join('\n') + '\n'
}

async function validateChatSource(
  reference: ChatMessageReferenceV1,
  targetSession: Session,
  deps: HandlerDeps,
): Promise<void> {
  const source = await deps.sessionManager.getSession(reference.sessionId)
  if (
    !source
    || source.workspaceId !== targetSession.workspaceId
    || source.projectId !== targetSession.projectId
  ) {
    throw projectNoteError('PROJECT_NOTE_SOURCE_INVALID', 'Chat reference is outside the target Project')
  }
  const message = source.messages.find(candidate => candidate.id === reference.messageId)
  if (!message || message.role !== reference.role) {
    throw projectNoteError('PROJECT_NOTE_SOURCE_INVALID', 'Chat reference source is unavailable')
  }
}

async function validateProjectFileSource(
  reference: ProjectFileReferenceV1,
  targetSession: Session,
  workspace: Workspace,
): Promise<void> {
  if (reference.projectId !== targetSession.projectId) {
    throw projectNoteError('PROJECT_NOTE_SOURCE_INVALID', 'Project File reference is outside the target Project')
  }
  try {
    const rootPath = await resolveProjectWorkingDirectory(workspace.rootPath, reference.projectId)
    const kind = classifyProjectFile(reference.relativePath)
    const source = kind === 'epub' || kind === 'pdf'
      ? await readProjectFileBinaryWithinRoot(rootPath, reference)
      : await readProjectTextFileWithinRoot(rootPath, reference)
    if (source.sourceFingerprint !== reference.sourceFingerprint) {
      throw projectNoteError('PROJECT_NOTE_SOURCE_CHANGED', 'Project File changed after selection')
    }
  } catch (error) {
    if (error instanceof CodedError && error.code === 'PROJECT_NOTE_SOURCE_CHANGED') throw error
    throw projectNoteError('PROJECT_NOTE_SOURCE_INVALID', 'Project File reference source is unavailable')
  }
}

async function validateSource(
  reference: Reference,
  targetSession: Session,
  workspace: Workspace,
  deps: HandlerDeps,
): Promise<void> {
  if (reference.projectId !== targetSession.projectId) {
    throw projectNoteError('PROJECT_NOTE_SOURCE_INVALID', 'Reference is outside the target Project')
  }
  if (reference.kind === 'chat-message') {
    await validateChatSource(reference, targetSession, deps)
  } else {
    await validateProjectFileSource(reference, targetSession, workspace)
  }
}

function rootFingerprint(rootPath: string): string {
  return createHash('sha256').update(rootPath).digest('hex')
}

function expectedTarget(
  session: Session,
  projectId: string,
  expectedPath: string,
  expectedRootFingerprint: string,
): string {
  if (session.projectId !== projectId) {
    throw projectNoteError('PROJECT_NOTE_SESSION_PROJECT_CHANGED', 'Session Project changed')
  }
  if (!session.projectNoteTargetPath) {
    throw projectNoteError('PROJECT_NOTE_TARGET_REQUIRED', 'Choose a note target for this Session')
  }
  if (
    session.projectNoteTargetPath !== expectedPath
    || session.projectNoteTargetRootFingerprint !== expectedRootFingerprint
  ) {
    throw projectNoteError('PROJECT_NOTE_TARGET_CHANGED', 'Note target changed before writing')
  }
  return expectedPath
}

const sessionQueues = new Map<string, Promise<void>>()

async function withSessionQueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve()
  const result = previous.catch(() => {}).then(operation)
  const settled = result.then(() => {}, () => {})
  sessionQueues.set(sessionId, settled)
  void settled.finally(() => {
    if (sessionQueues.get(sessionId) === settled) sessionQueues.delete(sessionId)
  })
  return result
}

function appendSignature(request: AppendProjectNoteRequest): string {
  return createHash('sha256').update(JSON.stringify({
    sessionId: request.sessionId,
    projectId: request.projectId,
    expectedTargetPath: request.expectedTargetPath,
    selection: request.selection,
  })).digest('hex')
}

export function registerProjectNoteHandlers(server: RpcServer, deps: HandlerDeps): void {
  const idempotency = new Map<string, {
    signature: string
    promise: Promise<AppendProjectNoteResponse>
    settled: boolean
  }>()

  server.handle(
    RPC_CHANNELS.projectNotes.CONFIGURE_TARGET,
    async (context, rawRequest: unknown): Promise<ConfigureProjectNoteTargetResponse> => {
      const request = configureRequest(rawRequest)
      return withSessionQueue(request.sessionId, async () => {
        const { session, workspace } = await authorizedSession(context, deps, request.sessionId)
        if (session.projectId !== request.projectId) {
          throw projectNoteError('PROJECT_NOTE_SESSION_PROJECT_CHANGED', 'Session belongs to a different Project')
        }

        let fingerprint: string | null = null
        if (request.relativePath) {
          const rootPath = await resolveProjectWorkingDirectory(workspace.rootPath, request.projectId)
          await ensureProjectNoteTarget(rootPath, request.relativePath)
          fingerprint = rootFingerprint(rootPath)
        }
        const configured = await deps.sessionManager.setSessionProjectNoteTarget(
          session.id,
          request.projectId,
          request.relativePath,
          fingerprint,
        )
        if (!configured) {
          throw projectNoteError('PROJECT_NOTE_TARGET_CHANGED', 'Note target changed while configuring')
        }
        if (request.relativePath && fingerprint) {
          try {
            const latestRoot = await resolveProjectWorkingDirectory(workspace.rootPath, request.projectId)
            if (rootFingerprint(latestRoot) !== fingerprint) {
              throw projectNoteError('PROJECT_NOTE_TARGET_CHANGED', 'Project root changed while configuring')
            }
          } catch (error) {
            await deps.sessionManager.clearSessionProjectNoteTargetIfMatches(
              session.id,
              request.projectId,
              request.relativePath,
              fingerprint,
            )
            throw error
          }
        }
        return { projectId: request.projectId, ...configured }
      })
    },
  )

  server.handle(
    RPC_CHANNELS.projectNotes.APPEND,
    async (context, rawRequest: unknown): Promise<AppendProjectNoteResponse> => {
      const request = appendRequest(rawRequest)
      const { workspace: requestWorkspace } = await authorizedSession(
        context,
        deps,
        request.sessionId,
      )
      const idempotencyKey = `${requestWorkspace.id}\0${request.requestId}`
      const signature = appendSignature(request)
      const cached = idempotency.get(idempotencyKey)
      if (cached) {
        if (cached.signature !== signature) {
          throw projectNoteError('PROJECT_NOTE_REQUEST_CONFLICT', 'Request id was reused for a different note')
        }
        return cached.promise
      }

      const promise = withSessionQueue(request.sessionId, async () => {
        const { session, workspace } = await authorizedSession(context, deps, request.sessionId)
        await validateSource(request.selection, session, workspace, deps)
        const rootPath = await resolveProjectWorkingDirectory(workspace.rootPath, request.projectId)
        const targetPath = expectedTarget(
          session,
          request.projectId,
          request.expectedTargetPath,
          rootFingerprint(rootPath),
        )
        await appendProjectNoteWithinRoot(
          rootPath,
          targetPath,
          serializeProjectNote(request.selection, session),
        )
        return {
          projectId: request.projectId,
          relativePath: targetPath,
          appendedAt: new Date().toISOString(),
        }
      })
      const entry = { signature, promise, settled: false }
      idempotency.set(idempotencyKey, entry)
      void promise.finally(() => {
        entry.settled = true
        if (idempotency.size <= 512) return
        for (const [requestId, candidate] of idempotency) {
          if (!candidate.settled) continue
          idempotency.delete(requestId)
          if (idempotency.size <= 512) break
        }
      }).catch(() => {})
      try {
        return await promise
      } catch (error) {
        if (idempotency.get(idempotencyKey)?.promise === promise) {
          idempotency.delete(idempotencyKey)
        }
        throw error
      }
    },
  )
}
