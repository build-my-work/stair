import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test'
import * as config from '@craft-agent/shared/config'
import {
  RPC_CHANNELS,
  type AppendProjectNoteRequest,
  type Session,
} from '@craft-agent/shared/protocol'
import { createProject } from '@craft-agent/shared/projects'
import type {
  HandlerFn,
  RequestContext,
  RpcServer,
} from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import {
  HANDLED_CHANNELS,
  appendProjectNoteWithinRoot,
  ensureProjectNoteTarget,
  registerProjectNoteHandlers,
  resolveExpectedProjectNoteTarget,
  serializeProjectNote,
} from './project-notes'
import { MAX_PROJECT_FILE_TEXT_BYTES } from './project-files'

function createHandlerHarness(sessionManager: Partial<HandlerDeps['sessionManager']>) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    },
    push: () => {},
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  }
  registerProjectNoteHandlers(server, {
    sessionManager,
    oauthFlowStore: {},
    platform: {},
  } as HandlerDeps)
  return handlers
}

function createAppendRequest(
  requestId: string,
  sessionId: string,
  projectId: string,
  quote = 'Evidence',
): AppendProjectNoteRequest {
  return {
    requestId,
    sessionId,
    projectId,
    expectedTargetPath: 'notes.md',
    selection: {
      version: 1,
      kind: 'web-selection',
      url: 'https://example.com',
      title: 'Example',
      quote,
      locator: {
        type: 'text-quote',
        exact: quote,
      },
    },
  }
}

describe('Project Notes', () => {
  let sandbox = ''
  let root = ''

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'craft-project-note-'))
    root = join(sandbox, 'project')
    await mkdir(root)
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('accepts only an existing Markdown target', async () => {
    await writeFile(join(root, 'existing.md'), '# Existing\n')

    await expect(ensureProjectNoteTarget(root, 'existing.md'))
      .resolves.toBeUndefined()
    await expect(ensureProjectNoteTarget(root, 'missing.md'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_NOT_FOUND:/)
  })

  it('rejects traversal, non-Markdown, missing targets, and directories', async () => {
    await mkdir(join(root, 'folder.md'))

    await expect(ensureProjectNoteTarget(root, '../outside.md'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_INVALID:/)
    await expect(ensureProjectNoteTarget(root, 'notes.txt'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_INVALID:/)
    await expect(ensureProjectNoteTarget(root, 'missing/notes.md'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_NOT_FOUND:/)
    await expect(ensureProjectNoteTarget(root, 'folder.md'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_NOT_REGULAR:/)
  })

  it('rejects symlink targets and symlink parent directories', async () => {
    if (process.platform === 'win32') return

    const outside = join(sandbox, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'outside.md'), '')
    await symlink(join(outside, 'outside.md'), join(root, 'linked.md'))
    await symlink(outside, join(root, 'linked-dir'), 'dir')

    await expect(ensureProjectNoteTarget(root, 'linked.md'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_ACCESS_DENIED:/)
    await expect(ensureProjectNoteTarget(root, 'linked-dir/outside.md'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_ACCESS_DENIED:/)
  })

  it('rejects invalid UTF-8 and over-limit targets before appending', async () => {
    await writeFile(join(root, 'invalid.md'), Buffer.from([0xff]))
    await writeFile(join(root, 'large.md'), '')
    await truncate(join(root, 'large.md'), MAX_PROJECT_FILE_TEXT_BYTES + 1)

    await expect(appendProjectNoteWithinRoot(root, 'invalid.md', '> note\n'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_INVALID_TEXT:/)
    await expect(appendProjectNoteWithinRoot(root, 'large.md', '> note\n'))
      .rejects.toThrow(/^PROJECT_NOTE_TARGET_TOO_LARGE:/)
  })

  it('normalizes separators and serializes concurrent appends without loss', async () => {
    await writeFile(join(root, 'notes.md'), 'Existing line')
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendProjectNoteWithinRoot(root, 'notes.md', `> note-${index}\n`)),
    )

    const content = await readFile(join(root, 'notes.md'), 'utf8')
    expect(content.startsWith('Existing line\n\n> note-')).toBe(true)
    for (let index = 0; index < 20; index += 1) {
      expect(content.match(new RegExp(`> note-${index}(?:\\n|$)`, 'g')))
        .toHaveLength(1)
    }
    expect(content.endsWith('\n')).toBe(true)
  })

  it('writes source attribution without allowing selected HTML through', () => {
    const web = serializeProjectNote({
      version: 1,
      kind: 'web-selection',
      url: 'https://example.com/article',
      title: 'Example [article]\nspoof',
      quote: '<script>alert(1)</script>\n![image](file:///tmp/private)',
      locator: {
        type: 'text-quote',
        exact: '<script>alert(1)</script>\n![image](file:///tmp/private)',
      },
    }, {
      id: 'session-1',
      name: 'Research',
    }, '2026-07-29T00:00:00.000Z')

    expect(web).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(web).toContain('!\\[image\\](file:///tmp/private)')
    expect(web).toContain('[Example \\[article\\] spoof](<https://example.com/article>)')
    expect(web).toContain('2026-07-29T00:00:00.000Z')
    expect(web).not.toContain('<script>')
    expect(web).not.toContain('![image]')

    const chat = serializeProjectNote({
      version: 1,
      kind: 'chat-message',
      sessionId: 'session-1',
      messageId: 'message-1',
      role: 'plan',
      quote: 'Do the work',
      locator: {
        type: 'text-quote',
        exact: 'Do the work',
        start: 0,
        end: 11,
      },
    }, {
      id: 'session-1',
      name: 'Research\nspoof',
    }, '2026-07-29T00:00:00.000Z')
    expect(chat).toContain('Chat · Plan · Research spoof')

    const projectFile = serializeProjectNote({
      version: 1,
      kind: 'project-file',
      projectId: 'project-1',
      relativePath: 'papers/`review`.pdf',
      fileName: 'review.pdf',
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      quote: 'Evidence',
      locator: {
        type: 'pdf-text-quote',
        exact: 'Evidence',
        startPage: 2,
        endPage: 3,
      },
    }, {
      id: 'session-1',
      name: 'Research',
    }, '2026-07-29T00:00:00.000Z')
    expect(projectFile).toContain('``papers/`review`.pdf`` · pages 2-3')
  })

  it('binds append to the Project and target path the user confirmed', () => {
    expect(resolveExpectedProjectNoteTarget({
      projectId: 'project-1',
      projectNoteTargetPath: 'notes.md',
    }, 'project-1', 'notes.md')).toBe('notes.md')

    expect(() => resolveExpectedProjectNoteTarget({
      projectId: 'project-2',
      projectNoteTargetPath: 'notes.md',
    }, 'project-1', 'notes.md')).toThrow(
      /^PROJECT_NOTE_SESSION_PROJECT_CHANGED:/,
    )
    expect(() => resolveExpectedProjectNoteTarget({
      projectId: 'project-1',
      projectNoteTargetPath: 'other.md',
    }, 'project-1', 'notes.md')).toThrow(/^PROJECT_NOTE_TARGET_CHANGED:/)
  })

  it('authorizes the caller workspace before returning a cached append', async () => {
    const workspaceRootA = join(sandbox, 'workspace-a')
    const workspaceRootB = join(sandbox, 'workspace-b')
    await Promise.all([
      mkdir(workspaceRootA),
      mkdir(workspaceRootB),
      writeFile(join(root, 'notes.md'), ''),
    ])
    const project = createProject(workspaceRootA, {
      name: 'Project A',
      workingDirectory: root,
    })
    const workspaceA = {
      id: 'workspace-a',
      name: 'Workspace A',
      slug: 'workspace-a',
      rootPath: workspaceRootA,
      createdAt: 1,
    }
    const workspaceB = {
      id: 'workspace-b',
      name: 'Workspace B',
      slug: 'workspace-b',
      rootPath: workspaceRootB,
      createdAt: 1,
    }
    const workspaceLookup = spyOn(config, 'getWorkspaceByNameOrId')
      .mockImplementation(id => {
        if (id === workspaceA.id) return workspaceA
        if (id === workspaceB.id) return workspaceB
        return null
      })
    let getSessionCalls = 0
    const session = {
      id: 'session-1',
      name: 'Research',
      workspaceId: workspaceA.id,
      projectId: project.id,
      projectNoteTargetPath: 'notes.md',
      messages: [],
    } as unknown as Session
    const handlers = createHandlerHarness({
      getSession: async () => {
        getSessionCalls += 1
        return session
      },
    })
    const append = handlers.get(RPC_CHANNELS.projectNotes.APPEND)!
    const request = createAppendRequest(
      'request-1',
      session.id,
      project.id,
    )

    try {
      await expect(append({
        clientId: 'client-a',
        workspaceId: workspaceA.id,
        webContentsId: null,
      }, request)).resolves.toMatchObject({
        projectId: project.id,
        relativePath: 'notes.md',
      })
      await expect(append({
        clientId: 'client-b',
        workspaceId: workspaceB.id,
        webContentsId: null,
      }, request)).rejects.toThrow(
        /^PROJECT_NOTE_SESSION_WORKSPACE_MISMATCH:/,
      )
      expect(getSessionCalls).toBe(2)
    } finally {
      workspaceLookup.mockRestore()
    }
  })

  it('does not evict in-flight appends when the cache exceeds its settled-entry limit', async () => {
    const workspaceRoot = join(sandbox, 'workspace')
    await mkdir(workspaceRoot)
    const project = createProject(workspaceRoot, {
      name: 'Project',
      workingDirectory: root,
    })
    const workspace = {
      id: 'workspace',
      name: 'Workspace',
      slug: 'workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    const workspaceLookup = spyOn(config, 'getWorkspaceByNameOrId')
      .mockImplementation(id => id === workspace.id ? workspace : null)
    const session = {
      id: 'session-1',
      name: 'Research',
      workspaceId: workspace.id,
      projectId: project.id,
      projectNoteTargetPath: 'notes.md',
      messages: [],
    } as unknown as Session
    const handlers = createHandlerHarness({
      getSession: async () => session,
    })
    const append = handlers.get(RPC_CHANNELS.projectNotes.APPEND)!
    const ctx: RequestContext = {
      clientId: 'client',
      workspaceId: workspace.id,
      webContentsId: null,
    }
    let releaseRootResolution: () => void = () => {}
    const rootResolutionGate = new Promise<void>(resolve => {
      releaseRootResolution = resolve
    })
    let rootResolutionCalls = 0
    const realpathSpy = spyOn(fsPromises, 'realpath')
      .mockImplementation(async () => {
        rootResolutionCalls += 1
        await rootResolutionGate
        throw new Error('blocked test root resolution')
      })
    const requests = Array.from({ length: 513 }, (_, index) =>
      createAppendRequest(
        `request-${index}`,
        session.id,
        project.id,
        `Evidence ${index}`,
      ))
    const initialOperations = requests.map(request => append(ctx, request))
    let retryOperation: Promise<unknown> | undefined

    try {
      for (let attempt = 0; attempt < 100 && rootResolutionCalls < 513; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      expect(rootResolutionCalls).toBe(513)

      retryOperation = append(ctx, requests[0]!)
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(rootResolutionCalls).toBe(513)
    } finally {
      releaseRootResolution()
      await Promise.allSettled([
        ...initialOperations,
        ...(retryOperation ? [retryOperation] : []),
      ])
      realpathSpy.mockRestore()
      workspaceLookup.mockRestore()
    }
  })

  it('registers only target configuration and append channels', () => {
    expect(HANDLED_CHANNELS).toEqual([
      'projectNotes:configureTarget',
      'projectNotes:append',
    ])
  })

  it('rejects malformed requests before resolving workspace state', async () => {
    const handlers = createHandlerHarness({})
    const ctx: RequestContext = {
      clientId: 'test',
      workspaceId: null,
      webContentsId: null,
    }

    await expect(handlers.get('projectNotes:configureTarget')!(ctx, {
      sessionId: 'session-1',
      target: { mode: 'create', relativePath: '../outside.md' },
    })).rejects.toThrow(/^PROJECT_NOTE_TARGET_INVALID:/)
    await expect(handlers.get('projectNotes:configureTarget')!(ctx, {
      sessionId: 'session-1',
      relativePath: '../outside.md',
    })).rejects.toThrow(/^PROJECT_NOTE_TARGET_INVALID:/)
    await expect(handlers.get('projectNotes:configureTarget')!(ctx, {
      sessionId: 'session-1',
      relativePath: 'notes.md',
    })).rejects.toThrow(/^PROJECT_NOTE_INVALID_REQUEST:/)
    await expect(handlers.get('projectNotes:append')!(ctx, {
      requestId: 'request-1',
      sessionId: 'session-1',
      selection: { kind: 'manual-note', text: 'not a selection' },
    })).rejects.toThrow(/^PROJECT_NOTE_INVALID_REQUEST:/)
    await expect(handlers.get('projectNotes:append')!(ctx, {
      requestId: 'request-1',
      sessionId: 'session-1',
      expectedTargetPath: 'notes.md',
      selection: {
        version: 1,
        kind: 'web-selection',
        url: 'https://example.com',
        title: 'Example',
        quote: 'Evidence',
        locator: {
          type: 'text-quote',
          exact: 'Evidence',
        },
      },
    })).rejects.toThrow(/^PROJECT_NOTE_INVALID_REQUEST:/)
    await expect(handlers.get('projectNotes:append')!(ctx, {
      requestId: 'request-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      selection: {
        version: 1,
        kind: 'web-selection',
        url: 'https://example.com',
        title: 'Example',
        quote: 'Evidence',
        locator: {
          type: 'text-quote',
          exact: 'Evidence',
        },
      },
    })).rejects.toThrow(/^PROJECT_NOTE_TARGET_INVALID:/)
  })
})
