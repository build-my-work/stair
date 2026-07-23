import { describe, expect, it } from 'bun:test'

import { pickSessionFields } from '../utils'

describe('systemPromptPreset persistence', () => {
  it('keeps tutor mode in the persisted session field set', () => {
    expect(pickSessionFields({ id: 'lesson', systemPromptPreset: 'tutor' })).toEqual({
      id: 'lesson',
      systemPromptPreset: 'tutor',
    })
  })
})
