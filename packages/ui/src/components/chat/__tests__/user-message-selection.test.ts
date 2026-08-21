import { describe, expect, it } from 'bun:test'

import { buildUserChatTextSelection } from '../user-message-selection'

describe('用户消息选区引用', () => {
  it('生成 user 角色，并在修剪空白后保留稳定上下文', () => {
    expect(buildUserChatTextSelection(
      'message-user',
      'before  selected text \nafter',
      '  selected text \n',
      6,
    )).toEqual({
      messageId: 'message-user',
      role: 'user',
      selectedText: 'selected text',
      start: 8,
      end: 21,
      prefix: 'before  ',
      suffix: ' \nafter',
    })
  })

  it('忽略纯空白选区', () => {
    expect(buildUserChatTextSelection('message-user', '   ', '  ', 0)).toBeNull()
  })
})
