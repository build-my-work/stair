import { describe, expect, it } from 'bun:test'
import { PendingInputJournal, type PendingInput } from '../send-message-recovery'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}
const entry: PendingInput = {
  version: 1, workspaceId: 'workspace-a', projectId: 'project-a', sessionId: 'session-a',
  clientMessageId: 'request-a', createdAt: 1, text: 'body',
  attachments: [{ path: 'paste.txt', name: 'original.txt', content: { type: 'text', mimeType: 'text/plain', size: 7, text: 'payload' } }],
  references: [{ version: 1, kind: 'chat-message', projectId: 'project-a', sessionId: 'source', messageId: 'message', role: 'assistant', quote: 'quote', locator: { type: 'text-quote', exact: 'quote', start: 0, end: 5 } }],
  consumption: { content: { text: '' }, mutation: { id: 'consume-a', clientId: 'writer-a', sequence: 1, baseRevision: 0, base: { text: 'body' } } },
}

describe('pending send durability', () => {
  it('survives a renderer restart with complete input and its original consumption identity', () => {
    const storage = memoryStorage()
    new PendingInputJournal(storage).write(entry)
    const reopened = new PendingInputJournal(storage)
    expect(reopened.list('workspace-a')).toEqual([entry])
    expect(reopened.list('workspace-b')).toEqual([])
    reopened.remove(entry.clientMessageId)
    expect(new PendingInputJournal(storage).list('workspace-a')).toEqual([])
  })

  it('cannot overwrite an independent window entry while recording another input', () => {
    const storage = memoryStorage()
    const first = new PendingInputJournal(storage)
    const second = new PendingInputJournal(storage)
    first.write(entry)
    second.write({ ...entry, clientMessageId: 'request-b' })
    first.remove(entry.clientMessageId)
    expect(second.list('workspace-a').map(value => value.clientMessageId)).toEqual(['request-b'])
  })

  it('exposes quota failure before the caller may clear its composer', () => {
    const storage = memoryStorage()
    storage.setItem = () => { throw new Error('quota exceeded') }
    expect(() => new PendingInputJournal(storage).write(entry)).toThrow('quota exceeded')
  })
})
