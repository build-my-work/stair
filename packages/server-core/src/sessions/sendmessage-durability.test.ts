import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Regression test for the High-severity finding in eb81086e:
//
//   sendMessage's `{ accepted, messageId }` ack contract was returning before
//   the user message hit disk because `persistSession` only enqueues with a
//   500ms debounce. A crash inside the debounce window after ack would lose
//   the message.
//
// The fix added `await this.flushSession(managed.id)` between persistSession
// and onAck. This test locks that ordering by reading the session file from
// inside the onAck callback and asserting the user message is already there.

describe('sendMessage durability', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-durability-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'durability test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function readPersistedMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    // First line is the header, remaining lines are messages.
    return lines.slice(1).map(l => JSON.parse(l)).map(m => m.id as string)
  }

  function readPersistedMessages(sessionId: string): Array<Record<string, unknown>> {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8')
      .trim()
      .split('\n')
      .slice(1)
      .map(line => JSON.parse(line) as Record<string, unknown>)
  }

  it('user message is on disk before onAck fires (normal branch)', async () => {
    const sessionId = 'durability-normal'
    buildSession(sessionId)

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    // sendMessage continues past the ack into agent-init, which would throw
    // because we haven't called `setSessionPlatform()` in this minimal test
    // harness. That's fine — we only care about the persist+flush+ack ordering
    // that happens before agent-init. Catch the post-ack rejection.
    await sm
      .sendMessage(
        sessionId,
        'hello',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (messageId) => {
          ackedMessageId = messageId
          onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
        },
      )
      .catch(() => { /* expected post-ack agent-init failure */ })

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })

  it('user message is on disk before onAck fires (mid-stream / queued branch)', async () => {
    const sessionId = 'durability-midstream'
    const managed = buildSession(sessionId)
    // Force the mid-stream branch. Agent is null, so redirect() falls back to
    // false and the queue path runs.
    managed.isProcessing = true

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    const references = [{
      projectId: 'project-1',
      path: 'books/operating-systems.epub',
      locator: { type: 'epub-cfi' as const, cfiRange: 'epubcfi(/6/2!/4/2:0)' },
    }]
    const badges = [{
      type: 'context' as const,
      label: 'Selected passage',
      rawText: 'Selected passage',
      start: 0,
      end: 16,
    }]

    await sm.sendMessage(
      sessionId,
      'queued message',
      undefined,
      undefined,
      { references, badges },
      undefined,
      undefined,
      (messageId) => {
        ackedMessageId = messageId
        onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
      },
    )

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
    const persisted = readPersistedMessages(sessionId).find(message => message.type === 'user')
    expect(persisted?.isQueued).toBe(true)

    const recoveredManager = new SessionManager()
    const recovered = createManagedSession(
      { id: sessionId, name: 'recovered durability test' },
      {
        id: 'ws_test',
        name: 'Test Workspace',
        rootPath: tmpRoot,
        createdAt: Date.now(),
      } as never,
      { messagesLoaded: false },
    )
    recovered.isProcessing = true
    ;(recoveredManager as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, recovered)
    await (recoveredManager as unknown as {
      loadMessagesFromDisk: (managed: typeof recovered) => Promise<void>
    }).loadMessagesFromDisk(recovered)

    expect(recovered.messageQueue).toHaveLength(1)
    expect(recovered.messageQueue[0]?.options?.references).toEqual(references)
    expect(recovered.messageQueue[0]?.options?.badges).toEqual(badges)
  })

  it('persists structured file references with the user message', async () => {
    const sessionId = 'durability-reference'
    buildSession(sessionId)
    const references = [{
      projectId: 'project-1',
      path: 'books/操作系统导论 .epub',
      quote: '进程就是运行中的程序。',
      locator: { type: 'epub-cfi' as const, cfiRange: 'epubcfi(/6/4!/4/2:0,/4/2:8)' },
    }]
    let referencesAtAck: unknown

    await sm
      .sendMessage(
        sessionId,
        '解释这段话',
        undefined,
        undefined,
        { references },
        undefined,
        undefined,
        () => {
          referencesAtAck = readPersistedMessages(sessionId)
            .find(message => message.type === 'user')?.references
        },
      )
      .catch(() => { /* expected post-persist agent-init failure */ })

    const inMemory = (sm as unknown as { sessions: Map<string, { messages: Array<Record<string, unknown>> }> })
      .sessions.get(sessionId)?.messages.find(message => message.role === 'user')
    expect(inMemory?.references).toEqual(references)
    expect(referencesAtAck).toEqual(references)
    const userMessage = readPersistedMessages(sessionId).find(message => message.type === 'user')
    expect(userMessage?.references).toEqual(references)
  })
})
