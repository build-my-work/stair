import {
  MAX_REFERENCE_CONTEXT_CHARS,
  MAX_REFERENCE_QUOTE_CHARS,
  type ChatMessageReferenceV1,
} from '@craft-agent/core'
import type { ChatTextSelection } from '@craft-agent/ui'

export function buildChatSelectionReference(
  projectId: string,
  sessionId: string,
  selection: ChatTextSelection,
): ChatMessageReferenceV1 | null {
  const selectedText = selection.selectedText
  const quote = selectedText.trim()
  if (!quote || quote.length > MAX_REFERENCE_QUOTE_CHARS) return null
  const leadingWhitespace = selectedText.length - selectedText.trimStart().length
  const trailingStart = selectedText.trimEnd().length
  const prefix = `${selection.prefix}${selectedText.slice(0, leadingWhitespace)}`
    .slice(-MAX_REFERENCE_CONTEXT_CHARS)
  const suffix = `${selectedText.slice(trailingStart)}${selection.suffix}`
    .slice(0, MAX_REFERENCE_CONTEXT_CHARS)
  const start = selection.start + leadingWhitespace

  return {
    version: 1,
    kind: 'chat-message',
    projectId,
    sessionId,
    messageId: selection.messageId,
    role: selection.role,
    quote,
    locator: {
      type: 'text-quote',
      exact: quote,
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
      start,
      end: start + quote.length,
    },
  }
}
