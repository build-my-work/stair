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
  it('所有 Draft 读写都以当前 RPC Workspace 为边界', async () => {
    const drafts: Record<string, config.SessionDraft> = {
      'session-a': { text: 'workspace a' },
      'session-b': { text: 'workspace b' },
      stale: { text: 'stale' },
    }
    const sessions = [
      { id: 'session-a', workspaceId: 'workspace-a', projectId: 'project-a' },
      { id: 'session-b', workspaceId: 'workspace-b', projectId: 'project-b' },
    ]
    const getDraft = spyOn(config, 'getSessionDraft').mockImplementation(sessionId => drafts[sessionId] ?? null)
    const getDraftHydration = spyOn(config, 'getSessionDraftHydrationState')
      .mockImplementation(() => ({
        drafts: { ...drafts },
        appliedRestoreIds: {
          'session-a': ['restore-a'],
          'session-b': ['restore-b'],
          stale: ['restore-stale'],
        },
      }))
    const setDraftContent = spyOn(config, 'setSessionDraftContent')
      .mockImplementation((sessionId, content) => {
        const next = { ...drafts[sessionId], ...content }
        drafts[sessionId] = next
        return next
      })
    const reconcileReferences = spyOn(config, 'reconcileSessionDraftReferences')
      .mockImplementation((sessionId, _projectId, _base, references) => {
        const next = { ...(drafts[sessionId] ?? { text: '' }), references }
        drafts[sessionId] = next
        return next
      })
    const deleteDraft = spyOn(config, 'deleteSessionDraft').mockImplementation((sessionId) => {
      delete drafts[sessionId]
    })
    const addReferenceAtomic = spyOn(config, 'addSessionDraftReferenceAtomic')
      .mockImplementation((_sessionId, _projectId, reference) => ({
        text: '',
        references: [reference],
      }))
    const restoreDraftAtomic = spyOn(config, 'restoreSessionDraftAtomic')
      .mockImplementation((_sessionId, _projectId, _restoreId, draft) => ({
        draft,
        applied: true,
      }))
    restores.push(
      () => getDraft.mockRestore(),
      () => getDraftHydration.mockRestore(),
      () => setDraftContent.mockRestore(),
      () => reconcileReferences.mockRestore(),
      () => deleteDraft.mockRestore(),
      () => addReferenceAtomic.mockRestore(),
      () => restoreDraftAtomic.mockRestore(),
    )

    const handlers = new Map<string, HandlerFn>()
    const pushes: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const server = {
      handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler),
      push: (channel: string, target: unknown, ...args: unknown[]) => {
        pushes.push({ channel, target, args })
      },
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
    const setContent = handlers.get(RPC_CHANNELS.drafts.SET_CONTENT)!
    const updateReferences = handlers.get(RPC_CHANNELS.drafts.UPDATE_REFERENCES)!
    const addReference = handlers.get(RPC_CHANNELS.drafts.ADD_REFERENCE)!
    const restoreInput = handlers.get(RPC_CHANNELS.drafts.RESTORE_INPUT)!
    const remove = handlers.get(RPC_CHANNELS.drafts.DELETE)!
    const getAll = handlers.get(RPC_CHANNELS.drafts.GET_ALL)!
    const workspaceA = context('workspace-a')
    const workspaceB = context('workspace-b')

    expect(await get(workspaceA, 'session-a')).toEqual({ text: 'workspace a' })
    await expect(get(workspaceA, 'session-b')).rejects.toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)
    await expect(setContent(workspaceA, 'session-b', { text: 'cross write' }))
      .rejects.toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)
    await expect(updateReferences(workspaceA, 'session-b', {
      baseReferences: [],
      nextReferences: [],
    })).rejects.toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)
    await expect(addReference(workspaceA, 'session-b', {
      version: 1,
      kind: 'web-selection',
      projectId: 'project-b',
      url: 'https://example.com',
      title: 'Example',
      quote: 'selection',
      locator: { type: 'web-text-quote', exact: 'selection' },
    })).rejects.toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)
    await expect(restoreInput(workspaceA, 'session-b', {
      restoreId: 'restore-cross-workspace',
      draft: { text: 'cross write' },
    })).rejects.toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)
    await expect(remove(workspaceA, 'session-b'))
      .rejects.toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)

    await setContent(workspaceA, 'session-a', { text: 'updated' })
    const reference = {
      version: 1 as const,
      kind: 'web-selection' as const,
      projectId: 'project-a',
      url: 'https://example.com',
      title: 'Example',
      quote: 'selection',
      locator: { type: 'web-text-quote' as const, exact: 'selection' },
    }
    await addReference(workspaceA, 'session-a', reference)
    expect(pushes).toContainEqual({
      channel: RPC_CHANNELS.drafts.REFERENCES_CHANGED,
      target: {
        to: 'workspace',
        workspaceId: 'workspace-a',
        exclude: 'client-workspace-a',
      },
      args: ['session-a', [reference]],
    })
    await expect(restoreInput(workspaceA, 'session-a', {
      restoreId: 'restore-1',
      draft: { text: 'queued' },
    })).resolves.toEqual({ draft: { text: 'queued' }, applied: true })
    expect(await get(workspaceA, 'session-a')).toEqual({ text: 'updated' })
    expect(await getAll(workspaceA)).toEqual({
      drafts: { 'session-a': { text: 'updated' } },
      appliedRestoreIds: { 'session-a': ['restore-a'] },
    })
    expect(await getAll(workspaceB)).toEqual({
      drafts: { 'session-b': { text: 'workspace b' } },
      appliedRestoreIds: { 'session-b': ['restore-b'] },
    })
    expect(getSessions).toHaveBeenCalledWith('workspace-a')
    expect(getSessions).toHaveBeenCalledWith('workspace-b')
  })
})
