import { describe, expect, it } from 'bun:test'

import {
  PROJECT_NOTE_TARGET_EXTENSIONS,
  isProjectNoteTargetPath,
} from '../project-note-target'

describe('Project note target paths', () => {
  it('accepts supported note files case-insensitively', () => {
    expect(PROJECT_NOTE_TARGET_EXTENSIONS).toEqual(['md', 'markdown', 'txt'])
    expect(isProjectNoteTargetPath('notes.md')).toBe(true)
    expect(isProjectNoteTargetPath('Notes.MD')).toBe(true)
    expect(isProjectNoteTargetPath('research/journal.markdown')).toBe(true)
    expect(isProjectNoteTargetPath('research/JOURNAL.MARKDOWN')).toBe(true)
    expect(isProjectNoteTargetPath('research/quotes.txt')).toBe(true)
    expect(isProjectNoteTargetPath('research/QUOTES.TXT')).toBe(true)
  })

  it('rejects unsupported extensions and extension-only hidden files', () => {
    expect(isProjectNoteTargetPath('notes.mdx')).toBe(false)
    expect(isProjectNoteTargetPath('notes.json')).toBe(false)
    expect(isProjectNoteTargetPath('book.epub')).toBe(false)
    expect(isProjectNoteTargetPath('.md')).toBe(false)
    expect(isProjectNoteTargetPath('..md')).toBe(false)
    expect(isProjectNoteTargetPath('.notes.md')).toBe(true)
  })
})
