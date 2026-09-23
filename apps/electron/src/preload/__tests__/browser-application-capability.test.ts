import { describe, expect, it, mock } from 'bun:test'

import { RPC_CHANNELS, type Session } from '@craft-agent/shared/protocol'
import type { RpcClient } from '@craft-agent/server-core/transport'
import { handleBrowserApplicationCapability } from '../browser-application-capability'

function session(id: string, projectId: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: 'remote-workspace',
    workspaceName: 'Remote Workspace',
    projectId,
    name: id,
    lastMessageAt: 1,
    messages: [],
    isProcessing: false,
    ...overrides,
  }
}

function makeClient(
  sessions: Session[] | (() => Session[] | Promise<Session[]>),
  project: unknown = { id: 'project-a' },
  projects: unknown[] = [],
) {
  const invoke = mock(async (channel: string) => {
    if (channel === RPC_CHANNELS.projects.GET) return projects
    if (channel === RPC_CHANNELS.projects.GET_ONE) return project
    if (channel === RPC_CHANNELS.sessions.GET) {
      return typeof sessions === 'function' ? sessions() : sessions
    }
    if (channel === RPC_CHANNELS.projectNotes.APPEND) return { appendedAt: 'now' }
    throw new Error(`Unexpected channel: ${channel}`)
  })
  return {
    client: {
      invoke,
      on: () => () => {},
      handleCapability: () => {},
    } as RpcClient,
    invoke,
  }
}

describe('Browser application capability', () => {
  it('reports whether the shared renderer selection flow is mounted', async () => {
    const { client } = makeClient([])
    const request = {
      v: 1 as const,
      action: 'get-application-readiness' as const,
      workspaceId: 'local-mirror-id',
    }

    await expect(handleBrowserApplicationCapability(client, request, null))
      .resolves.toEqual({ applicationReady: false })
    await expect(handleBrowserApplicationCapability(
      client,
      request,
      async () => ({ ok: true }),
      'local-mirror-id',
    )).resolves.toEqual({ applicationReady: true })
    await expect(handleBrowserApplicationCapability(
      client,
      request,
      async () => ({ ok: true }),
      'other-workspace',
    )).resolves.toEqual({ applicationReady: false })
  })

  it('returns only visible Chats from the requested remote Project', async () => {
    const { client } = makeClient([
      session('target', 'project-a'),
      session('other-project', 'project-b'),
      session('hidden', 'project-a', { hidden: true }),
      session('archived', 'project-a', { isArchived: true }),
    ])

    await expect(handleBrowserApplicationCapability(client, {
      v: 1,
      action: 'get-project-context',
      workspaceId: 'local-mirror-id',
      projectId: 'project-a',
    })).resolves.toEqual({
      projectExists: true,
      chatTargets: [{ id: 'target', title: 'target', noteTargetPath: null }],
    })
  })

  it('returns the Projects that a manual Browser can switch to', async () => {
    const { client } = makeClient([], undefined, [
      { config: { id: 'project-a', name: 'Project A' } },
      { config: { id: 'project-b', name: 'Project B' } },
    ])

    await expect(handleBrowserApplicationCapability(client, {
      v: 1,
      action: 'list-project-targets',
      workspaceId: 'local-mirror-id',
    })).resolves.toEqual({
      projectTargets: [
        { id: 'project-a', title: 'Project A' },
        { id: 'project-b', title: 'Project B' },
      ],
    })
  })

  it('includes only the requested live owner in its Project, without exposing other hidden Chats', async () => {
    const { client } = makeClient([
      session('visible', 'project-a'),
      session('owner', 'project-a', { hidden: true, isArchived: true }),
      session('other-hidden', 'project-a', { hidden: true }),
      session('foreign-owner', 'project-b', { hidden: true }),
    ])
    for (const includeOwnerSessionId of ['owner', 'deleted', 'foreign-owner']) {
      await expect(handleBrowserApplicationCapability(client, {
        v: 1,
        action: 'get-project-context',
        workspaceId: 'local-mirror-id',
        projectId: 'project-a',
        includeOwnerSessionId,
      })).resolves.toEqual({
        projectExists: true,
        chatTargets: [
          { id: 'visible', title: 'visible', noteTargetPath: null },
          ...(includeOwnerSessionId === 'owner'
            ? [{ id: 'owner', title: 'owner', noteTargetPath: null }]
            : []),
        ],
      })
    }
  })

  it('delegates Add Note to the shared renderer flow even without a current target', async () => {
    const { client, invoke } = makeClient([
      session('target', 'project-a'),
    ])
    const handleSelection = mock(async () => ({
      ok: true as const,
      noteTargetPath: 'notes/research.md',
    }))
    const source = {
      url: 'https://example.com/article',
      title: 'Article',
      quote: 'selected text',
      locator: {
        type: 'web-text-quote' as const,
        exact: 'selected text',
      },
    }

    await expect(handleBrowserApplicationCapability(client, {
      v: 1,
      action: 'add-selection-note',
      requestId: 'request-note',
      mode: 'current',
      workspaceId: 'local-mirror-id',
      projectId: 'project-a',
      sessionId: 'target',
      source,
    }, handleSelection, 'local-mirror-id')).resolves.toEqual({
      ok: true,
      noteTargetPath: 'notes/research.md',
      sessionId: 'target',
    })

    expect(handleSelection).toHaveBeenCalledWith(expect.objectContaining({
      action: 'add-selection-note',
      mode: 'current',
      sessionId: 'target',
    }))
    expect(invoke.mock.calls.some(([channel]) => channel === RPC_CHANNELS.projectNotes.APPEND))
      .toBe(false)
  })

  it('adds a Note without reading the optional Session list when no Chat is selected', async () => {
    let sessionReads = 0
    const { client } = makeClient(() => {
      sessionReads += 1
      throw new Error('Session list unavailable')
    })
    const handleSelection = mock(async () => ({
      ok: true as const,
      noteTargetPath: 'notes/research.md',
    }))

    await expect(handleBrowserApplicationCapability(client, {
      v: 1,
      action: 'add-selection-note',
      requestId: 'request-note-without-session-list',
      mode: 'current',
      workspaceId: 'local-mirror-id',
      projectId: 'project-a',
      sessionId: null,
      source: {
        url: 'https://example.com/article',
        title: 'Article',
        quote: 'selected text',
        locator: {
          type: 'web-text-quote',
          exact: 'selected text',
        },
      },
    }, handleSelection, 'local-mirror-id')).resolves.toEqual({
      ok: true,
      noteTargetPath: 'notes/research.md',
      sessionId: null,
    })
    expect(sessionReads).toBe(0)
  })

  it('does not read optional Chat metadata before opening Add Note', async () => {
    let sessionReads = 0
    const { client } = makeClient(() => {
      sessionReads += 1
      return new Promise<Session[]>(() => {})
    })
    const handleSelection = mock(async () => ({
      ok: true as const,
      noteTargetPath: 'notes/research.md',
    }))

    const result = await Promise.race([
      handleBrowserApplicationCapability(client, {
        v: 1,
        action: 'add-selection-note',
        requestId: 'request-note-optional-session-lookup-hangs',
        mode: 'choose-target',
        workspaceId: 'local-mirror-id',
        projectId: 'project-a',
        sessionId: 'target',
        source: {
          url: 'https://example.com/article',
          title: 'Article',
          quote: 'selected text',
          locator: {
            type: 'web-text-quote',
            exact: 'selected text',
          },
        },
      }, handleSelection, 'local-mirror-id'),
      Bun.sleep(25).then(() => ({ timeout: true as const })),
    ])

    expect(result).toEqual({
      ok: true,
      noteTargetPath: 'notes/research.md',
      sessionId: 'target',
    })
    expect(sessionReads).toBe(0)
    expect(handleSelection).toHaveBeenCalledWith(expect.objectContaining({
      action: 'add-selection-note',
      sessionId: 'target',
    }))
  })

  it('adds a Browser selection through the live Chat draft handler', async () => {
    const { client } = makeClient([
      session('target', 'project-a'),
    ])
    const handleSelection = mock(async () => ({ ok: true as const }))
    const request = {
      v: 1 as const,
      action: 'add-selection-to-chat' as const,
      requestId: 'request-chat',
      workspaceId: 'local-mirror-id',
      projectId: 'project-a',
      sessionId: 'target',
      source: {
        url: 'https://example.com/article',
        title: 'Article',
        quote: 'selected text',
        locator: { type: 'web-text-quote' as const, exact: 'selected text' },
      },
    }

    await expect(handleBrowserApplicationCapability(
      client,
      request,
      handleSelection,
      'local-mirror-id',
    )).resolves.toEqual({ ok: true })
    expect(handleSelection).toHaveBeenCalledWith(request)
  })

  it('creates a Chat from a Browser selection without an existing target Chat', async () => {
    let sessionReads = 0
    const { client } = makeClient(() => {
      sessionReads += 1
      return new Promise<Session[]>(() => {})
    })
    const handleSelection = mock(async () => ({
      ok: true as const,
      sessionId: 'chat-new',
      targetTitle: 'New Chat',
    }))
    const request = {
      v: 1 as const,
      action: 'create-chat-from-selection' as const,
      requestId: 'request-new-chat',
      workspaceId: 'local-mirror-id',
      projectId: 'project-a',
      source: {
        url: 'https://example.com/article',
        title: 'Article',
        quote: 'selected text',
        locator: { type: 'web-text-quote' as const, exact: 'selected text' },
      },
    }

    const result = await Promise.race([
      handleBrowserApplicationCapability(
        client,
        request,
        handleSelection,
        'local-mirror-id',
      ),
      Bun.sleep(25).then(() => ({ timeout: true as const })),
    ])

    expect(result).toEqual({
      ok: true,
      sessionId: 'chat-new',
      targetTitle: 'New Chat',
    })
    expect(sessionReads).toBe(0)
    expect(handleSelection).toHaveBeenCalledWith(request)
  })

  it('opens an existing target Chat only after the renderer handler is mounted', async () => {
    const { client } = makeClient([
      session('target', 'project-a'),
    ])
    const handleApplication = mock(async () => ({ ok: true as const }))
    const request = {
      v: 1 as const,
      action: 'open-chat' as const,
      workspaceId: 'local-mirror-id',
      projectId: 'project-a',
      sessionId: 'target',
    }

    await expect(handleBrowserApplicationCapability(
      client,
      request as any,
      null,
      'local-mirror-id',
    )).rejects.toThrow('handler is unavailable')
    await expect(handleBrowserApplicationCapability(
      client,
      request as any,
      handleApplication,
      'local-mirror-id',
    )).resolves.toEqual({ ok: true })
    expect(handleApplication).toHaveBeenCalledWith(request)
  })

  it('rejects a Chat outside the requested Project before writing', async () => {
    const { client, invoke } = makeClient([
      session('other-project', 'project-b', { projectNoteTargetPath: 'notes/other.md' }),
    ])

    await expect(handleBrowserApplicationCapability(client, {
      v: 1,
      action: 'add-selection-to-chat',
      requestId: 'request-cross-project',
      workspaceId: 'local-mirror-id',
      projectId: 'project-a',
      sessionId: 'other-project',
      source: {
        url: 'https://example.com',
        title: 'Example',
        quote: 'text',
        locator: { type: 'web-text-quote', exact: 'text' },
      },
    })).rejects.toThrow('not available in this Project')

    expect(invoke.mock.calls.some(([channel]) => channel === RPC_CHANNELS.projectNotes.APPEND))
      .toBe(false)
  })
})
