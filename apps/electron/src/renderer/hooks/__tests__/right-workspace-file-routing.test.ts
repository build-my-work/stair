import { describe, expect, it } from 'bun:test'

import { isProjectRelativeFilePath } from '../file-routing'

describe('right workspace file routing', () => {
  it('accepts project-relative paths', () => {
    expect(isProjectRelativeFilePath('books/operating-systems.epub')).toBe(true)
    expect(isProjectRelativeFilePath('./notes/chapter-1.md')).toBe(true)
  })

  it('keeps absolute and escaping paths on the legacy preview route', () => {
    expect(isProjectRelativeFilePath('/Users/me/book.epub')).toBe(false)
    expect(isProjectRelativeFilePath('C:\\books\\book.epub')).toBe(false)
    expect(isProjectRelativeFilePath('../outside.md')).toBe(false)
    expect(isProjectRelativeFilePath('file:///tmp/book.epub')).toBe(false)
  })
})
