import { describe, expect, it } from 'bun:test'
import {
  handleProjectIdChanged,
  handleProjectNoteTargetChanged,
} from '../session'
import type {
  ProjectIdChangedEvent,
  ProjectNoteTargetChangedEvent,
  SessionState,
} from '../../types'

function makeState(
  projectNoteTargetPath?: string,
  projectId?: string,
  projectNoteRecentTargetPaths?: string[],
): SessionState {
  return {
    session: {
      id: 'session-1',
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      messages: [],
      lastMessageAt: Date.now(),
      isProcessing: false,
      projectId,
      projectNoteTargetPath,
      projectNoteRecentTargetPaths,
    },
    streaming: null,
  }
}

describe('handleProjectNoteTargetChanged', () => {
  it('sets and clears the target on only that Session state', () => {
    const setEvent: ProjectNoteTargetChangedEvent = {
      type: 'project_note_target_changed',
      sessionId: 'session-1',
      relativePath: 'notes/research.md',
      recentPaths: ['notes/research.md', 'notes/earlier.md'],
    }
    const configured = handleProjectNoteTargetChanged(
      makeState(),
      setEvent,
    )
    expect(configured.state.session.projectNoteTargetPath)
      .toBe('notes/research.md')
    expect(configured.state.session.projectNoteRecentTargetPaths)
      .toEqual(['notes/research.md', 'notes/earlier.md'])

    const clearEvent: ProjectNoteTargetChangedEvent = {
      ...setEvent,
      relativePath: null,
      recentPaths: [],
    }
    const cleared = handleProjectNoteTargetChanged(
      configured.state,
      clearEvent,
    )
    expect(cleared.state.session.projectNoteTargetPath).toBeUndefined()
    expect(cleared.state.session.projectNoteRecentTargetPaths).toBeUndefined()
  })
})

describe('handleProjectIdChanged', () => {
  it('clears the old note target atomically when the Project changes', () => {
    const event: ProjectIdChangedEvent = {
      type: 'project_id_changed',
      sessionId: 'session-1',
      projectId: 'project-2',
    }

    const result = handleProjectIdChanged(
      makeState(
        'notes/old-project.md',
        'project-1',
        ['notes/old-project.md', 'notes/older.md'],
      ),
      event,
    )

    expect(result.state.session.projectId).toBe('project-2')
    expect(result.state.session.projectNoteTargetPath).toBeUndefined()
    expect(result.state.session.projectNoteRecentTargetPaths).toBeUndefined()
  })

  it('keeps the target for a duplicate Project event', () => {
    const event: ProjectIdChangedEvent = {
      type: 'project_id_changed',
      sessionId: 'session-1',
      projectId: 'project-1',
    }

    const result = handleProjectIdChanged(
      makeState(
        'notes/current.md',
        'project-1',
        ['notes/current.md', 'notes/earlier.md'],
      ),
      event,
    )

    expect(result.state.session.projectNoteTargetPath)
      .toBe('notes/current.md')
    expect(result.state.session.projectNoteRecentTargetPaths)
      .toEqual(['notes/current.md', 'notes/earlier.md'])
  })
})
