import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as config from '@craft-agent/shared/config'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { registerReaderStateHandlers } from './reader-state'

const fingerprint = `sha256:${'a'.repeat(64)}`

describe('Reader State RPC 类型边界', () => {
  it('EPUB 与 PDF 状态接口分别拒绝另一种文件类型', async () => {
    const handlers = new Map<string, HandlerFn>()
    const server: RpcServer = {
      handle: (channel, handler) => handlers.set(channel, handler),
      push: () => undefined,
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }
    registerReaderStateHandlers(server, {
      sessionManager: {},
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps)
    const context = {
      clientId: 'renderer',
      workspaceId: null,
      webContentsId: null,
    }

    await expect(handlers.get(RPC_CHANNELS.projectFiles.GET_EPUB_STATE)!(context, {
      projectId: 'project',
      relativePath: 'paper.pdf',
      sourceFingerprint: fingerprint,
    })).rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
    await expect(handlers.get(RPC_CHANNELS.projectFiles.GET_PDF_STATE)!(context, {
      projectId: 'project',
      relativePath: 'book.epub',
      sourceFingerprint: fingerprint,
    })).rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
  })

  it('把 active Workspace 中不存在的 Project 映射为稳定错误码', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'reader-state-rpc-'))
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue({
      id: 'workspace',
      name: 'Workspace',
      rootPath,
    } as never)
    const handlers = new Map<string, HandlerFn>()
    registerReaderStateHandlers({
      handle: (channel, handler) => handlers.set(channel, handler),
      push: () => undefined,
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }, {
      sessionManager: {},
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps)

    try {
      await expect(handlers.get(RPC_CHANNELS.projectFiles.GET_EPUB_STATE)!({
        clientId: 'renderer',
        workspaceId: 'workspace',
        webContentsId: null,
      }, {
        projectId: 'missing',
        relativePath: 'book.epub',
        sourceFingerprint: fingerprint,
      })).rejects.toMatchObject({ code: 'PROJECT_FILE_NOT_FOUND' })
    } finally {
      lookup.mockRestore()
      rmSync(rootPath, { recursive: true, force: true })
    }
  })
})
