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
    }
    const configured = handleProjectNoteTargetChanged(
      makeState(),
      setEvent,
    )
    expect(configured.state.session.projectNoteTargetPath)
      .toBe('notes/research.md')

    const clearEvent: ProjectNoteTargetChangedEvent = {
      ...setEvent,
      relativePath: null,
    }
    const cleared = handleProjectNoteTargetChanged(
      configured.state,
      clearEvent,
    )
    expect(cleared.state.session.projectNoteTargetPath).toBeUndefined()
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
      makeState('notes/old-project.md', 'project-1'),
      event,
    )

    expect(result.state.session.projectId).toBe('project-2')
    expect(result.state.session.projectNoteTargetPath).toBeUndefined()
  })

  it('keeps the target for a duplicate Project event', () => {
    const event: ProjectIdChangedEvent = {
      type: 'project_id_changed',
      sessionId: 'session-1',
      projectId: 'project-1',
    }

    const result = handleProjectIdChanged(
      makeState('notes/current.md', 'project-1'),
      event,
    )

    expect(result.state.session.projectNoteTargetPath)
      .toBe('notes/current.md')
  })
})
