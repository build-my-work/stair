import { describe, expect, it } from 'bun:test'

import { isReference } from '@craft-agent/core'
import { buildChatSelectionReference } from '../selection-reference'

describe('聊天选区引用', () => {
  it('修剪选区空白，同时保留稳定位置和上下文', () => {
    const reference = buildChatSelectionReference('project-a', 'session-a', {
      messageId: 'message-a',
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
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-a',
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
    expect(isReference(reference)).toBe(true)
  })

  it('拒绝空白选区和超过统一引用上限的聊天选区', () => {
    const base = {
      messageId: 'message-a',
      role: 'assistant' as const,
      start: 0,
      end: 0,
      prefix: '',
      suffix: '',
    }
    expect(buildChatSelectionReference('project-a', 'session-a', {
      ...base,
      selectedText: '   \n',
    })).toBeNull()
    expect(buildChatSelectionReference('project-a', 'session-a', {
      ...base,
      selectedText: 'x'.repeat(4_001),
      end: 4_001,
    })).toBeNull()
  })
})
