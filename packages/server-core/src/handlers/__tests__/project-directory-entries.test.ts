import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  listDirectoryEntriesWithinRoot,
  toProjectRelativePath,
} from '../rpc/project-files'

describe('listDirectoryEntriesWithinRoot', () => {
  let sandbox = ''
  let root = ''

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'craft-project-tree-'))
    root = join(sandbox, 'project')
    await mkdir(root)
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('lists one level with directories first and root-relative paths', async () => {
    await Promise.all([
      mkdir(join(root, 'z-dir')),
      mkdir(join(root, 'a-dir')),
      writeFile(join(root, 'B.ts'), ''),
      writeFile(join(root, 'a.ts'), ''),
    ])

    const result = await listDirectoryEntriesWithinRoot(root)

    expect(result.entries.map(entry => entry.name)).toEqual([
      'a-dir',
      'z-dir',
      'a.ts',
      'B.ts',
    ])
    expect(result.entries.map(entry => entry.relativePath)).toEqual([
      'a-dir',
      'z-dir',
      'a.ts',
      'B.ts',
    ])
    expect(result).not.toHaveProperty('currentPath')
    expect(result).not.toHaveProperty('totalEntries')
    expect(result.entries.every(entry => !('path' in entry))).toBe(true)
    expect(result.truncated).toBe(false)
  })

  it('normalizes Project paths to POSIX separators', () => {
    expect(toProjectRelativePath('nested\\chapter.epub')).toBe(
      process.platform === 'win32'
        ? 'nested/chapter.epub'
        : 'nested\\chapter.epub',
    )
  })

  it('rejects traversal outside the Project root', async () => {
    await expect(listDirectoryEntriesWithinRoot(root, '..')).rejects.toThrow('outside project root')
    await expect(listDirectoryEntriesWithinRoot(root, join('nested', '..', '..'))).rejects.toThrow('outside project root')
  })

  it.each([
    'nested/../sibling',
    'nested/./child',
    'nested//child',
    'nested\\child',
  ])('rejects non-canonical directory aliases %s', async (relativePath) => {
    await expect(listDirectoryEntriesWithinRoot(root, relativePath))
      .rejects.toThrow('outside project root')
  })

  it('keeps in-root symlinks and omits external or broken symlinks', async () => {
    if (process.platform === 'win32') return

    const internalDirectory = join(root, 'internal')
    const externalDirectory = join(sandbox, 'external')
    await Promise.all([
      mkdir(internalDirectory),
      mkdir(externalDirectory),
    ])
    await Promise.all([
      writeFile(join(root, 'inside.ts'), ''),
      writeFile(join(internalDirectory, 'child.ts'), ''),
      writeFile(join(externalDirectory, 'outside.ts'), ''),
    ])
    await Promise.all([
      symlink(join(root, 'inside.ts'), join(root, 'inside-link.ts')),
      symlink(internalDirectory, join(root, 'inside-dir-link')),
      symlink(join(externalDirectory, 'outside.ts'), join(root, 'outside-link.ts')),
      symlink(externalDirectory, join(root, 'outside-dir-link')),
      symlink(join(root, 'missing.ts'), join(root, 'broken-link.ts')),
    ])

    const result = await listDirectoryEntriesWithinRoot(root)
    const names = result.entries.map(entry => entry.name)

    expect(names).toContain('inside-link.ts')
    expect(names).toContain('inside-dir-link')
    expect(names).not.toContain('outside-link.ts')
    expect(names).not.toContain('outside-dir-link')
    expect(names).not.toContain('broken-link.ts')

    const nested = await listDirectoryEntriesWithinRoot(root, 'inside-dir-link')
    expect(nested.entries.map(entry => entry.relativePath)).toEqual(['internal/child.ts'])
  })

  it('caps each directory level at 500 entries', async () => {
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        writeFile(join(root, `file-${String(index).padStart(3, '0')}.txt`), '')
      ),
    )

    const result = await listDirectoryEntriesWithinRoot(root)

    expect(result.entries).toHaveLength(500)
    expect(result.truncated).toBe(true)
  })
})
