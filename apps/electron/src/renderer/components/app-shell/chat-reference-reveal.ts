import type { TextQuoteLocatorV1 } from '@craft-agent/core'

export interface ChatReferenceRevealIntent {
  messageId: string
  locator: TextQuoteLocatorV1
}

const pendingRevealBySession = new Map<string, ChatReferenceRevealIntent>()

export function queueChatReferenceReveal(
  sessionId: string,
  intent: ChatReferenceRevealIntent,
): void {
  pendingRevealBySession.set(sessionId, intent)
}

export function consumeChatReferenceReveal(
  sessionId: string,
): ChatReferenceRevealIntent | null {
  const intent = pendingRevealBySession.get(sessionId) ?? null
  if (intent) pendingRevealBySession.delete(sessionId)
  return intent
}

export function resolveChatReferenceTextRange(
  text: string,
  locator: TextQuoteLocatorV1,
): { start: number; end: number } | null {
  if (text.slice(locator.start, locator.end) === locator.exact) {
    return { start: locator.start, end: locator.end }
  }

  const candidates: number[] = []
  let cursor = 0
  while (cursor <= text.length - locator.exact.length) {
    const start = text.indexOf(locator.exact, cursor)
    if (start < 0) break
    candidates.push(start)
    cursor = start + Math.max(locator.exact.length, 1)
  }
  if (candidates.length === 0) return null

  const contextual = candidates.filter(start => {
    const prefixMatches = locator.prefix === undefined
      || text.slice(Math.max(0, start - locator.prefix.length), start) === locator.prefix
    const end = start + locator.exact.length
    const suffixMatches = locator.suffix === undefined
      || text.slice(end, end + locator.suffix.length) === locator.suffix
    return prefixMatches && suffixMatches
  })
  const resolved = contextual.length === 1
    ? contextual[0]
    : candidates.length === 1
      ? candidates[0]
      : undefined
  return resolved === undefined
    ? null
    : { start: resolved, end: resolved + locator.exact.length }
}
