import {
  isSourceFingerprint,
  type PdfStateMutation,
} from '@craft-agent/core/types'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  RPC_CHANNELS,
  type ApplyPdfStateMutationRequest,
  type PdfStateRequest,
} from '@craft-agent/shared/protocol'
import {
  normalizePdfStateMutation,
  pdfStateStore,
  type PdfStateIdentity,
} from '../../project-files/pdf-state'
import type { RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { canonicalizeProjectFileRelativePath } from './project-files'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projectFiles.GET_PDF_STATE,
  RPC_CHANNELS.projectFiles.APPLY_PDF_STATE_MUTATION,
] as const

function pdfStateError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`)
}

function validateIdentity(value: unknown): PdfStateIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw pdfStateError('PDF_STATE_INVALID_REQUEST', 'PDF state request is required')
  }
  const candidate = value as Partial<PdfStateRequest>
  if (
    typeof candidate.projectId !== 'string'
    || !candidate.projectId
    || candidate.projectId !== candidate.projectId.trim()
    || candidate.projectId.includes('\0')
    || Buffer.byteLength(candidate.projectId, 'utf8') > 256
  ) {
    throw pdfStateError('PDF_STATE_INVALID_REQUEST', 'Invalid Project id')
  }
  if (!isSourceFingerprint(candidate.sourceFingerprint)) {
    throw pdfStateError('PDF_STATE_INVALID_REQUEST', 'Invalid source fingerprint')
  }
  return {
    projectId: candidate.projectId,
    relativePath: canonicalizeProjectFileRelativePath(candidate.relativePath),
    sourceFingerprint: candidate.sourceFingerprint,
  }
}

function validateMutationRequest(value: unknown): {
  identity: PdfStateIdentity
  mutation: PdfStateMutation
} {
  const identity = validateIdentity(value)
  const rawMutation = (value as Partial<ApplyPdfStateMutationRequest>).mutation
  let mutation: PdfStateMutation
  try {
    mutation = normalizePdfStateMutation(rawMutation)
  } catch (error) {
    throw pdfStateError(
      'PDF_STATE_INVALID_REQUEST',
      error instanceof Error ? error.message : 'Invalid PDF state mutation',
    )
  }
  return { identity, mutation }
}

function resolveWorkspaceRoot(ctx: RequestContext, deps: HandlerDeps): string {
  let workspaceId = ctx.workspaceId
  if (workspaceId == null && ctx.webContentsId != null) {
    workspaceId = deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) ?? null
  }
  if (!workspaceId) {
    throw pdfStateError(
      'PDF_STATE_NO_WORKSPACE',
      'No active workspace is associated with this request',
    )
  }
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw pdfStateError('PDF_STATE_NO_WORKSPACE', 'Active workspace is unavailable')
  }
  return workspace.rootPath
}

export function registerPdfStateHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.projectFiles.GET_PDF_STATE,
    async (ctx, rawRequest: unknown) => {
      const identity = validateIdentity(rawRequest)
      return pdfStateStore.get(resolveWorkspaceRoot(ctx, deps), identity)
    },
  )

  server.handle(
    RPC_CHANNELS.projectFiles.APPLY_PDF_STATE_MUTATION,
    async (ctx, rawRequest: unknown) => {
      const { identity, mutation } = validateMutationRequest(rawRequest)
      return pdfStateStore.apply(resolveWorkspaceRoot(ctx, deps), identity, mutation)
    },
  )
}
