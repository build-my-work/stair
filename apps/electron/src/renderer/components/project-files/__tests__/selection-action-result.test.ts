import { describe, expect, it } from 'bun:test'

import { shouldDismissReaderSelection } from '../selection-action-result'

describe('Reader 引用动作完成状态', () => {
  it('仅在动作成功或没有返回值时收起选区，取消选择 Note 目标时保留', () => {
    expect(shouldDismissReaderSelection(true)).toBe(true)
    expect(shouldDismissReaderSelection()).toBe(true)
    expect(shouldDismissReaderSelection(false)).toBe(false)
  })
})
