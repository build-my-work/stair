import { describe, expect, it } from 'bun:test'
import { getSessionInSameProject } from './SessionManager.ts'

function session(id: string, workspaceId: string, projectId: string) {
  return {
    id,
    workspace: { id: workspaceId },
    projectId,
  }
}

describe('getSessionInSameProject', () => {
  const caller = session('caller', 'ws-a', 'proj-a')
  const sibling = session('sibling', 'ws-a', 'proj-a')
  const otherProject = session('other-project', 'ws-a', 'proj-b')
  const otherWorkspace = session('other-workspace', 'ws-b', 'proj-a')
  const sessions = new Map([
    [caller.id, caller],
    [sibling.id, sibling],
    [otherProject.id, otherProject],
    [otherWorkspace.id, otherWorkspace],
  ])

  it('returns a target owned by the caller Project', () => {
    expect(getSessionInSameProject(sessions, caller, sibling.id))
      .toBe(sibling)
  })

  it('rejects a target in another Project', () => {
    expect(() => getSessionInSameProject(sessions, caller, otherProject.id))
      .toThrow('CROSS_PROJECT_SESSION')
  })

  it('rejects the same Project id from another Workspace', () => {
    expect(() => getSessionInSameProject(sessions, caller, otherWorkspace.id))
      .toThrow('CROSS_PROJECT_SESSION')
  })

  it('rejects an unknown target', () => {
    expect(() => getSessionInSameProject(sessions, caller, 'missing'))
      .toThrow('SESSION_NOT_FOUND')
  })
})
