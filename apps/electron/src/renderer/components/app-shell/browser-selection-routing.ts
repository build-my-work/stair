export interface BrowserSelectionBinding {
  boundSessionId: string | null
  selectionSessionId: string | null
}

export interface BrowserSelectionSessionMeta {
  id: string
  sideChatForSessionId?: string
  isArchived?: boolean
  lastMessageAt?: number
}

export type BrowserSelectionSessionRoute =
  | {
    ok: true
    sourceSessionId: string
    mainSessionId: string
    boundSideChatSessionId: string | null
  }
  | {
    ok: false
    reason: 'unbound' | 'missing-session' | 'missing-main-session'
  }

/**
 * Resolve only the session explicitly attached to the browser instance.
 * The currently focused chat is intentionally not a fallback.
 */
export function resolveBrowserSelectionSessionRoute(
  binding: BrowserSelectionBinding,
  sessions: ReadonlyMap<string, BrowserSelectionSessionMeta>,
): BrowserSelectionSessionRoute {
  // Agent ownership is released after each turn. selectionSessionId preserves
  // the explicit citation destination independently from browser ownership.
  const sourceSessionId = binding.boundSessionId ?? binding.selectionSessionId
  if (!sourceSessionId) {
    return { ok: false, reason: 'unbound' }
  }

  const sourceSession = sessions.get(sourceSessionId)
  if (!sourceSession || sourceSession.isArchived) {
    return { ok: false, reason: 'missing-session' }
  }

  const mainSessionId = sourceSession.sideChatForSessionId ?? sourceSession.id
  const mainSession = sessions.get(mainSessionId)
  if (!mainSession || mainSession.isArchived) {
    return { ok: false, reason: 'missing-main-session' }
  }

  return {
    ok: true,
    sourceSessionId,
    mainSessionId,
    boundSideChatSessionId: sourceSession.sideChatForSessionId
      ? sourceSession.id
      : null,
  }
}

/**
 * A browser already bound to a side chat stays on that chat. Otherwise prefer
 * the last active side-chat tab, then the most recently used saved side chat.
 */
export function pickSideChatForBrowserSelection<T extends BrowserSelectionSessionMeta>(
  route: Extract<BrowserSelectionSessionRoute, { ok: true }>,
  sessions: readonly T[],
  activeSideChatSessionId?: string | null,
): T | null {
  if (route.boundSideChatSessionId) {
    return sessions.find(session => (
      session.id === route.boundSideChatSessionId
      && !session.isArchived
    )) ?? null
  }

  if (activeSideChatSessionId) {
    const active = sessions.find(session => (
      session.id === activeSideChatSessionId
      && session.sideChatForSessionId === route.mainSessionId
      && !session.isArchived
    ))
    if (active) return active
  }

  return sessions
    .filter(session => (
      session.sideChatForSessionId === route.mainSessionId
      && !session.isArchived
    ))
    .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))[0] ?? null
}
