import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type {
  MessageReference,
  EpubProjectFileReferenceV1,
  WebSelectionReferenceV1,
} from '@craft-agent/core/types'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { createProject } from '@craft-agent/shared/projects'

import { SessionManager, createManagedSession } from './SessionManager'
import { createMinimalEpubFixture } from './test-epub-fixture'

interface ManagedHarness {
  id: string
  name?: string
  isProcessing: boolean
  stopRequested?: boolean
  agent: unknown
  messages: Array<{
    id: string
    role: string
    content: string
    references?: MessageReference[]
    isQueued?: boolean
  }>
  messageQueue: Array<{
    message: string
    messageId?: string
    options?: { references?: MessageReference[] }
  }>
  lastSentOptions?: { references?: MessageReference[] }
  lastSentMessage?: string
  authRetryAttempted?: boolean
  authRetryInProgress?: boolean
}

interface SessionManagerHarness {
  sessions: Map<string, unknown>
  getOrCreateAgent: (managed: unknown) => Promise<unknown>
  processEvent: (managed: unknown, event: unknown) => Promise<void>
  attemptAuthRetry: (
    sessionId: string,
    managed: unknown,
    workspaceId: string,
    failureErrorCode?: string,
  ) => boolean
}

describe('SessionManager Project File references', () => {
  let workspaceRoot = ''
  let projectRoot = ''
  let projectId = ''
  let reference: EpubProjectFileReferenceV1
  let managers: Set<SessionManager>
  const workspaceId = 'workspace-reference-test'

  beforeEach(() => {
    managers = new Set()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'session-reference-'))
    projectRoot = join(workspaceRoot, 'project-root')
    mkdirSync(join(projectRoot, 'books'), { recursive: true })
    const bytes = createMinimalEpubFixture('session-reference')
    writeFileSync(join(projectRoot, 'books', 'os.epub'), bytes)
    projectId = createProject(workspaceRoot, {
      name: 'Book',
      workingDirectory: projectRoot,
    }).id
    reference = {
      version: 1,
      kind: 'project-file',
      projectId,
      relativePath: 'books/os.epub',
      sourceFingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      fileName: 'os.epub',
      quote: 'selected paragraph',
      contextBefore: 'before',
      contextAfter: 'after',
      chapterKey: 'chapter-1',
      chapterTitle: 'Chapter 1',
      tocPath: [{
        key: 'chapter-1',
        title: 'Chapter 1',
        orderPath: [0],
      }],
      locator: {
        type: 'epub-cfi',
        cfiRange: 'epubcfi(/6/4!/4/2:0,/1:0,/1:18)',
      },
    }
  })

  afterEach(async () => {
    for (const manager of managers) {
      await manager.flushAllSessions()
      manager.cleanup()
    }
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  function installSession(
    manager: SessionManager,
    sessionId: string,
    options: {
      messagesLoaded?: boolean
      isProcessing?: boolean
      name?: string
      projectId?: string | null
    } = {},
  ): ManagedHarness {
    managers.add(manager)
    const workspace = {
      id: workspaceId,
      name: 'Reference Workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      {
        id: sessionId,
        name: options.name === undefined ? 'Reference test' : options.name,
        ...(options.projectId === null
          ? {}
          : { projectId: options.projectId ?? projectId }),
      },
      workspace as never,
      {
        messagesLoaded: options.messagesLoaded ?? true,
        isProcessing: options.isProcessing ?? false,
      },
    )
    ;(manager as unknown as SessionManagerHarness).sessions.set(sessionId, managed)
    return managed as unknown as ManagedHarness
  }

  function storedMessages(sessionId: string): Array<Record<string, unknown>> {
    const lines = readFileSync(
      getSessionFilePath(workspaceRoot, sessionId),
      'utf8',
    ).trim().split('\n')
    return lines.slice(1).map(line => JSON.parse(line) as Record<string, unknown>)
  }

  it('persists raw references before ACK and sends escaped untrusted data to the model', async () => {
    const manager = new SessionManager()
    const sessionId = 'normal-reference'
    const managed = installSession(manager, sessionId)
    let modelInput = ''

    const fakeAgent = {
      setAllSources: () => {},
      getModel: () => 'test-model',
      getSessionId: () => 'sdk-reference',
      chat: async function* (input: string) {
        modelInput = input
        yield { type: 'complete' as const }
      },
    }
    ;(manager as unknown as SessionManagerHarness).getOrCreateAgent =
      async () => fakeAgent

    let persistedAtAck: Record<string, unknown> | undefined
    await manager.sendMessage(
      sessionId,
      'Explain this selection',
      undefined,
      undefined,
      { references: [reference] },
      undefined,
      undefined,
      () => {
        persistedAtAck = storedMessages(sessionId).at(-1)
      },
      { callerClientId: 'client-a', workspaceId },
    )

    expect(persistedAtAck).toMatchObject({
      type: 'user',
      content: 'Explain this selection',
      references: [reference],
    })
    expect(modelInput).toStartWith(
      'Explain this selection\n\n<project_file_reference_data trust="untrusted">\n',
    )
    expect(modelInput).toContain(reference.locator.cfiRange)
    expect(modelInput).not.toContain('<system-reminder>')
    expect(managed.lastSentOptions?.references).toEqual([reference])

    const reloaded = await manager.getSession(sessionId)
    expect(reloaded?.messages.at(-1)?.references).toEqual([reference])
  })

  it('uses structured reference metadata to title a reference-only first turn', async () => {
    const manager = new SessionManager()
    const sessionId = 'reference-only-title'
    const managed = installSession(manager, sessionId, { name: '' })
    let generatedTitleInput = ''

    const fakeAgent = {
      setAllSources: () => {},
      getModel: () => 'test-model',
      getSessionId: () => 'sdk-reference',
      chat: async function* () {
        yield { type: 'complete' as const }
      },
    }
    ;(manager as unknown as SessionManagerHarness).getOrCreateAgent =
      async () => fakeAgent
    ;(manager as unknown as {
      generateTitle: (managed: unknown, input: string) => Promise<void>
    }).generateTitle = async (_managed, input) => {
      generatedTitleInput = input
    }

    await manager.sendMessage(
      sessionId,
      '',
      undefined,
      undefined,
      { references: [reference] },
    )

    expect(managed.name).toBe('Chapter 1')
    expect(generatedTitleInput).toBe('Chapter 1')
  })

  it('persists and sends web selections for a Session without a Project', async () => {
    const manager = new SessionManager()
    const sessionId = 'web-selection-reference'
    const managed = installSession(manager, sessionId, {
      name: '',
      projectId: null,
    })
    const webReference: WebSelectionReferenceV1 = {
      version: 1,
      kind: 'web-selection',
      url: 'https://example.com/article',
      title: 'Example article',
      quote: 'selected paragraph',
      locator: {
        type: 'text-quote',
        exact: 'selected paragraph',
        prefix: 'before',
        suffix: 'after',
      },
    }
    let modelInput = ''
    const fakeAgent = {
      setAllSources: () => {},
      getModel: () => 'test-model',
      getSessionId: () => 'sdk-reference',
      chat: async function* (input: string) {
        modelInput = input
        yield { type: 'complete' as const }
      },
    }
    ;(manager as unknown as SessionManagerHarness).getOrCreateAgent =
      async () => fakeAgent

    await manager.sendMessage(
      sessionId,
      '',
      undefined,
      undefined,
      { references: [webReference] },
    )

    expect(managed.name).toBe('Example article')
    expect(modelInput).toStartWith(
      '<web_selection_reference_data trust="untrusted">\n',
    )
    expect(modelInput).not.toContain('<project_file_reference_data')
    expect(storedMessages(sessionId).at(-1)).toMatchObject({
      content: '',
      references: [webReference],
    })
  })

  it('rejects a cross-workspace RPC before persisting or redirecting', async () => {
    const manager = new SessionManager()
    const sessionId = 'cross-workspace-reference'
    installSession(manager, sessionId, { isProcessing: true })

    await expect(manager.sendMessage(
      sessionId,
      'must not send',
      undefined,
      undefined,
      { references: [reference] },
      undefined,
      undefined,
      undefined,
      { callerClientId: 'client-b', workspaceId: 'another-workspace' },
    )).rejects.toThrow(/WORKSPACE_MISMATCH:/)
    expect(() => storedMessages(sessionId)).toThrow()
  })

  it('preserves references through queue persistence and restart recovery', async () => {
    const manager = new SessionManager()
    const sessionId = 'queued-reference'
    const managed = installSession(manager, sessionId, { isProcessing: true })
    let redirected = ''
    managed.agent = {
      redirect: (input: string) => {
        redirected = input
        return false
      },
    }

    await manager.sendMessage(
      sessionId,
      'queued text',
      undefined,
      undefined,
      { references: [reference] },
    )

    expect(redirected).toContain(
      '<project_file_reference_data trust="untrusted">',
    )
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.message).toBe('queued text')
    expect(managed.messageQueue[0]?.options?.references).toEqual([reference])
    expect(storedMessages(sessionId).at(-1)).toMatchObject({
      content: 'queued text',
      isQueued: true,
      references: [reference],
    })

    const restartedManager = new SessionManager()
    const restarted = installSession(restartedManager, sessionId, {
      messagesLoaded: false,
      isProcessing: true,
    })
    await restartedManager.getSession(sessionId)
    expect(restarted.messageQueue).toHaveLength(1)
    expect(restarted.messageQueue[0]?.message).toBe('queued text')
    expect(restarted.messageQueue[0]?.options?.references).toEqual([reference])
  })

  it('restores structured metadata when an accepted steer is undelivered', async () => {
    const manager = new SessionManager()
    const sessionId = 'undelivered-steer-reference'
    const managed = installSession(manager, sessionId, { isProcessing: true })
    let redirected = ''
    managed.agent = {
      redirect: (input: string) => {
        redirected = input
        return true
      },
    }

    await manager.sendMessage(
      sessionId,
      'steer text',
      undefined,
      undefined,
      { references: [reference] },
    )
    expect(managed.messageQueue).toHaveLength(0)

    await (manager as unknown as SessionManagerHarness).processEvent(managed, {
      type: 'steer_undelivered',
      message: redirected,
    })

    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.message).toBe('steer text')
    expect(managed.messageQueue[0]?.options?.references).toEqual([reference])
    expect(managed.messages.at(-1)?.isQueued).toBe(true)
    expect(managed.messages.at(-1)?.references).toEqual([reference])
  })

  it('passes references unchanged into the OAuth retry send', async () => {
    const manager = new SessionManager()
    const sessionId = 'oauth-reference'
    const managed = installSession(manager, sessionId)
    managed.lastSentMessage = 'retry text'
    managed.lastSentOptions = { references: [reference] }
    managed.messages.push({
      id: 'previous-user',
      role: 'user',
      content: 'retry text',
      references: [reference],
    })

    let retryArguments: unknown[] | undefined
    manager.sendMessage = (async (...args: unknown[]) => {
      retryArguments = args
    }) as typeof manager.sendMessage

    const initiated = (manager as unknown as SessionManagerHarness)
      .attemptAuthRetry(sessionId, managed, workspaceId)
    expect(initiated).toBe(true)
    await new Promise(resolve => setImmediate(resolve))

    expect(retryArguments?.[0]).toBe(sessionId)
    expect(retryArguments?.[1]).toBe('retry text')
    expect(retryArguments?.[4]).toEqual({ references: [reference] })
    expect(retryArguments?.[6]).toBe(true)
  })
})
