import {
  MAX_CHAT_SELECTION_CONTEXT_CHARS,
  type ChatMessageSelectionReferenceV1,
} from '@craft-agent/core'
import type { ChatTextSelection } from '@craft-agent/ui'

export function buildChatSelectionReference(
  sessionId: string,
  selection: ChatTextSelection,
): ChatMessageSelectionReferenceV1 {
  const selectedText = selection.selectedText
  const quote = selectedText.trim()
  const textWithoutLeadingWhitespace = selectedText.trimStart()
  const textWithoutTrailingWhitespace = selectedText.trimEnd()
  const leadingWhitespace =
    selectedText.length - textWithoutLeadingWhitespace.length
  const prefix = `${selection.prefix}${selectedText.slice(0, leadingWhitespace)}`
    .slice(-MAX_CHAT_SELECTION_CONTEXT_CHARS)
  const suffix = `${selectedText.slice(textWithoutTrailingWhitespace.length)}${selection.suffix}`
    .slice(0, MAX_CHAT_SELECTION_CONTEXT_CHARS)
  const start = selection.start + leadingWhitespace

  return {
    version: 1,
    kind: 'chat-message',
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
