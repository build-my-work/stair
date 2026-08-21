import { afterEach, describe, expect, it } from 'bun:test'
import { safeSuggestedTextFilename, saveTextFile } from '../save-text-file'

const originalWindow = globalThis.window

afterEach(() => {
  Object.assign(globalThis, { window: originalWindow })
})

describe('saveTextFile renderer adapter', () => {
  it('uses the Electron API with a safe suggestion and exact in-memory text', async () => {
    const requests: unknown[] = []
    ;(globalThis as { window: unknown }).window = {
      electronAPI: {
        getRuntimeEnvironment: () => 'electron',
        saveTextFile: async (request: unknown) => {
          requests.push(request)
          return { saved: true }
        },
      },
    }

    expect(safeSuggestedTextFilename('../Book:draft.md')).toBe('.._Book_draft.md')
    expect(await saveTextFile({
      suggestedName: '../Book:draft.md',
      content: 'memory text, not disk text',
    })).toEqual({ saved: true })
    expect(requests).toEqual([{
      suggestedName: '.._Book_draft.md',
      content: 'memory text, not disk text',
    }])
  })
})
