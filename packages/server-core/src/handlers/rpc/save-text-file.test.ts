import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import {
  CLIENT_SAVE_TEXT_FILE,
  LOCAL_CLIENT_CAPABILITIES,
} from '@craft-agent/server-core/transport'
import {
  MAX_SAVED_TEXT_BYTES,
  registerSaveTextFileHandlers,
  validateSaveTextFileRequest,
} from './save-text-file'

type Handler = (
  ctx: { clientId: string },
  value: unknown,
) => Promise<unknown>

function createServer(capabilityResult: { saved: boolean }) {
  let handler: Handler | undefined
  const invocations: Array<{
    clientId: string
    capability: string
    request: unknown
  }> = []

  const server = {
    handle(channel: string, nextHandler: Handler) {
      expect(channel).toBe(RPC_CHANNELS.dialog.SAVE_TEXT_FILE)
      handler = nextHandler
    },
    async invokeClient(clientId: string, capability: string, request: unknown) {
      invocations.push({ clientId, capability, request })
      return capabilityResult
    },
  } as unknown as RpcServer

  registerSaveTextFileHandlers(server)
  return {
    invoke: (value: unknown) => handler!({ clientId: 'desktop-1' }, value),
    invocations,
  }
}

describe('save text file RPC', () => {
  it('forwards only validated text and basename to the local capability', async () => {
    const { invoke, invocations } = createServer({ saved: true })
    const result = await invoke({
      suggestedName: 'Book-highlights.md',
      content: '# Book\n',
      outputPath: '/caller/must/not/control.md',
    })

    expect(result).toEqual({ saved: true })
    expect(invocations).toEqual([{
      clientId: 'desktop-1',
      capability: CLIENT_SAVE_TEXT_FILE,
      request: {
        suggestedName: 'Book-highlights.md',
        content: '# Book\n',
      },
    }])
  })

  it('preserves a canceled capability result', async () => {
    const { invoke } = createServer({ saved: false })
    expect(await invoke({
      suggestedName: 'highlights.md',
      content: 'text',
    })).toEqual({ saved: false })
  })

  it('rejects paths and unsafe cross-platform basenames', () => {
    for (const suggestedName of [
      '../outside.md',
      'folder/file.md',
      'folder\\file.md',
      '/absolute.md',
      'C:\\absolute.md',
      '.',
      '..',
      ' trailing.md',
      'trailing.md.',
      'bad:name.md',
      'CON.md',
      'nul\u0000.md',
    ]) {
      expect(() => validateSaveTextFileRequest({
        suggestedName,
        content: '',
      })).toThrow('Invalid suggested filename')
    }
  })

  it('enforces the UTF-8 content byte limit', () => {
    expect(validateSaveTextFileRequest({
      suggestedName: 'highlights.md',
      content: 'a'.repeat(MAX_SAVED_TEXT_BYTES),
    }).content).toHaveLength(MAX_SAVED_TEXT_BYTES)

    expect(() => validateSaveTextFileRequest({
      suggestedName: 'highlights.md',
      content: `${'a'.repeat(MAX_SAVED_TEXT_BYTES)}b`,
    })).toThrow('Text content exceeds the save limit')
  })

  it('advertises the save capability for local Electron clients', () => {
    expect(LOCAL_CLIENT_CAPABILITIES).toContain(CLIENT_SAVE_TEXT_FILE)
  })
})
