import { MAX_REFERENCE_CONTEXT_CHARS } from '@craft-agent/core'

import type { ChatTextSelection } from './TurnCard'

export function buildUserChatTextSelection(
  messageId: string,
  fullText: string,
  rawSelectedText: string,
  rawStart: number,
): ChatTextSelection | null {
  const selectedText = rawSelectedText.trim()
  if (
    !messageId
    || !selectedText
    || !Number.isSafeInteger(rawStart)
    || rawStart < 0
    || rawStart + rawSelectedText.length > fullText.length
  ) {
    return null
  }

  const leadingWhitespace = rawSelectedText.length - rawSelectedText.trimStart().length
  const trailingWhitespace = rawSelectedText.length - rawSelectedText.trimEnd().length
  const start = rawStart + leadingWhitespace
  const end = rawStart + rawSelectedText.length - trailingWhitespace

  return {
    messageId,
    role: 'user',
    selectedText,
    start,
    end,
    prefix: fullText.slice(Math.max(0, start - MAX_REFERENCE_CONTEXT_CHARS), start),
    suffix: fullText.slice(end, end + MAX_REFERENCE_CONTEXT_CHARS),
  }
}
