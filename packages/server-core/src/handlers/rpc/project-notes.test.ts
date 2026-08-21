import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

import { MAX_REFERENCE_SERIALIZED_BYTES } from '@craft-agent/core'
import * as config from '@craft-agent/shared/config'
import { RPC_CHANNELS, type Session } from '@craft-agent/shared/protocol'
import { createProject } from '@craft-agent/shared/projects'
import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import {
  appendProjectNoteWithinRoot,
  ensureProjectNoteTarget,
  registerProjectNoteHandlers,
  serializeProjectNote,
} from './project-notes'
import { projectNoteWindowsNativeLayoutForTests } from './secure-project-note-file'

function handlerHarness(sessionManager: Partial<HandlerDeps['sessionManager']>) {
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle: (channel: string, handler: HandlerFn) => { handlers.set(channel, handler) },
    push: () => {},
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  } as RpcServer
  registerProjectNoteHandlers(server, {
    sessionManager,
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
    sandbox = await mkdtemp(join(tmpdir(), 'stair-project-note-'))
    projectRoot = join(sandbox, 'project')
    await mkdir(projectRoot)
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('只接受 Project 内现有 Markdown/文本普通文件并拒绝软链接', async () => {
    await writeFile(join(projectRoot, 'notes.md'), '')
    await expect(ensureProjectNoteTarget(projectRoot, 'notes.md')).resolves.toBeUndefined()
    await expect(ensureProjectNoteTarget(projectRoot, '../outside.md'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_INVALID:/)
    await expect(ensureProjectNoteTarget(projectRoot, 'notes.json'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_INVALID:/)

    if (process.platform !== 'win32') {
      await writeFile(join(sandbox, 'outside.md'), '')
      await symlink(join(sandbox, 'outside.md'), join(projectRoot, 'linked.md'))
      await expect(ensureProjectNoteTarget(projectRoot, 'linked.md'))
        .rejects.toThrow(/^PROJECT_NOTE_TARGET_ACCESS_DENIED:/)
    }
  })

  it('串行并发追加且不丢失任何引用', async () => {
    await writeFile(join(projectRoot, 'notes.md'), 'Existing')
    await Promise.all(Array.from({ length: 12 }, (_, index) => (
      appendProjectNoteWithinRoot(projectRoot, 'notes.md', `> note-${index}\n`)
    )))
    const content = await readFile(join(projectRoot, 'notes.md'), 'utf8')
    for (let index = 0; index < 12; index += 1) {
      expect(content.match(new RegExp(`> note-${index}(?:\\n|$)`, 'g'))).toHaveLength(1)
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

    await appendProjectNoteWithinRoot(projectRoot, 'notes/target.md', '> safe\n', {
      beforeFinalOpen: async () => {
        await rename(originalDirectory, pinnedDirectory)
        await rename(replacementDirectory, originalDirectory)
      },
    })

    expect(await readFile(join(pinnedDirectory, 'target.md'), 'utf8')).toContain('> safe')
    expect(await readFile(join(originalDirectory, 'target.md'), 'utf8')).toBe('replacement')
  })

  it('父目录在最终打开前被替换为软链接时不会跟随软链接', async () => {
    if (process.platform === 'win32') return
    const originalDirectory = join(projectRoot, 'notes')
    const outsideDirectory = join(sandbox, 'outside')
    const pinnedDirectory = join(projectRoot, 'notes-pinned')
    await mkdir(originalDirectory)
    await mkdir(outsideDirectory)
    await writeFile(join(originalDirectory, 'target.md'), 'original')
    await writeFile(join(outsideDirectory, 'target.md'), 'outside')

    await appendProjectNoteWithinRoot(projectRoot, 'notes/target.md', '> safe\n', {
      beforeFinalOpen: async () => {
        await rename(originalDirectory, pinnedDirectory)
        await symlink(outsideDirectory, originalDirectory)
      },
    })

    expect(await readFile(join(pinnedDirectory, 'target.md'), 'utf8')).toContain('> safe')
    expect(await readFile(join(outsideDirectory, 'target.md'), 'utf8')).toBe('outside')
  })

  it('Windows x64 原生打开契约使用与系统头文件一致的 ABI 布局', () => {
    if (process.arch !== 'x64' && process.arch !== 'arm64') return
    expect(projectNoteWindowsNativeLayoutForTests()).toEqual({
      attributeTagInfo: 8,
      handle: 8,
      ioStatusBlock: 16,
      objectAttributes: 48,
      standardInfo: 24,
    })
  })

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

  it('RPC 以当前 Workspace 和 Session Project 为最终授权边界', async () => {
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
    const handlers = handlerHarness({
      getSession: async id => id === session.id ? session : null,
      setSessionProjectNoteTarget: async (_id, _projectId, relativePath, rootFingerprint) => {
        session.projectNoteTargetPath = relativePath ?? undefined
        session.projectNoteTargetRootFingerprint = rootFingerprint ?? undefined
        return {
          relativePath,
          recentPaths: relativePath ? [relativePath] : [],
        }
      },
      clearSessionProjectNoteTargetIfMatches: async () => {},
    })
    const configure = handlers.get(RPC_CHANNELS.projectNotes.CONFIGURE_TARGET)!

    await expect(configure(rpcContext(workspace.id), {
      sessionId: session.id,
      projectId: project.id,
      relativePath: 'notes.md',
    })).resolves.toMatchObject({ relativePath: 'notes.md' })

    await expect(configure(rpcContext(otherWorkspace.id), {
      sessionId: session.id,
      projectId: project.id,
      relativePath: 'notes.md',
    })).rejects.toThrow(/^PROJECT_NOTE_SESSION_WORKSPACE_MISMATCH:/)

    await expect(configure(rpcContext(workspace.id), {
      sessionId: session.id,
      projectId: 'project-other',
      relativePath: 'notes.md',
    })).rejects.toThrow(/^PROJECT_NOTE_SESSION_PROJECT_CHANGED:/)

    expect(session.projectNoteTargetRootFingerprint).toMatch(/^[a-f0-9]{64}$/)

    const append = handlers.get(RPC_CHANNELS.projectNotes.APPEND)!
    const appendRequest = {
      requestId: 'append-markdown-selection',
      sessionId: session.id,
      projectId: project.id,
      expectedTargetPath: 'notes.md',
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
    await expect(append(rpcContext(workspace.id), appendRequest))
      .resolves.toMatchObject({ relativePath: 'notes.md' })
    await expect(append(rpcContext(otherWorkspace.id), appendRequest))
      .rejects.toThrow(/^PROJECT_NOTE_SESSION_WORKSPACE_MISMATCH:/)

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
  })
})
