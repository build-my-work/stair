import { describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'

const workspace = {
  id: 'ws-main',
  name: 'Workspace',
  rootPath: '/tmp/craft-side-chat-workspace',
  createdAt: 1,
}

function installManagedSession(
  manager: SessionManager,
  source: Record<string, unknown>,
): void {
  const managed = createManagedSession(source as never, workspace as never, {
    messagesLoaded: true,
    messages: (source.messages as never[]) ?? [],
  })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(source.id as string, managed)
}

describe('SessionManager side chats', () => {
  it('creates a trusted independent session inheriting the main session runtime configuration', async () => {
    const manager = new SessionManager()
    installManagedSession(manager, {
      id: 'main',
      projectId: 'project-1',
      workingDirectory: '/tmp/operating-systems',
      model: 'glm-4.5',
      llmConnection: 'zhipu',
      permissionMode: 'allow-all',
      thinkingLevel: 'high',
      enabledSourceSlugs: ['books'],
      messages: [{ id: 'message-42', role: 'user', content: 'Explain paging', timestamp: 1 }],
    })

    let call: { workspaceId: string; options: Record<string, unknown>; internal: Record<string, unknown> } | undefined
    manager.createSession = (async (workspaceId, options, internal) => {
      call = { workspaceId, options: options as Record<string, unknown>, internal: internal as Record<string, unknown> }
      return {
        id: 'side', workspaceId, workspaceName: 'Workspace', lastMessageAt: 1,
        messages: [], isProcessing: false,
      }
    }) as typeof manager.createSession

    const created = await manager.createSideChat('main', 'message-42')

    expect(created.id).toBe('side')
    expect(call).toEqual({
      workspaceId: 'ws-main',
      options: {
        name: 'Side chat',
        projectId: 'project-1',
        workingDirectory: '/tmp/operating-systems',
        model: 'glm-4.5',
        llmConnection: 'zhipu',
        permissionMode: 'allow-all',
        thinkingLevel: 'high',
        enabledSourceSlugs: ['books'],
      },
      internal: {
        sideChatForSessionId: 'main',
        originMessageId: 'message-42',
      },
    })
  })

  it('preserves an explicit no-working-directory main session', async () => {
    const manager = new SessionManager()
    installManagedSession(manager, { id: 'main', workingDirectoryMode: 'none' })

    let workingDirectory: unknown
    manager.createSession = (async (_workspaceId, options) => {
      workingDirectory = options?.workingDirectory
      return {
        id: 'side', workspaceId: 'ws-main', workspaceName: 'Workspace', lastMessageAt: 1,
        messages: [], isProcessing: false,
      }
    }) as typeof manager.createSession

    await manager.createSideChat('main')
    expect(workingDirectory).toBe('none')
  })

  it('lets createSession resolve the Project working directory when the main session has no cwd snapshot', async () => {
    const manager = new SessionManager()
    installManagedSession(manager, { id: 'main', projectId: 'project-1' })

    let workingDirectory: unknown = 'not-called'
    manager.createSession = (async (_workspaceId, options) => {
      workingDirectory = options?.workingDirectory
      return {
        id: 'side', workspaceId: 'ws-main', workspaceName: 'Workspace', lastMessageAt: 1,
        messages: [], isProcessing: false,
      }
    }) as typeof manager.createSession

    await manager.createSideChat('main')
    expect(workingDirectory).toBeUndefined()
  })

  it('rejects missing, nested, and invalid-origin side chats', async () => {
    const manager = new SessionManager()
    installManagedSession(manager, { id: 'main', messages: [] })
    installManagedSession(manager, { id: 'nested', sideChatForSessionId: 'main' })

    await expect(manager.createSideChat('missing')).rejects.toThrow('not found')
    await expect(manager.createSideChat('nested')).rejects.toThrow('cannot be created from another side chat')
    await expect(manager.createSideChat('main', 'missing-message')).rejects.toThrow('does not belong to main session')
  })

  it('tracks multiple simultaneously visible sessions independently', () => {
    const manager = new SessionManager()

    manager.setActiveViewingSession('main', 'ws-main', true)
    manager.setActiveViewingSession('side', 'ws-main', true)

    expect((manager as any).isSessionBeingViewed('main', 'ws-main')).toBe(true)
    expect((manager as any).isSessionBeingViewed('side', 'ws-main')).toBe(true)

    manager.setActiveViewingSession('side', 'ws-main', false)

    expect((manager as any).isSessionBeingViewed('main', 'ws-main')).toBe(true)
    expect((manager as any).isSessionBeingViewed('side', 'ws-main')).toBe(false)
  })

  it('deletes associated side chats with their main session but leaves unrelated sessions intact', async () => {
    const manager = new SessionManager()
    installManagedSession(manager, { id: 'main' })
    installManagedSession(manager, { id: 'side-a', sideChatForSessionId: 'main' })
    installManagedSession(manager, { id: 'side-b', sideChatForSessionId: 'main' })
    installManagedSession(manager, { id: 'other' })

    await manager.deleteSession('main')

    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions
    expect(sessions.has('main')).toBe(false)
    expect(sessions.has('side-a')).toBe(false)
    expect(sessions.has('side-b')).toBe(false)
    expect(sessions.has('other')).toBe(true)
  })
})
