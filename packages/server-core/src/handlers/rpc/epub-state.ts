import {
  isSourceFingerprint,
  type EpubStateMutation,
} from '@craft-agent/core/types'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  RPC_CHANNELS,
  type ApplyEpubStateMutationRequest,
  type EpubStateRequest,
} from '@craft-agent/shared/protocol'
import {
  epubStateStore,
  normalizeEpubStateMutation,
  type EpubStateIdentity,
} from '../../project-files/epub-state'
import type { RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { canonicalizeProjectFileRelativePath } from './project-files'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projectFiles.GET_EPUB_STATE,
  RPC_CHANNELS.projectFiles.APPLY_EPUB_STATE_MUTATION,
] as const

function epubStateError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`)
}

function validateIdentity(value: unknown): EpubStateIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw epubStateError('EPUB_STATE_INVALID_REQUEST', 'EPUB state request is required')
  }
  const candidate = value as Partial<EpubStateRequest>
  if (
    typeof candidate.projectId !== 'string'
    || !candidate.projectId
    || candidate.projectId !== candidate.projectId.trim()
    || candidate.projectId.includes('\0')
    || Buffer.byteLength(candidate.projectId, 'utf8') > 256
  ) {
    throw epubStateError('EPUB_STATE_INVALID_REQUEST', 'Invalid Project id')
  }
  if (!isSourceFingerprint(candidate.sourceFingerprint)) {
    throw epubStateError('EPUB_STATE_INVALID_REQUEST', 'Invalid source fingerprint')
  }
  return {
    projectId: candidate.projectId,
    relativePath: canonicalizeProjectFileRelativePath(candidate.relativePath),
    sourceFingerprint: candidate.sourceFingerprint,
  }
}

function validateMutationRequest(value: unknown): {
  identity: EpubStateIdentity
  mutation: EpubStateMutation
} {
  const identity = validateIdentity(value)
  const rawMutation = (value as Partial<ApplyEpubStateMutationRequest>).mutation
  let mutation: EpubStateMutation
  try {
    mutation = normalizeEpubStateMutation(rawMutation)
  } catch (error) {
    throw epubStateError(
      'EPUB_STATE_INVALID_REQUEST',
      error instanceof Error ? error.message : 'Invalid EPUB state mutation',
    )
  }
  return { identity, mutation }
}

function resolveWorkspaceRoot(ctx: RequestContext, deps: HandlerDeps): string {
  const workspaceId = ctx.workspaceId
    ?? (ctx.webContentsId == null
      ? null
      : deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId))
  if (!workspaceId) {
    throw epubStateError(
      'EPUB_STATE_NO_WORKSPACE',
      'No active workspace is associated with this request',
    )
  }
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw epubStateError('EPUB_STATE_NO_WORKSPACE', 'Active workspace is unavailable')
  }
  return workspace.rootPath
}

export function registerEpubStateHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.projectFiles.GET_EPUB_STATE,
    async (ctx, rawRequest: unknown) => {
      const identity = validateIdentity(rawRequest)
      return epubStateStore.get(resolveWorkspaceRoot(ctx, deps), identity)
    },
  )

  server.handle(
    RPC_CHANNELS.projectFiles.APPLY_EPUB_STATE_MUTATION,
    async (ctx, rawRequest: unknown) => {
      const { identity, mutation } = validateMutationRequest(rawRequest)
      return epubStateStore.apply(resolveWorkspaceRoot(ctx, deps), identity, mutation)
    },
  )
}
