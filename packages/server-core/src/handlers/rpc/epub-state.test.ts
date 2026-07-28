import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type {
  HandlerFn,
  RequestContext,
  RpcServer,
} from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import {
  HANDLED_CHANNELS,
  registerEpubStateHandlers,
} from './epub-state'

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    },
    push: () => {},
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  }
  const deps = {
    sessionManager: {},
    oauthFlowStore: {},
    platform: {},
  } as HandlerDeps
  registerEpubStateHandlers(server, deps)
  const ctx: RequestContext = {
    clientId: 'test',
    workspaceId: null,
    webContentsId: null,
  }
  return { handlers, ctx }
}

describe('EPUB state RPC', () => {
  it('registers only the two incremental state channels', () => {
    expect(HANDLED_CHANNELS).toEqual([
      'projectFiles:getEpubState',
      'projectFiles:applyEpubStateMutation',
    ])
  })

  it('rejects malformed identity before workspace resolution', async () => {
    const { handlers, ctx } = createHarness()
    const get = handlers.get(RPC_CHANNELS.projectFiles.GET_EPUB_STATE)!

    await expect(get(ctx, {
      projectId: 'project-1',
      relativePath: '../book.epub',
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    })).rejects.toThrow(/^PROJECT_FILE_INVALID_REQUEST:/)
    await expect(get(ctx, {
      projectId: 'project-1',
      relativePath: 'book.epub',
      sourceFingerprint: 'mtime:1',
    })).rejects.toThrow(/^EPUB_STATE_INVALID_REQUEST:/)
  })

  it('rejects full-state and unknown mutations', async () => {
    const { handlers, ctx } = createHarness()
    const apply = handlers.get(RPC_CHANNELS.projectFiles.APPLY_EPUB_STATE_MUTATION)!
    const identity = {
      projectId: 'project-1',
      relativePath: 'book.epub',
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    }

    await expect(apply(ctx, { ...identity, mutation: undefined }))
      .rejects.toThrow(/^EPUB_STATE_INVALID_REQUEST:/)
    await expect(apply(ctx, { ...identity, mutation: { type: 'replace-state' } }))
      .rejects.toThrow(/^EPUB_STATE_INVALID_REQUEST:/)
  })
})
