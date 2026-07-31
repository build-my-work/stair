import { describe, expect, it, jest } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureSessionDir,
  getSessionFilePath,
  readSessionHeader,
  sessionPersistenceQueue,
  type StoredSession,
  writeSessionJsonl,
} from '@craft-agent/shared/sessions'

import { createManagedSession, SessionManager } from './SessionManager'

function createHarness(
  workspaceId = 'workspace-1',
  sessionId = 'session-1',
) {
  const manager = new SessionManager()
  manager.setEventSink(() => {})
  const workspace = {
    id: workspaceId,
    name: workspaceId,
    rootPath: `/tmp/${workspaceId}`,
    createdAt: 1,
  }
  const managed = createManagedSession({
    id: sessionId,
    projectId: 'project-1',
  }, workspace as any, {
    messagesLoaded: true,
  })

  ;(manager as any).sessions.set(sessionId, managed)
  ;(manager as any).persistSession = () => {}
  ;(manager as any).flushSession = async () => {}

  return { manager, managed }
}

describe('Session Add Note target history', () => {
  it('keeps a five-item, deduplicated MRU per Session', async () => {
    const { manager, managed } = createHarness()

    for (const path of [
      'notes/a.md',
      'notes/b.md',
      'notes/c.md',
      'notes/d.md',
      'notes/e.md',
      'notes/f.md',
      'notes/c.md',
    ]) {
      await manager.setSessionProjectNoteTarget(
        managed.id,
        'project-1',
        path,
        'root-1',
      )
    }

    expect(managed.projectNoteTargetPath).toBe('notes/c.md')
    expect(managed.projectNoteRecentTargetPaths).toEqual([
      'notes/c.md',
      'notes/f.md',
      'notes/e.md',
      'notes/d.md',
      'notes/b.md',
    ])
  })

  it('clears only the current target when requested explicitly', async () => {
    const { manager, managed } = createHarness()
    await manager.setSessionProjectNoteTarget(
      managed.id,
      'project-1',
      'notes/a.md',
      'root-1',
    )

    const cleared = await manager.setSessionProjectNoteTarget(
      managed.id,
      'project-1',
      null,
      null,
    )

    expect(cleared).toEqual({
      relativePath: null,
      recentPaths: ['notes/a.md'],
    })
    expect(managed.projectNoteTargetPath).toBeUndefined()
    expect(managed.projectNoteTargetRootFingerprint).toBe('root-1')
    expect(managed.projectNoteRecentTargetPaths).toEqual(['notes/a.md'])
  })

  it('drops history when the Project root changes', async () => {
    const { manager, managed } = createHarness()
    await manager.setSessionProjectNoteTarget(
      managed.id,
      'project-1',
      'notes/a.md',
      'root-1',
    )
    await manager.setSessionProjectNoteTarget(
      managed.id,
      'project-1',
      null,
      null,
    )

    await expect(manager.setSessionProjectNoteTarget(
      managed.id,
      'project-1',
      'notes/b.md',
      'root-2',
    )).resolves.toEqual({
      relativePath: 'notes/b.md',
      recentPaths: ['notes/b.md'],
    })
    expect(managed.projectNoteTargetRootFingerprint).toBe('root-2')
    expect(managed.projectNoteRecentTargetPaths).toEqual(['notes/b.md'])
  })

  it('does not update a Session that changed Project', async () => {
    const { manager, managed } = createHarness()

    await expect(manager.setSessionProjectNoteTarget(
      managed.id,
      'project-2',
      'notes/a.md',
      'root-1',
    )).resolves.toBeNull()
    expect(managed.projectNoteTargetPath).toBeUndefined()
    expect(managed.projectNoteRecentTargetPaths).toBeUndefined()
  })

  it('rejects a configure response superseded while persistence is flushing', async () => {
    const { manager, managed } = createHarness()
    const flushResolvers: Array<() => void> = []
    ;(manager as any).flushSession = () => new Promise<void>(resolve => {
      flushResolvers.push(resolve)
    })

    const first = manager.setSessionProjectNoteTarget(
      managed.id,
      'project-1',
      'notes/a.md',
      'root-1',
    )
    const second = manager.setSessionProjectNoteTarget(
      managed.id,
      'project-1',
      'notes/b.md',
      'root-1',
    )

    flushResolvers[1]?.()
    flushResolvers[0]?.()

    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toEqual({
      relativePath: 'notes/b.md',
      recentPaths: ['notes/b.md', 'notes/a.md'],
    })
  })

  it('rejects a configure response superseded by Project root invalidation', async () => {
    const { manager, managed } = createHarness()
    const flushResolvers: Array<() => void> = []
    ;(manager as any).flushSession = () => new Promise<void>(resolve => {
      flushResolvers.push(resolve)
    })

    const configuring = manager.setSessionProjectNoteTarget(
      managed.id,
      'project-1',
      'notes/a.md',
      'root-1',
    )
    const clearing = manager.clearProjectNoteTargetsForProject(
      'workspace-1',
      'project-1',
    )

    flushResolvers[1]?.()
    await clearing
    flushResolvers[0]?.()
    await expect(configuring).resolves.toBeNull()
    expect(managed.projectNoteTargetPath).toBeUndefined()
    expect(managed.projectNoteRecentTargetPaths).toBeUndefined()
  })

  it('clears targets only in the matching Workspace and Project', async () => {
    const first = createHarness('workspace-1', 'session-1')
    const secondManaged = createManagedSession({
      id: 'session-2',
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/b.md',
      projectNoteTargetRootFingerprint: 'root-2',
      projectNoteRecentTargetPaths: ['notes/b.md'],
    }, {
      id: 'workspace-2',
      name: 'workspace-2',
      rootPath: '/tmp/workspace-2',
      createdAt: 1,
    } as any, {
      messagesLoaded: true,
    })
    ;(first.manager as any).sessions.set('session-2', secondManaged)

    await first.manager.setSessionProjectNoteTarget(
      first.managed.id,
      'project-1',
      'notes/a.md',
      'root-1',
    )
    await first.manager.clearProjectNoteTargetsForProject(
      'workspace-1',
      'project-1',
    )

    expect(first.managed.projectNoteTargetPath).toBeUndefined()
    expect(first.managed.projectNoteTargetRootFingerprint).toBeUndefined()
    expect(first.managed.projectNoteRecentTargetPaths).toBeUndefined()
    expect(secondManaged.projectNoteTargetPath).toBe('notes/b.md')
    expect(secondManaged.projectNoteRecentTargetPaths).toEqual(['notes/b.md'])
  })

  it('unbinds matching in-memory Sessions when a Project is deleted', async () => {
    const { manager, managed } = createHarness()
    managed.projectNoteTargetPath = 'notes/a.md'
    managed.projectNoteTargetRootFingerprint = 'root-1'
    managed.projectNoteRecentTargetPaths = ['notes/a.md']

    await expect(manager.unbindSessionsFromProject(
      'workspace-1',
      'project-1',
    )).resolves.toBe(1)
    expect(managed.projectId).toBeUndefined()
    expect(managed.projectNoteTargetPath).toBeUndefined()
    expect(managed.projectNoteTargetRootFingerprint).toBeUndefined()
    expect(managed.projectNoteRecentTargetPaths).toBeUndefined()
  })

  it('conditionally unbinds only Sessions still in the deleted Project', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'craft-project-delete-'))
    const manager = new SessionManager()
    manager.setEventSink(() => {})
    const workspace = {
      id: 'workspace-delete',
      name: 'Workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    const stored = {
      id: 'session-delete-race',
      workspaceRootPath: workspaceRoot,
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/a.md',
      projectNoteTargetRootFingerprint: 'root-1',
      projectNoteRecentTargetPaths: ['notes/a.md'],
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    } as StoredSession
    const managed = createManagedSession({
      id: stored.id,
      projectId: stored.projectId,
      projectNoteTargetPath: stored.projectNoteTargetPath,
      projectNoteTargetRootFingerprint:
        stored.projectNoteTargetRootFingerprint,
      projectNoteRecentTargetPaths: stored.projectNoteRecentTargetPaths,
      createdAt: stored.createdAt,
    }, workspace as any, {
      messagesLoaded: true,
    })
    const sessionFile = getSessionFilePath(workspaceRoot, managed.id)

    try {
      ensureSessionDir(workspaceRoot, managed.id)
      writeSessionJsonl(sessionFile, stored)
      sessionPersistenceQueue.observeHeader(readSessionHeader(sessionFile)!)
      ;(manager as any).sessions.set(managed.id, managed)

      writeSessionJsonl(sessionFile, {
        ...stored,
        projectId: 'project-2',
        projectNoteTargetPath: 'notes/b.md',
        projectNoteTargetRootFingerprint: 'root-2',
        projectNoteRecentTargetPaths: ['notes/b.md'],
      })

      await expect(manager.unbindSessionsFromProject(
        workspace.id,
        'project-1',
      )).resolves.toBe(0)
      expect(managed.projectId).toBe('project-2')
      expect(managed.projectNoteTargetPath).toBe('notes/b.md')
      expect(readSessionHeader(sessionFile)?.projectId).toBe('project-2')
      expect(readSessionHeader(sessionFile)?.projectNoteTargetPath)
        .toBe('notes/b.md')

      Object.assign(managed, {
        projectId: stored.projectId,
        projectNoteTargetPath: stored.projectNoteTargetPath,
        projectNoteTargetRootFingerprint:
          stored.projectNoteTargetRootFingerprint,
        projectNoteRecentTargetPaths: stored.projectNoteRecentTargetPaths,
      })
      writeSessionJsonl(sessionFile, stored)
      sessionPersistenceQueue.observeHeader(readSessionHeader(sessionFile)!)
      writeSessionJsonl(sessionFile, {
        ...stored,
        projectNoteTargetPath: 'notes/b.md',
        projectNoteRecentTargetPaths: ['notes/b.md'],
      })

      await expect(manager.unbindSessionsFromProject(
        workspace.id,
        'project-1',
      )).resolves.toBe(1)
      expect(managed.projectId).toBeUndefined()
      expect(managed.projectNoteTargetPath).toBeUndefined()
      expect(readSessionHeader(sessionFile)?.projectId).toBeUndefined()
      expect(readSessionHeader(sessionFile)?.projectNoteTargetPath)
        .toBeUndefined()
    } finally {
      sessionPersistenceQueue.cancel(managed.id)
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reconciles the latest external target after the write guard expires', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'craft-note-guard-'))
    const manager = new SessionManager()
    manager.setEventSink(() => {})
    const workspace = {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    const managed = createManagedSession({
      id: 'session-guard',
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/local.md',
      projectNoteTargetRootFingerprint: 'local-root',
      projectNoteRecentTargetPaths: ['notes/local.md'],
    }, workspace as any, {
      messagesLoaded: true,
    })

    try {
      ensureSessionDir(workspaceRoot, managed.id)
      writeSessionJsonl(getSessionFilePath(workspaceRoot, managed.id), {
        id: managed.id,
        workspaceRootPath: workspaceRoot,
        projectId: 'project-1',
        projectNoteTargetPath: 'notes/external.md',
        projectNoteTargetRootFingerprint: 'external-root',
        projectNoteRecentTargetPaths: ['notes/external.md'],
        createdAt: 1,
        lastUsedAt: 1,
        messages: [],
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
      } as StoredSession)
      ;(manager as any).sessions.set(managed.id, managed)
      ;(manager as any).persistSession = () => {}
      managed.pendingExternalMetadata = {} as any

      jest.useFakeTimers()
      ;(manager as any).setMetadataWriteGuard(managed)
      jest.advanceTimersByTime(5_001)

      expect(managed.projectNoteTargetPath).toBe('notes/external.md')
      expect(managed.projectNoteTargetRootFingerprint).toBe('external-root')
      expect(managed.projectNoteRecentTargetPaths)
        .toEqual(['notes/external.md'])
      expect(managed.pendingExternalMetadata).toBeUndefined()
    } finally {
      jest.useRealTimers()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('does not report a target that an external write superseded', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'craft-note-conflict-'))
    const manager = new SessionManager()
    manager.setEventSink(() => {})
    const workspace = {
      id: 'workspace-conflict',
      name: 'Workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    const stored = {
      id: 'session-conflict',
      workspaceRootPath: workspaceRoot,
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/a.md',
      projectNoteTargetRootFingerprint: 'root-1',
      projectNoteRecentTargetPaths: ['notes/a.md'],
      labels: ['old'],
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    } as StoredSession
    const managed = createManagedSession({
      id: stored.id,
      projectId: stored.projectId,
      projectNoteTargetPath: stored.projectNoteTargetPath,
      projectNoteTargetRootFingerprint:
        stored.projectNoteTargetRootFingerprint,
      projectNoteRecentTargetPaths: stored.projectNoteRecentTargetPaths,
      createdAt: stored.createdAt,
    }, workspace as any, {
      messagesLoaded: true,
    })
    const sessionFile = getSessionFilePath(workspaceRoot, managed.id)

    try {
      ensureSessionDir(workspaceRoot, managed.id)
      writeSessionJsonl(sessionFile, stored)
      sessionPersistenceQueue.observeHeader(readSessionHeader(sessionFile)!)
      ;(manager as any).sessions.set(managed.id, managed)

      writeSessionJsonl(sessionFile, {
        ...stored,
        projectNoteTargetPath: 'notes/external.md',
        projectNoteTargetRootFingerprint: 'root-external',
        projectNoteRecentTargetPaths: ['notes/external.md'],
        labels: ['external'],
      })

      await expect(manager.setSessionProjectNoteTarget(
        managed.id,
        'project-1',
        'notes/local.md',
        'root-local',
      )).resolves.toBeNull()
      expect(managed.projectNoteTargetPath).toBe('notes/external.md')
      expect(managed.projectNoteTargetRootFingerprint)
        .toBe('root-external')
      expect(managed.projectNoteRecentTargetPaths)
        .toEqual(['notes/external.md'])
      expect(managed.labels).toEqual(['external'])

      manager.setSessionThinkingLevel(managed.id, 'medium')
      await manager.flushSession(managed.id)
      expect(readSessionHeader(sessionFile)?.labels).toEqual(['external'])
    } finally {
      sessionPersistenceQueue.cancel(managed.id)
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('cancels metadata reconciliation when the manager is cleaned up', () => {
    const { manager, managed } = createHarness()
    let applied = false
    ;(manager as any).applyExternalSessionMetadata = () => {
      applied = true
    }
    managed.pendingExternalMetadata = {} as any

    jest.useFakeTimers()
    try {
      ;(manager as any).setMetadataWriteGuard(managed)
      manager.cleanup()
      jest.advanceTimersByTime(5_001)

      expect(applied).toBe(false)
      expect(managed._metadataWriteGuardTimer).toBeUndefined()
      expect(managed._metadataWriteGuardUntil).toBeUndefined()
      expect(managed.pendingExternalMetadata).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })
})
