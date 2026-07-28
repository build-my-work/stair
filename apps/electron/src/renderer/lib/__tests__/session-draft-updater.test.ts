import { describe, expect, test } from 'bun:test'
import type { MessageReference } from '@craft-agent/core'
import type { SessionDraft } from '@craft-agent/shared/config'
import {
  DRAFT_LOCKED,
  SessionDraftUpdater,
} from '../session-draft-updater'
import {
  addDraftReference,
  getProjectFileReferenceSendError,
  mergeDraftReferences,
} from '../session-draft-references'

const reference: MessageReference = {
  version: 1,
  kind: 'project-file',
  projectId: 'project-1',
  relativePath: 'books/one.epub',
  sourceFingerprint: `sha256:${'a'.repeat(64)}`,
  fileName: 'one.epub',
  quote: 'selected text',
  tocPath: [{
    key: 'toc:0',
    title: 'Chapter 1',
    orderPath: [0],
  }],
  locator: {
    type: 'epub-cfi',
    cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:4)',
  },
}

describe('SessionDraftUpdater', () => {
  test('text and attachment mutations preserve references', () => {
    const drafts = new Map<string, SessionDraft>([
      ['session-1', { text: 'before', references: [reference] }],
    ])
    const updater = new SessionDraftUpdater(drafts, async () => {})

    updater.update('session-1', current => ({
      ...current,
      text: 'after',
    }))
    updater.update('session-1', current => ({
      ...current,
      attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }],
    }))

    expect(updater.get('session-1')).toEqual({
      text: 'after',
      attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }],
      references: [reference],
    })
  })

  test('beginSend snapshots and locks every mutation before async work', () => {
    const drafts = new Map<string, SessionDraft>([
      ['session-1', { text: 'message', references: [reference] }],
    ])
    const updater = new SessionDraftUpdater(drafts, async () => {})
    const send = updater.beginSend('session-1')

    expect(send).toEqual({
      text: 'message',
      references: [reference],
    })
    expect(() => updater.update('session-1', draft => ({ ...draft, text: 'changed' })))
      .toThrow(DRAFT_LOCKED)
    expect(() => updater.beginSend('session-1')).toThrow(DRAFT_LOCKED)
  })

  test('abort keeps the original draft and releases its lock', () => {
    const drafts = new Map<string, SessionDraft>([
      ['session-1', { text: 'message', references: [reference] }],
    ])
    const updater = new SessionDraftUpdater(drafts, async () => {})
    const send = updater.beginSend('session-1')

    updater.abortSend('session-1')

    expect(updater.isLocked('session-1')).toBe(false)
    expect(updater.get('session-1')).toEqual(send)
  })

  test('finish clears memory, persists immediately, and releases its lock', async () => {
    const drafts = new Map<string, SessionDraft>([
      ['session-1', { text: 'message', references: [reference] }],
    ])
    const persisted: Array<[string, SessionDraft]> = []
    const updater = new SessionDraftUpdater(drafts, async (sessionId, draft) => {
      persisted.push([sessionId, draft])
    })
    updater.beginSend('session-1')

    await updater.finishSend('session-1')

    expect(updater.get('session-1')).toBeUndefined()
    expect(updater.isLocked('session-1')).toBe(false)
    expect(persisted).toEqual([['session-1', { text: '' }]])
  })

  test('finish persistence failure keeps memory clear and still unlocks', async () => {
    const drafts = new Map<string, SessionDraft>([
      ['session-1', { text: 'message' }],
    ])
    const updater = new SessionDraftUpdater(drafts, async () => {
      throw new Error('disk full')
    })
    updater.beginSend('session-1')

    await expect(updater.finishSend('session-1')).rejects.toThrow('disk full')

    expect(updater.get('session-1')).toBeUndefined()
    expect(updater.isLocked('session-1')).toBe(false)
  })

  test('reference add preserves text and deduplicates by locator', () => {
    const original: SessionDraft = { text: 'keep me' }
    const added = addDraftReference(original, reference)
    const duplicate = addDraftReference(added, { ...reference, quote: 'new quote' })

    expect(duplicate.text).toBe('keep me')
    expect(duplicate.references).toEqual([reference])
  })

  test('restored references deduplicate and stop at the draft limit', () => {
    const incoming = Array.from({ length: 40 }, (_, index) => ({
      ...reference,
      locator: {
        type: 'epub-cfi' as const,
        cfiRange: `epubcfi(/6/${index + 2})`,
      },
    }))

    const restored = mergeDraftReferences(
      { text: 'restored', references: [incoming[0]] },
      incoming,
    )

    expect(restored.text).toBe('restored')
    expect(restored.references).toHaveLength(32)
    expect(restored.references?.[0]).toEqual(incoming[0])
  })

  test('notifies only the target Session and only when references change', () => {
    const updater = new SessionDraftUpdater(new Map(), async () => {})
    const snapshots: MessageReference[][] = []
    const unsubscribe = updater.subscribeReferences('session-1', references => {
      snapshots.push(references)
    })

    updater.update('session-1', draft => ({ ...draft, text: 'typing' }))
    updater.update('session-1', draft => ({
      ...draft,
      attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }],
    }))
    updater.update(
      'session-1',
      draft => addDraftReference(draft, reference),
    )
    updater.update(
      'session-2',
      draft => addDraftReference(draft, reference),
    )
    unsubscribe()
    updater.update(
      'session-1',
      draft => ({ ...draft, references: undefined }),
    )

    expect(snapshots).toEqual([[reference]])
  })

  test('hydrates references, keeps them on abort, and clears them after send', async () => {
    const updater = new SessionDraftUpdater(new Map(), async () => {})
    const snapshots: MessageReference[][] = []
    updater.subscribeReferences('session-1', references => {
      snapshots.push(references)
    })

    updater.replaceAll({
      'session-1': {
        text: '',
        references: [reference],
      },
    })
    updater.replaceAll({
      'session-1': {
        text: 'hydrated text changed',
        references: [reference],
      },
    })
    updater.update('session-1', draft => ({ ...draft, text: 'typing' }))
    updater.beginSend('session-1')
    updater.abortSend('session-1')
    updater.beginSend('session-1')
    await updater.finishSend('session-1')

    expect(snapshots).toEqual([
      [reference],
      [],
    ])
  })

  test('recognizes send-boundary stale reference errors through RPC wrappers', () => {
    expect(getProjectFileReferenceSendError(
      new Error(
        'RPC failed: PROJECT_FILE_REFERENCE_STALE: Referenced Project File has changed: books/one.epub',
      ),
      [reference],
    )).toEqual({
      code: 'PROJECT_FILE_REFERENCE_STALE',
      message: 'Referenced Project File has changed: books/one.epub',
      relativePath: 'books/one.epub',
    })
    expect(getProjectFileReferenceSendError(new Error('network unavailable'))).toBeNull()
  })
})
