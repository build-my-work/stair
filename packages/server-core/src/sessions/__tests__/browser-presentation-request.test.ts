import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { SessionManager } from '../SessionManager'

describe('SessionManager browser presentation requests', () => {
  it('targets the desktop client pinned by the originating session message', () => {
    const manager = Object.create(SessionManager.prototype) as SessionManager
    const pushes: unknown[][] = []
    Object.assign(manager as object, {
      eventSink: (...args: unknown[]) => pushes.push(args),
      browserHostByCanvas: new Map([['session-1', 'client-1']]),
      sessions: new Map([[
        'session-1',
        { workspace: { id: 'workspace-1' } },
      ]]),
    })

    const requested = (manager as any).requestBrowserPresentation(
      'session-1',
      'browser-1',
    )

    expect(requested).toBe(true)
    expect(pushes).toEqual([[
      RPC_CHANNELS.browserPane.PRESENT_REQUESTED,
      { to: 'client', clientId: 'client-1' },
      {
        browserId: 'browser-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
      },
    ]])
  })
})
