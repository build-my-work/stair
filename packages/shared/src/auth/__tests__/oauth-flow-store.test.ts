import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { OAuthFlowStore, createPendingFlow, type PendingOAuthFlow } from '../oauth-flow-store.ts'

const stores: OAuthFlowStore[] = []

function newStore(): OAuthFlowStore {
  const store = new OAuthFlowStore()
  stores.push(store)
  return store
}

function flow(overrides: Partial<PendingOAuthFlow> & { state: string }): PendingOAuthFlow {
  return createPendingFlow({
    flowId: `flow-${overrides.state}`,
    codeVerifier: 'verifier',
    redirectUri: 'http://localhost:6477/callback',
    source: {} as PendingOAuthFlow['source'],
    clientId: 'oauth-client',
    tokenEndpoint: 'https://oauth2.example.com/token',
    provider: 'google',
    ownerClientId: 'client-a',
    workspaceId: 'ws-1',
    sourceSlug: 'gmail',
    ...overrides,
  })
}

afterEach(() => {
  setSystemTime()
  while (stores.length > 0) stores.pop()!.dispose()
})

describe('OAuthFlowStore single flight', () => {
  it('disconnect removes every owned flow and exposes a retryable outcome', () => {
    const store = newStore()
    const older = flow({ state: 'older' })
    const newest = flow({ state: 'newest' })
    store.store(older)
    store.store(newest)

    expect(store.removeOwnedByClient('client-a')).toEqual([older, newest])
    expect(store.getByState('older')).toBeNull()
    expect(store.getByState('newest')).toBeNull()
    expect(store.getLiveForSource('ws-1', 'gmail')).toBeNull()
    const status = store.getStatus(newest.flowId, 'ws-1')
    expect(status.live === false && status.outcome?.error).toContain('disconnected')
    expect(store.removeOwnedByClient('client-a')).toEqual([])
  })

  it('disconnect detaches only that client’s waiter bindings from a flow it does not own', () => {
    const store = newStore()
    const owner = flow({ state: 'shared', ownerClientId: 'service-owner' })
    store.store(owner)
    store.join(owner.state, { clientId: 'client-a', sessionId: 'session', authRequestId: 'request', authOwnerToken: 'old-owner' })
    store.join(owner.state, { clientId: 'service-owner', sessionId: 'owner-session', authRequestId: 'owner-request', authOwnerToken: 'active-owner' })

    expect(store.removeOwnedByClient('client-a')).toEqual([])
    expect(store.getByState(owner.state)).toBe(owner)
    expect(owner.waiters).toEqual([{ clientId: 'service-owner', sessionId: 'owner-session', authRequestId: 'owner-request', authOwnerToken: 'active-owner' }])
  })

  it('finds the live flow for a workspace + source, and only that one', () => {
    const store = newStore()
    const owner = flow({ state: 's1' })
    store.store(owner)

    expect(store.getLiveForSource('ws-1', 'gmail')).toBe(owner)
    expect(store.getLiveForSource('ws-2', 'gmail')).toBeNull()
    expect(store.getLiveForSource('ws-1', 'calendar')).toBeNull()
  })

  it('records each joining caller once', () => {
    const store = newStore()
    store.store(flow({ state: 's1' }))

    store.join('s1', { clientId: 'client-a', sessionId: 'session-2', authRequestId: 'auth-2' })
    store.join('s1', { clientId: 'client-a', sessionId: 'session-2', authRequestId: 'auth-2' })
    store.join('s1', { clientId: 'client-b', sessionId: 'session-3', authRequestId: 'auth-3' })

    expect(store.getByState('s1')!.waiters).toEqual([
      { clientId: 'client-a', sessionId: 'session-2', authRequestId: 'auth-2' },
      { clientId: 'client-b', sessionId: 'session-3', authRequestId: 'auth-3' },
    ])
    expect(store.join('missing', { clientId: 'client-a' })).toBeNull()
  })

  it('reports a live flow, then how it ended, to its own workspace only', () => {
    const store = newStore()
    store.store(flow({ state: 's1' }))

    const live = store.getStatus('flow-s1', 'ws-1')
    expect(live.live).toBe(true)
    expect(store.getStatus('flow-s1', 'ws-2')).toEqual({ live: false })

    store.remove('s1', { success: true, email: 'me@example.com' })

    expect(store.getLiveForSource('ws-1', 'gmail')).toBeNull()
    expect(store.getStatus('flow-s1', 'ws-1')).toEqual({
      live: false,
      outcome: { success: true, error: undefined, email: 'me@example.com' },
    })
    expect(store.getStatus('flow-s1', 'ws-2')).toEqual({ live: false })
  })

  it('reports a cancellation when a flow is removed without an outcome', () => {
    const store = newStore()
    store.store(flow({ state: 's1' }))
    store.remove('s1')

    const status = store.getStatus('flow-s1', 'ws-1')
    expect(status.live).toBe(false)
    expect(status.live === false && status.outcome?.success).toBe(false)
    expect(status.live === false && status.outcome?.error).toContain('cancelled')
  })

  it('releases waiters when the flow expires, so the next caller can own a new one', () => {
    const store = newStore()
    const start = Date.now()
    setSystemTime(new Date(start))
    store.store(flow({ state: 's1' }))
    store.join('s1', { clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' })

    setSystemTime(new Date(start + 5 * 60 * 1000 + 1))

    expect(store.getLiveForSource('ws-1', 'gmail')).toBeNull()
    const status = store.getStatus('flow-s1', 'ws-1')
    expect(status.live === false && status.outcome?.error).toContain('expired')
  })

  it('forgets outcomes after a while', () => {
    const store = newStore()
    const start = Date.now()
    setSystemTime(new Date(start))
    store.store(flow({ state: 's1' }))
    store.remove('s1', { success: false, error: 'denied' })

    setSystemTime(new Date(start + 3 * 60 * 1000))
    store.cleanup()

    expect(store.getStatus('flow-s1', 'ws-1')).toEqual({ live: false })
  })

  it('falls back to another live flow for the source when the newest one ends', () => {
    const store = newStore()
    const start = Date.now()
    setSystemTime(new Date(start))
    const older = flow({ state: 'old' })
    store.store(older)
    setSystemTime(new Date(start + 1000))
    const newer = flow({ state: 'new' })
    store.store(newer)

    expect(store.getLiveForSource('ws-1', 'gmail')).toBe(newer)
    store.remove('new', { success: false, error: 'The sign-in was restarted.' })
    expect(store.getLiveForSource('ws-1', 'gmail')).toBe(older)
    store.remove('old')
    expect(store.getLiveForSource('ws-1', 'gmail')).toBeNull()
  })

  it('keeps the index when an older flow for the source ends', () => {
    const store = newStore()
    store.store(flow({ state: 'old' }))
    const newer = flow({ state: 'new' })
    store.store(newer)

    store.remove('old')
    expect(store.getLiveForSource('ws-1', 'gmail')).toBe(newer)
  })
})
