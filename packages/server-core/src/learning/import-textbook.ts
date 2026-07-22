import { extname } from 'node:path'

import { parseMarkdownChapters, type ImportedTextbook } from '@craft-agent/shared/learning'

import { parseEpub } from './epub'

export const SUPPORTED_TEXTBOOK_EXTENSIONS = ['.md', '.markdown', '.epub'] as const
export const MAX_TEXTBOOK_BYTES = 25 * 1024 * 1024

export function parseTextbook(bytes: Uint8Array, sourceFilename: string): ImportedTextbook {
  if (bytes.byteLength === 0) throw new Error('The textbook file is empty')
  if (bytes.byteLength > MAX_TEXTBOOK_BYTES) throw new Error('The textbook file exceeds the 25 MB limit')

  const extension = extname(sourceFilename).toLowerCase()
  if (extension === '.epub') return parseEpub(bytes, sourceFilename)
  if (extension === '.md' || extension === '.markdown') {
    let markdown: string
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
    } catch {
      throw new Error('Markdown textbooks must use UTF-8 encoding')
    }
    const fallbackTitle = filenameTitle(sourceFilename)
    const chapters = parseMarkdownChapters(markdown, fallbackTitle)
    const firstTopLevel = chapters.find((chapter) => chapter.level === 1)
    return {
      format: 'markdown',
      sourceFilename,
      title: firstTopLevel?.title ?? fallbackTitle,
      chapters,
    }
  }
  throw new Error('Unsupported textbook format. Choose a Markdown or EPUB file.')
}

export function isSupportedTextbookFilename(filename: string): boolean {
  const extension = extname(filename).toLowerCase()
  return (SUPPORTED_TEXTBOOK_EXTENSIONS as readonly string[]).includes(extension)
}

function filenameTitle(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() ?? filename
  return leaf.replace(/\.(?:md|markdown)$/i, '').replace(/[-_]+/g, ' ').trim() || 'Imported textbook'
}
