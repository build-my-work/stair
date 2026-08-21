import { describe, expect, it } from 'bun:test'

import { resolveProjectFileMarkdownTarget } from '../project-file-markdown-links'

describe('Project File Markdown links', () => {
  it('resolves relative files from the current Project File directory', () => {
    expect(resolveProjectFileMarkdownTarget(
      'docs/guides/start.md',
      '../reference/api.ts#client',
    )).toEqual({
      kind: 'project-file',
      relativePath: 'docs/reference/api.ts',
    })
  })

  it('keeps supported web links on the existing URL path', () => {
    expect(resolveProjectFileMarkdownTarget(
      'docs/start.md',
      'https://example.com/guide?q=1#intro',
    )).toEqual({
      kind: 'url',
      url: 'https://example.com/guide?q=1#intro',
    })
  })

  it('blocks dangerous URLs and relative paths that escape the project', () => {
    expect(resolveProjectFileMarkdownTarget(
      'docs/start.md',
      'javascript:alert(1)',
    ).kind).toBe('blocked')
    expect(resolveProjectFileMarkdownTarget(
      'docs/start.md',
      '../../outside.md',
    ).kind).toBe('blocked')
  })

  it('blocks anchor-only and query-only targets without a relative file path', () => {
    expect(resolveProjectFileMarkdownTarget(
      'docs/start.md',
      '#section',
    )).toEqual({ kind: 'blocked', target: '#section' })
    expect(resolveProjectFileMarkdownTarget(
      'docs/start.md',
      '?mode=print',
    )).toEqual({ kind: 'blocked', target: '?mode=print' })
  })
})
