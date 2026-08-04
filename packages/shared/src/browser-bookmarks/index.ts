import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';

export const BROWSER_BOOKMARKS_FILE = 'browser-bookmarks.json';

const BROWSER_BOOKMARKS_VERSION = 1;
const MAX_BOOKMARK_ID_CHARS = 128;
const MAX_BOOKMARK_URL_CHARS = 8_192;
const MAX_BOOKMARK_TITLE_CHARS = 512;

export interface BrowserBookmark {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

interface BrowserBookmarksDocument {
  version: typeof BROWSER_BOOKMARKS_VERSION;
  bookmarks: BrowserBookmark[];
}

export interface ToggleBrowserBookmarkInput {
  url: string;
  title: string;
}

export interface ToggleBrowserBookmarkResult {
  bookmarks: BrowserBookmark[];
  isBookmarked: boolean;
}

function normalizeBookmarkUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  if (!url || url.length > MAX_BOOKMARK_URL_CHARS) {
    throw new Error('BROWSER_BOOKMARK_INVALID: Invalid bookmark URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('BROWSER_BOOKMARK_INVALID: Invalid bookmark URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('BROWSER_BOOKMARK_INVALID: Only HTTP(S) pages can be bookmarked');
  }
  return url;
}

function isBrowserBookmark(value: unknown): value is BrowserBookmark {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bookmark = value as Partial<BrowserBookmark>;
  if (
    typeof bookmark.id !== 'string'
    || !bookmark.id.trim()
    || bookmark.id.length > MAX_BOOKMARK_ID_CHARS
    || typeof bookmark.url !== 'string'
    || typeof bookmark.title !== 'string'
    || !bookmark.title.trim()
    || bookmark.title.length > MAX_BOOKMARK_TITLE_CHARS
    || typeof bookmark.createdAt !== 'number'
    || !Number.isSafeInteger(bookmark.createdAt)
    || bookmark.createdAt <= 0
  ) {
    return false;
  }

  try {
    return normalizeBookmarkUrl(bookmark.url) === bookmark.url;
  } catch {
    return false;
  }
}

function saveBrowserBookmarks(
  workspaceRootPath: string,
  bookmarks: BrowserBookmark[],
): void {
  const document: BrowserBookmarksDocument = {
    version: BROWSER_BOOKMARKS_VERSION,
    bookmarks,
  };
  atomicWriteFileSync(
    join(workspaceRootPath, BROWSER_BOOKMARKS_FILE),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

export function loadBrowserBookmarks(workspaceRootPath: string): BrowserBookmark[] {
  const filePath = join(workspaceRootPath, BROWSER_BOOKMARKS_FILE);
  if (!existsSync(filePath)) return [];

  const document = readJsonFileSync<unknown>(filePath);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('BROWSER_BOOKMARKS_INVALID: Bookmark file must be an object');
  }

  const candidate = document as Partial<BrowserBookmarksDocument>;
  if (
    candidate.version !== BROWSER_BOOKMARKS_VERSION
    || !Array.isArray(candidate.bookmarks)
    || !candidate.bookmarks.every(isBrowserBookmark)
  ) {
    throw new Error('BROWSER_BOOKMARKS_INVALID: Bookmark file has an unsupported format');
  }
  return candidate.bookmarks;
}

export function toggleBrowserBookmark(
  workspaceRootPath: string,
  input: ToggleBrowserBookmarkInput,
): ToggleBrowserBookmarkResult {
  const url = normalizeBookmarkUrl(input.url);
  const bookmarks = loadBrowserBookmarks(workspaceRootPath);

  if (bookmarks.some(bookmark => bookmark.url === url)) {
    const remainingBookmarks = bookmarks.filter(bookmark => bookmark.url !== url);
    saveBrowserBookmarks(workspaceRootPath, remainingBookmarks);
    return { bookmarks: remainingBookmarks, isBookmarked: false };
  }

  const title = input.title.trim() || new URL(url).hostname;
  if (!title || title.length > MAX_BOOKMARK_TITLE_CHARS) {
    throw new Error('BROWSER_BOOKMARK_INVALID: Invalid bookmark title');
  }

  const newBookmark: BrowserBookmark = {
    id: randomUUID(),
    url,
    title,
    createdAt: Date.now(),
  };
  const updatedBookmarks = [newBookmark, ...bookmarks];
  saveBrowserBookmarks(workspaceRootPath, updatedBookmarks);
  return { bookmarks: updatedBookmarks, isBookmarked: true };
}

export function removeBrowserBookmark(
  workspaceRootPath: string,
  bookmarkId: string,
): BrowserBookmark[] {
  const bookmarks = loadBrowserBookmarks(workspaceRootPath);
  const remainingBookmarks = bookmarks.filter(bookmark => bookmark.id !== bookmarkId);
  if (remainingBookmarks.length !== bookmarks.length) {
    saveBrowserBookmarks(workspaceRootPath, remainingBookmarks);
  }
  return remainingBookmarks;
}
