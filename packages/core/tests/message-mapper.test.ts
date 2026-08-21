import { describe, expect, it } from 'bun:test'

import type { Message, Reference } from '../src/types/index'
import { messageToStored, storedToMessage } from '../src/types/message-mapper'

const reference: Reference = {
  version: 1,
  kind: 'chat-message',
  projectId: 'project-a',
  sessionId: 'session-a',
  messageId: 'message-a',
  role: 'assistant',
  quote: '引用',
  locator: {
    type: 'text-quote',
    exact: '引用',
    start: 0,
    end: 2,
  },
}

describe('消息引用持久化', () => {
  it('runtime 与 StoredMessage 往返时精确保留引用', () => {
    const message: Message = {
      id: 'message-target',
      role: 'user',
      content: '请解释',
      timestamp: 123,
      references: [reference],
    }

    const stored = messageToStored(message)
    expect(stored.references).toEqual([reference])
    expect(storedToMessage(stored)).toEqual(message)
  })
})
