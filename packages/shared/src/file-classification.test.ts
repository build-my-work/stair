import { describe, expect, it } from 'bun:test'
import {
  classifyFile,
  isEditableProjectTextFile,
} from './file-classification'

describe('shared file classification', () => {
  it.each([
    ['README.markdown', 'markdown'],
    ['src/index.ts', 'code'],
    ['Dockerfile', 'code'],
    ['Makefile', 'code'],
    ['config/.env.local', 'text'],
    ['config/.gitignore', 'text'],
    ['data/settings.jsonc', 'json'],
    ['images/diagram.svg', 'image'],
    ['docs/reference.pdf', 'pdf'],
  ] as const)('classifies %s as %s', (path, type) => {
    expect(classifyFile(path)).toEqual({ type, canPreview: true })
  })

  it('edits source-like UTF-8 types but keeps SVG and special files read-only', () => {
    for (const path of [
      'README.md',
      'notes.txt',
      'src/main.go',
      '.env.development',
      'settings.json',
    ]) {
      expect(isEditableProjectTextFile(path)).toBe(true)
    }

    for (const path of ['diagram.svg', 'manual.pdf', 'archive.zip', 'board.drawnix']) {
      expect(isEditableProjectTextFile(path)).toBe(false)
    }
  })
})
