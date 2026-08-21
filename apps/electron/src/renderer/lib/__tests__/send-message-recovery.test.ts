import { describe, expect, it } from 'bun:test'

import { rollbackRejectedOptimisticUserMessage } from '../send-message-recovery'

describe('引用校验失败的 optimistic 消息回滚', () => {
  it('只移除本次仍 pending 的用户气泡', () => {
    const messages = [
      { id: 'older', role: 'user', content: 'older' },
      { id: 'rejected', role: 'user', content: 'rejected', isPending: true },
      { id: 'other-pending', role: 'user', content: 'other', isPending: true },
    ]

    expect(rollbackRejectedOptimisticUserMessage(messages, 'rejected')).toEqual([
      messages[0],
      messages[2],
    ])
  })

  it('不移除已被服务端确认的同 id 消息', () => {
    const confirmed = { id: 'confirmed', role: 'user', content: 'sent', isPending: false }
    expect(rollbackRejectedOptimisticUserMessage([confirmed], confirmed.id)).toEqual([confirmed])
  })
})
