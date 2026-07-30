import { describe, expect, it } from 'bun:test'
import { SESSION_PERSISTENT_FIELDS } from '../types'
import { pickSessionFields } from '../utils'

describe('Session Project note target persistence', () => {
  it('persists the Session-scoped target path', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('projectNoteTargetPath')
    expect(pickSessionFields({
      id: 'session-1',
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/research.md',
      unrelatedRuntimeValue: true,
    })).toEqual({
      id: 'session-1',
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/research.md',
    })
  })
})
