import { describe, expect, it } from 'bun:test'

import { withProjectNoteTargetTimeout } from '../project-note-target-timeout'

describe('ProjectNoteTargetPicker helpers', () => {
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
