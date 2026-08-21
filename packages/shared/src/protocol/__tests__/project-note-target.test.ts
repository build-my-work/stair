import { describe, expect, it } from 'bun:test'

import { isProjectNoteTargetPath } from '../project-note-target'

describe('Project Note 目标路径', () => {
  it('只接受规范的 Markdown 与文本 Project 相对路径', () => {
    expect(isProjectNoteTargetPath('notes/research.md')).toBe(true)
    expect(isProjectNoteTargetPath('notes/research.markdown')).toBe(true)
    expect(isProjectNoteTargetPath('notes/research.TXT')).toBe(true)
    expect(isProjectNoteTargetPath('../outside.md')).toBe(false)
    expect(isProjectNoteTargetPath('notes.json')).toBe(false)
    expect(isProjectNoteTargetPath('.md')).toBe(false)
  })
})
