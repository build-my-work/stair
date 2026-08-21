import { describe, expect, it } from 'bun:test'

import {
  consumeChatReferenceReveal,
  queueChatReferenceReveal,
  resolveChatReferenceTextRange,
} from '../chat-reference-reveal'

const intent = {
  messageId: 'message-a',
  locator: {
    type: 'text-quote' as const,
    exact: 'selected text',
    prefix: 'before ',
    suffix: ' after',
    start: 7,
    end: 20,
  },
}

describe('聊天引用 reveal mailbox', () => {
  it('在目标 ChatDisplay 挂载后只消费一次', () => {
    queueChatReferenceReveal('session-a', intent)

    expect(consumeChatReferenceReveal('session-b')).toBeNull()
    expect(consumeChatReferenceReveal('session-a')).toEqual(intent)
    expect(consumeChatReferenceReveal('session-a')).toBeNull()
  })

  it('同一 Session 的最新显式点击覆盖尚未消费的旧意图', () => {
    queueChatReferenceReveal('session-a', {
      ...intent,
      messageId: 'message-old',
    })
    queueChatReferenceReveal('session-a', {
      ...intent,
      messageId: 'message-new',
    })

    expect(consumeChatReferenceReveal('session-a')?.messageId).toBe('message-new')
  })

  it('优先使用稳定 offset，内容漂移时按 quote context 重新定位', () => {
    expect(resolveChatReferenceTextRange('before selected text after', intent.locator))
      .toEqual({ start: 7, end: 20 })

    expect(resolveChatReferenceTextRange(
      'new prefix before selected text after tail',
      intent.locator,
    )).toEqual({ start: 18, end: 31 })
  })

  it('重复 quote 无法由上下文判定时保守拒绝', () => {
    expect(resolveChatReferenceTextRange(
      'selected text / selected text',
      { ...intent.locator, prefix: 'missing', suffix: 'missing' },
    )).toBeNull()
  })
})
