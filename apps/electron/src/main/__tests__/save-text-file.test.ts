import { describe, expect, it } from 'bun:test'
import {
  registerSaveTextFileIpc,
  SAVE_TEXT_FILE_IPC_CHANNEL,
  saveTextFileWithDialog,
} from '../save-text-file'

describe('native text save bridge', () => {
  it('writes UTF-8 content only to the path confirmed by the Save dialog', async () => {
    const parentWindow = { id: 'window-1' }
    const calls: unknown[][] = []
    const writes: Array<{ path: string; content: string }> = []
    const dialog = {
      async showSaveDialog(...args: unknown[]) {
        calls.push(args)
        return { canceled: false, filePath: '/user/chosen/highlights.md' }
      },
    }

    const result = await saveTextFileWithDialog(
      dialog,
      parentWindow,
      { suggestedName: 'Book-highlights.md', content: '# Book\n' },
      async (path, content) => {
        writes.push({ path, content })
      },
    )

    expect(result).toEqual({ saved: true })
    expect(calls).toEqual([[
      parentWindow,
      { defaultPath: 'Book-highlights.md' },
    ]])
    expect(writes).toEqual([{
      path: '/user/chosen/highlights.md',
      content: '# Book\n',
    }])
  })

  it('does not write when the user cancels', async () => {
    let writeCount = 0
    const result = await saveTextFileWithDialog(
      {
        async showSaveDialog() {
          return { canceled: true }
        },
      },
      undefined,
      { suggestedName: 'highlights.md', content: 'not written' },
      async () => {
        writeCount += 1
      },
    )

    expect(result).toEqual({ saved: false })
    expect(writeCount).toBe(0)
  })

  it('registers one main-only IPC handler and resolves its parent window', async () => {
    let registeredChannel = ''
    let registeredHandler:
      | ((event: { sender: unknown }, request: {
          suggestedName: string
          content: string
        }) => Promise<{ saved: boolean }>)
      | undefined
    const sender = { id: 'sender' }
    const parentWindow = { id: 'parent' }
    const calls: unknown[][] = []

    registerSaveTextFileIpc({
      ipcMain: {
        handle(channel, handler) {
          registeredChannel = channel
          registeredHandler = handler
        },
      },
      dialog: {
        async showSaveDialog(...args: unknown[]) {
          calls.push(args)
          return { canceled: true }
        },
      },
      BrowserWindow: {
        fromWebContents(value) {
          expect(value).toBe(sender)
          return parentWindow
        },
        getFocusedWindow: () => null,
        getAllWindows: () => [],
      },
      writeUtf8File: async () => {
        throw new Error('cancel must not write')
      },
    })

    expect(registeredChannel).toBe(SAVE_TEXT_FILE_IPC_CHANNEL)
    expect(await registeredHandler!({ sender }, {
      suggestedName: 'highlights.md',
      content: 'text',
    })).toEqual({ saved: false })
    expect(calls[0]?.[0]).toBe(parentWindow)
  })
})
