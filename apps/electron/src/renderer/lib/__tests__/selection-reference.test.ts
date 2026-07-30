import { describe, expect, it } from 'bun:test'
import {
  isChatMessageSelectionReferenceV1,
} from '@craft-agent/core'
import { buildChatSelectionReference } from '../selection-reference'

describe('buildChatSelectionReference', () => {
  it('normalizes whitespace while preserving stable text positions and context', () => {
    const reference = buildChatSelectionReference('session-1', {
      messageId: 'message-1',
      role: 'plan',
      selectedText: '  selected text \n',
      start: 10,
      end: 27,
      prefix: 'before',
      suffix: 'after',
    })

    expect(reference).toEqual({
      version: 1,
      kind: 'chat-message',
      sessionId: 'session-1',
      messageId: 'message-1',
      role: 'plan',
      quote: 'selected text',
      locator: {
        type: 'text-quote',
        exact: 'selected text',
        prefix: 'before  ',
        suffix: ' \nafter',
        start: 12,
        end: 25,
      },
    })
    expect(isChatMessageSelectionReferenceV1(reference)).toBe(true)
  })

  it('does not introduce a free-form note payload', () => {
    const reference = buildChatSelectionReference('session-1', {
      messageId: 'message-1',
      role: 'user',
      selectedText: 'quote',
      start: 0,
      end: 5,
      prefix: '',
      suffix: '',
    })
    expect(reference).not.toHaveProperty('note')
    expect(reference).not.toHaveProperty('text')
  })
})
