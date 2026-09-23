import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSessionsHandlers } from './sessions'

describe('Session existence RPC', () => {
  it('checks a batch against authoritative metadata without loading messages', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const hasSession = mock((sessionId: string, workspaceId?: string) => (
      workspaceId === 'workspace-a' && sessionId === 'existing'
    ))
    const getSession = mock(async () => null)
    const server = {
      handle: (channel: string, handler: (...args: any[]) => unknown) => {
        handlers.set(channel, handler)
      },
      push: () => {},
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    } as unknown as RpcServer

    registerSessionsHandlers(server, {
      sessionManager: {
        waitForInit: async () => {},
        hasSession,
        getSession,
      },
      platform: { logger: console },
      oauthFlowStore: {},
    } as unknown as HandlerDeps)

    const handler = handlers.get(RPC_CHANNELS.sessions.GET_EXISTING_IDS)!
    await expect(handler(
      { clientId: 'client', workspaceId: 'workspace-a', webContentsId: null },
      ['existing', 'deleted'],
    )).resolves.toEqual(['existing'])
    expect(hasSession).toHaveBeenCalledTimes(2)
    expect(getSession).not.toHaveBeenCalled()
  })
})
