import { describe, expect, it } from 'bun:test'
import type { DrawnixBoardCapabilityRequest, DrawnixMindmapSnapshot } from '@craft-agent/server-core/transport'
import {
  discoverDrawnixBoards,
  handleDrawnixBoardCapability,
  registerOpenDrawnixBoard,
  type OpenDrawnixBoardController,
} from '../drawnix-board-registry'

const snapshot: DrawnixMindmapSnapshot = {
  relativePath: 'maps/tutorial.drawnix',
  changeSeq: 4,
  roots: [{ id: 'root', topic: 'Tutorial', children: [] }],
}

describe('open Drawnix board registry', () => {
  it('discovers exact live targets without reading, flushing, or updating them', () => {
    const actions: string[] = []
    const controller: OpenDrawnixBoardController = {
      flush: async () => { actions.push('flush') },
      read: async () => { actions.push('read'); return snapshot },
      update: async () => { actions.push('update'); return snapshot },
    }
    const request = {
      v: 1 as const,
      projectId: 'project-a',
      relativePath: snapshot.relativePath,
    }
    const unregister = registerOpenDrawnixBoard('project-a', snapshot.relativePath, controller)
    const unregisterDuplicate = registerOpenDrawnixBoard('project-a', snapshot.relativePath, { ...controller })
    try {
      expect(discoverDrawnixBoards(request, 'project-a')).toEqual({
        ok: true, boardCount: 2, canCreate: true,
      })
      expect(discoverDrawnixBoards({ ...request, projectId: 'project-b' }, 'project-a')).toEqual({
        ok: true, boardCount: 0, canCreate: false,
      })
      unregisterDuplicate()
      expect(discoverDrawnixBoards(request, 'project-b')).toEqual({
        ok: true, boardCount: 1, canCreate: false,
      })
      unregister()
      expect(discoverDrawnixBoards(request, 'project-b')).toEqual({
        ok: true, boardCount: 0, canCreate: false,
      })
      expect(actions).toEqual([])
    } finally {
      unregisterDuplicate()
      unregister()
    }
  })

  it('routes reads and updates only to the exact Project and path', async () => {
    const updates: unknown[] = []
    const controller: OpenDrawnixBoardController = {
      flush: async () => {},
      read: async () => snapshot,
      update: async request => {
        updates.push(request)
        return { ...snapshot, changeSeq: 5 }
      },
    }
    const unregister = registerOpenDrawnixBoard(
      'project-a',
      snapshot.relativePath,
      controller,
    )

    try {
      expect(await handleDrawnixBoardCapability({
        v: 1,
        action: 'read',
        projectId: 'project-a',
        relativePath: snapshot.relativePath,
      })).toEqual({ ok: true, snapshot })
      expect(await handleDrawnixBoardCapability({
        v: 1,
        action: 'read',
        projectId: 'project-b',
        relativePath: snapshot.relativePath,
      })).toMatchObject({ ok: false, error: { code: 'MINDMAP_NOT_OPEN' } })

      const request = {
        v: 1 as const,
        action: 'update' as const,
        projectId: 'project-a',
        relativePath: snapshot.relativePath,
        expectedChangeSeq: 4,
        operations: [{
          type: 'insert_child' as const,
          parentId: 'root',
          topic: 'New topic',
        }],
      }
      expect(await handleDrawnixBoardCapability(request)).toEqual({
        ok: true,
        snapshot: { ...snapshot, changeSeq: 5 },
      })
      expect(updates).toEqual([request])
    } finally {
      unregister()
    }
  })

  it('rejects an unsupported invoke action instead of treating it as an update', async () => {
    let updates = 0
    const unregister = registerOpenDrawnixBoard('project-a', snapshot.relativePath, {
      flush: async () => {},
      read: async () => snapshot,
      update: async () => { updates += 1; return snapshot },
    })
    try {
      expect(await handleDrawnixBoardCapability({
        v: 1,
        action: 'discover',
        projectId: 'project-a',
        relativePath: snapshot.relativePath,
      } as unknown as DrawnixBoardCapabilityRequest)).toMatchObject({
        ok: false, error: { code: 'MINDMAP_INVALID_REQUEST' },
      })
      expect(updates).toBe(0)
    } finally {
      unregister()
    }
  })

  it('rechecks the live registry after discovery when the window switches Project', async () => {
    const actions: string[] = []
    const controller: OpenDrawnixBoardController = {
      flush: async () => {},
      read: async () => { actions.push('read'); return snapshot },
      update: async () => { actions.push('update'); return snapshot },
    }
    const request = { v: 1 as const, projectId: 'project-a', relativePath: snapshot.relativePath }
    const unregisterA = registerOpenDrawnixBoard('project-a', snapshot.relativePath, controller)
    expect(discoverDrawnixBoards(request, 'project-a')).toMatchObject({ ok: true, boardCount: 1 })
    unregisterA()
    const unregisterB = registerOpenDrawnixBoard('project-b', snapshot.relativePath, controller)
    try {
      expect(await handleDrawnixBoardCapability({ ...request, action: 'read' })).toMatchObject({
        ok: false, error: { code: 'MINDMAP_NOT_OPEN' },
      })
      expect(await handleDrawnixBoardCapability({
        ...request, action: 'update', expectedChangeSeq: 4,
        operations: [{ type: 'set_topic', nodeId: 'root', topic: 'Changed' }],
      })).toMatchObject({ ok: false, error: { code: 'MINDMAP_NOT_OPEN' } })
      expect(actions).toEqual([])
    } finally {
      unregisterB()
    }
  })

  it('fails closed for a closed board, invalid path, or ambiguous duplicate board', async () => {
    expect(await handleDrawnixBoardCapability({
      v: 1,
      action: 'read',
      projectId: 'project-closed',
      relativePath: 'maps/closed.drawnix',
    })).toMatchObject({ ok: false, error: { code: 'MINDMAP_NOT_OPEN' } })
    expect(await handleDrawnixBoardCapability({
      v: 1,
      action: 'read',
      projectId: 'project-a',
      relativePath: '../outside.drawnix',
    })).toMatchObject({ ok: false, error: { code: 'MINDMAP_INVALID_REQUEST' } })

    const controller: OpenDrawnixBoardController = {
      flush: async () => {},
      read: async () => snapshot,
      update: async () => snapshot,
    }
    const unregister = registerOpenDrawnixBoard(
      'project-a',
      snapshot.relativePath,
      controller,
    )
    const unregisterDuplicate = registerOpenDrawnixBoard(
      'project-a',
      snapshot.relativePath,
      { ...controller },
    )
    try {
      expect(await handleDrawnixBoardCapability({
        v: 1,
        action: 'read',
        projectId: 'project-a',
        relativePath: snapshot.relativePath,
      })).toMatchObject({
        ok: false,
        error: { code: 'MINDMAP_AMBIGUOUS_BOARD' },
      })
      unregisterDuplicate()
      expect(await handleDrawnixBoardCapability({
        v: 1,
        action: 'read',
        projectId: 'project-a',
        relativePath: snapshot.relativePath,
      })).toEqual({ ok: true, snapshot })
    } finally {
      unregisterDuplicate()
      unregister()
    }
  })
})
