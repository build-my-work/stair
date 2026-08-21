import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as config from '@craft-agent/shared/config'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSettingsHandlers } from './settings'

const restores: Array<() => void> = []

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

function context(workspaceId: string): RequestContext {
  return { clientId: `client-${workspaceId}`, workspaceId, webContentsId: null }
}

describe('Draft RPC Workspace 授权', () => {
  it('GET、SET、DELETE 和 GET_ALL 都以当前 RPC Workspace 为边界', async () => {
    const drafts: Record<string, config.SessionDraft> = {
      'session-a': { text: 'workspace a' },
      'session-b': { text: 'workspace b' },
      stale: { text: 'stale' },
    }
    const sessions = [
      { id: 'session-a', workspaceId: 'workspace-a' },
      { id: 'session-b', workspaceId: 'workspace-b' },
    ]
    const getDraft = spyOn(config, 'getSessionDraft').mockImplementation(sessionId => drafts[sessionId] ?? null)
    const getAllDrafts = spyOn(config, 'getAllSessionDrafts').mockImplementation(() => ({ ...drafts }))
    const setDraft = spyOn(config, 'setSessionDraft').mockImplementation((sessionId, draft) => {
      drafts[sessionId] = draft
    })
    const deleteDraft = spyOn(config, 'deleteSessionDraft').mockImplementation((sessionId) => {
      delete drafts[sessionId]
    })
    restores.push(
      () => getDraft.mockRestore(),
      () => getAllDrafts.mockRestore(),
      () => setDraft.mockRestore(),
      () => deleteDraft.mockRestore(),
    )

    const handlers = new Map<string, HandlerFn>()
    const server = {
      handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler),
      push: () => {},
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    } as RpcServer
    const getSessions = mock((workspaceId?: string) => (
      sessions.filter(session => !workspaceId || session.workspaceId === workspaceId)
    ))
    registerSettingsHandlers(server, {
      sessionManager: { getSessions },
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps)

    const get = handlers.get(RPC_CHANNELS.drafts.GET)!
    const set = handlers.get(RPC_CHANNELS.drafts.SET)!
    const remove = handlers.get(RPC_CHANNELS.drafts.DELETE)!
    const getAll = handlers.get(RPC_CHANNELS.drafts.GET_ALL)!
    const workspaceA = context('workspace-a')
    const workspaceB = context('workspace-b')

    expect(await get(workspaceA, 'session-a')).toEqual({ text: 'workspace a' })
    await expect(get(workspaceA, 'session-b')).rejects.toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)
    await expect(set(workspaceA, 'session-b', { text: 'cross write' }))
      .rejects.toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)
    await expect(remove(workspaceA, 'session-b'))
      .rejects.toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)

    await set(workspaceA, 'session-a', { text: 'updated' })
    expect(await get(workspaceA, 'session-a')).toEqual({ text: 'updated' })
    expect(await getAll(workspaceA)).toEqual({ 'session-a': { text: 'updated' } })
    expect(await getAll(workspaceB)).toEqual({ 'session-b': { text: 'workspace b' } })
    expect(getSessions).toHaveBeenCalledWith('workspace-a')
    expect(getSessions).toHaveBeenCalledWith('workspace-b')
  })
})
