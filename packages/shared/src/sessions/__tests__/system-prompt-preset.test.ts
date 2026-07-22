import { describe, expect, it } from 'bun:test'

import { pickSessionFields } from '../utils'

describe('systemPromptPreset persistence', () => {
  it('keeps tutor mode in the persisted session field set', () => {
    const learningContext = {
      sourceFilename: 'book.epub',
      textbookTitle: 'Book',
      chapterId: 'chapter-1',
      chapterTitle: 'Chapter 1',
      format: 'epub' as const,
    }
    expect(pickSessionFields({ id: 'lesson', systemPromptPreset: 'tutor', learningContext })).toEqual({
      id: 'lesson',
      systemPromptPreset: 'tutor',
      learningContext,
    })
  })
})
