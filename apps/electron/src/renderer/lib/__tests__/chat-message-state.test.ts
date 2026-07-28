import { describe, expect, it } from 'bun:test'
import type { Message, MessageReference } from '@craft-agent/core'

import {
  areMemoizedMessagesEqual,
  buildSendFailureUpdate,
  restoreStoppedMessageDraft,
} from '../chat-message-state'

const reference: MessageReference = {
  version: 1,
  kind: 'project-file',
  projectId: 'project-1',
  relativePath: 'books/os.epub',
  sourceFingerprint: `sha256:${'a'.repeat(64)}`,
  fileName: 'os.epub',
  quote: 'selected text',
  tocPath: [],
  locator: {
    type: 'epub-cfi',
    cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:4)',
  },
}

function message(patch: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    role: 'user',
    content: 'hello',
    timestamp: 1,
    ...patch,
  }
}

describe('stopped message draft recovery', () => {
  it('restores text and structured references together', () => {
    const restored = restoreStoppedMessageDraft({
      currentText: 'new draft',
      currentReferences: [],
      stoppedMessage: message({ references: [reference] }),
    })

    expect(restored.text).toBe('new draft\n\nhello')
    expect(restored.references).toEqual([reference])
    expect(restored.textChanged).toBe(true)
    expect(restored.referencesChanged).toBe(true)
  })

  it('restores a reference-only turn without requiring message text', () => {
    const restored = restoreStoppedMessageDraft({
      currentText: '',
      currentReferences: [],
      stoppedMessage: message({ content: '', references: [reference] }),
    })

    expect(restored.text).toBe('')
    expect(restored.textChanged).toBe(false)
    expect(restored.references).toEqual([reference])
    expect(restored.referencesChanged).toBe(true)
  })

  it('uses the shared Draft merge limit when restoring stopped references', () => {
    const references = Array.from({ length: 40 }, (_, index) => ({
      ...reference,
      locator: {
        type: 'epub-cfi' as const,
        cfiRange: `epubcfi(/6/${index + 2})`,
      },
    }))
    const restored = restoreStoppedMessageDraft({
      currentText: '',
      currentReferences: [],
      stoppedMessage: message({ content: '', references }),
    })

    expect(restored.references).toHaveLength(32)
  })
})

describe('send failure state', () => {
  it('keeps an existing turn processing when a mid-stream send is rejected', () => {
    const optimistic = message({ id: 'optimistic', isPending: true })
    const update = buildSendFailureUpdate({
      messages: [optimistic],
      optimisticMessageId: optimistic.id,
      wasProcessingBeforeSend: true,
      errorContent: 'Failed to send message: stale reference',
      errorMessageId: 'error-1',
      timestamp: 2,
      retryDraft: false,
    })

    expect(update.isProcessing).toBe(true)
    expect(update.messages[0]).toMatchObject({
      id: optimistic.id,
      isPending: false,
      isError: true,
    })
  })

  it('clears processing when the failed send started an idle turn', () => {
    const update = buildSendFailureUpdate({
      messages: [],
      wasProcessingBeforeSend: false,
      errorContent: 'Failed to send message: unavailable reference',
      errorMessageId: 'error-1',
      timestamp: 2,
      retryDraft: true,
    })

    expect(update.isProcessing).toBe(false)
    expect(update.messages[0]?.errorActions?.[0]?.key).toBe('retry-draft')
  })
})

describe('memoized message equality', () => {
  it('re-renders when the send-error marker changes', () => {
    const previous = message({ isError: false })
    const next = message({ isError: true })

    expect(areMemoizedMessagesEqual(previous, next)).toBe(false)
  })
})
