import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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
  getProjectPath,
  loadProjectById,
  withProjectMutationLock,
} from '@craft-agent/shared/projects'
import { atomicWriteFileSync, readJsonFileSync } from '@craft-agent/shared/utils'
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
  withProjectFileWriteQueue,
} from './project-files'
import {
  openProjectNoteFileWithinRoot,
  SecureProjectNoteOpenError,
  type SecureProjectNoteFile,
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
    sessionId: request.sessionId === null ? null : boundedId(request.sessionId, 'Session id'),
    projectId: boundedId(request.projectId, 'Project id'),
    relativePath: noteTargetPath(request.relativePath),
  }
}

function projectRootFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw projectNoteError('PROJECT_NOTE_INVALID_REQUEST', 'Invalid Project root fingerprint')
  }
  return value
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
    projectId: boundedId(request.projectId, 'Project id'),
    relativePath: noteTargetPath(request.relativePath),
    expectedProjectRootFingerprint: projectRootFingerprint(
      request.expectedProjectRootFingerprint,
    ),
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
): Promise<{ handle: SecureProjectNoteFile; bytes: Buffer }> {
  const canonicalPath = noteTargetPath(relativePath)
  let handle: SecureProjectNoteFile
  try {
    handle = await openProjectNoteFileWithinRoot(rootPath, canonicalPath)
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

interface PendingProjectNoteAppendReceipt {
  signature: string
  status: 'pending'
  targetPath: string
  rootFingerprint: string
  initialSize: number
  initialHash: string
  payloadBase64: string
  response: AppendProjectNoteResponse
}

interface CompleteProjectNoteAppendReceipt {
  signature: string
  status: 'complete'
  response: AppendProjectNoteResponse
}

type ProjectNoteAppendReceipt =
  | PendingProjectNoteAppendReceipt
  | CompleteProjectNoteAppendReceipt

interface ProjectNoteAppendReceipts {
  version: 1
  requests: Record<string, ProjectNoteAppendReceipt>
}

const MAX_COMPLETED_PROJECT_NOTE_RECEIPTS = 128

function loadProjectNoteAppendReceipts(filePath: string): ProjectNoteAppendReceipts {
  if (!existsSync(filePath)) return { version: 1, requests: {} }
  try {
    const value = readJsonFileSync<ProjectNoteAppendReceipts>(filePath)
    if (value.version !== 1 || !value.requests || typeof value.requests !== 'object') {
      throw new Error('invalid receipt document')
    }
    return value
  } catch {
    throw projectNoteError(
      'PROJECT_NOTE_REQUEST_RECOVERY_REQUIRED',
      'The durable Add Note request record could not be read safely',
    )
  }
}

function saveProjectNoteAppendReceipts(
  filePath: string,
  receipts: ProjectNoteAppendReceipts,
): void {
  const completedRequestIds = Object.entries(receipts.requests)
    .filter(([, receipt]) => receipt.status === 'complete')
    .map(([requestId]) => requestId)
  const retainedCompletedRequestIds = new Set(
    completedRequestIds.slice(-MAX_COMPLETED_PROJECT_NOTE_RECEIPTS),
  )
  const requests: Record<string, ProjectNoteAppendReceipt> = {}
  for (const [requestId, receipt] of Object.entries(receipts.requests)) {
    if (receipt.status === 'complete') {
      if (!retainedCompletedRequestIds.has(requestId)) continue
      requests[requestId] = {
        signature: receipt.signature,
        status: 'complete',
        response: receipt.response,
      }
    } else {
      requests[requestId] = receipt
    }
  }
  receipts.requests = requests
  mkdirSync(dirname(filePath), { recursive: true })
  atomicWriteFileSync(filePath, JSON.stringify(receipts, null, 2))
}

async function appendProjectNoteWithinRootOnce(
  rootPath: string,
  relativePath: string,
  entry: string,
  receiptFile: string,
  requestId: string,
  signature: string,
  response: AppendProjectNoteResponse,
): Promise<AppendProjectNoteResponse> {
  // rootPath was authorized by resolveProjectWorkingDirectory; do not follow a substituted root.
  const root = resolve(rootPath)
  const path = noteTargetPath(relativePath)
  // The Project lifecycle lock is held by APPEND; file writers never acquire it in reverse.
  return withProjectFileWriteQueue(root, path, async () => {
    const receipts = loadProjectNoteAppendReceipts(receiptFile)
    const existing = receipts.requests[requestId]
    if (existing?.signature !== undefined && existing.signature !== signature) {
      throw projectNoteError(
        'PROJECT_NOTE_REQUEST_CONFLICT',
        'Request id was reused for a different note',
      )
    }
    if (existing?.status === 'complete') return existing.response
    if (existing && (
      existing.targetPath !== path
      || existing.rootFingerprint !== rootFingerprint(root)
    )) {
      throw projectNoteError(
        'PROJECT_NOTE_REQUEST_RECOVERY_REQUIRED',
        'The Project or Note target changed during Add Note recovery',
      )
    }

    const { handle, bytes } = await openTarget(root, path)
    try {
      let receipt = existing
      let payload: Buffer
      if (receipt) {
        payload = Buffer.from(receipt.payloadBase64, 'base64')
        const prefix = bytes.subarray(0, receipt.initialSize)
        if (
          bytes.length < receipt.initialSize
          || createHash('sha256').update(prefix).digest('hex') !== receipt.initialHash
        ) {
          throw projectNoteError(
            'PROJECT_NOTE_REQUEST_RECOVERY_REQUIRED',
            'The Note changed before the pending Add Note request could be recovered',
          )
        }
        const appendedEnd = receipt.initialSize + payload.length
        if (
          bytes.length >= appendedEnd
          && bytes.subarray(receipt.initialSize, appendedEnd).equals(payload)
        ) {
          const completedReceipt: CompleteProjectNoteAppendReceipt = {
            signature: receipt.signature,
            status: 'complete',
            response: receipt.response,
          }
          delete receipts.requests[requestId]
          receipts.requests[requestId] = completedReceipt
          saveProjectNoteAppendReceipts(receiptFile, receipts)
          return completedReceipt.response
        }
        if (bytes.length !== receipt.initialSize) {
          throw projectNoteError(
            'PROJECT_NOTE_REQUEST_RECOVERY_REQUIRED',
            'The Note changed while the pending Add Note request was incomplete',
          )
        }
      } else {
        payload = Buffer.from(`${separatorBeforeAppend(bytes)}${entry}`, 'utf8')
        if (bytes.length + payload.length > MAX_PROJECT_FILE_TEXT_BYTES) {
          throw projectNoteError(
            'PROJECT_NOTE_TARGET_TOO_LARGE',
            'Appending would exceed the Project text limit',
          )
        }
        receipt = {
          signature,
          status: 'pending',
          targetPath: path,
          rootFingerprint: rootFingerprint(root),
          initialSize: bytes.length,
          initialHash: createHash('sha256').update(bytes).digest('hex'),
          payloadBase64: payload.toString('base64'),
          response,
        }
        receipts.requests[requestId] = receipt
        saveProjectNoteAppendReceipts(receiptFile, receipts)
      }

      await handle.append(payload)
      await handle.sync()
      const completedReceipt: CompleteProjectNoteAppendReceipt = {
        signature: receipt.signature,
        status: 'complete',
        response: receipt.response,
      }
      delete receipts.requests[requestId]
      receipts.requests[requestId] = completedReceipt
      saveProjectNoteAppendReceipts(receiptFile, receipts)
      return completedReceipt.response
    } finally {
      await handle.close()
    }
  })
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

function sourceLabel(
  reference: Reference,
  sourceSession?: Pick<Session, 'id' | 'name'>,
): string {
  if (reference.kind === 'chat-message') {
    if (!sourceSession) {
      throw projectNoteError('PROJECT_NOTE_SOURCE_INVALID', 'Chat reference source is unavailable')
    }
    const role = {
      assistant: 'Assistant',
      plan: 'Plan',
      user: 'User',
    }[reference.role]
    return `Chat · ${role} · ${inlineCode(sourceSession.name ?? sourceSession.id)}`
  }
  if (reference.kind === 'web-selection') {
    return `Web · ${escapeQuoteLine(reference.title.replace(/\s+/g, ' ').trim())} · ${inlineCode(reference.url)}`
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
  sourceSession?: Pick<Session, 'id' | 'name'>,
): string {
  const quote = reference.quote
    .trim()
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => `> ${escapeQuoteLine(line)}`)
  return [...quote, '>', `> — ${sourceLabel(reference, sourceSession)}`].join('\n') + '\n'
}

async function validateChatSource(
  reference: ChatMessageReferenceV1,
  projectId: string,
  workspace: Workspace,
  deps: HandlerDeps,
): Promise<Session> {
  const source = await deps.sessionManager.getSession(reference.sessionId)
  if (
    !source
    || source.workspaceId !== workspace.id
    || source.projectId !== projectId
  ) {
    throw projectNoteError('PROJECT_NOTE_SOURCE_INVALID', 'Chat reference is outside the target Project')
  }
  const message = source.messages.find(candidate => candidate.id === reference.messageId)
  if (!message || message.role !== reference.role) {
    throw projectNoteError('PROJECT_NOTE_SOURCE_INVALID', 'Chat reference source is unavailable')
  }
  return source
}

async function validateProjectFileSource(
  reference: ProjectFileReferenceV1,
  projectId: string,
  workspace: Workspace,
): Promise<void> {
  if (reference.projectId !== projectId) {
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
  projectId: string,
  workspace: Workspace,
  deps: HandlerDeps,
): Promise<Session | undefined> {
  if (reference.projectId !== projectId) {
    throw projectNoteError('PROJECT_NOTE_SOURCE_INVALID', 'Reference is outside the target Project')
  }
  if (reference.kind === 'chat-message') {
    return validateChatSource(reference, projectId, workspace, deps)
  } else if (reference.kind === 'project-file') {
    await validateProjectFileSource(reference, projectId, workspace)
  }
  return undefined
}

function rootFingerprint(rootPath: string): string {
  return createHash('sha256').update(rootPath).digest('hex')
}

function appendSignature(request: AppendProjectNoteRequest): string {
  return createHash('sha256').update(JSON.stringify({
    projectId: request.projectId,
    relativePath: request.relativePath,
    expectedProjectRootFingerprint: request.expectedProjectRootFingerprint,
    selection: request.selection,
  })).digest('hex')
}

export function registerProjectNoteHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.projectNotes.CONFIGURE_TARGET,
    async (context, rawRequest: unknown): Promise<ConfigureProjectNoteTargetResponse> => {
      const request = configureRequest(rawRequest)
      const workspace = authorizedWorkspace(context, deps)
      const rootPath = await resolveProjectWorkingDirectory(workspace.rootPath, request.projectId)
      await ensureProjectNoteTarget(rootPath, request.relativePath)
      const fingerprint = rootFingerprint(rootPath)
      let recentPaths: string[] = []
      const sessionId = request.sessionId
      if (sessionId) {
        await deps.sessionManager.withSessionLifecycleLock(sessionId, async () => {
          const session = await deps.sessionManager.getSession(sessionId)
          if (
            !session
            || session.workspaceId !== workspace.id
            || session.projectId !== request.projectId
          ) return
          const configured = await deps.sessionManager.setSessionProjectNoteTarget(
            session.id,
            request.projectId,
            request.relativePath,
          )
          if (configured) recentPaths = configured.recentPaths
        })
      }
      return {
        projectId: request.projectId,
        relativePath: request.relativePath,
        recentPaths,
        projectRootFingerprint: fingerprint,
      }
    },
  )

  server.handle(
    RPC_CHANNELS.projectNotes.APPEND,
    async (context, rawRequest: unknown): Promise<AppendProjectNoteResponse> => {
      const request = appendRequest(rawRequest)
      const signature = appendSignature(request)
      const workspace = authorizedWorkspace(context, deps)
      return withProjectMutationLock(workspace.rootPath, request.projectId, async () => {
        const project = loadProjectById(workspace.rootPath, request.projectId)
        if (!project) {
          throw projectNoteError('PROJECT_NOTE_SOURCE_INVALID', 'Project is unavailable in this Workspace')
        }
        const receiptFile = join(
          getProjectPath(workspace.rootPath, project.config.slug),
          'data',
          'project-note-requests.json',
        )
        const existing = loadProjectNoteAppendReceipts(receiptFile).requests[request.requestId]
        if (existing) {
          if (existing.signature !== signature) {
            throw projectNoteError(
              'PROJECT_NOTE_REQUEST_CONFLICT',
              'Request id was reused for a different note',
            )
          }
          if (existing.status === 'complete') return existing.response
        }

        const rootPath = await resolveProjectWorkingDirectory(workspace.rootPath, request.projectId)
        if (rootFingerprint(rootPath) !== request.expectedProjectRootFingerprint) {
          throw projectNoteError('PROJECT_NOTE_TARGET_CHANGED', 'Project root changed after choosing the Note')
        }
        if (existing) {
          return appendProjectNoteWithinRootOnce(
            rootPath,
            existing.targetPath,
            '',
            receiptFile,
            request.requestId,
            signature,
            existing.response,
          )
        }

        const sourceSession = await validateSource(
          request.selection,
          request.projectId,
          workspace,
          deps,
        )
        return appendProjectNoteWithinRootOnce(
          rootPath,
          request.relativePath,
          serializeProjectNote(request.selection, sourceSession),
          receiptFile,
          request.requestId,
          signature,
          {
            projectId: request.projectId,
            relativePath: request.relativePath,
            appendedAt: new Date().toISOString(),
          },
        )
      })
    },
  )
}
