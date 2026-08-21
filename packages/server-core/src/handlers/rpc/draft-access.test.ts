import { describe, expect, it } from 'bun:test'

import {
  assertDraftSessionAccess,
  authorizedDraftSessionIds,
  filterDraftsForWorkspace,
} from './draft-access'

const sessions = [
  { id: 'session-a', workspaceId: 'workspace-a' },
  { id: 'session-b', workspaceId: 'workspace-b' },
]

describe('Draft Workspace 授权', () => {
  it('要求当前 Workspace，并且只授权自身 Session', () => {
    expect(() => authorizedDraftSessionIds(null, sessions))
      .toThrow(/^DRAFT_WORKSPACE_REQUIRED:/)
    expect(authorizedDraftSessionIds('workspace-a', sessions))
      .toEqual(new Set(['session-a']))
    expect(() => assertDraftSessionAccess('workspace-a', sessions, 'session-b'))
      .toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)
    expect(() => assertDraftSessionAccess('workspace-a', sessions, 'missing'))
      .toThrow(/^DRAFT_SESSION_ACCESS_DENIED:/)
    expect(() => assertDraftSessionAccess('workspace-a', sessions, 'session-a'))
      .not.toThrow()
  })

  it('GET_ALL 不暴露其他 Workspace 或已删除 Session 的 Draft', () => {
    expect(filterDraftsForWorkspace('workspace-a', sessions, {
      'session-a': { text: 'visible' },
      'session-b': { text: 'private' },
      stale: { text: 'deleted Session' },
    })).toEqual({
      'session-a': { text: 'visible' },
    })
  })
})
