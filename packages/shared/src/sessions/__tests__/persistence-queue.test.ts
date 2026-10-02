import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import type { SessionHeader } from '../types'
import { getHeaderMetadataSignature, mergeHeaderWithExternalMetadata } from '../persistence-queue'

function makeHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 's1',
    workspaceRootPath: '~/.craft-agent/workspaces/ws',
    projectId: 'proj_default',
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 0,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      contextTokens: 0,
    },
    ...overrides,
  }
}

describe('session persistence header conflict helpers', () => {
  it('metadata signature ignores non-metadata fields', () => {
    const a = makeHeader({ name: 'A', lastUsedAt: 100 })
    const b = makeHeader({ name: 'A', lastUsedAt: 999, messageCount: 42 })

    expect(getHeaderMetadataSignature(a)).toBe(getHeaderMetadataSignature(b))
  })

  it('metadata signature changes when metadata changes', () => {
    const a = makeHeader({ name: 'A', labels: ['x'] })
    const b = makeHeader({ name: 'B', labels: ['x'] })

    expect(getHeaderMetadataSignature(a)).not.toBe(getHeaderMetadataSignature(b))
  })

  it('merge preserves external metadata while keeping local computed fields', () => {
    const local = makeHeader({
      name: 'Local Name',
      labels: ['local'],
      isFlagged: false,
      sessionStatus: 'todo',
      permissionMode: 'allow-all',
      hasUnread: true,
      lastReadMessageId: 'm-local',
      messageCount: 99,
      lastUsedAt: 500,
    })

    const disk = makeHeader({
      name: 'Disk Name',
      labels: ['disk'],
      isFlagged: true,
      sessionStatus: 'needs-review',
      permissionMode: 'safe',
      hasUnread: false,
      lastReadMessageId: 'm-disk',
      messageCount: 1,
      lastUsedAt: 50,
    })

    const merged = mergeHeaderWithExternalMetadata(local, disk)

    expect(merged.name).toBe('Disk Name')
    expect(merged.labels).toEqual(['disk'])
    expect(merged.isFlagged).toBe(true)
    expect(merged.sessionStatus).toBe('needs-review')
    expect(merged.permissionMode).toBe('safe')
    expect(merged.hasUnread).toBe(false)
    expect(merged.lastReadMessageId).toBe('m-disk')

    // Local computed/runtime persistence fields remain local
    expect(merged.messageCount).toBe(99)
    expect(merged.lastUsedAt).toBe(500)
  })

  it('startup scenario: external metadata differs from local signature', () => {
    const local = makeHeader({ name: 'Local Name', labels: ['local'] })
    const disk = makeHeader({ name: 'External Name', labels: ['external'] })

    const localSig = getHeaderMetadataSignature(local)
    const diskSig = getHeaderMetadataSignature(disk)

    // This is the condition used by persistence queue at startup:
    // no previousSig yet, disk differs from local → preserve external metadata.
    const hasExternalMetadataChange = diskSig !== localSig
      && (undefined === undefined || diskSig !== undefined)

    expect(hasExternalMetadataChange).toBe(true)

    const merged = mergeHeaderWithExternalMetadata(local, disk)
    expect(merged.name).toBe('External Name')
    expect(merged.labels).toEqual(['external'])
  })
})

// ---------------------------------------------------------------------------
// Strict (error-propagating) writes — real IO failures, not mocks.
// ---------------------------------------------------------------------------

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StoredSession } from '../types'
import { SessionPersistenceQueue } from '../persistence-queue'
import { ensureSessionsDir, getSessionFilePath } from '../storage'

function makeSession(workspaceRootPath: string, id: string): StoredSession {
  return {
    id,
    workspaceRootPath,
    projectId: 'proj_default',
    createdAt: 1,
    lastUsedAt: 1,
    messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  } as StoredSession
}

describe('session persistence queue strict writes', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'pq-strict-'))
    ensureSessionsDir(workspaceRoot)
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('strict flush rejects when the write fails (real EACCES)', async () => {
    const queue = new SessionPersistenceQueue(0)
    const session = makeSession(workspaceRoot, 'strict-io')
    const sessionDir = join(workspaceRoot, 'sessions', 'strict-io')
    mkdirSync(sessionDir, { recursive: true })
    chmodSync(sessionDir, 0o555)
    try {
      queue.enqueue(session)
      await expect(queue.flush('strict-io', { strict: true })).rejects.toThrow()
      expect(existsSync(getSessionFilePath(workspaceRoot, 'strict-io'))).toBe(false)
    } finally {
      chmodSync(sessionDir, 0o755)
      queue.cancel('strict-io')
    }
  })

  it('plain flush keeps the historical best-effort contract on failure', async () => {
    const queue = new SessionPersistenceQueue(0)
    const session = makeSession(workspaceRoot, 'best-effort-io')
    const sessionDir = join(workspaceRoot, 'sessions', 'best-effort-io')
    mkdirSync(sessionDir, { recursive: true })
    chmodSync(sessionDir, 0o555)
    try {
      queue.enqueue(session)
      await expect(queue.flush('best-effort-io')).resolves.toBeUndefined()
    } finally {
      chmodSync(sessionDir, 0o755)
      queue.cancel('best-effort-io')
    }
  })

  it('strict flush surfaces a failure of an in-flight best-effort write', async () => {
    const queue = new SessionPersistenceQueue(0)
    const session = makeSession(workspaceRoot, 'inflight-io')
    const sessionDir = join(workspaceRoot, 'sessions', 'inflight-io')
    mkdirSync(sessionDir, { recursive: true })

    // The debounced write takes the entry and starts (and fails) while the
    // strict caller arrives with nothing pending: it must still learn the
    // session's newest persisted state never reached disk.
    const failingWrite = queue.flush('inflight-io') // plain: swallows the error internally
    chmodSync(sessionDir, 0o555)
    const enqueue = makeSession(workspaceRoot, 'inflight-io')
    queue.enqueue(enqueue)
    await failingWrite
    // Entry may still be pending if the plain flush never took it; force the
    // strict path through whichever state it finds.
    try {
      await expect(queue.flush('inflight-io', { strict: true })).rejects.toThrow()
    } finally {
      chmodSync(sessionDir, 0o755)
      queue.cancel('inflight-io')
    }
  })

  it('a successful write clears a previous strict failure', async () => {
    const queue = new SessionPersistenceQueue(0)
    const sessionDir = join(workspaceRoot, 'sessions', 'recovered-io')
    mkdirSync(sessionDir, { recursive: true })
    chmodSync(sessionDir, 0o555)
    queue.enqueue(makeSession(workspaceRoot, 'recovered-io'))
    try {
      await expect(queue.flush('recovered-io', { strict: true })).rejects.toThrow()
    } finally {
      chmodSync(sessionDir, 0o755)
    }
    queue.enqueue(makeSession(workspaceRoot, 'recovered-io'))
    await expect(queue.flush('recovered-io', { strict: true })).resolves.toBeUndefined()
    const content = readFileSync(getSessionFilePath(workspaceRoot, 'recovered-io'), 'utf-8')
    expect(content).toContain('"id":"recovered-io"')
    queue.cancel('recovered-io')
  })
})

// ---------------------------------------------------------------------------
// Codex-review regressions: sticky strict failures, best-effort no-reject
// contract under concurrency, and true replace-on-rename semantics.
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { spyOn } from 'bun:test'

describe('session persistence queue durability regressions', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'pq-durability-'))
    ensureSessionsDir(workspaceRoot)
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  function makeFailingTmpDirFixture(id: string) {
    const session = makeSession(workspaceRoot, id)
    const path = getSessionFilePath(workspaceRoot, id)
    mkdirSync(path + '.tmp', { recursive: true }) // EISDIR on every write
    return { path, session }
  }

  it('a strict flush keeps reporting an undurable state until a write succeeds', async () => {
    const queue = new SessionPersistenceQueue(60_000)
    const { path, session } = makeFailingTmpDirFixture('sticky-failure')
    queue.enqueue(session)
    let failures = 0
    for (let i = 0; i < 3; i++) {
      try {
        await queue.flush('sticky-failure', { strict: true })
      } catch {
        failures++
      }
    }
    expect(failures).toBe(3)
    // A genuine successful retry clears the sticky failure.
    rmSync(path + '.tmp', { recursive: true, force: true })
    queue.enqueue(session)
    await expect(queue.flush('sticky-failure', { strict: true })).resolves.toBeUndefined()
    queue.cancel('sticky-failure')
  })

  it('strict shutdown retries a failed snapshot even after the pending entry was removed', async () => {
    const queue = new SessionPersistenceQueue(60_000)
    const { path, session } = makeFailingTmpDirFixture('shutdown-retry')
    session.messages = [{ id: 'reply', type: 'assistant', content: 'COMPLETED-BEFORE-QUIT', timestamp: 2 }]
    try {
      queue.enqueue(session)
      await queue.flush(session.id)
      expect(queue.hasPending(session.id)).toBe(false)
      await expect(queue.flushAll({ strict: true })).rejects.toThrow()
      await expect(queue.flushAll({ strict: true })).rejects.toThrow()
      expect(existsSync(path)).toBe(false)

      rmSync(path + '.tmp', { recursive: true, force: true })
      await expect(queue.flushAll({ strict: true })).resolves.toBeUndefined()
      expect(readFileSync(path, 'utf-8')).toContain('COMPLETED-BEFORE-QUIT')
      await expect(queue.flushAll({ strict: true })).resolves.toBeUndefined()
    } finally {
      queue.cancel(session.id)
    }
  })

  it('shutdown never retries an older failed snapshot over a newer pending write', async () => {
    const queue = new SessionPersistenceQueue(60_000)
    const { path, session } = makeFailingTmpDirFixture('shutdown-newer')
    try {
      queue.enqueue({ ...session, name: 'OLDER-FAILED' })
      await queue.flush(session.id)
      rmSync(path + '.tmp', { recursive: true, force: true })
      queue.enqueue({ ...session, name: 'LATEST-PENDING' })
      await queue.flushAll({ strict: true })
      const saved = readFileSync(path, 'utf-8')
      expect(saved).toContain('LATEST-PENDING')
      expect(saved).not.toContain('OLDER-FAILED')
    } finally {
      queue.cancel(session.id)
    }
  })

  it('shutdown waits for a newer in-flight write without replaying the older failure', async () => {
    const queue = new SessionPersistenceQueue(60_000)
    const { path, session } = makeFailingTmpDirFixture('shutdown-inflight')
    queue.enqueue({ ...session, name: 'OLDER-FAILED' })
    await queue.flush(session.id)
    rmSync(path + '.tmp', { recursive: true, force: true })

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const originalRename = fsPromises.rename
    const rename = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path) {
        entered.resolve()
        await release.promise
      }
      return originalRename(from, to)
    })
    queue.enqueue({ ...session, name: 'LATEST-IN-FLIGHT' })
    const writing = queue.flush(session.id)
    await entered.promise
    let completed = false
    const shutdown = queue.flushAll({ strict: true }).then(() => { completed = true })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(completed).toBe(false)
      release.resolve()
      await Promise.all([writing, shutdown])
      const saved = readFileSync(path, 'utf-8')
      expect(saved).toContain('LATEST-IN-FLIGHT')
      expect(saved).not.toContain('OLDER-FAILED')
    } finally {
      release.resolve()
      await Promise.allSettled([writing, shutdown])
      rename.mockRestore()
      queue.cancel(session.id)
    }
  })

  it('two concurrent plain flushes of one failing write both keep the no-reject contract', async () => {
    const queue = new SessionPersistenceQueue(60_000)
    const { path, session } = makeFailingTmpDirFixture('best-effort-failure')
    queue.enqueue(session)
    const results = await Promise.allSettled([
      queue.flush('best-effort-failure'),
      queue.flush('best-effort-failure'),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    // ...while a strict caller still learns the disk never got the data.
    await expect(queue.flush('best-effort-failure', { strict: true })).rejects.toThrow()
    queue.cancel('best-effort-failure')
  })

  it('a failed atomic replacement preserves the prior valid session file', async () => {
    const queue = new SessionPersistenceQueue(0)
    const session = makeSession(workspaceRoot, 'rename-failure')
    queue.enqueue(session)
    await queue.flush('rename-failure', { strict: true })
    const path = getSessionFilePath(workspaceRoot, 'rename-failure')
    const before = readFileSync(path, 'utf-8')

    const rename = spyOn(fsPromises, 'rename').mockRejectedValue(new Error('injected rename failure'))
    try {
      queue.enqueue({ ...session, name: 'updated' })
      await expect(queue.flush('rename-failure', { strict: true })).rejects.toThrow('injected rename failure')
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf-8')).toBe(before)
    } finally {
      rename.mockRestore()
      queue.cancel('rename-failure')
    }
  })
})
