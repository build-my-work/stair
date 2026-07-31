import { describe, it, expect } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionHeader, readSessionHeader, writeSessionJsonl } from '../jsonl'
import {
  getHeaderMetadataSignature,
  mergeHeaderWithExternalMetadata,
  SessionPersistenceQueue,
} from '../persistence-queue'
import type { SessionHeader, StoredSession } from '../types'

function makeHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 's1',
    workspaceRootPath: '~/.craft-agent/workspaces/ws',
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

function makeSession(
  workspaceRootPath: string,
  overrides: Partial<StoredSession> = {},
): StoredSession {
  return {
    id: 's1',
    workspaceRootPath,
    createdAt: 1,
    lastUsedAt: 2,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
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

  it('metadata signature changes when Project note routing changes', () => {
    const original = makeHeader({
      projectId: 'project-a',
      projectNoteTargetPath: 'notes/a.md',
      projectNoteTargetRootFingerprint: 'root-a',
      projectNoteRecentTargetPaths: ['notes/a.md'],
    })

    expect(getHeaderMetadataSignature(original)).not.toBe(getHeaderMetadataSignature(
      makeHeader({
        projectId: 'project-b',
        projectNoteTargetPath: 'notes/a.md',
        projectNoteTargetRootFingerprint: 'root-a',
        projectNoteRecentTargetPaths: ['notes/a.md'],
      }),
    ))
    expect(getHeaderMetadataSignature(original)).not.toBe(getHeaderMetadataSignature(
      makeHeader({
        projectId: 'project-a',
        projectNoteTargetPath: 'notes/b.md',
        projectNoteTargetRootFingerprint: 'root-a',
        projectNoteRecentTargetPaths: ['notes/b.md', 'notes/a.md'],
      }),
    ))
    expect(getHeaderMetadataSignature(original)).not.toBe(getHeaderMetadataSignature(
      makeHeader({
        projectId: 'project-a',
        projectNoteTargetPath: 'notes/a.md',
        projectNoteTargetRootFingerprint: 'root-a',
        projectNoteRecentTargetPaths: ['notes/a.md', 'notes/older.md'],
      }),
    ))
    expect(getHeaderMetadataSignature(original)).not.toBe(getHeaderMetadataSignature(
      makeHeader({
        projectId: 'project-a',
        projectNoteTargetPath: 'notes/a.md',
        projectNoteTargetRootFingerprint: 'root-b',
        projectNoteRecentTargetPaths: ['notes/a.md'],
      }),
    ))
  })

  it('merge preserves external metadata while keeping local computed fields', () => {
    const local = makeHeader({
      name: 'Local Name',
      labels: ['local'],
      isFlagged: false,
      sessionStatus: 'todo',
      permissionMode: 'allow-all',
      projectId: 'local-project',
      projectNoteTargetPath: 'notes/local.md',
      projectNoteTargetRootFingerprint: 'local-root',
      projectNoteRecentTargetPaths: ['notes/local.md', 'notes/old-local.md'],
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
      projectId: 'disk-project',
      projectNoteTargetPath: 'notes/disk.md',
      projectNoteTargetRootFingerprint: 'disk-root',
      projectNoteRecentTargetPaths: ['notes/disk.md', 'notes/old-disk.md'],
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
    expect(merged.projectId).toBe('disk-project')
    expect(merged.projectNoteTargetPath).toBe('notes/disk.md')
    expect(merged.projectNoteTargetRootFingerprint).toBe('disk-root')
    expect(merged.projectNoteRecentTargetPaths)
      .toEqual(['notes/disk.md', 'notes/old-disk.md'])
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

describe('SessionPersistenceQueue serialization', () => {
  it('serializes timer and concurrent flush writes for one Session', async () => {
    const queue = new SessionPersistenceQueue(0)
    let releaseFirstWrite: () => void = () => {}
    let releaseSecondWrite: () => void = () => {}
    let markFirstStarted: () => void = () => {}
    let markSecondStarted: () => void = () => {}
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const secondStarted = new Promise<void>(resolve => {
      markSecondStarted = resolve
    })
    const firstGate = new Promise<void>(resolve => {
      releaseFirstWrite = resolve
    })
    const secondGate = new Promise<void>(resolve => {
      releaseSecondWrite = resolve
    })
    const writtenNames: Array<string | undefined> = []
    let activeWrites = 0
    let maxActiveWrites = 0

    ;(queue as unknown as {
      write: (sessionId: string, data: StoredSession) => Promise<void>
    }).write = async (_sessionId, data) => {
      activeWrites += 1
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
      writtenNames.push(data.name)
      if (writtenNames.length === 1) {
        markFirstStarted()
        await firstGate
      } else {
        markSecondStarted()
        await secondGate
      }
      activeWrites -= 1
    }

    queue.enqueue(makeSession('/tmp', { name: 'timer' }))
    await firstStarted
    queue.enqueue(makeSession('/tmp', { name: 'flush' }))

    let firstFlushResolved = false
    let secondFlushResolved = false
    const firstFlush = queue.flush('s1').then(() => {
      firstFlushResolved = true
    })
    const secondFlush = queue.flush('s1').then(() => {
      secondFlushResolved = true
    })

    releaseFirstWrite()
    await secondStarted
    expect(firstFlushResolved).toBe(false)
    expect(secondFlushResolved).toBe(false)

    releaseSecondWrite()
    await Promise.all([firstFlush, secondFlush])

    expect(maxActiveWrites).toBe(1)
    expect(writtenNames).toEqual(['timer', 'flush'])
  })

  it('uses an observed startup header to preserve an external route clear', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'craft-queue-baseline-'))
    const sessionDir = join(workspaceRoot, 'sessions', 's1')
    const sessionFile = join(sessionDir, 'session.jsonl')
    const queue = new SessionPersistenceQueue(0)
    const original = makeSession(workspaceRoot, {
      name: 'Original',
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/a.md',
      projectNoteTargetRootFingerprint: 'root-1',
      projectNoteRecentTargetPaths: ['notes/a.md'],
    })

    try {
      await mkdir(sessionDir, { recursive: true })
      writeSessionJsonl(sessionFile, original)
      queue.observeHeader(createSessionHeader(original))
      writeSessionJsonl(sessionFile, {
        ...original,
        projectNoteTargetPath: undefined,
        projectNoteTargetRootFingerprint: undefined,
        projectNoteRecentTargetPaths: undefined,
      })

      let markFirstWriteStarted: () => void = () => {}
      let releaseFirstWrite: () => void = () => {}
      const firstWriteStarted = new Promise<void>(resolve => {
        markFirstWriteStarted = resolve
      })
      const firstWriteGate = new Promise<void>(resolve => {
        releaseFirstWrite = resolve
      })
      const writableQueue = queue as unknown as {
        write: (
          sessionId: string,
          data: StoredSession,
        ) => Promise<unknown>
      }
      const write = writableQueue.write.bind(queue)
      let writeCount = 0
      writableQueue.write = async (sessionId, data) => {
        writeCount += 1
        if (writeCount === 1) {
          markFirstWriteStarted()
          await firstWriteGate
        }
        return write(sessionId, data)
      }

      queue.enqueue({
        ...original,
        name: 'Concurrent local rename',
      })
      const flushing = queue.flush(original.id)
      await firstWriteStarted
      queue.enqueue({
        ...original,
        name: 'Concurrent local rename',
        labels: ['new'],
      })
      releaseFirstWrite()
      await flushing

      const persisted = readSessionHeader(sessionFile)
      expect(persisted?.name).toBe('Concurrent local rename')
      expect(persisted?.labels).toEqual(['new'])
      expect(persisted?.projectNoteTargetPath).toBeUndefined()
      expect(persisted?.projectNoteTargetRootFingerprint).toBeUndefined()
      expect(persisted?.projectNoteRecentTargetPaths).toBeUndefined()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('merges Project note routing as one atomic group', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'craft-queue-route-'))
    const sessionDir = join(workspaceRoot, 'sessions', 's1')
    const sessionFile = join(sessionDir, 'session.jsonl')
    const queue = new SessionPersistenceQueue(0)
    const original = makeSession(workspaceRoot, {
      permissionMode: 'ask',
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/a.md',
      projectNoteTargetRootFingerprint: 'root-1',
      projectNoteRecentTargetPaths: ['notes/a.md'],
    })

    try {
      await mkdir(sessionDir, { recursive: true })
      writeSessionJsonl(sessionFile, original)
      queue.observeHeader(createSessionHeader(original))
      writeSessionJsonl(sessionFile, {
        ...original,
        permissionMode: 'safe',
        projectNoteTargetPath: 'notes/external.md',
        projectNoteRecentTargetPaths: ['notes/external.md'],
      })

      queue.enqueue({
        ...original,
        projectNoteTargetPath: undefined,
        projectNoteTargetRootFingerprint: undefined,
        projectNoteRecentTargetPaths: undefined,
      })
      await queue.flush(original.id)

      const persisted = readSessionHeader(sessionFile)
      expect(persisted?.permissionMode).toBe('ask')
      expect(persisted?.projectNoteTargetPath).toBe('notes/external.md')
      expect(persisted?.projectNoteTargetRootFingerprint).toBe('root-1')
      expect(persisted?.projectNoteRecentTargetPaths)
        .toEqual(['notes/external.md'])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('lets Project root invalidation authoritatively clear its route', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'craft-queue-clear-'))
    const sessionDir = join(workspaceRoot, 'sessions', 's1')
    const sessionFile = join(sessionDir, 'session.jsonl')
    const queue = new SessionPersistenceQueue(0)
    const original = makeSession(workspaceRoot, {
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/a.md',
      projectNoteTargetRootFingerprint: 'root-1',
      projectNoteRecentTargetPaths: ['notes/a.md'],
    })

    try {
      await mkdir(sessionDir, { recursive: true })
      writeSessionJsonl(sessionFile, original)
      queue.observeHeader(createSessionHeader(original))
      writeSessionJsonl(sessionFile, {
        ...original,
        projectNoteTargetPath: 'notes/external.md',
        projectNoteRecentTargetPaths: ['notes/external.md'],
      })

      queue.enqueue({
        ...original,
        projectNoteTargetPath: undefined,
        projectNoteTargetRootFingerprint: undefined,
        projectNoteRecentTargetPaths: undefined,
      }, 'project-note-routing')
      await queue.flush(original.id)

      const persisted = readSessionHeader(sessionFile)
      expect(persisted?.projectId).toBe('project-1')
      expect(persisted?.projectNoteTargetPath).toBeUndefined()
      expect(persisted?.projectNoteTargetRootFingerprint).toBeUndefined()
      expect(persisted?.projectNoteRecentTargetPaths).toBeUndefined()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('does not combine an external Project with a queued old-Project target', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'craft-queue-project-'))
    const sessionDir = join(workspaceRoot, 'sessions', 's1')
    const sessionFile = join(sessionDir, 'session.jsonl')
    const queue = new SessionPersistenceQueue(0)
    const original = makeSession(workspaceRoot, {
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/a.md',
      projectNoteTargetRootFingerprint: 'root-1',
      projectNoteRecentTargetPaths: ['notes/a.md'],
    })

    try {
      await mkdir(sessionDir, { recursive: true })
      writeSessionJsonl(sessionFile, original)
      queue.observeHeader(createSessionHeader(original))
      writeSessionJsonl(sessionFile, {
        ...original,
        projectId: 'project-2',
        projectNoteTargetPath: undefined,
        projectNoteTargetRootFingerprint: undefined,
        projectNoteRecentTargetPaths: undefined,
      })

      let markFirstWriteStarted: () => void = () => {}
      let releaseFirstWrite: () => void = () => {}
      const firstWriteStarted = new Promise<void>(resolve => {
        markFirstWriteStarted = resolve
      })
      const firstWriteGate = new Promise<void>(resolve => {
        releaseFirstWrite = resolve
      })
      const writableQueue = queue as unknown as {
        write: (
          sessionId: string,
          data: StoredSession,
        ) => Promise<unknown>
      }
      const write = writableQueue.write.bind(queue)
      let writeCount = 0
      writableQueue.write = async (sessionId, data) => {
        writeCount += 1
        if (writeCount === 1) {
          markFirstWriteStarted()
          await firstWriteGate
        }
        return write(sessionId, data)
      }

      queue.enqueue({ ...original, name: 'First local write' })
      const flushing = queue.flush(original.id)
      await firstWriteStarted
      queue.enqueue({
        ...original,
        projectNoteTargetPath: 'notes/b.md',
        projectNoteRecentTargetPaths: ['notes/b.md', 'notes/a.md'],
      })
      releaseFirstWrite()
      await flushing

      const persisted = readSessionHeader(sessionFile)
      expect(persisted?.projectId).toBe('project-2')
      expect(persisted?.projectNoteTargetPath).toBeUndefined()
      expect(persisted?.projectNoteTargetRootFingerprint).toBeUndefined()
      expect(persisted?.projectNoteRecentTargetPaths).toBeUndefined()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
