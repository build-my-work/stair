import { describe, expect, it } from 'bun:test'
import { handleComplete, handleInterrupted, handleQueuedInputRestored, handleUserMessage } from '../session'
import type { SessionState, InterruptedEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
      isProcessing: true,
    } as any,
    streaming: null,
  }
}

describe('handleInterrupted (#616)', () => {
  describe('user-initiated stop (event.message present)', () => {
    it('keeps queued bubbles until draft persistence is acknowledged', () => {
      const state = makeState([
        { id: 'msg-1', role: 'user', content: 'first' },
        { id: 'msg-2', role: 'user', content: 'queued one', isQueued: true },
        { id: 'msg-3', role: 'user', content: 'queued two', isQueued: true },
      ])

      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 0 } as any,
        queuedMessages: ['queued one', 'queued two'],
        queuedRestoreId: 'restore-1',
        queuedMessageIds: ['msg-2', 'msg-3'],
      }

      const next = handleInterrupted(state, event)

      // queued bubbles remain until the draft write and server ack succeed
      const ids = next.state.session.messages.map(m => m.id)
      expect(ids).toContain('msg-2')
      expect(ids).toContain('msg-3')
      expect(next.state.session.messages.find(message => message.id === 'msg-2'))
        .toEqual(expect.objectContaining({
          isQueued: true,
          queuedRestoreId: 'restore-1',
        }))
      // info message appended
      expect(ids).toContain('info-1')
      // restore_input effect emitted with combined text
      expect(next.effects).toEqual([
        {
          type: 'restore_input',
          text: 'queued one\n\nqueued two',
          queuedRestoreId: 'restore-1',
          messageIds: ['msg-2', 'msg-3'],
        },
      ])
      // isProcessing cleared
      expect(next.state.session.isProcessing).toBe(false)

      const completed = handleComplete(next.state, {
        type: 'complete',
        sessionId: 'session-1',
      })
      expect(completed.state.session.messages.find(message => message.id === 'msg-2')?.isQueued)
        .toBe(true)
    })

    it('removes an optimistic bubble when restore events use its server id', () => {
      const optimisticState = makeState([
        {
          id: 'optimistic-queued',
          role: 'user',
          content: 'queued one',
          timestamp: 100,
          isPending: true,
          isQueued: true,
        },
      ])
      const queued = handleUserMessage(optimisticState, {
        type: 'user_message',
        sessionId: 'session-1',
        message: {
          id: 'server-queued',
          role: 'user',
          content: 'queued one',
          timestamp: 101,
        },
        status: 'queued',
        optimisticMessageId: 'optimistic-queued',
      })
      const interrupted = handleInterrupted(queued.state, {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 102 },
        queuedMessages: ['queued one'],
        queuedRestoreId: 'restore-1',
        queuedMessageIds: ['server-queued'],
      })

      expect(interrupted.state.session.messages.find(message => message.id === 'optimistic-queued'))
        .toEqual(expect.objectContaining({ queuedRestoreId: 'restore-1' }))

      const restored = handleQueuedInputRestored(interrupted.state, {
        type: 'queued_input_restored',
        sessionId: 'session-1',
        queuedRestoreId: 'restore-1',
        messageIds: ['server-queued'],
      })
      expect(restored.state.session.messages.map(message => message.id))
        .not.toContain('optimistic-queued')
    })

    it('restores structured references from queued messages with the input text', () => {
      const reference = {
        version: 1,
        kind: 'chat-message',
        projectId: 'project-1',
        sessionId: 'source-session',
        messageId: 'source-message',
        role: 'assistant',
        quote: 'quoted text',
        locator: {
          type: 'text-quote',
          exact: 'quoted text',
          start: 0,
          end: 11,
        },
      } as const
      const state = makeState([
        { id: 'msg-1', role: 'user', content: 'first' },
        { id: 'msg-2', role: 'user', content: 'queued with reference', isQueued: true, references: [reference] },
      ])

      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 0 } as any,
        queuedMessages: ['queued with reference'],
        queuedReferences: [reference],
        queuedRestoreId: 'restore-with-reference',
        queuedMessageIds: ['msg-2'],
      }

      const next = handleInterrupted(state, event)

      expect(next.effects).toEqual([{
        type: 'restore_input',
        text: 'queued with reference',
        references: [reference],
        queuedRestoreId: 'restore-with-reference',
        messageIds: ['msg-2'],
      }])
    })

    it('restores queued attachments into the draft effect', () => {
      const state = makeState([
        { id: 'msg-2', role: 'user', content: 'queued with file', isQueued: true },
      ])
      const queuedAttachment = {
        id: 'attachment-1',
        type: 'text',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 12,
        storedPath: '/tmp/session/attachments/notes.txt',
      } as const

      const next = handleInterrupted(state, {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 0 } as any,
        queuedMessages: ['queued with file'],
        queuedAttachments: [queuedAttachment],
        queuedRestoreId: 'restore-with-attachment',
        queuedMessageIds: ['msg-2'],
      })

      expect(next.effects).toEqual([{
        type: 'restore_input',
        text: 'queued with file',
        attachments: [{ path: queuedAttachment.storedPath, name: queuedAttachment.name }],
        queuedRestoreId: 'restore-with-attachment',
        messageIds: ['msg-2'],
      }])
    })

    it('still works when no queued bubbles exist', () => {
      const state = makeState([
        { id: 'msg-1', role: 'user', content: 'first' },
      ])
      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 0 } as any,
      }

      const next = handleInterrupted(state, event)
      expect(next.effects).toEqual([])
      expect(next.state.session.messages.map(m => m.id)).toContain('info-1')
    })
  })

  describe('silent redirect (event.message absent)', () => {
    it('KEEPS queued bubbles in chat and does NOT emit restore_input (#616 fix)', () => {
      const state = makeState([
        { id: 'msg-1', role: 'user', content: 'first' },
        { id: 'msg-2', role: 'user', content: 'queued during run', isQueued: true },
      ])

      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        // no message field — silent redirect
        queuedMessages: ['queued during run'],
      }

      const next = handleInterrupted(state, event)

      // queued bubble must remain so the user sees it
      const ids = next.state.session.messages.map(m => m.id)
      expect(ids).toContain('msg-2')
      // no info bubble appended
      expect(ids).not.toContain('info-1')
      // critically: no restore_input effect — backend will auto-replay
      expect(next.effects).toEqual([])
      // isProcessing still gets cleared
      expect(next.state.session.isProcessing).toBe(false)
    })

    it('marks running tools as interrupted regardless of redirect type', () => {
      const state = makeState([
        { id: 'tool-1', role: 'tool', toolStatus: 'executing', toolResult: undefined },
      ])
      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
      }

      const next = handleInterrupted(state, event)
      const tool = next.state.session.messages[0] as any
      expect(tool.toolStatus).toBe('error')
      expect(tool.toolResult).toBe('Interrupted')
      expect(tool.isError).toBe(true)
    })
  })

  it('restores a persisted queued draft after restart without adding an info bubble', () => {
    const state = makeState([
      { id: 'msg-2', role: 'user', content: 'queued before crash', isQueued: true },
    ])

    const next = handleInterrupted(state, {
      type: 'interrupted',
      sessionId: 'session-1',
      queuedMessages: ['queued before crash'],
      queuedRestoreId: 'restore-after-restart',
      queuedMessageIds: ['msg-2'],
    })

    expect(next.effects).toEqual([{
      type: 'restore_input',
      text: 'queued before crash',
      queuedRestoreId: 'restore-after-restart',
      messageIds: ['msg-2'],
    }])
    expect(next.state.session.messages).toHaveLength(1)
  })

  it('always strips transient status messages', () => {
    const state = makeState([
      { id: 'msg-1', role: 'user', content: 'hi' },
      { id: 'status-1', role: 'status', content: 'thinking…' },
    ])
    const event: InterruptedEvent = {
      type: 'interrupted',
      sessionId: 'session-1',
    }

    const next = handleInterrupted(state, event)
    const ids = next.state.session.messages.map(m => m.id)
    expect(ids).not.toContain('status-1')
    expect(ids).toContain('msg-1')
  })

  it('removes only the queued bubbles confirmed by the server acknowledgement', () => {
    const state = makeState([
      { id: 'msg-1', role: 'user', content: 'first' },
      { id: 'msg-2', role: 'user', content: 'queued one', isQueued: true },
      { id: 'msg-3', role: 'user', content: 'queued two', isQueued: true },
    ])

    const next = handleQueuedInputRestored(state, {
      type: 'queued_input_restored',
      sessionId: 'session-1',
      queuedRestoreId: 'restore-1',
      messageIds: ['msg-2', 'unknown-message'],
    })

    expect(next.state.session.messages.map(message => message.id)).toEqual(['msg-1', 'msg-3'])
    expect(next.effects).toEqual([])
  })
})
