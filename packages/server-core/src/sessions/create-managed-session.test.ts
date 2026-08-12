import { describe, expect, it } from 'bun:test'
import { createManagedSession } from './SessionManager.ts'

describe('createManagedSession', () => {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/test-workspace',
    createdAt: Date.now(),
  }

  it('normalizes legacy thinkingLevel=think on restore', () => {
    const managed = createManagedSession({
      id: 'session_legacy',
      projectId: 'proj_default',
      thinkingLevel: 'think' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBe('medium')
  })

  it('drops invalid thinking levels instead of leaking them into runtime state', () => {
    const managed = createManagedSession({
      id: 'session_invalid',
      projectId: 'proj_default',
      thinkingLevel: 'ultra' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBeUndefined()
  })

  it('rejects a runtime Session without Project ownership', () => {
    expect(() => createManagedSession({ id: 'session_unbound' }, workspace as any))
      .toThrow('Session session_unbound is missing projectId')
  })
})
