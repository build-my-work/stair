import { describe, expect, it } from 'bun:test'

import {
  pickSideChatForBrowserSelection,
  resolveBrowserSelectionSessionRoute,
  type BrowserSelectionSessionMeta,
} from '../browser-selection-routing'

function sessionMap(...sessions: BrowserSelectionSessionMeta[]) {
  return new Map(sessions.map(session => [session.id, session]))
}

describe('browser selection session routing', () => {
  it('never guesses the current chat for an unbound browser', () => {
    expect(resolveBrowserSelectionSessionRoute({
      boundSessionId: null,
      selectionSessionId: null,
    }, sessionMap({ id: 'focused-main' }))).toEqual({
      ok: false,
      reason: 'unbound',
    })
  })

  it('routes a main-session browser back to that main session', () => {
    expect(resolveBrowserSelectionSessionRoute({
      boundSessionId: 'main',
      selectionSessionId: 'main',
    }, sessionMap({ id: 'main' }))).toEqual({
      ok: true,
      sourceSessionId: 'main',
      mainSessionId: 'main',
      boundSideChatSessionId: null,
    })
  })

  it('keeps a bound side chat for side-chat asks while exposing its main session', () => {
    expect(resolveBrowserSelectionSessionRoute({
      boundSessionId: 'side',
      selectionSessionId: 'side',
    }, sessionMap(
      { id: 'main' },
      { id: 'side', sideChatForSessionId: 'main' },
    ))).toEqual({
      ok: true,
      sourceSessionId: 'side',
      mainSessionId: 'main',
      boundSideChatSessionId: 'side',
    })
  })

  it('does not fall back to the selection link when the bound session is stale', () => {
    expect(resolveBrowserSelectionSessionRoute({
      boundSessionId: 'missing',
      selectionSessionId: 'main',
    }, sessionMap({ id: 'main' }))).toEqual({
      ok: false,
      reason: 'missing-session',
    })
  })

  it('keeps the explicit selection link after per-turn browser ownership is released', () => {
    expect(resolveBrowserSelectionSessionRoute({
      boundSessionId: null,
      selectionSessionId: 'main',
    }, sessionMap({ id: 'main' }))).toEqual({
      ok: true,
      sourceSessionId: 'main',
      mainSessionId: 'main',
      boundSideChatSessionId: null,
    })
  })

  it('does not route selections into archived source or parent chats', () => {
    expect(resolveBrowserSelectionSessionRoute({
      boundSessionId: 'main',
      selectionSessionId: 'main',
    }, sessionMap({ id: 'main', isArchived: true }))).toEqual({
      ok: false,
      reason: 'missing-session',
    })

    expect(resolveBrowserSelectionSessionRoute({
      boundSessionId: 'side',
      selectionSessionId: 'side',
    }, sessionMap(
      { id: 'main', isArchived: true },
      { id: 'side', sideChatForSessionId: 'main' },
    ))).toEqual({
      ok: false,
      reason: 'missing-main-session',
    })
  })
})

describe('browser selection side-chat choice', () => {
  const main = { id: 'main' }
  const sideA = { id: 'side-a', sideChatForSessionId: 'main', lastMessageAt: 10 }
  const sideB = { id: 'side-b', sideChatForSessionId: 'main', lastMessageAt: 20 }
  const route = resolveBrowserSelectionSessionRoute({
    boundSessionId: 'main',
    selectionSessionId: 'main',
  }, sessionMap(main))

  if (!route.ok) throw new Error('Expected a resolved route')

  it('prefers the last active valid side-chat tab', () => {
    expect(pickSideChatForBrowserSelection(route, [sideA, sideB], 'side-a')?.id).toBe('side-a')
  })

  it('otherwise reuses the most recently active saved side chat', () => {
    expect(pickSideChatForBrowserSelection(route, [sideA, sideB])?.id).toBe('side-b')
  })

  it('does not reuse archived or unrelated side chats', () => {
    expect(pickSideChatForBrowserSelection(route, [
      { ...sideA, isArchived: true },
      { id: 'other-side', sideChatForSessionId: 'other-main', lastMessageAt: 100 },
    ])).toBeNull()
  })

  it('uses the browser-bound side chat instead of creating or selecting another', () => {
    const sideRoute = resolveBrowserSelectionSessionRoute({
      boundSessionId: 'side-a',
      selectionSessionId: 'side-a',
    }, sessionMap(main, sideA))
    if (!sideRoute.ok) throw new Error('Expected a resolved side-chat route')

    expect(pickSideChatForBrowserSelection(sideRoute, [sideA, sideB], 'side-b')?.id).toBe('side-a')
  })

  it('does not reuse an archived browser-bound side chat', () => {
    const sideRoute = resolveBrowserSelectionSessionRoute({
      boundSessionId: 'side-a',
      selectionSessionId: 'side-a',
    }, sessionMap(main, sideA))
    if (!sideRoute.ok) throw new Error('Expected a resolved side-chat route')

    expect(pickSideChatForBrowserSelection(
      sideRoute,
      [{ ...sideA, isArchived: true }, sideB],
      'side-b',
    )).toBeNull()
  })
})
