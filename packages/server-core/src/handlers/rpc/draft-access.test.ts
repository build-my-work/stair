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

describe('Draft workspace authorization', () => {
  it('requires an active workspace and authorizes only its Sessions', () => {
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

  it('filters GET_ALL without exposing another workspace or stale Sessions', () => {
    expect(filterDraftsForWorkspace('workspace-a', sessions, {
      'session-a': { text: 'visible' },
      'session-b': { text: 'private' },
      stale: { text: 'deleted Session' },
    })).toEqual({
      'session-a': { text: 'visible' },
    })
  })
})
