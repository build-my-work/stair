import {
  isCanonicalProjectRelativePath,
  isSourceFingerprint,
  type EpubStateMutation,
  type PdfStateMutation,
  type SourceFingerprint,
} from '@craft-agent/shared/project-files'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadProjectById } from '@craft-agent/shared/projects'
import {
  RPC_CHANNELS,
  type ApplyEpubStateMutationRequest,
  type ApplyPdfStateMutationRequest,
  type ErrorCode,
  type ReaderStateRequest,
} from '@craft-agent/shared/protocol'
import {
  epubStateStore,
  normalizeEpubStateMutation,
} from '../../project-files/epub-state'
import {
  normalizePdfStateMutation,
  pdfStateStore,
} from '../../project-files/pdf-state'
import type { RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projectFiles.GET_EPUB_STATE,
  RPC_CHANNELS.projectFiles.APPLY_EPUB_STATE_MUTATION,
  RPC_CHANNELS.projectFiles.GET_PDF_STATE,
  RPC_CHANNELS.projectFiles.APPLY_PDF_STATE_MUTATION,
] as const

function readerStateError(code: Extract<ErrorCode, `PROJECT_FILE_${string}`>, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function validateIdentity(
  value: unknown,
  expectedExtension: '.epub' | '.pdf',
): ReaderStateRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw readerStateError('PROJECT_FILE_INVALID_REQUEST', 'Reader state request is required')
  }
  const candidate = value as Partial<ReaderStateRequest>
  if (
    typeof candidate.projectId !== 'string'
    || !candidate.projectId
    || candidate.projectId !== candidate.projectId.trim()
    || candidate.projectId.includes('\0')
    || Buffer.byteLength(candidate.projectId, 'utf8') > 256
    || !isCanonicalProjectRelativePath(candidate.relativePath)
    || !candidate.relativePath.toLowerCase().endsWith(expectedExtension)
    || !isSourceFingerprint(candidate.sourceFingerprint)
  ) {
    throw readerStateError('PROJECT_FILE_INVALID_REQUEST', 'Invalid Reader state identity')
  }
  return {
    projectId: candidate.projectId,
    relativePath: candidate.relativePath,
    sourceFingerprint: candidate.sourceFingerprint,
  }
}

function resolveWorkspaceRoot(context: RequestContext, deps: HandlerDeps): string {
  const workspaceId = context.workspaceId
    ?? (context.webContentsId == null
      ? null
      : deps.windowManager?.getWorkspaceForWindow(context.webContentsId))
  if (!workspaceId) {
    throw readerStateError('PROJECT_FILE_NO_WORKSPACE', 'No active Workspace is associated with this request')
  }
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw readerStateError('PROJECT_FILE_NO_WORKSPACE', 'Active Workspace is unavailable')
  }
  return workspace.rootPath
}

function resolveReaderStateRoot(
  context: RequestContext,
  deps: HandlerDeps,
  projectId: string,
): string {
  const rootPath = resolveWorkspaceRoot(context, deps)
  if (!loadProjectById(rootPath, projectId)) {
    throw readerStateError(
      'PROJECT_FILE_NOT_FOUND',
      'Project is unavailable in the active Workspace',
    )
  }
  return rootPath
}

function normalizeEpubMutation(value: unknown): EpubStateMutation {
  try {
    return normalizeEpubStateMutation(value)
  } catch (error) {
    throw readerStateError(
      'PROJECT_FILE_INVALID_REQUEST',
      error instanceof Error ? error.message : 'Invalid EPUB state mutation',
    )
  }
}

function normalizePdfMutation(value: unknown): PdfStateMutation {
  try {
    return normalizePdfStateMutation(value)
  } catch (error) {
    throw readerStateError(
      'PROJECT_FILE_INVALID_REQUEST',
      error instanceof Error ? error.message : 'Invalid PDF state mutation',
    )
  }
}

async function mapReaderStateError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.endsWith('_LIMIT_EXCEEDED') || message.endsWith('_STATE_TOO_LARGE')) {
      throw readerStateError('PROJECT_FILE_TOO_LARGE', message)
    }
    throw error
  }
}

export function registerReaderStateHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.projectFiles.GET_EPUB_STATE, async (context, rawRequest) => {
    const identity = validateIdentity(rawRequest, '.epub')
    return epubStateStore.get(resolveReaderStateRoot(context, deps, identity.projectId), identity)
  })
  server.handle(RPC_CHANNELS.projectFiles.APPLY_EPUB_STATE_MUTATION, async (context, rawRequest) => {
    const request = rawRequest as Partial<ApplyEpubStateMutationRequest>
    const identity = validateIdentity(rawRequest, '.epub')
    const mutation = normalizeEpubMutation(request.mutation)
    return mapReaderStateError(() => epubStateStore.apply(
      resolveReaderStateRoot(context, deps, identity.projectId),
      identity,
      mutation,
    ))
  })
  server.handle(RPC_CHANNELS.projectFiles.GET_PDF_STATE, async (context, rawRequest) => {
    const identity = validateIdentity(rawRequest, '.pdf')
    return pdfStateStore.get(resolveReaderStateRoot(context, deps, identity.projectId), identity)
  })
  server.handle(RPC_CHANNELS.projectFiles.APPLY_PDF_STATE_MUTATION, async (context, rawRequest) => {
    const request = rawRequest as Partial<ApplyPdfStateMutationRequest>
    const identity = validateIdentity(rawRequest, '.pdf')
    const mutation = normalizePdfMutation(request.mutation)
    return mapReaderStateError(() => pdfStateStore.apply(
      resolveReaderStateRoot(context, deps, identity.projectId),
      identity,
      mutation,
    ))
  })
}
