import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as nativeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import * as config from '@craft-agent/shared/config'
import { createProject } from '@craft-agent/shared/projects'
import {
  MAX_EDITABLE_PROJECT_FILE_BYTES,
  MAX_PROJECT_FILE_BINARY_BYTES,
  MAX_PROJECT_FILE_TEXT_BYTES,
} from '@craft-agent/shared/project-files'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { createWorkspaceAtPath } from '@craft-agent/shared/workspaces'
import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import {
  EMPTY_DRAWNIX_DOCUMENT,
  atomicReplace,
  createDrawnixProjectFileWithinRoot,
  createProjectEntryWithinRoot,
  listProjectDirectoryEntriesWithinRoot,
  readProjectFileBinaryWithinRoot,
  readProjectTextFileWithinRoot,
  registerProjectFileHandlers,
  requestClientProjectFilesFlush,
  searchProjectFilesWithinRoot,
  saveDrawnixProjectFileWithinRoot,
  saveProjectTextFileWithinRoot,
} from './project-files'
import { registerWorkspaceCoreHandlers } from './workspace'
import { createProjectEntrySafelyWithinRoot } from './secure-project-note-file'
import * as secureFiles from './secure-project-note-file'

describe('Project Files RPC', () => {
  let sandbox = ''

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'stair-project-files-')))
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it.each(['list', 'search'] as const)('父目录替换后 %s 不返回 Project 外条目', async (operation) => {
    const root = join(sandbox, 'project')
    const docs = join(root, 'docs')
    const outside = join(sandbox, 'outside')
    mkdirSync(docs, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(root, 'inside-match.md'), 'inside')
    writeFileSync(join(outside, 'outside-match.md'), 'outside')
    const original = fs.readdir
    let swapped = false
    const barrier = spyOn(fs, 'readdir').mockImplementation((async (path, ...args) => {
      if (!swapped && path === docs) {
        swapped = true
        renameSync(docs, join(root, 'docs-pinned'))
        symlinkSync(outside, docs, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return Reflect.apply(original, fs, [path, ...args])
    }) as typeof fs.readdir)
    try {
      if (operation === 'list') {
        await expect(listProjectDirectoryEntriesWithinRoot(root, 'docs')).rejects.toThrow('PROJECT_FILE_CHANGED')
      } else {
        expect(await searchProjectFilesWithinRoot(root, 'match')).toEqual([
          { name: 'inside-match.md', relativePath: 'inside-match.md' },
        ])
      }
      expect(swapped).toBe(true)
    } finally {
      barrier.mockRestore()
    }
  })

  it('目录枚举尊重文件系统的大小写规则，不把同一 inode 的别名当越界', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'note.md'), 'inside')
    if (!existsSync(join(root, 'DOCS'))) {
      await expect(listProjectDirectoryEntriesWithinRoot(root, 'DOCS')).rejects.toThrow('PROJECT_FILE_NOT_FOUND')
      return
    }
    const result = await listProjectDirectoryEntriesWithinRoot(root, 'DOCS')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.name).toBe('note.md')
  })

  it.each(['file', 'directory'] as const)('已授权根目录被替换后创建 %s 不会重新跟随软链接', async (type) => {
    const root = join(sandbox, 'project')
    const outside = join(sandbox, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    const original = fs.lstat
    let swapped = false
    const barrier = spyOn(fs, 'lstat').mockImplementation((async (path, ...args) => {
      const result = await original(path, ...args)
      if (!swapped && path === root) {
        swapped = true
        renameSync(root, join(sandbox, 'project-pinned'))
        symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return result
    }) as typeof fs.lstat)
    try {
      await expect(createProjectEntryWithinRoot(root, { projectId: 'p', name: 'new-entry' }, type))
        .rejects.toThrow('PROJECT_FILE_ACCESS_DENIED')
      expect(swapped).toBe(true)
      expect(readdirSync(outside)).toEqual([])
    } finally {
      barrier.mockRestore()
    }
  })

  it.each(['text', 'drawnix'] as const)('保存 %s 始终替换固定父目录中的文件并返回该文件元数据', async (type) => {
    const root = join(sandbox, 'project')
    const docs = join(root, 'docs')
    const pinned = join(root, 'docs-pinned')
    const outside = join(sandbox, 'outside')
    const name = type === 'text' ? 'notes.md' : 'board.drawnix'
    const originalContent = type === 'text' ? 'original' : EMPTY_DRAWNIX_DOCUMENT
    const content = type === 'text' ? 'USER EDIT' : EMPTY_DRAWNIX_DOCUMENT.replace('"zoom": 1', '"zoom": 2')
    mkdirSync(docs, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(docs, name), originalContent)
    writeFileSync(join(outside, name), 'outside must remain unchanged')
    const request = { projectId: 'p', relativePath: `docs/${name}` }
    const loaded = await readProjectTextFileWithinRoot(root, request)
    const original = secureFiles.replaceProjectFileSafelyWithinRoot
    let swapped = false
    const barrier = spyOn(secureFiles, 'replaceProjectFileSafelyWithinRoot').mockImplementation(
      (rootPath, relativePath, bytes, mode) => original(rootPath, relativePath, bytes, mode, {
        beforeFinalOpen: async () => {
          swapped = true
          renameSync(docs, pinned)
          symlinkSync(outside, docs, process.platform === 'win32' ? 'junction' : 'dir')
        },
      }),
    )
    try {
      const save = type === 'text' ? saveProjectTextFileWithinRoot : saveDrawnixProjectFileWithinRoot
      const result = await save(root, { ...request, expectedFingerprint: loaded.sourceFingerprint, content })
      expect(swapped).toBe(true)
      expect(readFileSync(join(outside, name), 'utf8')).toBe('outside must remain unchanged')
      expect(readFileSync(join(pinned, name), 'utf8')).toBe(content)
      expect(result.metadata.byteLength).toBe(Buffer.byteLength(content))
      expect(result.metadata.lastModifiedMs).toBeCloseTo(statSync(join(pinned, name)).mtimeMs, 0)
      expect(readdirSync(pinned)).toEqual([name])
      expect(readdirSync(outside)).toEqual([name])
    } finally {
      barrier.mockRestore()
    }
  })

  it('懒加载单层目录，并隐藏符号链接', async () => {
    const root = join(sandbox, 'project')
    const outside = join(sandbox, 'outside.txt')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'README.md'), '# Stair\n')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(root, 'escape.md'))

    await expect(listProjectDirectoryEntriesWithinRoot(root, '../'))
      .rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
    await expect(listProjectDirectoryEntriesWithinRoot(root, 'escape.md'))
      .rejects.toThrow('PROJECT_FILE_ACCESS_DENIED')

    const result = await listProjectDirectoryEntriesWithinRoot(root)
    expect(result.entries).toEqual([
      expect.objectContaining({ name: 'docs', relativePath: 'docs', type: 'directory' }),
      expect.objectContaining({ name: 'README.md', relativePath: 'README.md', type: 'file' }),
    ])
  })

  it('拒绝绝对路径和越界路径', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)

    for (const relativePath of ['/absolute.md', '../outside.md']) {
      await expect(readProjectTextFileWithinRoot(root, {
        projectId: 'project-a',
        relativePath,
      })).rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
    }
  })

  it('拒绝符号链接或 Windows junction 路径', async () => {
    const root = join(sandbox, 'project')
    const outside = join(sandbox, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.md'), 'outside')
    symlinkSync(
      outside,
      join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(readProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'linked/secret.md',
    })).rejects.toThrow('PROJECT_FILE_ACCESS_DENIED')
  })

  it.skipIf(process.platform === 'win32')('拒绝 POSIX socket 特殊文件', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)
    const socketPath = join(root, 's') // Stay below macOS sockaddr_un.sun_path after canonicalizing /var.
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(readProjectTextFileWithinRoot(root, {
        projectId: 'project-a',
        relativePath: 's',
      })).rejects.toThrow('PROJECT_FILE_NOT_REGULAR')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  })

  it('搜索 Project 文件时跳过依赖目录和符号链接', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'docs', 'reader-guide.md'), 'guide')
    writeFileSync(join(root, 'node_modules', 'reader-hidden.md'), 'hidden')
    symlinkSync(join(root, 'docs'), join(root, 'linked-docs'))

    expect(await searchProjectFilesWithinRoot(root, 'reader')).toEqual([{
      name: 'reader-guide.md',
      relativePath: 'docs/reader-guide.md',
    }])
  })

  it('在结果上限前按扩展名过滤，避免 Note Picker 被无效文件挤满', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(join(root, 'notes'), { recursive: true })
    writeFileSync(join(root, 'notes', 'target-note.md'), 'target')
    for (let index = 0; index < 60; index += 1) {
      writeFileSync(join(root, `noise-note-${index}.bin`), 'noise')
    }

    expect(await searchProjectFilesWithinRoot(root, 'note', ['md'])).toEqual([{
      name: 'target-note.md',
      relativePath: 'notes/target-note.md',
    }])
  })

  it('在 Project 根目录或普通子目录创建空文件和目录', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(join(root, 'docs'), { recursive: true })

    expect(await createProjectEntryWithinRoot(root, {
      projectId: 'project-a',
      parentRelativePath: 'docs',
      name: 'notes.md',
    }, 'file')).toEqual({
      name: 'notes.md',
      relativePath: 'docs/notes.md',
      type: 'file',
    })
    expect(readFileSync(join(root, 'docs', 'notes.md'), 'utf8')).toBe('')
    expect(await createProjectEntryWithinRoot(root, {
      projectId: 'project-a',
      name: 'assets',
    }, 'directory')).toEqual({
      name: 'assets',
      relativePath: 'assets',
      type: 'directory',
    })
    expect(statSync(join(root, 'assets')).isDirectory()).toBe(true)

    await expect(createProjectEntryWithinRoot(root, {
      projectId: 'project-a',
      name: '../outside.md',
    }, 'file')).rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
    await expect(createProjectEntryWithinRoot(root, {
      projectId: 'project-a',
      parentRelativePath: 'docs',
      name: 'notes.md',
    }, 'file')).rejects.toThrow('PROJECT_FILE_ALREADY_EXISTS')
    await expect(createProjectEntryWithinRoot(root, {
      projectId: 'project-a',
      name: 'broken.drawnix',
    }, 'file')).rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
    expect(existsSync(join(root, 'broken.drawnix'))).toBe(false)
  })

  it.each(['file', 'directory'] as const)('创建 %s 时父目录被替换为软链接不会写入 Project 外', async type => {
    const root = join(sandbox, 'project')
    const docs = join(root, 'docs')
    const outside = join(sandbox, 'outside')
    mkdirSync(docs, { recursive: true })
    mkdirSync(outside)
    const originalLstat = fs.lstat
    let swapped = false
    const barrier = spyOn(fs, 'lstat').mockImplementation((async (path, ...options) => {
      const result = await originalLstat(path, ...options)
      if (!swapped && String(path).endsWith('/docs')) {
        swapped = true
        await fs.rename(docs, join(root, 'docs-pinned'))
        await fs.symlink(outside, docs, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return result
    }) as typeof fs.lstat)
    try {
      await createProjectEntryWithinRoot(root, {
        projectId: 'project-a', parentRelativePath: 'docs', name: 'new-entry',
      }, type).catch(error => {
        expect(error.message).toContain('PROJECT_FILE_ACCESS_DENIED')
      })
      expect(swapped).toBe(true)
      expect(readdirSync(outside)).toEqual([])
    } finally {
      barrier.mockRestore()
    }
  })

  it.each(['file', 'directory'] as const)('父句柄固定后创建 %s 不跟随随后替换的目录', async type => {
    const root = join(sandbox, 'project')
    const docs = join(root, 'docs')
    const pinned = join(root, 'docs-pinned')
    const outside = join(sandbox, 'outside')
    mkdirSync(docs, { recursive: true })
    mkdirSync(outside)
    await createProjectEntrySafelyWithinRoot(root, 'docs/new-entry', type, 'original parent', {
      beforeFinalOpen: async () => {
        await fs.rename(docs, pinned)
        await fs.symlink(outside, docs, process.platform === 'win32' ? 'junction' : 'dir')
      },
    })
    expect(readdirSync(outside)).toEqual([])
    if (type === 'file') {
      expect(readFileSync(join(pinned, 'new-entry'), 'utf8')).toBe('original parent')
    } else {
      expect(statSync(join(pinned, 'new-entry')).isDirectory()).toBe(true)
    }
  })

  it.skipIf(process.platform === 'win32')('创建写入失败时通过原父句柄清理，不删除替换目录内容', async () => {
    const root = join(sandbox, 'project')
    const docs = join(root, 'docs')
    const pinned = join(root, 'docs-pinned')
    const outside = join(sandbox, 'outside')
    mkdirSync(docs, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'new.md'), 'outside content')
    const failedSync = spyOn(nativeFs, 'fsync').mockImplementation(((_fd, callback) => {
      callback(new Error('disk sync failed'))
    }) as typeof nativeFs.fsync)
    try {
      await expect(createProjectEntrySafelyWithinRoot(root, 'docs/new.md', 'file', 'draft', {
        beforeFinalOpen: async () => {
          await fs.rename(docs, pinned)
          await fs.symlink(outside, docs, 'dir')
        },
      })).rejects.toThrow('disk sync failed')
      expect(readdirSync(pinned)).toEqual([])
      expect(readFileSync(join(outside, 'new.md'), 'utf8')).toBe('outside content')
    } finally {
      failedSync.mockRestore()
    }
  })

  it('创建初始文档失败时不残留无法重试的部分文件', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)

    await expect(createProjectEntryWithinRoot(root, {
      projectId: 'project-a',
      name: 'failed.md',
    }, 'file', {} as string)).rejects.toThrow('PROJECT_FILE_ACCESS_DENIED')
    expect(existsSync(join(root, 'failed.md'))).toBe(false)
  })

  it('只为 .drawnix 创建可立即打开的原生空文档', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(join(root, 'maps'), { recursive: true })

    expect(await createDrawnixProjectFileWithinRoot(root, {
      projectId: 'project-a',
      parentRelativePath: 'maps',
      name: 'tutorial.drawnix',
    })).toEqual({
      name: 'tutorial.drawnix',
      relativePath: 'maps/tutorial.drawnix',
      type: 'file',
    })
    expect(JSON.parse(readFileSync(
      join(root, 'maps', 'tutorial.drawnix'),
      'utf8',
    ))).toEqual({
      type: 'drawnix',
      version: 1,
      source: 'web',
      elements: [],
      viewport: { zoom: 1 },
      theme: { themeColorMode: 'default' },
    })

    await expect(createDrawnixProjectFileWithinRoot(root, {
      projectId: 'project-a',
      name: 'tutorial.json',
    })).rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
  })

  it('校验 Drawnix 文档并使用 fingerprint CAS 原子保存', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)
    writeFileSync(join(root, 'tutorial.drawnix'), EMPTY_DRAWNIX_DOCUMENT)
    const opened = await readProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'tutorial.drawnix',
    })
    expect(opened.metadata.mimeType).toBe('application/vnd.drawnix+json')
    const changed = JSON.stringify({
      ...JSON.parse(EMPTY_DRAWNIX_DOCUMENT),
      elements: [{ id: 'root', type: 'mind', children: [] }],
    }, null, 2)

    const saved = await saveDrawnixProjectFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'tutorial.drawnix',
      expectedFingerprint: opened.sourceFingerprint,
      content: changed,
    })
    expect(readFileSync(join(root, 'tutorial.drawnix'), 'utf8')).toBe(changed)
    expect(saved.sourceFingerprint).toBe(
      `sha256:${createHash('sha256').update(changed).digest('hex')}`,
    )

    await expect(saveDrawnixProjectFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'tutorial.drawnix',
      expectedFingerprint: opened.sourceFingerprint,
      content: EMPTY_DRAWNIX_DOCUMENT,
    })).rejects.toThrow('PROJECT_FILE_CHANGED')
    await expect(saveDrawnixProjectFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'tutorial.drawnix',
      expectedFingerprint: saved.sourceFingerprint,
      content: '{"type":"not-drawnix"}',
    })).rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
    await expect(saveDrawnixProjectFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'tutorial.json',
      expectedFingerprint: saved.sourceFingerprint,
      content: EMPTY_DRAWNIX_DOCUMENT,
    })).rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
  })

  it('允许保存达到 8 MiB 上限的 Drawnix 文档并拒绝超限内容', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)
    writeFileSync(join(root, 'large.drawnix'), EMPTY_DRAWNIX_DOCUMENT)
    const opened = await readProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'large.drawnix',
    })
    const document = {
      ...JSON.parse(EMPTY_DRAWNIX_DOCUMENT),
      padding: '',
    }
    const emptyContent = JSON.stringify(document)
    const changed = JSON.stringify({
      ...document,
      padding: 'x'.repeat(MAX_PROJECT_FILE_TEXT_BYTES - Buffer.byteLength(emptyContent)),
    })
    expect(Buffer.byteLength(changed)).toBe(MAX_PROJECT_FILE_TEXT_BYTES)

    const saved = await saveDrawnixProjectFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'large.drawnix',
      expectedFingerprint: opened.sourceFingerprint,
      content: changed,
    })
    expect(saved).toEqual(expect.objectContaining({
      sourceFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }))
    expect(readFileSync(join(root, 'large.drawnix'), 'utf8')).toBe(changed)

    await expect(saveDrawnixProjectFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'large.drawnix',
      expectedFingerprint: saved.sourceFingerprint,
      content: changed.replace(/"}$/, 'x"}'),
    })).rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
  })

  it('以 SHA-256 指纹比较并原子保存可编辑文本', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)
    writeFileSync(join(root, 'notes.md'), '\ufefffirst\r\nsecond\r\n')
    chmodSync(join(root, 'notes.md'), 0o640)

    const loaded = await readProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'notes.md',
    })
    expect(loaded.text).toBe('first\r\nsecond\r\n')
    expect(loaded.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)

    const saved = await saveProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'notes.md',
      expectedFingerprint: loaded.sourceFingerprint,
      content: 'changed\nline\n',
    })
    expect(saved.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('\ufeffchanged\r\nline\r\n')
    expect(statSync(join(root, 'notes.md')).mode & 0o777).toBe(0o640)

    await expect(saveProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'notes.md',
      expectedFingerprint: loaded.sourceFingerprint,
      content: 'stale writer',
    })).rejects.toThrow('PROJECT_FILE_CHANGED')
  })

  it('普通文本保存仍限制为 1 MiB', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)
    writeFileSync(join(root, 'limit.md'), 'initial')
    const loaded = await readProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'limit.md',
    })
    const atLimit = 'a'.repeat(MAX_EDITABLE_PROJECT_FILE_BYTES)

    const saved = await saveProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'limit.md',
      expectedFingerprint: loaded.sourceFingerprint,
      content: atLimit,
    })
    await expect(saveProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'limit.md',
      expectedFingerprint: saved.sourceFingerprint,
      content: `${atLimit}a`,
    })).rejects.toThrow('PROJECT_FILE_TOO_LARGE')
    expect(readFileSync(join(root, 'limit.md'), 'utf8')).toBe(atLimit)
  })

  it('串行化同一 fingerprint 的并发保存且不残留临时文件', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)
    writeFileSync(join(root, 'notes.md'), 'original')
    const loaded = await readProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'notes.md',
    })
    const request = (content: string) => saveProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'notes.md',
      expectedFingerprint: loaded.sourceFingerprint,
      content,
    })

    const results = await Promise.allSettled([request('first'), request('second')])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => (
      result.status === 'rejected'
      && String(result.reason).includes('PROJECT_FILE_CHANGED')
    ))).toHaveLength(1)
    expect(['first', 'second']).toContain(readFileSync(join(root, 'notes.md'), 'utf8'))
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('原子替换失败时清理临时文件且不改变目标', async () => {
    const root = join(sandbox, 'project')
    const target = join(root, 'notes.md')
    mkdirSync(target, { recursive: true })

    await expect(atomicReplace(root, 'notes.md', Buffer.from('replacement'), 0o600))
      .rejects.toBeDefined()
    expect(statSync(target).isDirectory()).toBe(true)
    expect(readdirSync(root)).toEqual(['notes.md'])
  })

  it('逐字保留末尾空行，并允许把文件清空', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)
    writeFileSync(join(root, 'notes.txt'), 'line\n')

    const loaded = await readProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'notes.txt',
    })
    const withBlankLine = await saveProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'notes.txt',
      expectedFingerprint: loaded.sourceFingerprint,
      content: 'line\n\n',
    })
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('line\n\n')

    await saveProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'notes.txt',
      expectedFingerprint: withBlankLine.sourceFingerprint,
      content: '',
    })
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('')
  })

  it('拒绝写入随后无法按文本读取的 NUL 内容', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)
    writeFileSync(join(root, 'notes.txt'), 'original')

    const loaded = await readProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'notes.txt',
    })
    await expect(saveProjectTextFileWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'notes.txt',
      expectedFingerprint: loaded.sourceFingerprint,
      content: 'before\0after',
    })).rejects.toThrow('PROJECT_FILE_INVALID_TEXT')
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('original')
  })

  it('为 EPUB/PDF/图片 Reader 返回带稳定 fingerprint 的安全二进制', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)
    const pdf = Buffer.from('%PDF-1.7\ntext-layer fixture\n')
    writeFileSync(join(root, 'paper.pdf'), pdf)
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    writeFileSync(join(root, 'image.png'), image)
    writeFileSync(join(root, 'cover.avif'), image)

    const loaded = await readProjectFileBinaryWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'paper.pdf',
    })
    expect(Buffer.from(loaded.bytes)).toEqual(pdf)
    expect(loaded.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    const loadedImage = await readProjectFileBinaryWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'image.png',
    })
    expect(Buffer.from(loadedImage.bytes)).toEqual(image)
    expect(loadedImage.metadata.mimeType).toBe('image/png')
    const loadedAvif = await readProjectFileBinaryWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'cover.avif',
    })
    expect(loadedAvif.metadata.mimeType).toBe('image/avif')
  })

  it('拒绝读取超过 32 MiB 上限的 Reader 二进制', async () => {
    const root = join(sandbox, 'project')
    mkdirSync(root)
    const path = join(root, 'too-large.pdf')
    writeFileSync(path, '')
    truncateSync(path, MAX_PROJECT_FILE_BINARY_BYTES + 1)

    await expect(readProjectFileBinaryWithinRoot(root, {
      projectId: 'project-a',
      relativePath: 'too-large.pdf',
    })).rejects.toThrow('PROJECT_FILE_TOO_LARGE')
  })

  it('只允许 RPC 上下文所属 Workspace 中的 Project', async () => {
    const workspaceARoot = join(sandbox, 'workspace-a')
    const workspaceBRoot = join(sandbox, 'workspace-b')
    const projectARoot = join(sandbox, 'project-a')
    const projectBRoot = join(sandbox, 'project-b')
    mkdirSync(projectARoot)
    mkdirSync(projectBRoot)
    writeFileSync(join(projectBRoot, 'secret.md'), 'secret')

    const workspaceA = { ...createWorkspaceAtPath(workspaceARoot, 'A'), rootPath: workspaceARoot }
    const workspaceB = { ...createWorkspaceAtPath(workspaceBRoot, 'B'), rootPath: workspaceBRoot }
    createProject(workspaceARoot, { name: 'A Project', workingDirectory: projectARoot })
    const projectB = createProject(workspaceBRoot, {
      name: 'B Project',
      workingDirectory: projectBRoot,
    })
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => (
      id === workspaceA.id ? workspaceA : id === workspaceB.id ? workspaceB : null
    ) as never)

    const handlers = new Map<string, HandlerFn>()
    const server: RpcServer = {
      handle: (channel, handler) => handlers.set(channel, handler),
      push: () => {},
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }
    registerProjectFileHandlers(server, {
      sessionManager: {},
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps)

    try {
      const read = handlers.get(RPC_CHANNELS.projectFiles.READ_TEXT)!
      await expect(read({
        clientId: 'test',
        workspaceId: workspaceA.id,
        webContentsId: null,
      }, {
        projectId: projectB.id,
        relativePath: 'secret.md',
      })).rejects.toThrow('PROJECT_FILE_NOT_FOUND')
    } finally {
      lookup.mockRestore()
    }
  })

  it('应用退出前等待对应 Renderer 的 flush 回执', async () => {
    const handlers = new Map<string, HandlerFn>()
    let requestId = ''
    const server: RpcServer = {
      handle: (channel, handler) => handlers.set(channel, handler),
      push: (_channel, target, id) => {
        expect(target).toEqual({ to: 'client', clientId: 'renderer-a' })
        requestId = id as string
      },
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }
    registerProjectFileHandlers(server, {
      sessionManager: {},
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps)

    const flush = requestClientProjectFilesFlush(server, 'renderer-a', 100)
    await handlers.get(RPC_CHANNELS.projectFiles.FLUSH_COMPLETED)!({
      clientId: 'renderer-a',
      workspaceId: null,
      webContentsId: null,
    }, requestId)
    await expect(flush).resolves.toBeUndefined()
  })

  it('同窗口切换 Workspace 前先等待旧文档 flush', async () => {
    const handlers = new Map<string, HandlerFn>()
    const order: string[] = []
    const context = { clientId: 'renderer-a', workspaceId: 'workspace-a', webContentsId: 42 }
    const server: RpcServer = {
      handle: (channel, handler) => handlers.set(channel, handler),
      push: (channel, target, requestId) => {
        expect(channel).toBe(RPC_CHANNELS.projectFiles.FLUSH_REQUESTED)
        expect(target).toEqual({ to: 'client', clientId: 'renderer-a' })
        order.push('flush-requested')
        queueMicrotask(() => {
          void handlers.get(RPC_CHANNELS.projectFiles.FLUSH_COMPLETED)!(context, requestId)
        })
      },
      updateClientWorkspace: (_clientId, _workspaceId) => { order.push('client-switched') },
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }
    const windowManager = {
      getWorkspaceForWindow: () => 'workspace-a',
      updateWindowWorkspace: () => {
        order.push('window-switched')
        return true
      },
      getAllWindowsForWorkspace: () => [{}],
    }
    const sessionManager = {
      setupConfigWatcher: () => {},
      clearActiveViewingSession: () => {},
    }
    const deps = {
      sessionManager,
      windowManager,
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps
    registerProjectFileHandlers(server, deps)
    registerWorkspaceCoreHandlers(server, deps)

    await handlers.get(RPC_CHANNELS.window.SWITCH_WORKSPACE)!(context, 'workspace-b')

    expect(order).toEqual(['flush-requested', 'client-switched', 'window-switched'])
  })

  it('旧文档 flush 失败时 veto Workspace 切换', async () => {
    const handlers = new Map<string, HandlerFn>()
    let mappingChanged = false
    const context = { clientId: 'renderer-a', workspaceId: 'workspace-a', webContentsId: 42 }
    const server: RpcServer = {
      handle: (channel, handler) => handlers.set(channel, handler),
      push: (_channel, _target, requestId) => {
        queueMicrotask(() => {
          void handlers.get(RPC_CHANNELS.projectFiles.FLUSH_COMPLETED)!(
            context,
            requestId,
            'PROJECT_FILE_CHANGED: changed on disk',
          )
        })
      },
      updateClientWorkspace: () => { mappingChanged = true },
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }
    const deps = {
      sessionManager: {},
      windowManager: {
        updateWindowWorkspace: () => { mappingChanged = true },
      },
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps
    registerProjectFileHandlers(server, deps)
    registerWorkspaceCoreHandlers(server, deps)

    await expect(handlers.get(RPC_CHANNELS.window.SWITCH_WORKSPACE)!(
      context,
      'workspace-b',
    )).rejects.toThrow('PROJECT_FILE_CHANGED')
    expect(mappingChanged).toBe(false)
  })
})
