import { describe, expect, it } from 'bun:test'
import type { DrawnixMindmapSnapshot } from '@craft-agent/server-core/transport'
import {
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
