import { describe, expect, it } from 'bun:test'
import { getDeleteSessionConfirmationDetail } from './auth'

describe('getDeleteSessionConfirmationDetail', () => {
  it('uses the ordinary irreversible warning when there are no side chats', () => {
    expect(getDeleteSessionConfirmationDetail(0)).toBe('This action cannot be undone.')
  })

  it('warns that related persistent side chats are deleted too', () => {
    expect(getDeleteSessionConfirmationDetail(2)).toBe(
      'This also deletes 2 related side chats. This action cannot be undone.',
    )
  })
})
