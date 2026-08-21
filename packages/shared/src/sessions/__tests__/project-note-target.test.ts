import { describe, expect, it } from 'bun:test'

import { SESSION_PERSISTENT_FIELDS } from '../types'
import { pickSessionFields } from '../utils'

describe('Session Project Note 目标持久化', () => {
  it('持久化当前目标、Project 根指纹和最近目标', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('projectNoteTargetPath')
    expect(SESSION_PERSISTENT_FIELDS).toContain('projectNoteTargetRootFingerprint')
    expect(SESSION_PERSISTENT_FIELDS).toContain('projectNoteRecentTargetPaths')
    expect(pickSessionFields({
      id: 'session-1',
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/research.md',
      projectNoteTargetRootFingerprint: 'root-fingerprint',
      projectNoteRecentTargetPaths: ['notes/research.md', 'notes/earlier.md'],
      runtimeOnly: true,
    })).toEqual({
      id: 'session-1',
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/research.md',
      projectNoteTargetRootFingerprint: 'root-fingerprint',
      projectNoteRecentTargetPaths: ['notes/research.md', 'notes/earlier.md'],
    })
  })
})
