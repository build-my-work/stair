import { describe, expect, it } from 'bun:test'

import { handleSessionMetadataChanged } from '../session'
import type { SessionMetadataChangedEvent, SessionState } from '../../types'

describe('handleSessionMetadataChanged', () => {
  it('把 WS 可传输的 null 归一化为已清除的 Project Note 目标', () => {
    const state = {
      session: {
        id: 'session-1',
        projectNoteTargetPath: 'notes/research.md',
        messages: [],
      },
      streaming: null,
    } as unknown as SessionState
    const event: SessionMetadataChangedEvent = {
      type: 'session_metadata_changed',
      sessionId: 'session-1',
      changes: {
        projectNoteTargetPath: null,
      },
    }

    const next = handleSessionMetadataChanged(state, event)

    expect(next.state.session.projectNoteTargetPath).toBeUndefined()
  })
})
