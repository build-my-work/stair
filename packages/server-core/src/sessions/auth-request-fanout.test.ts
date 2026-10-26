import { describe, expect, it } from 'bun:test'
import type { AuthRequest } from '@craft-agent/shared/agent'
import { SessionManager, createManagedSession } from './SessionManager.ts'

function harness() {
  const manager = new SessionManager()
  const completed: Array<{ id: string; requestId: string; token?: string }> = []
  ;(manager as any).persistSession = () => {}
  ;(manager as any).flushSessionStrict = async () => {}
  manager.completeAuthRequest = async (id, result, token) => { completed.push({ id, requestId: result.requestId, token }) }
  function session(id: string, workspaceId: string, sourceSlug?: string, type: AuthRequest['type'] = 'oauth') {
    const managed = createManagedSession({ id, projectId: 'project-a' }, {
      id: workspaceId, name: workspaceId, slug: workspaceId, createdAt: 1, rootPath: '/unused-auth-fixture',
    }, { messagesLoaded: true })
    if (sourceSlug) {
      const request = { requestId: `auth-${id}`, sessionId: id, type, sourceSlug, sourceName: sourceSlug } as AuthRequest
      managed.pendingAuthRequest = request
      managed.pendingAuthRequestId = request.requestId
      managed.pendingAuthOwner = { generation: 0, stopEpoch: 0, token: `owner-${id}` }
      managed.pendingAuthContinuation = { version: 1, request, projectId: 'project-a', originMessageIds: ['user'],
        input: { text: 'Original input' }, continuationMessageId: `continue-${id}`, phase: 'waiting' }
      managed.messages.push({ id: 'user', role: 'user', content: 'Original input', timestamp: 1 }, {
        id: 'card', role: 'auth-request', content: 'Sign in', timestamp: 2, authRequestId: request.requestId,
        authSourceSlug: sourceSlug, authRequestType: type, authStatus: 'pending',
      })
    }
    ;(manager as any).sessions.set(id, managed)
    return managed
  }
  return { manager, completed, session }
}

describe('SessionManager.completeAuthRequestsForSource', () => {
  it('answers live OAuth requests only in the matching workspace and source', async () => {
    const h = harness()
    h.session('a', 'ws', 'gmail'); h.session('b', 'ws', 'gmail')
    h.session('other-source', 'ws', 'calendar'); h.session('elsewhere', 'other-ws', 'gmail')
    h.session('credential', 'ws', 'gmail', 'credential'); h.session('idle', 'ws')
    expect(await h.manager.completeAuthRequestsForSource('ws', 'gmail', {})).toEqual(['a', 'b'])
    expect(h.completed.map(item => item.id)).toEqual(['a', 'b'])
  })

  it('only explicit preparation re-arms a persisted card; a callback cannot do that', async () => {
    const h = harness()
    const cold = h.session('cold', 'ws', 'gmail')
    cold.pendingAuthRequest = undefined; cold.pendingAuthRequestId = undefined; cold.pendingAuthOwner = undefined
    expect(await h.manager.completeAuthRequestsForSource('ws', 'gmail', {}, [{ sessionId: 'cold', authRequestId: 'auth-cold' }])).toEqual([])
    const token = await h.manager.prepareAuthRequest('cold', 'auth-cold', 'ws', 'gmail')
    expect(await h.manager.completeAuthRequestsForSource('ws', 'gmail', {}, [{ sessionId: 'cold', authRequestId: 'auth-cold', authOwnerToken: token }])).toEqual(['cold'])
    expect(h.completed[0]?.token).toBe(token)
  })

  it('stale bound card or ownership token cannot override the current request', async () => {
    const h = harness()
    h.session('live', 'ws', 'gmail')
    for (const binding of [{ sessionId: 'live', authRequestId: 'old-card', authOwnerToken: 'owner-live' },
      { sessionId: 'live', authRequestId: 'auth-live', authOwnerToken: 'old-owner' }]) {
      expect(await h.manager.completeAuthRequestsForSource('ws', 'gmail', {}, [binding])).toEqual([])
    }
    expect(h.completed).toHaveLength(0)
  })

  it('clears cooldowns in the source workspace even for sessions not waiting on it', async () => {
    const h = harness()
    const sessions = [h.session('waiting', 'ws', 'gmail'), h.session('idle', 'ws'), h.session('elsewhere', 'other-ws')]
    const cleared: string[] = []
    for (const managed of sessions) managed.tokenRefreshManager.clearCooldown = slug => { cleared.push(`${managed.id}:${slug}`) }
    await h.manager.completeAuthRequestsForSource('ws', 'gmail', {})
    expect(new Set(cleared)).toEqual(new Set(['waiting:gmail', 'idle:gmail']))
  })
})
