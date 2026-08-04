import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BROWSER_BOOKMARKS_FILE,
  loadBrowserBookmarks,
  removeBrowserBookmark,
  toggleBrowserBookmark,
} from './index.ts';

describe('browser bookmarks storage', () => {
  let workspaceRootPath: string;

  beforeEach(() => {
    workspaceRootPath = mkdtempSync(join(tmpdir(), 'browser-bookmarks-'));
  });

  afterEach(() => {
    rmSync(workspaceRootPath, { recursive: true, force: true });
  });

  it('treats a missing file as an empty bookmark list', () => {
    expect(loadBrowserBookmarks(workspaceRootPath)).toEqual([]);
  });

  it('adds the newest bookmark first and persists the versioned document', () => {
    const result = toggleBrowserBookmark(workspaceRootPath, {
      url: 'https://example.com/article',
      title: 'Example article',
    });

    expect(result.isBookmarked).toBe(true);
    expect(result.bookmarks).toHaveLength(1);
    expect(result.bookmarks[0]).toMatchObject({
      url: 'https://example.com/article',
      title: 'Example article',
    });
    expect(loadBrowserBookmarks(workspaceRootPath)).toEqual(result.bookmarks);

    const document = JSON.parse(readFileSync(
      join(workspaceRootPath, BROWSER_BOOKMARKS_FILE),
      'utf8',
    ));
    expect(document).toEqual({ version: 1, bookmarks: result.bookmarks });
  });

  it('uses the hostname when the page title is empty', () => {
    const result = toggleBrowserBookmark(workspaceRootPath, {
      url: 'https://docs.example.com/guide',
      title: '   ',
    });

    expect(result.bookmarks[0]?.title).toBe('docs.example.com');
  });

  it('toggles an existing URL off without creating duplicates', () => {
    toggleBrowserBookmark(workspaceRootPath, {
      url: 'https://example.com/article',
      title: 'First title',
    });
    const result = toggleBrowserBookmark(workspaceRootPath, {
      url: 'https://example.com/article',
      title: 'Updated title',
    });

    expect(result).toEqual({ bookmarks: [], isBookmarked: false });
    expect(loadBrowserBookmarks(workspaceRootPath)).toEqual([]);
  });

  it('removes a bookmark by id', () => {
    const first = toggleBrowserBookmark(workspaceRootPath, {
      url: 'https://example.com/one',
      title: 'One',
    }).bookmarks[0]!;
    toggleBrowserBookmark(workspaceRootPath, {
      url: 'https://example.com/two',
      title: 'Two',
    });

    expect(removeBrowserBookmark(workspaceRootPath, first.id)).toEqual([
      expect.objectContaining({ url: 'https://example.com/two' }),
    ]);
  });

  it('rejects non-web URLs without creating a bookmark file', () => {
    expect(() => toggleBrowserBookmark(workspaceRootPath, {
      url: 'file:///tmp/private.txt',
      title: 'Private file',
    })).toThrow('Only HTTP(S) pages can be bookmarked');

    expect(loadBrowserBookmarks(workspaceRootPath)).toEqual([]);
  });

  it('does not silently replace a malformed bookmark file', () => {
    const filePath = join(workspaceRootPath, BROWSER_BOOKMARKS_FILE);
    writeFileSync(filePath, '{"version":1,"bookmarks":"broken"}', 'utf8');

    expect(() => toggleBrowserBookmark(workspaceRootPath, {
      url: 'https://example.com',
      title: 'Example',
    })).toThrow('unsupported format');
    expect(readFileSync(filePath, 'utf8')).toBe('{"version":1,"bookmarks":"broken"}');
  });
});
