import { afterEach, describe, expect, it } from 'bun:test'
import {
  safeSuggestedTextFilename,
  saveTextFile,
} from '../save-text-file'

const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL

afterEach(() => {
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
  })
  URL.createObjectURL = originalCreateObjectUrl
  URL.revokeObjectURL = originalRevokeObjectUrl
})

describe('safeSuggestedTextFilename', () => {
  it('removes path syntax, controls, and Windows reserved names', () => {
    expect(safeSuggestedTextFilename('../Book: Notes/highlights.md'))
      .toBe('.._Book_ Notes_highlights.md')
    expect(safeSuggestedTextFilename('CON.md')).toBe('_CON.md')
    expect(safeSuggestedTextFilename(' \u0000 ')).toBe('highlights.md')
  })

  it('keeps the extension while capping the UTF-8 byte length', () => {
    const filename = safeSuggestedTextFilename(`${'书'.repeat(200)}-highlights.md`)
    expect(filename.endsWith('.md')).toBe(true)
    expect(new TextEncoder().encode(filename).byteLength).toBeLessThanOrEqual(200)
  })
})

describe('saveTextFile renderer adapter', () => {
  it('uses the Electron API with a safe suggestion and no output path', async () => {
    const requests: unknown[] = []
    ;(globalThis as { window: unknown }).window = {
      electronAPI: {
        getRuntimeEnvironment: () => 'electron',
        saveTextFile: async (request: unknown) => {
          requests.push(request)
          return { saved: false }
        },
      },
    }

    expect(await saveTextFile({
      suggestedName: '../Book:highlights.md',
      content: '# Book\n',
    })).toEqual({ saved: false })
    expect(requests).toEqual([{
      suggestedName: '.._Book_highlights.md',
      content: '# Book\n',
    }])
  })

  it('uses one Blob download in the web runtime and revokes its URL', async () => {
    const actions: string[] = []
    const anchor = {
      href: '',
      download: '',
      style: { display: '' },
      click() {
        actions.push('click')
      },
      remove() {
        actions.push('remove')
      },
    }
    ;(globalThis as { window: unknown }).window = {
      electronAPI: {
        getRuntimeEnvironment: () => 'web',
      },
    }
    ;(globalThis as { document: unknown }).document = {
      createElement(tag: string) {
        expect(tag).toBe('a')
        return anchor
      },
      body: {
        appendChild(value: unknown) {
          expect(value).toBe(anchor)
          actions.push('append')
        },
      },
    }
    URL.createObjectURL = (blob: Blob) => {
      expect(blob.type).toBe('text/markdown;charset=utf-8')
      actions.push('create')
      return 'blob:export'
    }
    URL.revokeObjectURL = (url: string) => {
      expect(url).toBe('blob:export')
      actions.push('revoke')
    }

    expect(await saveTextFile({
      suggestedName: 'Book-highlights.md',
      content: '# Book\n',
    })).toEqual({ saved: true })
    expect(anchor.href).toBe('blob:export')
    expect(anchor.download).toBe('Book-highlights.md')
    expect(actions).toEqual(['create', 'append', 'click', 'remove', 'revoke'])
  })
})
