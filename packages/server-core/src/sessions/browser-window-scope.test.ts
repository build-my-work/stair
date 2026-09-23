import { describe, expect, it, mock } from 'bun:test'

import type { BrowserInstanceInfo } from '@craft-agent/shared/protocol'
import { filterBrowserWindowsForChat, SessionManager } from './SessionManager'

function browser(id: string, overrides: Partial<BrowserInstanceInfo>): BrowserInstanceInfo {
  return {
    id,
    url: 'https://example.com',
    title: id,
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    targetSessionId: null,
    boundSessionId: null,
    ownerType: 'session',
    ownerSessionId: null,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
    workspaceId: null,
    projectId: null,
    ...overrides,
  }
}

describe('filterBrowserWindowsForChat', () => {
  it('keeps only windows owned by the exact Workspace, Project, and Chat', () => {
    const windows = [
      browser('owned', {
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        ownerSessionId: 'chat-a',
      }),
      browser('other-chat', {
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        ownerSessionId: 'chat-b',
      }),
      browser('other-project', {
        workspaceId: 'workspace-a',
        projectId: 'project-b',
        ownerSessionId: 'chat-a',
      }),
      browser('other-workspace', {
        workspaceId: 'workspace-b',
        projectId: 'project-a',
        ownerSessionId: 'chat-a',
      }),
    ]

    expect(filterBrowserWindowsForChat(windows, {
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      sessionId: 'chat-a',
    }).map(window => window.id)).toEqual(['owned'])
  })

  it('cleans the deleted Project on every Browser-capable remote Workspace client', async () => {
    const manager = new SessionManager()
    const invokeClient = mock(async () => {})
    manager.setRpcServer({
      handle: () => {},
      push: () => {},
      invokeClient,
      hasClientCapability: () => true,
      findClientsWithCapability: (_capability, options) => (
        options?.workspaceId === 'workspace-a' ? ['client-a', 'client-b'] : []
      ),
    })

    await manager.beginBrowserProjectDeletion('workspace-a', 'project-a')

    expect(invokeClient).toHaveBeenCalledTimes(2)
    for (const clientId of ['client-a', 'client-b']) {
      expect(invokeClient).toHaveBeenCalledWith(
        clientId,
        'client:browser:invoke',
        {
          v: 1,
          method: 'beginProjectDeletion',
          args: ['workspace-a', 'project-a'],
          sessionId: '__project_cleanup__',
          workspaceId: 'workspace-a',
        },
      )
    }
  })

  it('cleans the deleted Chat on every Browser-capable remote Workspace client', async () => {
    const manager = new SessionManager()
    const invokeClient = mock(async () => {})
    manager.setRpcServer({
      handle: () => {},
      push: () => {},
      invokeClient,
      hasClientCapability: () => true,
      findClientsWithCapability: (_capability, options) => (
        options?.workspaceId === 'workspace-a' ? ['client-a', 'client-b'] : []
      ),
    })

    await manager.destroyBrowserWindowsForSession('workspace-a', 'chat-a')

    expect(invokeClient).toHaveBeenCalledTimes(2)
    for (const clientId of ['client-a', 'client-b']) {
      expect(invokeClient).toHaveBeenCalledWith(
        clientId,
        'client:browser:invoke',
        {
          v: 1,
          method: 'destroyForSession',
          args: ['chat-a', 'workspace-a'],
          sessionId: 'chat-a',
          workspaceId: 'workspace-a',
        },
      )
    }
  })

  it('blocks Project deletion when one remote Browser client cannot be cleaned up', async () => {
    const manager = new SessionManager()
    let releaseSlowClient!: () => void
    let markSlowClientStarted!: () => void
    const slowClientStarted = new Promise<void>(resolve => { markSlowClientStarted = resolve })
    const slowClient = new Promise<void>(resolve => { releaseSlowClient = resolve })
    const invokeClient = mock(async (clientId: string) => {
      if (clientId === 'client-a') throw new Error('disconnected')
      markSlowClientStarted()
      await slowClient
    })
    manager.setRpcServer({
      handle: () => {},
      push: () => {},
      invokeClient,
      hasClientCapability: () => true,
      findClientsWithCapability: () => ['client-a', 'client-b'],
    })

    let rejected = false
    const deletion = manager.beginBrowserProjectDeletion('workspace-a', 'project-a')
    void deletion.catch(() => { rejected = true })
    await slowClientStarted
    await Bun.sleep(10)
    expect(rejected).toBe(false)

    releaseSlowClient()
    await expect(deletion).rejects.toThrow('disconnected')
    expect(invokeClient).toHaveBeenCalledTimes(2)
  })

  it('does not block Chat deletion when one remote Browser client disconnects', async () => {
    const manager = new SessionManager()
    const invokeClient = mock(async (clientId: string) => {
      if (clientId === 'client-a') throw new Error('disconnected')
    })
    manager.setRpcServer({
      handle: () => {},
      push: () => {},
      invokeClient,
      hasClientCapability: () => true,
      findClientsWithCapability: () => ['client-a', 'client-b'],
    })

    await expect(
      manager.destroyBrowserWindowsForSession('workspace-a', 'chat-a'),
    ).resolves.toBeUndefined()
    expect(invokeClient).toHaveBeenCalledTimes(2)
  })
})
