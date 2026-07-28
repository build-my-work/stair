import { describe, expect, it } from 'bun:test'

import { hasDraftSubmissionContent } from '../input-event-guards'

describe('FreeFormInput structured Draft submission', () => {
  it('allows a reference-only Draft and rejects a fully empty Draft', () => {
    expect(hasDraftSubmissionContent({
      text: '',
      attachmentCount: 0,
      followUpCount: 0,
      referenceCount: 1,
    })).toBe(true)
    expect(hasDraftSubmissionContent({
      text: '   ',
      attachmentCount: 0,
      followUpCount: 0,
      referenceCount: 0,
    })).toBe(false)
  })
})
