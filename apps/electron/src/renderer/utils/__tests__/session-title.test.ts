import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@/atoms/sessions'
import { getSessionTitle } from '../session'

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    ...overrides,
  }
}

describe('getSessionTitle', () => {
  it('keeps an explicit user name without applying the inferred-title limit', () => {
    const name = 'A'.repeat(80)

    expect(getSessionTitle(session({ name, preview: 'ignored' }))).toBe(name)
  })

  it('sanitizes and limits an inferred title to 50 characters plus ellipsis', () => {
    const prefix = '<edit_request>hidden</edit_request><b>'
    const preview = `${prefix}${'A'.repeat(60)}</b>`

    expect(getSessionTitle(session({ preview }))).toBe(`${'A'.repeat(50)}…`)
  })

  it('collapses whitespace in an inferred title', () => {
    expect(getSessionTitle(session({ preview: 'one\n\n  two\tthree' }))).toBe(
      'one two three',
    )
  })
})
