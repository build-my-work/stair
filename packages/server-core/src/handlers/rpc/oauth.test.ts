import { afterEach, describe, expect, it } from 'bun:test'
import { OAuthFlowStore, type PreparedOAuthFlow } from '@craft-agent/shared/auth'
import type { LoadedSource } from '@craft-agent/shared/sources'
import { completeOAuthFlow, createOAuthFlowStarter } from './oauth'

const logger = { info: () => {} }
const stores: OAuthFlowStore[] = []

afterEach(() => {
  while (stores.length > 0) stores.pop()!.dispose()
})

function source(slug = 'gmail'): LoadedSource {
  return { config: { slug }, workspaceId: 'ws-1' } as unknown as LoadedSource
}

/** A starter whose provider preparation resolves when the test lets it. */
function harness(opts: { manualPrepare?: boolean } = {}) {
  const flowStore = new OAuthFlowStore()
  stores.push(flowStore)
  let prepareCount = 0
  const releases: Array<() => void> = []
  const prepare = (): Promise<PreparedOAuthFlow> => {
    const n = ++prepareCount
    const prepared: PreparedOAuthFlow = {
      authUrl: `https://accounts.example.com/auth?n=${n}`,
      state: `state-${n}`,
      codeVerifier: 'verifier',
      tokenEndpoint: 'https://oauth2.example.com/token',
      clientId: 'oauth-client',
      redirectUri: 'http://localhost:6477/callback',
      provider: 'google',
    }
    if (!opts.manualPrepare) return Promise.resolve(prepared)
    return new Promise(resolve => releases.push(() => resolve(prepared)))
  }
  const start = createOAuthFlowStarter({ flowStore, prepare, logger })
  return { flowStore, start, prepareCount: () => prepareCount, releaseNext: () => releases.shift()!() }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    clientId: 'client-a',
    source: source(),
    sourceSlug: 'gmail',
    callbackUrl: 'http://localhost:6477/callback',
    joinLive: true,
    ...overrides,
  }
}

describe('oauth:start single flight', () => {
  it('does not publish a prepared flow after its auth owner was cancelled', async () => {
    const { start, flowStore, releaseNext } = harness({ manualPrepare: true })
    let current = true
    const starting = start(request({ assertCurrent: () => { if (!current) throw new Error('AUTH_REQUEST_CANCELLED') } }))
    const failure = starting.catch(error => error)
    current = false
    releaseNext()
    expect((await failure).message).toBe('AUTH_REQUEST_CANCELLED')
    expect(flowStore.getLiveForSource('ws-1', 'gmail')).toBeNull()
  })
  it('a second start for the same source joins the live flow instead of opening another sign-in', async () => {
    const { flowStore, start, prepareCount } = harness()

    const owner = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1' }))
    const joiner = await start(request({ clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' }))

    expect('authUrl' in owner && owner.authUrl).toBe('https://accounts.example.com/auth?n=1')
    expect(joiner).toMatchObject({ joined: true, flowId: owner.flowId })
    expect(prepareCount()).toBe(1)
    expect(flowStore.getLiveForSource('ws-1', 'gmail')!.waiters).toEqual([
      { clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' },
    ])
  })

  it('a start that arrives while the first is still preparing waits and joins it', async () => {
    const { start, prepareCount, releaseNext } = harness({ manualPrepare: true })

    const ownerPromise = start(request())
    const joinerPromise = start(request({ clientId: 'client-b' }))
    await Promise.resolve()
    releaseNext()

    const owner = await ownerPromise
    const joiner = await joinerPromise
    expect(joiner).toMatchObject({ joined: true, flowId: owner.flowId })
    expect(prepareCount()).toBe(1)
  })

  it('other sources and other workspaces get their own flow', async () => {
    const { start, prepareCount } = harness()

    const gmail = await start(request())
    const calendar = await start(request({ sourceSlug: 'calendar', source: source('calendar') }))
    const otherWorkspace = await start(request({ workspaceId: 'ws-2' }))

    expect('joined' in calendar).toBe(false)
    expect('joined' in otherWorkspace).toBe(false)
    expect(new Set([gmail.flowId, calendar.flowId, otherWorkspace.flowId]).size).toBe(3)
    expect(prepareCount()).toBe(3)
  })

  it('older clients that cannot join still get their own flow', async () => {
    const { start } = harness()

    const first = await start(request())
    const legacy = await start(request({ clientId: 'old-client', joinLive: undefined }))

    expect('authUrl' in legacy).toBe(true)
    expect(legacy.flowId).not.toBe(first.flowId)
  })

  it('once the flow ends, the next start owns a new one', async () => {
    const { flowStore, start } = harness()

    const first = await start(request())
    flowStore.remove('authUrl' in first ? first.state : '', { success: false, error: 'denied' })
    const next = await start(request({ clientId: 'client-b' }))

    expect('authUrl' in next).toBe(true)
    expect(next.flowId).not.toBe(first.flowId)
  })

  it('a restart replaces the live flow, releases its waiters and keeps their cards bound', async () => {
    const { flowStore, start } = harness()

    const first = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1' }))
    await start(request({ clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' }))
    const restarted = await start(request({ clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2', restart: true }))

    expect('authUrl' in restarted).toBe(true)
    expect(restarted.flowId).not.toBe(first.flowId)
    const replaced = flowStore.getStatus(first.flowId, 'ws-1')
    expect(replaced.live).toBe(false)
    expect(replaced.live === false && replaced.outcome?.error).toBe('The sign-in was restarted.')

    const live = flowStore.getLiveForSource('ws-1', 'gmail')!
    expect(live.flowId).toBe(restarted.flowId)
    expect(live.sessionId).toBe('session-2')
    expect(live.waiters).toEqual([{ clientId: 'client-a', sessionId: 'session-1', authRequestId: 'auth-1' }])
  })
})

describe('completeOAuthFlow', () => {
  function completionHarness(exchange: () => Promise<{ success: boolean; error?: string; email?: string }>) {
    const { flowStore, start } = harness()
    const calls: { fanOut: unknown[][]; completed: unknown[][]; pushed: string[] } = { fanOut: [], completed: [], pushed: [] }
    const complete = (state: string) => completeOAuthFlow({
      code: 'auth-code',
      state,
      flowStore,
      credManager: { exchangeAndStore: exchange },
      sessionManager: {
        completeAuthRequest: async (...args) => { calls.completed.push(args) },
        completeAuthRequestsForSource: async (...args) => { calls.fanOut.push(args); return ['session-1', 'session-2'] },
      },
      pushSourcesChanged: (workspaceId) => calls.pushed.push(workspaceId),
      logger,
      clientId: 'client-a',
      workspaceId: 'ws-1',
    })
    return { flowStore, start, calls, complete }
  }

  it('a successful sign-in answers every session waiting on the source and tells joiners', async () => {
    const { flowStore, start, calls, complete } = completionHarness(async () => ({ success: true, email: 'me@example.com' }))
    const owner = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1' }))
    await start(request({ clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' }))
    await start(request({ clientId: 'client-c' })) // page banner: no card

    const result = await complete('authUrl' in owner ? owner.state : '')

    expect(result).toEqual({ success: true, email: 'me@example.com' })
    expect(calls.fanOut).toEqual([[
      'ws-1',
      'gmail',
      { email: 'me@example.com' },
      [{ sessionId: 'session-1', authRequestId: 'auth-1' }, { sessionId: 'session-2', authRequestId: 'auth-2' }],
    ]])
    expect(calls.completed).toEqual([])
    expect(calls.pushed).toEqual(['ws-1'])
    expect(flowStore.getStatus(owner.flowId, 'ws-1')).toEqual({
      live: false,
      outcome: { success: true, error: undefined, email: 'me@example.com' },
    })
  })

  it('a cancellation during token exchange prevents the old flow from resuming cards', async () => {
    let release!: () => void
    const { flowStore, start, calls, complete } = completionHarness(() => new Promise(resolve => {
      release = () => resolve({ success: true })
    }))
    const owner = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1', authOwnerToken: 'owner-1' }))
    const state = 'authUrl' in owner ? owner.state : ''
    const completing = complete(state)
    const duplicate = complete(state)
    flowStore.remove(state)
    release()
    const outcome = await completing
    expect(outcome.success).toBe(false)
    expect(await duplicate).toEqual(outcome)
    expect(calls.fanOut).toHaveLength(0)
    expect(calls.completed).toHaveLength(0)
  })

  it('duplicate callbacks share one exchange so a consumed authorization code cannot cancel its winner', async () => {
    let exchanges = 0
    let release!: () => void
    const { start, calls, complete } = completionHarness(async () => {
      if (++exchanges > 1) throw new Error('invalid_grant: authorization code already consumed')
      return new Promise(resolve => { release = () => resolve({ success: true }) })
    })
    const owner = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1', authOwnerToken: 'owner-1' }))
    const state = 'authUrl' in owner ? owner.state : ''
    const first = complete(state)
    const second = complete(state)
    const outcomes = Promise.allSettled([first, second])
    await Promise.resolve()
    release()
    expect(await outcomes).toEqual([
      { status: 'fulfilled', value: { success: true } },
      { status: 'fulfilled', value: { success: true } },
    ])
    expect(exchanges).toBe(1)
    expect(calls.fanOut).toHaveLength(1)
    expect(calls.pushed).toEqual(['ws-1'])
    expect(calls.fanOut[0]?.[3]).toEqual([{ sessionId: 'session-1', authRequestId: 'auth-1', authOwnerToken: 'owner-1' }])
  })

  it('a failed exchange fails only the card that started the flow; joined cards stay pending', async () => {
    const { flowStore, start, calls, complete } = completionHarness(async () => ({ success: false, error: 'invalid_grant' }))
    const owner = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1' }))
    await start(request({ clientId: 'client-b', sessionId: 'session-2', authRequestId: 'auth-2' }))

    await complete('authUrl' in owner ? owner.state : '')

    expect(calls.fanOut).toEqual([])
    expect(calls.completed).toEqual([[
      'session-1',
      { requestId: 'auth-1', sourceSlug: 'gmail', success: false, error: 'invalid_grant' },
    ]])
    const status = flowStore.getStatus(owner.flowId, 'ws-1')
    expect(status.live === false && status.outcome?.error).toBe('invalid_grant')
  })

  it('an exchange that throws still ends the flow so joiners stop waiting', async () => {
    const { flowStore, start, calls, complete } = completionHarness(async () => { throw new Error('network down') })
    const owner = await start(request({ sessionId: 'session-1', authRequestId: 'auth-1' }))

    await expect(complete('authUrl' in owner ? owner.state : '')).rejects.toThrow('network down')

    expect(calls.fanOut).toEqual([])
    expect(flowStore.getLiveForSource('ws-1', 'gmail')).toBeNull()
    const status = flowStore.getStatus(owner.flowId, 'ws-1')
    expect(status.live === false && status.outcome?.error).toBe('network down')
  })

  it('duplicate callbacks share a provider failure and end the flow once', async () => {
    let exchanges = 0
    let fail!: (error: Error) => void
    const { flowStore, start, calls, complete } = completionHarness(() => {
      exchanges++
      return new Promise((_resolve, reject) => { fail = reject })
    })
    const owner = await start(request())
    const state = 'authUrl' in owner ? owner.state : ''
    const outcomes = Promise.allSettled([complete(state), complete(state)])
    const error = new Error('network down')
    fail(error)
    expect(await outcomes).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ])
    expect(exchanges).toBe(1)
    expect(flowStore.getByState(state)).toBeNull()
    expect(calls.fanOut).toHaveLength(0)
    expect(calls.completed).toHaveLength(0)
  })

  it('only the owning client can complete over RPC', async () => {
    const { start, complete } = completionHarness(async () => ({ success: true }))
    const owner = await start(request({ clientId: 'someone-else' }))

    await expect(complete('authUrl' in owner ? owner.state : '')).rejects.toThrow('owned by different client')
  })
})
