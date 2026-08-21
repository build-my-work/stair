import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts'

export const BROWSER_BOOKMARKS_FILE = 'browser-bookmarks.json'
const BROWSER_BOOKMARKS_VERSION = 1

export interface BrowserBookmark {
  id: string
  url: string
  title: string
  createdAt: number
}

export interface ToggleBrowserBookmarkResult {
  bookmarks: BrowserBookmark[]
  isBookmarked: boolean
}

function normalizeUrl(rawUrl: string): string {
  const url = rawUrl.trim()
  if (!url || url.length > 8_192) {
    throw new Error('BROWSER_BOOKMARK_INVALID: Invalid bookmark URL')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('BROWSER_BOOKMARK_INVALID: Invalid bookmark URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('BROWSER_BOOKMARK_INVALID: Only HTTP(S) pages can be bookmarked')
  }
  return url
}

function isBrowserBookmark(value: unknown): value is BrowserBookmark {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const bookmark = value as Partial<BrowserBookmark>
  if (
    typeof bookmark.id !== 'string'
    || !bookmark.id.trim()
    || typeof bookmark.url !== 'string'
    || typeof bookmark.title !== 'string'
    || !bookmark.title.trim()
    || bookmark.title.length > 512
    || !Number.isSafeInteger(bookmark.createdAt)
    || Number(bookmark.createdAt) <= 0
  ) return false
  try {
    return normalizeUrl(bookmark.url) === bookmark.url
  } catch {
    return false
  }
}

function saveBrowserBookmarks(rootPath: string, bookmarks: BrowserBookmark[]): void {
  atomicWriteFileSync(join(rootPath, BROWSER_BOOKMARKS_FILE), `${JSON.stringify({
    version: BROWSER_BOOKMARKS_VERSION,
    bookmarks,
  }, null, 2)}\n`)
}

export function loadBrowserBookmarks(rootPath: string): BrowserBookmark[] {
  const filePath = join(rootPath, BROWSER_BOOKMARKS_FILE)
  if (!existsSync(filePath)) return []
  const document = readJsonFileSync<unknown>(filePath)
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('BROWSER_BOOKMARKS_INVALID: Bookmark file must be an object')
  }
  const candidate = document as { version?: unknown; bookmarks?: unknown }
  if (
    candidate.version !== BROWSER_BOOKMARKS_VERSION
    || !Array.isArray(candidate.bookmarks)
    || !candidate.bookmarks.every(isBrowserBookmark)
  ) throw new Error('BROWSER_BOOKMARKS_INVALID: Bookmark file has an unsupported format')
  return candidate.bookmarks
}

export function toggleBrowserBookmark(
  rootPath: string,
  input: { url: string; title: string },
): ToggleBrowserBookmarkResult {
  const url = normalizeUrl(input.url)
  const bookmarks = loadBrowserBookmarks(rootPath)
  if (bookmarks.some(bookmark => bookmark.url === url)) {
    const remaining = bookmarks.filter(bookmark => bookmark.url !== url)
    saveBrowserBookmarks(rootPath, remaining)
    return { bookmarks: remaining, isBookmarked: false }
  }
  const title = input.title.trim() || new URL(url).hostname
  if (title.length > 512) throw new Error('BROWSER_BOOKMARK_INVALID: Invalid bookmark title')
  const bookmark = { id: randomUUID(), url, title, createdAt: Date.now() }
  const updated = [bookmark, ...bookmarks]
  saveBrowserBookmarks(rootPath, updated)
  return { bookmarks: updated, isBookmarked: true }
}

export function removeBrowserBookmark(rootPath: string, bookmarkId: string): BrowserBookmark[] {
  const bookmarks = loadBrowserBookmarks(rootPath)
  const remaining = bookmarks.filter(bookmark => bookmark.id !== bookmarkId)
  if (remaining.length !== bookmarks.length) saveBrowserBookmarks(rootPath, remaining)
  return remaining
}
