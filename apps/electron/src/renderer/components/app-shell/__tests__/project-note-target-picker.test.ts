import { describe, expect, it } from 'bun:test'
import type { ProjectFileSearchResult } from '@craft-agent/shared/protocol'

import {
  filterProjectNoteTargets,
  isProjectNoteTargetPath,
  withProjectNoteTargetTimeout,
} from '../ProjectNoteTargetPicker'

describe('ProjectNoteTargetPicker helpers', () => {
  it('accepts Markdown targets case-insensitively', () => {
    expect(isProjectNoteTargetPath('notes.md')).toBe(true)
    expect(isProjectNoteTargetPath('Notes.MD')).toBe(true)
    expect(isProjectNoteTargetPath('research/journal.markdown')).toBe(true)
    expect(isProjectNoteTargetPath('research/JOURNAL.MARKDOWN')).toBe(true)
    expect(isProjectNoteTargetPath('notes.mdx')).toBe(false)
    expect(isProjectNoteTargetPath('notes.txt')).toBe(false)
  })

  it('keeps distinct paths and removes invalid or duplicate targets', () => {
    const results: ProjectFileSearchResult[] = [
      { name: 'notes.md', relativePath: 'a/notes.md' },
      { name: 'notes.md', relativePath: 'b/notes.md' },
      { name: 'notes.md', relativePath: 'a/notes.md' },
      { name: 'notes.txt', relativePath: 'notes.txt' },
    ]

    expect(filterProjectNoteTargets(results)).toEqual([
      { name: 'notes.md', relativePath: 'a/notes.md' },
      { name: 'notes.md', relativePath: 'b/notes.md' },
    ])
  })

  it('returns a completed target request before the timeout', async () => {
    await expect(
      withProjectNoteTargetTimeout(Promise.resolve('notes.md'), 10),
    ).resolves.toBe('notes.md')
  })

  it('rejects a target request that never completes', async () => {
    await expect(
      withProjectNoteTargetTimeout(new Promise(() => {}), 1),
    ).rejects.toThrow('Setting the Add Note target timed out. Try again.')
  })
})
