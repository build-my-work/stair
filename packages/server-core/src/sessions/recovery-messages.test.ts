import { describe, expect, it } from 'bun:test'

import type { Message, Reference } from '@craft-agent/core'
import { buildRecoveryMessages } from './recovery-messages.ts'

const reference: Reference = {
  version: 1,
  kind: 'project-file',
  projectId: 'project-a',
  relativePath: 'docs/guide.md',
  sourceFingerprint: `sha256:${'a'.repeat(64)}`,
  fileName: 'guide.md',
  quote: 'selected text',
  locator: {
    type: 'text-quote',
    exact: 'selected text',
    start: 0,
    end: 13,
  },
}

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return {
    timestamp: 1,
    ...overrides,
  }
}

describe('recovery history model context', () => {
  it('carries persisted references on historical user messages only', () => {
    const messages = buildRecoveryMessages([
      message({
        id: 'user-reference',
        role: 'user',
        content: 'explain this',
        references: [reference],
      }),
      message({
        id: 'assistant',
        role: 'assistant',
        content: 'answer',
        references: [reference],
      }),
      message({
        id: 'user-plain',
        role: 'user',
        content: 'plain follow-up',
      }),
    ])

    expect(messages[0]?.type).toBe('user')
    expect(messages[0]?.content).toBe('explain this')
    expect(messages[0]?.referenceContext).toContain('<stair_reference_data trust="untrusted">')
    expect(messages[0]?.referenceContext).toContain('docs/guide.md')
    expect(messages[0]?.referenceContext).toEndWith('</stair_reference_data>')
    expect(messages[1]).toEqual({ type: 'assistant', content: 'answer' })
    expect(messages[2]).toEqual({ type: 'user', content: 'plain follow-up' })
  })

  it('preserves existing filtering and recovery-window semantics', () => {
    const history = Array.from({ length: 8 }, (_, index) => message({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      ...(index === 1 ? { isIntermediate: true } : {}),
    }))

    expect(buildRecoveryMessages(history, 6).map(entry => entry.content)).toEqual([
      'message 2',
      'message 3',
      'message 4',
      'message 5',
      'message 6',
      'message 7',
    ])
    expect(buildRecoveryMessages([
      ...history,
      message({ id: 'tool', role: 'tool', content: 'tool output' }),
    ])).toHaveLength(7)
  })
})
