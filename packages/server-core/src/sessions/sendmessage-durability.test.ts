import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import type { Reference } from '@craft-agent/core'

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
      { id, name: 'durability test', projectId: 'project-general' },
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
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    return lines.slice(1).map(line => JSON.parse(line) as Record<string, unknown>)
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

    await sm.sendMessage(
      sessionId,
      'queued message',
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

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })

  it('persists validated references before acknowledging a queued message', async () => {
    const source = buildSession('reference-source')
    source.messages.push({
      id: 'source-message',
      role: 'assistant',
      content: 'selected text',
      timestamp: Date.now(),
    })
    const target = buildSession('reference-target')
    target.isProcessing = true
    const reference: Reference = {
      version: 1,
      kind: 'chat-message',
      projectId: 'project-general',
      sessionId: source.id,
      messageId: 'source-message',
      role: 'assistant',
      quote: 'selected text',
      locator: {
        type: 'text-quote',
        exact: 'selected text',
        start: 0,
        end: 13,
      },
    }

    await sm.sendMessage(
      target.id,
      'explain',
      undefined,
      undefined,
      { references: [reference] },
    )

    expect(readPersistedMessages(target.id).at(-1)).toEqual(expect.objectContaining({
      isQueued: true,
      references: [reference],
    }))
  })

  it('rejects a cross-Project chat reference before persistence', async () => {
    const source = buildSession('cross-project-source')
    source.projectId = 'project-other'
    source.messages.push({
      id: 'source-message',
      role: 'assistant',
      content: 'private text',
      timestamp: Date.now(),
    })
    const target = buildSession('cross-project-target')
    target.isProcessing = true

    await expect(sm.sendMessage(
      target.id,
      'explain',
      undefined,
      undefined,
      {
        references: [{
          version: 1,
          kind: 'chat-message',
          projectId: 'project-general',
          sessionId: source.id,
          messageId: 'source-message',
          role: 'assistant',
          quote: 'private text',
          locator: {
            type: 'text-quote',
            exact: 'private text',
            start: 0,
            end: 12,
          },
        }],
      },
    )).rejects.toThrow('MESSAGE_REFERENCE_PROJECT_MISMATCH')
    expect(readPersistedMessages(target.id)).toEqual([])
  })

  it('replays an already-persisted validated reference after its source Session disappears', async () => {
    const source = buildSession('replay-source')
    source.messages.push({
      id: 'source-message',
      role: 'assistant',
      content: 'selected text',
      timestamp: Date.now(),
    })
    const target = buildSession('replay-target')
    const reference: Reference = {
      version: 1,
      kind: 'chat-message',
      projectId: target.projectId,
      sessionId: source.id,
      messageId: 'source-message',
      role: 'assistant',
      quote: 'selected text',
      locator: {
        type: 'text-quote',
        exact: 'selected text',
        start: 0,
        end: 13,
      },
    }
    const queuedMessageId = 'queued-with-reference'
    target.messages.push({
      id: queuedMessageId,
      role: 'user',
      content: 'explain',
      timestamp: Date.now(),
      references: [reference],
    })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.delete(source.id)

    let error: unknown
    try {
      await sm.sendMessage(
        target.id,
        'explain',
        undefined,
        undefined,
        { references: [reference] },
        queuedMessageId,
      )
    } catch (caught) {
      error = caught
    }
    expect(String(error)).not.toContain('MESSAGE_REFERENCE_SOURCE_INVALID')
  })
})
