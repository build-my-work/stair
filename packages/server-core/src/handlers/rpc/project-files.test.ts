import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { MessageEnvelope } from '@craft-agent/shared/protocol'
import { createProject } from '@craft-agent/shared/projects'
import { deserializeEnvelope, serializeEnvelope } from '../../transport'
import {
  HANDLED_CHANNELS,
  MAX_PROJECT_FILE_BINARY_BYTES,
  MAX_PROJECT_FILE_PATH_BYTES,
  MAX_PROJECT_FILE_TEXT_BYTES,
  canonicalizeProjectFileRelativePath,
  projectFileStatSnapshotsMatch,
  readProjectFileBinaryWithinRoot,
  readProjectFileTextWithinRoot,
  resolveProjectWorkingDirectory,
  searchProjectFilesWithinRoot,
} from './project-files'
import { searchFilesWithinRoot } from './files'

describe('Project File reads', () => {
  let sandbox = ''
  let root = ''

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'craft-project-file-'))
    root = join(sandbox, 'project-root')
    await mkdir(root)
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('accepts only canonical root-relative POSIX paths', () => {
    expect(canonicalizeProjectFileRelativePath('books/example.epub')).toBe(
      'books/example.epub',
    )

    const invalid = [
      '',
      '.',
      '..',
      '/absolute.epub',
      'C:/absolute.epub',
      'C:relative.epub',
      'books\\example.epub',
      'books/../example.epub',
      'books/./example.epub',
      'books//example.epub',
      'books/example.epub/',
      'books/\0example.epub',
      `a${'/b'.repeat(MAX_PROJECT_FILE_PATH_BYTES)}`,
    ]
    for (const value of invalid) {
      expect(() => canonicalizeProjectFileRelativePath(value)).toThrow(
        /^PROJECT_FILE_INVALID_REQUEST:/,
      )
    }
  })

  it('returns metadata, bytes and a fingerprint of those exact bytes', async () => {
    const directory = join(root, 'books')
    const file = join(directory, 'example.epub')
    const content = Buffer.from('same bytes \0 including binary', 'utf8')
    await mkdir(directory)
    await writeFile(file, content)

    const response = await readProjectFileBinaryWithinRoot(root, {
      projectId: 'project-1',
      relativePath: 'books/example.epub',
    })

    expect(Buffer.from(response.bytes)).toEqual(content)
    expect(response.sourceFingerprint).toBe(
      `sha256:${createHash('sha256').update(response.bytes).digest('hex')}`,
    )
    expect(response.metadata).toMatchObject({
      projectId: 'project-1',
      relativePath: 'books/example.epub',
      name: 'example.epub',
      mimeType: 'application/epub+zip',
      byteLength: content.byteLength,
    })
    expect(response.metadata.byteLength).toBe(response.bytes.byteLength)
    expect(response.metadata.lastModifiedMs).toBeGreaterThan(0)
  })

  it('returns only decoded UTF-8 text', async () => {
    const content = Buffer.from('第一章\nHello', 'utf8')
    await writeFile(join(root, 'notes.md'), content)

    const response = await readProjectFileTextWithinRoot(root, {
      projectId: 'project-1',
      relativePath: 'notes.md',
    })

    expect(response).toEqual({ text: '第一章\nHello' })
  })

  it('returns file-only Project search DTOs without letting directories consume the limit', async () => {
    await Promise.all(
      Array.from({ length: 55 }, async (_, index) => {
        const directory = join(root, `needle-dir-${String(index).padStart(2, '0')}`)
        await mkdir(directory)
        await writeFile(join(directory, 'needle.txt'), '')
      }),
    )

    const projectResults = await searchProjectFilesWithinRoot(root, 'needle')

    expect(projectResults).toHaveLength(50)
    expect(projectResults.every(result => result.name === 'needle.txt')).toBe(true)
    expect(
      projectResults.every(
        result => Object.keys(result).sort().join(',') === 'name,relativePath',
      ),
    ).toBe(true)

    const genericResults = await searchFilesWithinRoot(root, 'needle')
    expect(genericResults).toHaveLength(50)
    expect(genericResults.every(result => result.type === 'directory')).toBe(true)
    expect(genericResults.every(result => result.path.startsWith(root))).toBe(true)
  })

  it('rejects invalid UTF-8 instead of silently replacing bytes', async () => {
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]))

    await expect(
      readProjectFileTextWithinRoot(root, {
        projectId: 'project-1',
        relativePath: 'invalid.txt',
      }),
    ).rejects.toThrow(/^PROJECT_FILE_INVALID_TEXT:/)
  })

  it('allows in-root symlinks and rejects symlink escapes', async () => {
    if (process.platform === 'win32') return

    const inside = join(root, 'inside.epub')
    const outside = join(sandbox, 'outside.epub')
    await Promise.all([
      writeFile(inside, 'inside'),
      writeFile(outside, 'outside'),
    ])
    await Promise.all([
      symlink(inside, join(root, 'inside-link.epub')),
      symlink(outside, join(root, 'outside-link.epub')),
    ])

    const response = await readProjectFileBinaryWithinRoot(root, {
      projectId: 'project-1',
      relativePath: 'inside-link.epub',
    })
    expect(Buffer.from(response.bytes).toString('utf8')).toBe('inside')
    expect(response.metadata.relativePath).toBe('inside-link.epub')

    await expect(
      readProjectFileBinaryWithinRoot(root, {
        projectId: 'project-1',
        relativePath: 'outside-link.epub',
      }),
    ).rejects.toThrow(/^PROJECT_FILE_ACCESS_DENIED:/)
  })

  it('canonicalizes a symlink Project root', async () => {
    if (process.platform === 'win32') return

    const linkedRoot = join(sandbox, 'linked-root')
    await writeFile(join(root, 'book.epub'), 'book')
    await symlink(root, linkedRoot, 'dir')

    const response = await readProjectFileBinaryWithinRoot(linkedRoot, {
      projectId: 'project-1',
      relativePath: 'book.epub',
    })
    expect(Buffer.from(response.bytes).toString('utf8')).toBe('book')
  })

  it('rejects directories and other non-regular targets', async () => {
    await mkdir(join(root, 'directory'))

    await expect(
      readProjectFileBinaryWithinRoot(root, {
        projectId: 'project-1',
        relativePath: 'directory',
      }),
    ).rejects.toThrow(/^PROJECT_FILE_NOT_REGULAR:/)
  })

  it('enforces the binary limit and survives a near-limit wire round trip', async () => {
    const atLimit = join(root, 'at-limit.epub')
    const overLimit = join(root, 'over-limit.epub')
    await Promise.all([
      writeFile(atLimit, ''),
      writeFile(overLimit, ''),
    ])
    await Promise.all([
      truncate(atLimit, MAX_PROJECT_FILE_BINARY_BYTES),
      truncate(overLimit, MAX_PROJECT_FILE_BINARY_BYTES + 1),
    ])

    const response = await readProjectFileBinaryWithinRoot(root, {
      projectId: 'project-1',
      relativePath: 'at-limit.epub',
    })
    expect(response.bytes.byteLength).toBe(MAX_PROJECT_FILE_BINARY_BYTES)

    const envelope: MessageEnvelope = {
      id: 'project-file-near-limit',
      type: 'response',
      channel: 'projectFiles:readBinary',
      result: response,
    }
    const decoded = deserializeEnvelope(serializeEnvelope(envelope))
    const decodedBytes = (
      decoded.result as { bytes: Uint8Array }
    ).bytes
    expect(decodedBytes).toBeInstanceOf(Uint8Array)
    expect(decodedBytes.byteLength).toBe(MAX_PROJECT_FILE_BINARY_BYTES)

    await expect(
      readProjectFileBinaryWithinRoot(root, {
        projectId: 'project-1',
        relativePath: 'over-limit.epub',
      }),
    ).rejects.toThrow(/^PROJECT_FILE_TOO_LARGE:/)
  })

  it('enforces the text limit independently of the binary limit', async () => {
    const atLimit = join(root, 'at-limit.txt')
    const overLimit = join(root, 'over-limit.txt')
    await Promise.all([
      writeFile(atLimit, ''),
      writeFile(overLimit, ''),
    ])
    await Promise.all([
      truncate(atLimit, MAX_PROJECT_FILE_TEXT_BYTES),
      truncate(overLimit, MAX_PROJECT_FILE_TEXT_BYTES + 1),
    ])

    const response = await readProjectFileTextWithinRoot(root, {
      projectId: 'project-1',
      relativePath: 'at-limit.txt',
    })
    expect(response.text).toHaveLength(MAX_PROJECT_FILE_TEXT_BYTES)

    await expect(
      readProjectFileTextWithinRoot(root, {
        projectId: 'project-1',
        relativePath: 'over-limit.txt',
      }),
    ).rejects.toThrow(/^PROJECT_FILE_TOO_LARGE:/)
  })

  it('detects every file identity field used by the stable-read check', () => {
    const initial = {
      dev: 1,
      ino: 2,
      size: 3,
      mtimeMs: 4,
      ctimeMs: 5,
    }
    expect(projectFileStatSnapshotsMatch(initial, { ...initial })).toBe(true)

    for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) {
      expect(projectFileStatSnapshotsMatch(initial, {
        ...initial,
        [field]: initial[field] + 1,
      })).toBe(false)
    }
  })

  it('resolves Project ids only inside the selected workspace', async () => {
    const workspaceA = join(sandbox, 'workspace-a')
    const workspaceB = join(sandbox, 'workspace-b')
    const workingA = join(sandbox, 'working-a')
    const workingB = join(sandbox, 'working-b')
    await Promise.all([
      mkdir(workspaceA),
      mkdir(workspaceB),
      mkdir(workingA),
      mkdir(workingB),
    ])

    const projectA = createProject(workspaceA, {
      name: 'Project A',
      workingDirectory: workingA,
    })
    const projectB = createProject(workspaceB, {
      name: 'Project B',
      workingDirectory: workingB,
    })

    await expect(
      resolveProjectWorkingDirectory(workspaceA, projectA.id),
    ).resolves.toBe(await realpath(workingA))
    await expect(
      resolveProjectWorkingDirectory(workspaceA, projectB.id),
    ).rejects.toThrow(/^PROJECT_FILE_NOT_FOUND:/)
  })

  it('declares all Project File read and tree handlers', () => {
    expect(HANDLED_CHANNELS).toEqual([
      'projectFiles:readText',
      'projectFiles:readBinary',
      'projectFiles:search',
      'projectFiles:listDirectoryEntries',
    ])
  })
})
