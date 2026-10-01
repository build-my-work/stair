import { expect, test } from 'bun:test'
import type { DraftContentMutation } from '@craft-agent/shared/config'
import type { SessionDraftPersistence } from '../session-draft-coordinator'

// The entry starts a fresh process before storage captures its profile path.
const profile = process.env.CRAFT_CONFIG_DIR
if (!profile?.includes('stair-draft-protocol-profile-')) throw new Error('Disposable draft protocol profile required')
const store = await import('@craft-agent/shared/config')
if (store.CONFIG_DIR !== profile) throw new Error('Draft store loaded before profile isolation')
const { SessionDraftCoordinator } = await import('../session-draft-coordinator')

test('a lost write reply remains idempotent after another window commits 64 edits', async () => {
  const sessionId = 'draft-protocol-' + crypto.randomUUID()
  const token = 'WINDOW-A-INPUT'
  const requests: DraftContentMutation[] = []
  let loseReply = true
  const persistence: SessionDraftPersistence = {
    setDraftContent: async (id, content, mutation) => store.setSessionDraftContent(id, content, mutation),
    updateDraftReferences: async (id, request) => store.reconcileSessionDraftReferences(id, 'project-a', request.baseReferences, request.nextReferences),
    addDraftReference: async (id, reference, requestId) => store.addSessionDraftReferenceAtomic(id, 'project-a', reference, requestId),
    restoreDraftInput: async (id, request) => store.restoreSessionDraftAtomic(id, 'project-a', request.restoreId, request.draft, request.local, request.planExecutionId),
    acknowledgeQueuedInputRestore: async () => {},
  }
  const a = new SessionDraftCoordinator({
    getProjectId: () => 'project-a', debounceMs: 60_000,
    persistence: {
      ...persistence,
      setDraftContent: async (id, content, mutation) => {
        if (!mutation) throw new Error('The real Coordinator must capture a modern mutation')
        requests.push(mutation)
        const committed = await persistence.setDraftContent(id, content, mutation)
        if (loseReply) {
          loseReply = false
          throw new Error('Reply lost after draft store commit')
        }
        return committed
      },
    },
  })
  const b = new SessionDraftCoordinator({ persistence, getProjectId: () => 'project-a', debounceMs: 60_000 })
  try {
    for (const window of [a, b]) {
      window.hydrate(window.beginHydration('workspace-a'), store.getSessionDraftHydrationState())
    }
    a.updateText(sessionId, token)
    await expect(a.flushContent(sessionId)).rejects.toThrow('Reply lost after draft store commit')
    // A stays disconnected while B saves normal edits. B's first stale append
    // observes A through the store; later appends preserve that shared text.
    for (let n = 0; n < 64; n++) {
      b.updateText(sessionId, `${b.getText(sessionId)}\nWINDOW-B-${n}`)
      await b.flushContent(sessionId)
    }
    const beforeRetry = store.getSessionDraft(sessionId)?.text ?? ''
    expect(beforeRetry.split(token).length - 1).toBe(1)
    expect(beforeRetry).toContain('WINDOW-B-63')
    await a.flushContent(sessionId)
    expect(requests[1]).toEqual(requests[0])
    const afterRetry = store.getSessionDraft(sessionId)?.text ?? ''
    expect(afterRetry.split(token).length - 1).toBe(1)
    expect(afterRetry).toBe(beforeRetry)
    expect(a.getText(sessionId)).toBe(afterRetry)
    // A genuinely new operation may repeat the same text. Identity, rather
    // than content equality, distinguishes this edit from the lost reply.
    a.updateText(sessionId, `${a.getText(sessionId)}\n${token}`)
    await a.flushContent(sessionId)
    expect(requests.at(-1)?.id).not.toBe(requests[0]?.id)
    expect((store.getSessionDraft(sessionId)?.text ?? '').split(token).length - 1).toBe(2)
    expect(store.getSessionDraft(sessionId)?.text).toContain('WINDOW-B-63')
  } finally {
    a.dispose()
    b.dispose()
  }
})
