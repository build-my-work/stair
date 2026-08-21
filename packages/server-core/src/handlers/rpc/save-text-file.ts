import { posix, win32 } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type {
  SaveTextFileRequest,
  SaveTextFileResponse,
} from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import { requestClientSaveTextFile } from '@craft-agent/server-core/transport'

export const MAX_SAVED_TEXT_BYTES = 8 * 1024 * 1024
const MAX_SUGGESTED_FILENAME_BYTES = 255
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*]/

export const HANDLED_CHANNELS = [RPC_CHANNELS.dialog.SAVE_TEXT_FILE] as const

export function validateSaveTextFileRequest(value: unknown): SaveTextFileRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid text save request')
  const candidate = value as { suggestedName?: unknown; content?: unknown }
  if (typeof candidate.suggestedName !== 'string') {
    throw new Error('Invalid suggested filename')
  }

  const suggestedName = candidate.suggestedName
  const windowsStem = suggestedName.split('.')[0] ?? ''
  if (
    suggestedName.length === 0
    || suggestedName === '.'
    || suggestedName === '..'
    || suggestedName.trim() !== suggestedName
    || suggestedName.endsWith('.')
    || posix.basename(suggestedName) !== suggestedName
    || win32.basename(suggestedName) !== suggestedName
    || posix.isAbsolute(suggestedName)
    || win32.isAbsolute(suggestedName)
    || Buffer.byteLength(suggestedName, 'utf8') > MAX_SUGGESTED_FILENAME_BYTES
    || CONTROL_CHARACTERS.test(suggestedName)
    || WINDOWS_FORBIDDEN_CHARACTERS.test(suggestedName)
    || WINDOWS_RESERVED_BASENAME.test(windowsStem)
  ) {
    throw new Error('Invalid suggested filename')
  }
  if (typeof candidate.content !== 'string') throw new Error('Invalid text content')
  if (Buffer.byteLength(candidate.content, 'utf8') > MAX_SAVED_TEXT_BYTES) {
    throw new Error('Text content exceeds the save limit')
  }
  return { suggestedName, content: candidate.content }
}

export function registerSaveTextFileHandlers(server: RpcServer): void {
  server.handle(
    RPC_CHANNELS.dialog.SAVE_TEXT_FILE,
    async (ctx, value: unknown): Promise<SaveTextFileResponse> => {
      return requestClientSaveTextFile(
        server,
        ctx.clientId,
        validateSaveTextFileRequest(value),
      )
    },
  )
}
