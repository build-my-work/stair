import { writeFile } from 'node:fs/promises'
import type {
  SaveTextFileRequest,
  SaveTextFileResponse,
} from '@craft-agent/shared/protocol'

export const SAVE_TEXT_FILE_IPC_CHANNEL = '__dialog:saveTextFile'

interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}

interface SaveTextFileMainDeps {
  ipcMain: {
    handle(
      channel: string,
      handler: (event: { sender: unknown }, request: SaveTextFileRequest) => Promise<SaveTextFileResponse>,
    ): void
  }
  dialog: {
    showSaveDialog(...args: unknown[]): Promise<SaveDialogResult>
  }
  BrowserWindow: {
    fromWebContents(sender: unknown): unknown
    getFocusedWindow(): unknown
    getAllWindows(): unknown[]
  }
  writeUtf8File?: (path: string, content: string) => Promise<void>
}

export async function saveTextFileWithDialog(
  dialog: SaveTextFileMainDeps['dialog'],
  parentWindow: unknown,
  request: SaveTextFileRequest,
  writeUtf8File: (path: string, content: string) => Promise<void> =
    (path, content) => writeFile(path, content, 'utf8'),
): Promise<SaveTextFileResponse> {
  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, { defaultPath: request.suggestedName })
    : await dialog.showSaveDialog({ defaultPath: request.suggestedName })

  if (result.canceled || !result.filePath) {
    return { saved: false }
  }

  await writeUtf8File(result.filePath, request.content)
  return { saved: true }
}

export function registerSaveTextFileIpc(deps: SaveTextFileMainDeps): void {
  deps.ipcMain.handle(SAVE_TEXT_FILE_IPC_CHANNEL, async (event, request) => {
    const parentWindow = deps.BrowserWindow.fromWebContents(event.sender)
      ?? deps.BrowserWindow.getFocusedWindow()
      ?? deps.BrowserWindow.getAllWindows()[0]

    return saveTextFileWithDialog(
      deps.dialog,
      parentWindow,
      request,
      deps.writeUtf8File,
    )
  })
}
