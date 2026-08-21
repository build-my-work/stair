import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as config from '@craft-agent/shared/config'
import { createProject } from '@craft-agent/shared/projects'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { createWorkspaceAtPath } from '@craft-agent/shared/workspaces'
import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import {
  createProjectEntryWithinRoot,
  listProjectDirectoryEntriesWithinRoot,
  readProjectFileBinaryWithinRoot,
  readProjectTextFileWithinRoot,
  registerProjectFileHandlers,
  requestClientProjectFilesFlush,
  searchProjectFilesWithinRoot,
  saveProjectTextFileWithinRoot,
} from './project-files'
import { registerWorkspaceCoreHandlers } from './workspace'

describe('Project Files RPC', () => {
  let sandbox = ''

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'stair-project-files-'))
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
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
