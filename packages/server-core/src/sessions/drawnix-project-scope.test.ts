import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import {
  CLIENT_DRAWNIX_BOARD_INVOKE,
  type DrawnixBoardCapabilityRequest,
  type RpcServer,
} from '../transport'
import { SessionManager } from './SessionManager'

describe('Drawnix Agent capability architecture', () => {
  it('stamps every capability request with the invoking Session Project', () => {
    const source = readFileSync(new URL('./SessionManager.ts', import.meta.url), 'utf8')
    const readBinding = source.match(/readMindmapFn:[\s\S]*?updateMindmapFn:/)?.[0] ?? ''
    const updateBinding = source.match(/updateMindmapFn:[\s\S]*?getSessionInfoFn:/)?.[0] ?? ''

    expect(readBinding).toContain('projectId: managed.projectId')
    expect(updateBinding).toContain('projectId: managed.projectId')
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

  it('retries another same-Workspace client and pins only the client with the open board', async () => {
    const calls: string[] = []
    const server: RpcServer = {
      handle() {},
      push() {},
      hasClientCapability: () => true,
      findClientsWithCapability: () => ['client-b', 'client-a'],
      invokeClient: async (clientId, channel) => {
        calls.push(clientId)
        expect(channel).toBe(CLIENT_DRAWNIX_BOARD_INVOKE)
        if (clientId === 'client-b') {
          return {
            ok: false,
            error: { code: 'MINDMAP_NOT_OPEN', message: 'not open here' },
          }
        }
        return {
          ok: true,
          snapshot: {
            relativePath: 'maps/tutorial.drawnix',
            changeSeq: 3,
            roots: [],
          },
        }
      },
    }
    const manager = new SessionManager()
    const internals = manager as unknown as {
      rpcServer: RpcServer
      sessions: Map<string, { workspace: { id: string } }>
      drawnixHostBySession: Map<string, string>
      requestDrawnixBoardForSession(
        sessionId: string,
        request: DrawnixBoardCapabilityRequest,
      ): Promise<unknown>
    }
    internals.rpcServer = server
    internals.sessions.set('session-a', { workspace: { id: 'workspace-a' } })
    internals.drawnixHostBySession.set('session-a', 'client-b')

    await expect(internals.requestDrawnixBoardForSession('session-a', {
      v: 1,
      action: 'read',
      projectId: 'project-a',
      relativePath: 'maps/tutorial.drawnix',
    })).resolves.toMatchObject({ ok: true })
    expect(calls).toEqual(['client-b', 'client-a'])
    expect(internals.drawnixHostBySession.get('session-a')).toBe('client-a')
  })
})
