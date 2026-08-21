import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BROWSER_BOOKMARKS_FILE,
  loadBrowserBookmarks,
  removeBrowserBookmark,
  toggleBrowserBookmark,
} from './index'

describe('browser bookmarks storage', () => {
  let workspaceRootPath = ''

  beforeEach(() => {
    workspaceRootPath = mkdtempSync(join(tmpdir(), 'stair-browser-bookmarks-'))
  })

  afterEach(() => {
    rmSync(workspaceRootPath, { recursive: true, force: true })
  })

  it('adds, lists, toggles, and removes Workspace bookmarks in one versioned document', () => {
    const first = toggleBrowserBookmark(workspaceRootPath, {
      url: 'https://example.com/one',
      title: 'One',
    }).bookmarks[0]!
    const second = toggleBrowserBookmark(workspaceRootPath, {
      url: 'https://example.com/two',
      title: 'Two',
    }).bookmarks[0]!

    expect(loadBrowserBookmarks(workspaceRootPath)).toEqual([second, first])
    expect(toggleBrowserBookmark(workspaceRootPath, {
      url: first.url,
      title: 'Ignored duplicate title',
    }).isBookmarked).toBe(false)
    expect(removeBrowserBookmark(workspaceRootPath, second.id)).toEqual([])
    expect(JSON.parse(readFileSync(
      join(workspaceRootPath, BROWSER_BOOKMARKS_FILE),
      'utf8',
    ))).toEqual({ version: 1, bookmarks: [] })
  })

  it('rejects non-web URLs and preserves malformed stored data', () => {
    expect(() => toggleBrowserBookmark(workspaceRootPath, {
      url: 'file:///tmp/private.txt',
      title: 'Private',
    })).toThrow('Only HTTP(S) pages can be bookmarked')

    const filePath = join(workspaceRootPath, BROWSER_BOOKMARKS_FILE)
    writeFileSync(filePath, '{"version":1,"bookmarks":"broken"}', 'utf8')
    expect(() => toggleBrowserBookmark(workspaceRootPath, {
      url: 'https://example.com',
      title: 'Example',
    })).toThrow('unsupported format')
    expect(readFileSync(filePath, 'utf8')).toBe('{"version":1,"bookmarks":"broken"}')
  })
})
