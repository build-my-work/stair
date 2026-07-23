import { describe, expect, it } from 'bun:test'

import {
  getWorkspaceFileKind,
  getWorkspaceFileLanguage,
} from '../workspace-file-types'

describe('WorkspaceFileTab routing', () => {
  it('routes learning and document formats to dedicated viewers', () => {
    expect(getWorkspaceFileKind('books/OS.EPUB')).toBe('epub')
    expect(getWorkspaceFileKind('papers/design.pdf')).toBe('pdf')
    expect(getWorkspaceFileKind('notes/chapter.markdown')).toBe('markdown')
    expect(getWorkspaceFileKind('images/diagram.webp')).toBe('image')
  })

  it('routes common source files to the text viewer with a language', () => {
    expect(getWorkspaceFileKind('src/index.tsx')).toBe('text')
    expect(getWorkspaceFileLanguage('src/index.tsx')).toBe('tsx')
    expect(getWorkspaceFileLanguage('Dockerfile')).toBe('dockerfile')
  })

  it('falls back to the external application for unsupported binary files', () => {
    expect(getWorkspaceFileKind('archives/course.zip')).toBe('external')
    expect(getWorkspaceFileKind('media/lecture.mp4')).toBe('external')
  })
})
