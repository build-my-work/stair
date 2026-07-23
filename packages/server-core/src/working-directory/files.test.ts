import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_WORKING_BINARY_BYTES,
  listSafeWorkingDirectoryEntries,
  readSafeWorkingDirectoryBinary,
  readSafeWorkingDirectoryDataUrl,
  readSafeWorkingDirectoryText,
  resolveSafeWorkingDirectoryPath,
} from './files'

let tempDirectory: string
let rootDirectory: string
let outsideDirectory: string

beforeEach(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), 'craft-working-directory-'))
  rootDirectory = join(tempDirectory, 'project')
  outsideDirectory = join(tempDirectory, 'outside')
  await mkdir(join(rootDirectory, 'books'), { recursive: true })
  await mkdir(outsideDirectory, { recursive: true })
  await writeFile(join(rootDirectory, 'README.md'), '# Project\n')
  await writeFile(join(rootDirectory, 'books', 'guide.md'), '# Guide\n')
  await writeFile(join(outsideDirectory, 'secret.txt'), 'secret')
})

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true })
})

describe('working-directory path security', () => {
  it('resolves an existing relative file inside the real project root', async () => {
    const resolved = await resolveSafeWorkingDirectoryPath(rootDirectory, 'books/guide.md', 'file')

    expect(resolved.relativePath).toBe('books/guide.md')
    expect(resolved.absolutePath).toBe(await realpath(join(rootDirectory, 'books', 'guide.md')))
  })

  it('rejects absolute, Windows-style, traversal, backslash and NUL paths', async () => {
    for (const unsafePath of [
      join(rootDirectory, 'README.md'),
      'C:\\Users\\reader\\book.epub',
      '../outside/secret.txt',
      'books/../../outside/secret.txt',
      'books\\guide.md',
      'books/guide.md\0.txt',
    ]) {
      expect(resolveSafeWorkingDirectoryPath(rootDirectory, unsafePath, 'file')).rejects.toThrow(
        /relative|outside|separator|NUL/,
      )
    }
  })

  it('rejects a symlink whose real target escapes the project root', async () => {
    await symlink(join(outsideDirectory, 'secret.txt'), join(rootDirectory, 'leak.txt'))

    expect(resolveSafeWorkingDirectoryPath(rootDirectory, 'leak.txt', 'file')).rejects.toThrow(
      'outside the project working directory',
    )
  })

  it('allows an in-root symlink while preserving the requested relative path', async () => {
    await symlink(join(rootDirectory, 'books', 'guide.md'), join(rootDirectory, 'guide-link.md'))

    const resolved = await resolveSafeWorkingDirectoryPath(rootDirectory, 'guide-link.md', 'file')
    expect(resolved.relativePath).toBe('guide-link.md')
    expect(await readSafeWorkingDirectoryText(rootDirectory, 'guide-link.md')).toBe('# Guide\n')
  })
})

describe('working-directory reads', () => {
  it('lists one directory level with normalized relative paths and folders first', async () => {
    const entries = await listSafeWorkingDirectoryEntries(rootDirectory)

    expect(entries.map(({ name, relativePath, type }) => ({ name, relativePath, type }))).toEqual([
      { name: 'books', relativePath: 'books', type: 'directory' },
      { name: 'README.md', relativePath: 'README.md', type: 'file' },
    ])
  })

  it('does not expose an out-of-root symlink in a directory listing', async () => {
    await symlink(join(outsideDirectory, 'secret.txt'), join(rootDirectory, 'leak.txt'))

    const entries = await listSafeWorkingDirectoryEntries(rootDirectory)
    expect(entries.some((entry) => entry.name === 'leak.txt')).toBe(false)
  })

  it('rejects invalid UTF-8 and text files over the text limit', async () => {
    await writeFile(join(rootDirectory, 'invalid.txt'), Uint8Array.from([0xff, 0xfe]))
    await writeFile(join(rootDirectory, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61))

    expect(readSafeWorkingDirectoryText(rootDirectory, 'invalid.txt')).rejects.toThrow('UTF-8')
    expect(readSafeWorkingDirectoryText(rootDirectory, 'large.txt')).rejects.toThrow('too large')
  })

  it('rejects binary files over the shared binary limit before reading them', async () => {
    const oversizedPath = join(rootDirectory, 'oversized.bin')
    await writeFile(oversizedPath, Buffer.alloc(1))
    const file = Bun.file(oversizedPath)
    await file.writer().end()
    const handle = await import('node:fs/promises').then(({ open }) => open(oversizedPath, 'r+'))
    await handle.truncate(MAX_WORKING_BINARY_BYTES + 1)
    await handle.close()

    expect(readSafeWorkingDirectoryBinary(rootDirectory, 'oversized.bin')).rejects.toThrow('too large')
  })

  it('returns a PDF data URL with the browser-readable MIME type', async () => {
    await writeFile(join(rootDirectory, 'paper.pdf'), '%PDF-1.7')

    expect(await readSafeWorkingDirectoryDataUrl(rootDirectory, 'paper.pdf'))
      .toStartWith('data:application/pdf;base64,')
  })
})
