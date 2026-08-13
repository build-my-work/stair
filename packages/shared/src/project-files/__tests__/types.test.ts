import { describe, expect, it } from 'bun:test'
import { isCanonicalProjectRelativePath } from '../types'
import { classifyProjectTextFile, isEditableProjectTextFile } from '../file-classification'
import { isErrorCode } from '../../protocol/types'

describe('Project 文件相对路径', () => {
  it('只接受唯一的 Project 根相对 POSIX 表示', () => {
    expect(isCanonicalProjectRelativePath('notes/today.md')).toBe(true)
    expect(isCanonicalProjectRelativePath('README.md')).toBe(true)

    for (const path of [
      '',
      '/notes/today.md',
      '../outside.md',
      'notes/../outside.md',
      './README.md',
      'notes//today.md',
      'notes\\today.md',
      'notes/today.md/',
      'notes/\0today.md',
    ]) {
      expect(isCanonicalProjectRelativePath(path)).toBe(false)
    }
  })
})

describe('Project 文本类型', () => {
  it('只把阶段 3 支持的 UTF-8 文本类型标记为可编辑', () => {
    expect(classifyProjectTextFile('docs/README.md')).toBe('markdown')
    expect(classifyProjectTextFile('src/index.ts')).toBe('code')
    expect(classifyProjectTextFile('data/config.json')).toBe('json')
    expect(isEditableProjectTextFile('notes.txt')).toBe(true)
    expect(isEditableProjectTextFile('.env')).toBe(true)
    expect(isEditableProjectTextFile('.gitignore')).toBe(true)
    expect(isEditableProjectTextFile('.editorconfig')).toBe(true)
    expect(isEditableProjectTextFile('.npmrc')).toBe(true)
    expect(isEditableProjectTextFile('book.epub')).toBe(false)
    expect(isEditableProjectTextFile('manual.pdf')).toBe(false)
  })
})

describe('Project File 传输错误码', () => {
  it('保留所有 Project File 错误码，不降级为 HANDLER_ERROR', () => {
    for (const code of [
      'PROJECT_FILE_INVALID_REQUEST',
      'PROJECT_FILE_NO_WORKSPACE',
      'PROJECT_FILE_NOT_FOUND',
      'PROJECT_FILE_ACCESS_DENIED',
      'PROJECT_FILE_NOT_REGULAR',
      'PROJECT_FILE_TOO_LARGE',
      'PROJECT_FILE_CHANGED',
      'PROJECT_FILE_INVALID_TEXT',
    ]) {
      expect(isErrorCode(code)).toBe(true)
    }
  })
})
