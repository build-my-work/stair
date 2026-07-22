import { describe, expect, it } from 'bun:test'

import type { ImportedChapter, ImportedTextbook } from '@craft-agent/shared/learning'

import { buildLessonKickoff, resolveLessonLanguage } from './lesson-kickoff'

const chapter: ImportedChapter = {
  id: 'chapter-1',
  title: '第一章',
  level: 1,
  order: 0,
  locator: { format: 'epub', href: 'chapter-1.xhtml', spineIndex: 0 },
  content: '章节正文',
}

const textbook: ImportedTextbook = {
  format: 'epub',
  sourceFilename: '操作系统导论.epub',
  title: '操作系统导论',
  chapters: [chapter],
}

describe('lesson kickoff', () => {
  it('prefers the trimmed textbook language over the interface language', () => {
    const chineseTextbook = { ...textbook, language: '  zh-CN  ' }

    expect(resolveLessonLanguage(chineseTextbook, 'en')).toBe('zh-CN')
    expect(buildLessonKickoff(chineseTextbook, chapter, 'en')).toContain(
      'Teach this lesson in "zh-CN".',
    )
  })

  it('falls back to the interface language when the textbook language is blank', () => {
    expect(resolveLessonLanguage({ ...textbook, language: '  ' }, 'en-US')).toBe('en-US')
  })
})
