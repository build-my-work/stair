import {
  type Message,
  type MessageReference,
} from '@craft-agent/core'

import { appendRestoredInput, coerceInputText } from './input-text'
import { mergeDraftReferences } from './session-draft-references'

export function restoreStoppedMessageDraft(input: {
  currentText?: string
  currentReferences: MessageReference[]
  stoppedMessage?: Pick<Message, 'content' | 'references'>
}): {
  text: string
  references: MessageReference[]
  textChanged: boolean
  referencesChanged: boolean
} {
  const currentText = coerceInputText(input.currentText)
  const text = appendRestoredInput(
    currentText,
    coerceInputText(input.stoppedMessage?.content),
  )
  const references = mergeDraftReferences(
    { text: currentText, references: input.currentReferences },
    input.stoppedMessage?.references ?? [],
  ).references ?? input.currentReferences

  return {
    text,
    references,
    textChanged: text !== currentText,
    referencesChanged: references !== input.currentReferences,
  }
}

export function buildSendFailureUpdate(input: {
  messages: Message[]
  optimisticMessageId?: string
  wasProcessingBeforeSend: boolean
  errorContent: string
  errorMessageId: string
  timestamp: number
  retryDraft: boolean
}): {
  isProcessing: boolean
  messages: Message[]
} {
  return {
    isProcessing: input.wasProcessingBeforeSend,
    messages: [
      ...input.messages.map(message => (
        message.id === input.optimisticMessageId
          ? { ...message, isPending: false, isError: true }
          : message
      )),
      {
        id: input.errorMessageId,
        role: 'error',
        content: input.errorContent,
        timestamp: input.timestamp,
        errorActions: [{
          key: input.retryDraft ? 'retry-draft' : 'retry',
          label: 'Retry',
          action: 'retry',
        }],
      },
    ],
  }
}

export function areMemoizedMessagesEqual(
  previous: Message,
  next: Message,
): boolean {
  if (previous.isStreaming || next.isStreaming) return false
  return previous.id === next.id
    && previous.content === next.content
    && previous.role === next.role
    && previous.references === next.references
    && previous.isError === next.isError
}
