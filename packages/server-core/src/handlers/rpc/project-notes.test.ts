import { createHash } from 'node:crypto'
import * as secureFiles from './secure-project-note-file'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

import { MAX_REFERENCE_SERIALIZED_BYTES } from '@craft-agent/core'
import * as config from '@craft-agent/shared/config'
import { RPC_CHANNELS, type Session } from '@craft-agent/shared/protocol'
import {
  createProject,
  getProjectPath,
  updateProject,
  withProjectMutationLock,
} from '@craft-agent/shared/projects'
import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import {
  ensureProjectNoteTarget,
  registerProjectNoteHandlers,
  serializeProjectNote,
} from './project-notes'
import { readProjectTextFileWithinRoot, saveProjectTextFileWithinRoot } from './project-files'
import {
  openProjectNoteFileWithinRoot,
  projectNoteWindowsNativeLayoutForTests,
} from './secure-project-note-file'

function handlerHarness(sessionManager: Partial<HandlerDeps['sessionManager']>) {
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle: (channel: string, handler: HandlerFn) => { handlers.set(channel, handler) },
    push: () => {},
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  } as RpcServer
  const manager = sessionManager as HandlerDeps['sessionManager']
  if (!manager.withSessionLifecycleLock) {
    manager.withSessionLifecycleLock = async (_sessionId, operation) => operation()
  }
  registerProjectNoteHandlers(server, {
    sessionManager: manager,
    oauthFlowStore: {},
    platform: {},
  } as HandlerDeps)
  return handlers
}

function rpcContext(workspaceId: string) {
  return { clientId: 'test-client', workspaceId, webContentsId: 1 }
}

describe('Project Note', () => {
  let sandbox = ''
  let projectRoot = ''

  beforeEach(async () => {
    sandbox = await realpath(await mkdtemp(join(tmpdir(), 'stair-project-note-')))
    projectRoot = join(sandbox, 'project')
    await mkdir(projectRoot)
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('只接受 Project 内现有 Markdown/文本普通文件并拒绝软链接或 junction', async () => {
    await writeFile(join(projectRoot, 'notes.md'), '')
    await expect(ensureProjectNoteTarget(projectRoot, 'notes.md')).resolves.toBeUndefined()
    await expect(ensureProjectNoteTarget(projectRoot, '../outside.md'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_INVALID:/)
    await expect(ensureProjectNoteTarget(projectRoot, 'notes.json'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_INVALID:/)

    const outsideDirectory = join(sandbox, 'outside')
    await mkdir(outsideDirectory)
    await writeFile(join(outsideDirectory, 'outside.md'), '')
    await symlink(
      outsideDirectory,
      join(projectRoot, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(ensureProjectNoteTarget(projectRoot, 'linked/outside.md'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_(?:ACCESS_DENIED|NOT_FOUND):/)
  })

  it('串行并发追加且不丢失任何引用', async () => {
    const workspaceRoot = join(sandbox, 'workspace-concurrent')
    await mkdir(workspaceRoot)
    await writeFile(join(projectRoot, 'notes.md'), 'Existing')
    const project = createProject(workspaceRoot, {
      name: 'Project',
      workingDirectory: projectRoot,
    })
    const workspace = {
      id: 'workspace-concurrent',
      name: 'Workspace concurrent',
      slug: 'workspace-concurrent',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => (
      id === workspace.id ? workspace : null
    ))
    const handlers = handlerHarness({})
    const configured = await handlers.get(RPC_CHANNELS.projectNotes.CONFIGURE_TARGET)!(
      rpcContext(workspace.id),
      {
        sessionId: null,
        projectId: project.id,
        relativePath: 'notes.md',
      },
    ) as { projectRootFingerprint: string }
    const append = handlers.get(RPC_CHANNELS.projectNotes.APPEND)!

    await Promise.all(Array.from({ length: 12 }, (_, index) => (
      append(rpcContext(workspace.id), {
        requestId: `concurrent-note-${index}`,
        projectId: project.id,
        relativePath: 'notes.md',
        expectedProjectRootFingerprint: configured.projectRootFingerprint,
        selection: {
          version: 1,
          kind: 'web-selection',
          projectId: project.id,
          url: `https://example.com/concurrent/${index}`,
          title: 'Concurrent source',
          quote: `note-${index}`,
          locator: {
            type: 'web-text-quote',
            exact: `note-${index}`,
          },
        },
      })
    )))
    const content = await readFile(join(projectRoot, 'notes.md'), 'utf8')
    for (let index = 0; index < 12; index += 1) {
      expect(content.match(new RegExp(`note-${index}(?:\\n|$)`, 'g'))).toHaveLength(1)
    }
  })

  it('自动保存提交期间成功追加的 Note 不会被覆盖，重试也不重复追加', async () => {
    const workspaceRoot = join(sandbox, 'workspace-save-race')
    await mkdir(workspaceRoot)
    await writeFile(join(projectRoot, 'notes.md'), 'Existing')
    const project = createProject(workspaceRoot, { name: 'Project', workingDirectory: projectRoot })
    const workspace = {
      id: 'workspace-save-race', name: 'Workspace', slug: 'workspace-save-race',
      rootPath: workspaceRoot, createdAt: 1,
    }
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => (
      id === workspace.id ? workspace : null
    ))
    const handlers = handlerHarness({})
    const context = rpcContext(workspace.id)
    const configured = await handlers.get(RPC_CHANNELS.projectNotes.CONFIGURE_TARGET)!(context, {
      sessionId: null, projectId: project.id, relativePath: 'notes.md',
    }) as { projectRootFingerprint: string }
    const fileRequest = { projectId: project.id, relativePath: 'notes.md' }
    const previous = await readProjectTextFileWithinRoot(projectRoot, fileRequest)
    const request = {
      requestId: 'note-during-save', ...fileRequest,
      expectedProjectRootFingerprint: configured.projectRootFingerprint,
      selection: {
        version: 1, kind: 'web-selection', projectId: project.id,
        url: 'https://example.com/', title: 'Source', quote: 'IMPORTANT NOTE',
        locator: { type: 'web-text-quote', exact: 'IMPORTANT NOTE' },
      },
    }
    const append = handlers.get(RPC_CHANNELS.projectNotes.APPEND)!
    let appendResult: Promise<unknown> | undefined
    const originalReplace = secureFiles.replaceProjectFileSafelyWithinRoot
    const barrier = spyOn(secureFiles, 'replaceProjectFileSafelyWithinRoot').mockImplementation(
      (rootPath, relativePath, bytes, mode) => originalReplace(rootPath, relativePath, bytes, mode, {
        beforeFinalOpen: async () => {
          // Run the real RPC after the final fingerprint check, before committing the save.
          // The shared queue must delay append until replacement completes.
          appendResult = Promise.resolve(append(context, request))
          await Promise.race([appendResult, new Promise(resolve => setTimeout(resolve, 100))])
        },
      }),
    )
    try {
      await saveProjectTextFileWithinRoot(projectRoot, {
        ...fileRequest,
        relativePath: existsSync(join(projectRoot, 'NOTES.md')) ? 'NOTES.md' : 'notes.md',
        expectedFingerprint: previous.sourceFingerprint, content: 'USER EDIT',
      })
      expect(appendResult).toBeDefined()
      await appendResult
      await append(context, request)
      const saved = await readProjectTextFileWithinRoot(projectRoot, fileRequest)
      expect(saved.text).toStartWith('USER EDIT')
      expect(saved.text.match(/> IMPORTANT NOTE/g)).toHaveLength(1)
    } finally {
      barrier.mockRestore()
      lookup.mockRestore()
    }
  })

  it('父目录在最终打开前被替换时不会写入替换目录', async () => {
    const originalDirectory = join(projectRoot, 'notes')
    const replacementDirectory = join(sandbox, 'replacement')
    const pinnedDirectory = join(projectRoot, 'notes-pinned')
    await mkdir(originalDirectory)
    await mkdir(replacementDirectory)
    await writeFile(join(originalDirectory, 'target.md'), 'original')
    await writeFile(join(replacementDirectory, 'target.md'), 'replacement')

    const handle = await openProjectNoteFileWithinRoot(projectRoot, 'notes/target.md', {
      beforeFinalOpen: async () => {
        await rename(originalDirectory, pinnedDirectory)
        await rename(replacementDirectory, originalDirectory)
      },
    })
    try {
      await handle.append(Buffer.from('> safe\n'))
      await handle.sync()
    } finally {
      await handle.close()
    }

    expect(await readFile(join(pinnedDirectory, 'target.md'), 'utf8')).toContain('> safe')
    expect(await readFile(join(originalDirectory, 'target.md'), 'utf8')).toBe('replacement')
  })

  it('父目录在最终打开前被替换为软链接或 junction 时不会跟随', async () => {
    const originalDirectory = join(projectRoot, 'notes')
    const outsideDirectory = join(sandbox, 'outside')
    const pinnedDirectory = join(projectRoot, 'notes-pinned')
    await mkdir(originalDirectory)
    await mkdir(outsideDirectory)
    await writeFile(join(originalDirectory, 'target.md'), 'original')
    await writeFile(join(outsideDirectory, 'target.md'), 'outside')

    const handle = await openProjectNoteFileWithinRoot(projectRoot, 'notes/target.md', {
      beforeFinalOpen: async () => {
        await rename(originalDirectory, pinnedDirectory)
        await symlink(
          outsideDirectory,
          originalDirectory,
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      },
    })
    try {
      await handle.append(Buffer.from('> safe\n'))
      await handle.sync()
    } finally {
      await handle.close()
    }

    expect(await readFile(join(pinnedDirectory, 'target.md'), 'utf8')).toContain('> safe')
    expect(await readFile(join(outsideDirectory, 'target.md'), 'utf8')).toBe('outside')
  })

  it.skipIf(process.arch !== 'x64' && process.arch !== 'arm64')(
    'Windows x64 原生打开契约使用与系统头文件一致的 ABI 布局',
    () => {
      expect(projectNoteWindowsNativeLayoutForTests()).toEqual({
        attributeTagInfo: 8,
        basicInfo: 40,
        handle: 8,
        ioStatusBlock: 16,
        objectAttributes: 48,
        renameInfo: 24,
        renameFileNameOffset: 20,
        standardInfo: 24,
      })
    },
  )

  it('序列化引用时转义可执行 Markdown', () => {
    const note = serializeProjectNote({
      version: 1,
      kind: 'chat-message',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-a',
      role: 'assistant',
      quote: '<script>alert(1)</script>\n# heading',
      locator: {
        type: 'text-quote',
        exact: '<script>alert(1)</script>\n# heading',
        start: 0,
        end: 35,
      },
    }, { id: 'session-a', name: 'Research' })
    expect(note).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(note).toContain('\\# heading')

    const projectFileNote = serializeProjectNote({
      version: 1,
      kind: 'project-file',
      projectId: 'project-a',
      relativePath: 'book.epub',
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      fileName: 'book.epub',
      quote: 'selection',
      chapterTitle: '[unsafe](javascript:alert(1))',
      locator: {
        type: 'epub-cfi',
        cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:9)',
      },
    }, { id: 'session-a', name: 'Research' })
    expect(projectFileNote).toContain('\\[unsafe\\](javascript:alert(1))')

    const webNote = serializeProjectNote({
      version: 1,
      kind: 'web-selection',
      projectId: 'project-a',
      url: 'https://example.com/article',
      title: 'Example [article]\nspoof',
      quote: '<script>alert(1)</script>\n![image](file:///tmp/private)',
      locator: {
        type: 'web-text-quote',
        exact: '<script>alert(1)</script>\n![image](file:///tmp/private)',
      },
    }, { id: 'session-a', name: 'Research' })
    expect(webNote).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(webNote).toContain('Example \\[article\\] spoof')
    expect(webNote).toContain('`https://example.com/article`')
  })

  it('无需 Chat 即可向 Project Note 追加网页引用', async () => {
    const workspaceRoot = join(sandbox, 'workspace-without-chat')
    await mkdir(workspaceRoot)
    await writeFile(join(projectRoot, 'notes.md'), '')
    const project = createProject(workspaceRoot, {
      name: 'Project',
      workingDirectory: projectRoot,
    })
    const workspace = {
      id: 'workspace-without-chat',
      name: 'Workspace without Chat',
      slug: 'workspace-without-chat',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => (
      id === workspace.id ? workspace : null
    ))

    const handlers = handlerHarness({})
    const configured = await handlers.get(RPC_CHANNELS.projectNotes.CONFIGURE_TARGET)!(
      rpcContext(workspace.id),
      {
        sessionId: null,
        projectId: project.id,
        relativePath: 'notes.md',
      },
    ) as { projectRootFingerprint: string }
    const append = handlers.get(RPC_CHANNELS.projectNotes.APPEND)!
    await expect(append(rpcContext(workspace.id), {
      requestId: 'append-without-chat',
      projectId: project.id,
      relativePath: 'notes.md',
      expectedProjectRootFingerprint: configured.projectRootFingerprint,
      selection: {
        version: 1,
        kind: 'web-selection',
        projectId: project.id,
        url: 'https://example.com/source',
        title: 'Web Source',
        quote: 'project-scoped evidence',
        locator: {
          type: 'web-text-quote',
          exact: 'project-scoped evidence',
        },
      },
    })).resolves.toMatchObject({
      projectId: project.id,
      relativePath: 'notes.md',
    })

    expect(await readFile(join(projectRoot, 'notes.md'), 'utf8'))
      .toContain('project-scoped evidence')
  })

  it('重启后恢复已写入但未完成的 Add Note receipt 且不重复追加', async () => {
    const workspaceRoot = join(sandbox, 'workspace-recovery')
    await mkdir(workspaceRoot)
    await writeFile(join(projectRoot, 'notes.md'), '')
    const project = createProject(workspaceRoot, {
      name: 'Project',
      workingDirectory: projectRoot,
    })
    const workspace = {
      id: 'workspace-recovery',
      name: 'Workspace recovery',
      slug: 'workspace-recovery',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => (
      id === workspace.id ? workspace : null
    ))
    const handlers = handlerHarness({})
    const configured = await handlers.get(RPC_CHANNELS.projectNotes.CONFIGURE_TARGET)!(
      rpcContext(workspace.id),
      {
        sessionId: null,
        projectId: project.id,
        relativePath: 'notes.md',
      },
    ) as { projectRootFingerprint: string }
    const requestId = 'recover-pending-note'
    const selection = {
      version: 1,
      kind: 'web-selection',
      projectId: project.id,
      url: 'https://example.com/recovery',
      title: 'Recovery source',
      quote: 'recover exactly once',
      locator: {
        type: 'web-text-quote',
        exact: 'recover exactly once',
      },
    } as const
    const payload = Buffer.from(serializeProjectNote(selection), 'utf8')
    const response = {
      projectId: project.id,
      relativePath: 'notes.md',
      appendedAt: '2026-08-27T00:00:00.000Z',
    }
    const signature = createHash('sha256').update(JSON.stringify({
      projectId: project.id,
      relativePath: 'notes.md',
      expectedProjectRootFingerprint: configured.projectRootFingerprint,
      selection,
    })).digest('hex')
    const receiptFile = join(
      getProjectPath(workspaceRoot, project.slug),
      'data',
      'project-note-requests.json',
    )
    await mkdir(join(getProjectPath(workspaceRoot, project.slug), 'data'), { recursive: true })
    await writeFile(join(projectRoot, 'notes.md'), payload)
    await writeFile(receiptFile, JSON.stringify({
      version: 1,
      requests: {
        [requestId]: {
          signature,
          status: 'pending',
          targetPath: 'notes.md',
          rootFingerprint: configured.projectRootFingerprint,
          initialSize: 0,
          initialHash: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
          payloadBase64: payload.toString('base64'),
          response,
        },
      },
    }))

    await expect(handlers.get(RPC_CHANNELS.projectNotes.APPEND)!(rpcContext(workspace.id), {
      requestId,
      projectId: project.id,
      relativePath: 'notes.md',
      expectedProjectRootFingerprint: configured.projectRootFingerprint,
      selection,
    })).resolves.toEqual(response)

    const content = await readFile(join(projectRoot, 'notes.md'), 'utf8')
    expect(content.match(/recover exactly once/g)).toHaveLength(1)
    const receipts = JSON.parse(await readFile(receiptFile, 'utf8')) as {
      requests: Record<string, Record<string, unknown>>
    }
    expect(receipts.requests[requestId]?.status).toBe('complete')
    expect(receipts.requests[requestId]?.payloadBase64).toBeUndefined()
  })

  it('选择 Note 后 Project 根目录改变时不会写入新目录的同名文件', async () => {
    const workspaceRoot = join(sandbox, 'workspace-root-change')
    const replacementRoot = join(sandbox, 'replacement-project')
    await mkdir(workspaceRoot)
    await mkdir(replacementRoot)
    await writeFile(join(projectRoot, 'notes.md'), 'original')
    await writeFile(join(replacementRoot, 'notes.md'), 'replacement')
    const project = createProject(workspaceRoot, {
      name: 'Project',
      workingDirectory: projectRoot,
    })
    const workspace = {
      id: 'workspace-root-change',
      name: 'Workspace root change',
      slug: 'workspace-root-change',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => (
      id === workspace.id ? workspace : null
    ))

    const handlers = handlerHarness({})
    const configured = await handlers.get(RPC_CHANNELS.projectNotes.CONFIGURE_TARGET)!(
      rpcContext(workspace.id),
      {
        sessionId: null,
        projectId: project.id,
        relativePath: 'notes.md',
      },
    ) as { projectRootFingerprint: string }
    updateProject(workspaceRoot, project.slug, { workingDirectory: replacementRoot })

    await expect(handlers.get(RPC_CHANNELS.projectNotes.APPEND)!(rpcContext(workspace.id), {
      requestId: 'append-after-project-root-change',
      projectId: project.id,
      relativePath: 'notes.md',
      expectedProjectRootFingerprint: configured.projectRootFingerprint,
      selection: {
        version: 1,
        kind: 'web-selection',
        projectId: project.id,
        url: 'https://example.com/source',
        title: 'Web Source',
        quote: 'must not be written',
        locator: {
          type: 'web-text-quote',
          exact: 'must not be written',
        },
      },
    })).rejects.toThrow(/^PROJECT_NOTE_TARGET_CHANGED:/)

    expect(await readFile(join(projectRoot, 'notes.md'), 'utf8')).toBe('original')
    expect(await readFile(join(replacementRoot, 'notes.md'), 'utf8')).toBe('replacement')
  })

  it('已完成的 Add Note 在 Project 根目录改变后仍按 receipt 幂等返回', async () => {
    const workspaceRoot = join(sandbox, 'workspace-complete-retry')
    const replacementRoot = join(sandbox, 'replacement-after-complete')
    await mkdir(workspaceRoot)
    await mkdir(replacementRoot)
    await writeFile(join(projectRoot, 'notes.md'), '')
    await writeFile(join(replacementRoot, 'notes.md'), 'replacement')
    const project = createProject(workspaceRoot, {
      name: 'Project',
      workingDirectory: projectRoot,
    })
    const workspace = {
      id: 'workspace-complete-retry',
      name: 'Workspace complete retry',
      slug: 'workspace-complete-retry',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => (
      id === workspace.id ? workspace : null
    ))
    const handlers = handlerHarness({})
    const configured = await handlers.get(RPC_CHANNELS.projectNotes.CONFIGURE_TARGET)!(
      rpcContext(workspace.id),
      {
        sessionId: null,
        projectId: project.id,
        relativePath: 'notes.md',
      },
    ) as { projectRootFingerprint: string }
    const request = {
      requestId: 'complete-before-project-root-change',
      projectId: project.id,
      relativePath: 'notes.md',
      expectedProjectRootFingerprint: configured.projectRootFingerprint,
      selection: {
        version: 1,
        kind: 'web-selection',
        projectId: project.id,
        url: 'https://example.com/source',
        title: 'Web Source',
        quote: 'write once before root change',
        locator: {
          type: 'web-text-quote',
          exact: 'write once before root change',
        },
      },
    } as const
    const append = handlers.get(RPC_CHANNELS.projectNotes.APPEND)!
    const firstResponse = await append(rpcContext(workspace.id), request)
    updateProject(workspaceRoot, project.slug, { workingDirectory: replacementRoot })

    await expect(append(rpcContext(workspace.id), request)).resolves.toEqual(firstResponse)
    expect((await readFile(join(projectRoot, 'notes.md'), 'utf8'))
      .match(/write once before root change/g)).toHaveLength(1)
    expect(await readFile(join(replacementRoot, 'notes.md'), 'utf8')).toBe('replacement')
  })

  it('Project 删除锁生效后不会继续写 Note 或重建 receipt 目录', async () => {
    const workspaceRoot = join(sandbox, 'workspace-delete-race')
    await mkdir(workspaceRoot)
    await writeFile(join(projectRoot, 'notes.md'), '')
    const project = createProject(workspaceRoot, {
      name: 'Project',
      workingDirectory: projectRoot,
    })
    const workspace = {
      id: 'workspace-delete-race',
      name: 'Workspace delete race',
      slug: 'workspace-delete-race',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => (
      id === workspace.id ? workspace : null
    ))
    const handlers = handlerHarness({})
    const configured = await handlers.get(RPC_CHANNELS.projectNotes.CONFIGURE_TARGET)!(
      rpcContext(workspace.id),
      {
        sessionId: null,
        projectId: project.id,
        relativePath: 'notes.md',
      },
    ) as { projectRootFingerprint: string }

    let releaseDeletion!: () => void
    let markDeletionLocked!: () => void
    const deletionLocked = new Promise<void>(resolve => { markDeletionLocked = resolve })
    const deletionReleased = new Promise<void>(resolve => { releaseDeletion = resolve })
    const projectPath = getProjectPath(workspaceRoot, project.slug)
    const deletion = withProjectMutationLock(workspaceRoot, project.id, async () => {
      markDeletionLocked()
      await deletionReleased
      await rm(projectPath, { recursive: true, force: true })
    })
    await deletionLocked

    const append = handlers.get(RPC_CHANNELS.projectNotes.APPEND)!(rpcContext(workspace.id), {
      requestId: 'append-while-project-delete-races',
      projectId: project.id,
      relativePath: 'notes.md',
      expectedProjectRootFingerprint: configured.projectRootFingerprint,
      selection: {
        version: 1,
        kind: 'web-selection',
        projectId: project.id,
        url: 'https://example.com/source',
        title: 'Web Source',
        quote: 'must not survive deletion',
        locator: {
          type: 'web-text-quote',
          exact: 'must not survive deletion',
        },
      },
    })
    await Bun.sleep(10)
    releaseDeletion()
    await deletion

    await expect(append).rejects.toThrow(/^PROJECT_NOTE_SOURCE_INVALID:/)
    expect(await readFile(join(projectRoot, 'notes.md'), 'utf8')).toBe('')
    expect(existsSync(projectPath)).toBe(false)
  })

  it('RPC 以当前 Workspace 和 Project 为授权边界，并校验 Chat 引用来源', async () => {
    const workspaceRoot = join(sandbox, 'workspace')
    await mkdir(workspaceRoot)
    await writeFile(join(projectRoot, 'notes.md'), '')
    const project = createProject(workspaceRoot, {
      name: 'Project',
      workingDirectory: projectRoot,
    })
    const workspace = {
      id: 'workspace-a',
      name: 'Workspace A',
      slug: 'workspace-a',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    const otherWorkspace = { ...workspace, id: 'workspace-b', slug: 'workspace-b' }
    spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => (
      id === workspace.id ? workspace : id === otherWorkspace.id ? otherWorkspace : null
    ))

    const session = {
      id: 'session-a',
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      projectId: project.id,
      lastMessageAt: 1,
      messages: [{
        id: 'source-message',
        role: 'assistant',
        content: 'before **bold** after',
        timestamp: 1,
      }],
      isProcessing: false,
    } as Session
    const sessionManager: Partial<HandlerDeps['sessionManager']> = {
      getSession: async id => id === session.id ? session : null,
      setSessionProjectNoteTarget: async (_id, _projectId, relativePath) => {
        session.projectNoteTargetPath = relativePath
        return {
          relativePath,
          recentPaths: [relativePath],
        }
      },
    }
    const handlers = handlerHarness(sessionManager)
    const configure = handlers.get(RPC_CHANNELS.projectNotes.CONFIGURE_TARGET)!

    const configured = await configure(rpcContext(workspace.id), {
      sessionId: session.id,
      projectId: project.id,
      relativePath: 'notes.md',
    }) as { projectRootFingerprint: string }
    expect(configured).toMatchObject({ relativePath: 'notes.md' })

    await expect(configure(rpcContext(otherWorkspace.id), {
      sessionId: session.id,
      projectId: project.id,
      relativePath: 'notes.md',
    })).resolves.toMatchObject({
      relativePath: 'notes.md',
      recentPaths: [],
    })

    const append = handlers.get(RPC_CHANNELS.projectNotes.APPEND)!
    const appendRequest = {
      requestId: 'append-markdown-selection',
      projectId: project.id,
      relativePath: 'notes.md',
      expectedProjectRootFingerprint: configured.projectRootFingerprint,
      selection: {
        version: 1,
        kind: 'chat-message',
        projectId: project.id,
        sessionId: session.id,
        messageId: 'source-message',
        role: 'assistant',
        quote: 'before bold after',
        locator: {
          type: 'text-quote',
          exact: 'before bold after',
          start: 0,
          end: 17,
        },
      },
    } as const
    await expect(append(rpcContext(workspace.id), appendRequest))
      .resolves.toMatchObject({ relativePath: 'notes.md' })
    const appendAfterRestart = handlerHarness(sessionManager)
      .get(RPC_CHANNELS.projectNotes.APPEND)!
    await expect(appendAfterRestart(rpcContext(workspace.id), appendRequest))
      .resolves.toMatchObject({ relativePath: 'notes.md' })
    await expect(append(rpcContext(workspace.id), appendRequest))
      .resolves.toMatchObject({ relativePath: 'notes.md' })
    await expect(append(rpcContext(otherWorkspace.id), {
      ...appendRequest,
      requestId: 'append-cross-workspace-chat-reference',
    }))
      .rejects.toThrow(/^PROJECT_NOTE_SOURCE_INVALID:/)

    await expect(append(rpcContext(workspace.id), {
      ...appendRequest,
      requestId: 'append-web-selection',
      selection: {
        version: 1,
        kind: 'web-selection',
        projectId: project.id,
        url: 'https://example.com/source',
        title: 'Web Source',
        quote: 'web evidence',
        locator: {
          type: 'web-text-quote',
          exact: 'web evidence',
        },
      },
    })).resolves.toMatchObject({ relativePath: 'notes.md' })

    await expect(append(rpcContext(workspace.id), {
      ...appendRequest,
      requestId: 'append-cross-project-web-selection',
      selection: {
        version: 1,
        kind: 'web-selection',
        projectId: 'project-other',
        url: 'https://example.com/source',
        title: 'Web Source',
        quote: 'web evidence',
        locator: {
          type: 'web-text-quote',
          exact: 'web evidence',
        },
      },
    })).rejects.toThrow(/^PROJECT_NOTE_SOURCE_INVALID:/)

    await expect(append(rpcContext(workspace.id), {
      ...appendRequest,
      requestId: 'append-oversized-reference',
      selection: {
        ...appendRequest.selection,
        ignoredPadding: 'x'.repeat(MAX_REFERENCE_SERIALIZED_BYTES),
      },
    })).rejects.toThrow(/^PROJECT_NOTE_INVALID_REQUEST:/)

    const note = await readFile(join(projectRoot, 'notes.md'), 'utf8')
    expect(note.match(/before bold after/g)).toHaveLength(1)
    expect(note).toContain('web evidence')

    const receiptFile = join(
      getProjectPath(workspaceRoot, project.slug),
      'data',
      'project-note-requests.json',
    )
    const firstReceipts = JSON.parse(await readFile(receiptFile, 'utf8')) as {
      requests: Record<string, Record<string, unknown>>
    }
    expect('payloadBase64' in firstReceipts.requests['append-markdown-selection']!).toBe(false)

    for (let index = 0; index < 130; index += 1) {
      await append(rpcContext(workspace.id), {
        ...appendRequest,
        requestId: `bounded-receipt-${index}`,
        selection: {
          version: 1,
          kind: 'web-selection',
          projectId: project.id,
          url: `https://example.com/source/${index}`,
          title: 'Web Source',
          quote: `bounded evidence ${index}`,
          locator: {
            type: 'web-text-quote',
            exact: `bounded evidence ${index}`,
          },
        },
      })
    }
    const boundedReceipts = JSON.parse(await readFile(receiptFile, 'utf8')) as {
      requests: Record<string, Record<string, unknown>>
    }
    expect(Object.keys(boundedReceipts.requests)).toHaveLength(128)
    expect(boundedReceipts.requests['bounded-receipt-0']).toBeUndefined()
    expect(boundedReceipts.requests['bounded-receipt-129']).toBeDefined()
  })

})
