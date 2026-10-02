import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import {
  CLIENT_DRAWNIX_BOARD_INVOKE,
  CLIENT_DRAWNIX_BOARD_DISCOVER,
  type DrawnixBoardCapabilityRequest,
  type RpcServer,
} from '../transport'
import { SessionManager } from './SessionManager'

describe('Drawnix Agent capability architecture', () => {
  it('stamps every capability request with the invoking Session Project', () => {
    const source = readFileSync(new URL('./SessionManager.ts', import.meta.url), 'utf8')
    const createBinding = source.match(/createMindmapFn:[\s\S]*?readMindmapFn:/)?.[0] ?? ''
    const readBinding = source.match(/readMindmapFn:[\s\S]*?updateMindmapFn:/)?.[0] ?? ''
    const updateBinding = source.match(/updateMindmapFn:[\s\S]*?getSessionInfoFn:/)?.[0] ?? ''

    expect(createBinding).toContain('projectId: managed.projectId')
    expect(readBinding).toContain('projectId: managed.projectId')
    expect(updateBinding).toContain('projectId: managed.projectId')
    expect(createBinding).not.toContain('request.projectId')
    expect(readBinding).not.toContain('request.projectId')
    expect(updateBinding).not.toContain('request.projectId')
  })

  it('keeps Agent tool execution independent from Renderer Workbench state', () => {
    const sessionManager = readFileSync(new URL('./SessionManager.ts', import.meta.url), 'utf8')
    const toolDefs = readFileSync(
      new URL('../../../session-tools-core/src/tool-defs.ts', import.meta.url),
      'utf8',
    )
    const source = `${sessionManager}\n${toolDefs}`
    expect(source).not.toMatch(/renderer\/workbench|@\/workbench/)
  })

  function routingFixture() {
    const calls: Array<{ clientId: string; channel: string; request: unknown }> = []
    const boards = new Map<string, number>([['client-a', 1], ['client-b', 0]])
    const activeProjects = new Map<string, string>([['client-a', 'project-a'], ['client-b', 'project-b']])
    let discoverSupported = true
    let disconnectDuringDiscovery = false
    let disconnectDuringOperation = false
    const server: RpcServer = {
      handle() {},
      push() {},
      hasClientCapability: (_clientId, capability) => capability !== CLIENT_DRAWNIX_BOARD_DISCOVER || discoverSupported,
      findClientsWithCapability: (_capability, scope) => {
        expect(scope?.workspaceId).toBe('workspace-a')
        return ['client-b', 'client-a']
      },
      invokeClient: async (clientId, channel, request) => {
        calls.push({ clientId, channel, request })
        if (channel === CLIENT_DRAWNIX_BOARD_DISCOVER) {
          if (disconnectDuringDiscovery && clientId === 'client-b') {
            throw Object.assign(new Error('Client disconnected'), { code: 'CLIENT_DISCONNECTED' })
          }
          return {
            ok: true,
            boardCount: request.projectId === 'project-a' ? boards.get(clientId) ?? 0 : 0,
            canCreate: activeProjects.get(clientId) === request.projectId,
          }
        }
        expect(channel).toBe(CLIENT_DRAWNIX_BOARD_INVOKE)
        if (disconnectDuringOperation) {
          throw Object.assign(new Error('Client disconnected after receiving the operation'), { code: 'CLIENT_DISCONNECTED' })
        }
        if (!boards.get(clientId) && request.action !== 'create') {
          return { ok: false, error: { code: 'MINDMAP_NOT_OPEN', message: 'not open here' } }
        }
        return {
          ok: true,
          snapshot: { relativePath: request.relativePath, changeSeq: 3, roots: [] },
        }
      },
    }
    const manager = new SessionManager()
    const internals = manager as unknown as {
      rpcServer: RpcServer
      sessions: Map<string, { workspace: { id: string }; projectId: string }>
      drawnixHostBySession: Map<string, string>
      requestDrawnixBoardForSession(sessionId: string, request: DrawnixBoardCapabilityRequest): Promise<unknown>
    }
    internals.rpcServer = server
    internals.sessions.set('session-a', { workspace: { id: 'workspace-a' }, projectId: 'project-a' })
    internals.drawnixHostBySession.set('session-a', 'client-b')
    const read = {
      v: 1 as const, action: 'read' as const, projectId: 'project-a', relativePath: 'maps/tutorial.drawnix',
    }
    return {
      calls, boards, activeProjects, internals, read,
      invoke: (request: DrawnixBoardCapabilityRequest = read) => internals.requestDrawnixBoardForSession('session-a', request),
      disableDiscovery: () => { discoverSupported = false },
      disconnectDuringDiscovery: () => { disconnectDuringDiscovery = true },
      disconnectDuringOperation: () => { disconnectDuringOperation = true },
    }
  }

  it('discovers all same-Workspace clients before reading the unique live board', async () => {
    const f = routingFixture()
    await expect(f.invoke()).resolves.toMatchObject({ ok: true })
    expect(f.calls.map(call => [call.clientId, call.channel])).toEqual([
      ['client-b', CLIENT_DRAWNIX_BOARD_DISCOVER],
      ['client-a', CLIENT_DRAWNIX_BOARD_DISCOVER],
      ['client-a', CLIENT_DRAWNIX_BOARD_INVOKE],
    ])
    expect(f.internals.drawnixHostBySession.get('session-a')).toBe('client-a')
  })

  it('rejects duplicate live boards across clients before any read, update, or create operation', async () => {
    const f = routingFixture()
    f.boards.set('client-b', 1)
    for (const request of [f.read, {
      ...f.read, action: 'update' as const, expectedChangeSeq: 3,
      operations: [{ type: 'set_topic' as const, nodeId: 'root', topic: 'Changed' }],
    }, { ...f.read, action: 'create' as const, markdown: '# Tutorial' }]) {
      await expect(f.invoke(request)).resolves.toMatchObject({
        ok: false, error: { code: 'MINDMAP_AMBIGUOUS_BOARD' },
      })
    }
    expect(f.calls.every(call => call.channel === CLIENT_DRAWNIX_BOARD_DISCOVER)).toBe(true)
    f.boards.set('client-b', 0)
    await expect(f.invoke()).resolves.toMatchObject({ ok: true })
  })

  it('does not trust a pinned client when another window opens the same board', async () => {
    const f = routingFixture()
    await expect(f.invoke()).resolves.toMatchObject({ ok: true })
    f.calls.length = 0
    f.boards.set('client-b', 1)
    await expect(f.invoke()).resolves.toMatchObject({
      ok: false, error: { code: 'MINDMAP_AMBIGUOUS_BOARD' },
    })
    expect(f.calls.every(call => call.channel === CLIENT_DRAWNIX_BOARD_DISCOVER)).toBe(true)
  })

  it('discovers a create target before issuing exactly one create operation', async () => {
    const f = routingFixture()
    f.boards.set('client-a', 0)
    await expect(f.invoke({ ...f.read, action: 'create', markdown: '# Tutorial' })).resolves.toMatchObject({ ok: true })
    expect(f.calls.filter(call => call.channel === CLIENT_DRAWNIX_BOARD_INVOKE)).toEqual([{
      clientId: 'client-a', channel: CLIENT_DRAWNIX_BOARD_INVOKE,
      request: { ...f.read, action: 'create', markdown: '# Tutorial' },
    }])
  })

  it('does not send a mutation to an old client or after incomplete discovery', async () => {
    for (const failure of ['old-client', 'disconnect']) {
      const f = routingFixture()
      if (failure === 'old-client') f.disableDiscovery()
      else f.disconnectDuringDiscovery()
      await expect(f.invoke({
        ...f.read, action: 'update', expectedChangeSeq: 3,
        operations: [{ type: 'set_topic', nodeId: 'root', topic: 'Changed' }],
      })).resolves.toMatchObject({ ok: false })
      expect(f.calls.every(call => call.channel === CLIENT_DRAWNIX_BOARD_DISCOVER)).toBe(true)
    }
  })

  it('rejects creation when multiple client windows have the target Project active', async () => {
    const f = routingFixture()
    f.boards.set('client-a', 0)
    f.activeProjects.set('client-b', 'project-a')
    await expect(f.invoke({ ...f.read, action: 'create', markdown: '# Tutorial' })).resolves.toMatchObject({
      ok: false, error: { code: 'MINDMAP_AMBIGUOUS_BOARD' },
    })
    expect(f.calls.every(call => call.channel === CLIENT_DRAWNIX_BOARD_DISCOVER)).toBe(true)
  })

  it('does not retry a mutation on another client after losing its reply', async () => {
    const f = routingFixture()
    f.disconnectDuringOperation()
    await expect(f.invoke({
      ...f.read, action: 'update', expectedChangeSeq: 3,
      operations: [{ type: 'set_topic', nodeId: 'root', topic: 'Changed' }],
    })).resolves.toMatchObject({ ok: false, error: { code: 'CLIENT_DISCONNECTED' } })
    expect(f.calls.filter(call => call.channel === CLIENT_DRAWNIX_BOARD_INVOKE)).toHaveLength(1)
    expect(f.internals.drawnixHostBySession.has('session-a')).toBe(false)
  })

  it('does not use another Project\'s open Canvas even at the same relative path', async () => {
    const f = routingFixture()
    f.internals.sessions.set('session-a', { workspace: { id: 'workspace-a' }, projectId: 'project-b' })
    await expect(f.invoke({ ...f.read, projectId: 'project-b' })).resolves.toMatchObject({
      ok: false, error: { code: 'MINDMAP_NOT_OPEN' },
    })
    expect(f.calls.every(call => call.channel === CLIENT_DRAWNIX_BOARD_DISCOVER)).toBe(true)
  })
})
