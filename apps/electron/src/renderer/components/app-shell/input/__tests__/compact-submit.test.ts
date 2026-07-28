import { describe, expect, it } from 'bun:test'

import {
  isCompactCommand,
  submitCompactCommand,
  type InputSubmitHandler,
} from '../compact-submit'

describe('compact command submission', () => {
  it('recognizes only the compact slash command', () => {
    expect(isCompactCommand('/compact')).toBe(true)
    expect(isCompactCommand('  /COMPACT keep decisions  ')).toBe(true)
    expect(isCompactCommand('/compaction')).toBe(false)
    expect(isCompactCommand('please /compact')).toBe(false)
  })

  it('submits without consuming the structured Draft', async () => {
    const references = [{ relativePath: 'book.epub' }]
    let submittedArgs: Parameters<InputSubmitHandler> | undefined

    const onSubmit: InputSubmitHandler = (...args) => {
      submittedArgs = args
      if (args[3]?.consumeDraft !== false) {
        references.length = 0
      }
    }

    await submitCompactCommand(onSubmit, '/compact keep decisions')

    expect(submittedArgs).toEqual([
      '/compact keep decisions',
      undefined,
      undefined,
      { consumeDraft: false },
    ])
    expect(references).toEqual([{ relativePath: 'book.epub' }])
  })

  it('propagates send rejection so every fire-and-forget caller must catch it', async () => {
    await expect(submitCompactCommand(async () => {
      throw new Error('send rejected')
    })).rejects.toThrow('send rejected')
  })
})
