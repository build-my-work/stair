import { describe, expect, it } from 'bun:test'
import type { DrawnixMindmapSnapshot } from '@craft-agent/server-core/transport'
import {
  flushOpenDrawnixBoard,
  handleDrawnixBoardCapability,
  registerOpenDrawnixBoard,
  type OpenDrawnixBoardController,
} from '../drawnix-board-registry'

const snapshot: DrawnixMindmapSnapshot = {
  relativePath: 'maps/tutorial.drawnix',
  changeSeq: 4,
  roots: [{
    id: 'root',
    topic: 'Tutorial',
    children: [],
  }],
}

describe('open Drawnix Board registry', () => {
  it('fails closed when the requested Project File is not open', async () => {
    const response = await handleDrawnixBoardCapability({
      v: 1,
      action: 'read',
      projectId: 'project-closed',
      relativePath: 'maps/closed.drawnix',
    })

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'MINDMAP_NOT_OPEN',
        message:
          'Open maps/closed.drawnix in Project Files before asking the Agent to read or modify it.',
      },
    })
  })

  it('routes reads, updates, and flushes to the exact open Board', async () => {
    const updates: unknown[] = []
    let flushCount = 0
    const controller: OpenDrawnixBoardController = {
      read: async () => snapshot,
      update: async request => {
        updates.push(request)
        return { ...snapshot, changeSeq: snapshot.changeSeq + 1 }
      },
      flush: async () => {
        flushCount += 1
      },
    }
    const unregister = registerOpenDrawnixBoard(
      'project-open',
      snapshot.relativePath,
      controller,
    )

    try {
      expect(await handleDrawnixBoardCapability({
        v: 1,
        action: 'read',
        projectId: 'project-open',
        relativePath: snapshot.relativePath,
      })).toEqual({ ok: true, snapshot })

      const updateRequest = {
        v: 1 as const,
        action: 'update' as const,
        projectId: 'project-open',
        relativePath: snapshot.relativePath,
        expectedChangeSeq: snapshot.changeSeq,
        operations: [{
          type: 'insert_child' as const,
          parentId: 'root',
          topic: 'New topic',
        }],
      }
      expect(await handleDrawnixBoardCapability(updateRequest)).toEqual({
        ok: true,
        snapshot: { ...snapshot, changeSeq: 5 },
      })
      expect(updates).toEqual([updateRequest])

      await flushOpenDrawnixBoard('project-open', snapshot.relativePath)
      expect(flushCount).toBe(1)
      expect(() => registerOpenDrawnixBoard(
        'project-open',
        snapshot.relativePath,
        controller,
      )).not.toThrow()
      expect(() => registerOpenDrawnixBoard(
        'project-open',
        snapshot.relativePath,
        { ...controller },
      )).toThrow('already has a visible Drawnix board')
    } finally {
      unregister()
    }
  })

  it('rejects non-Drawnix targets before registry lookup', async () => {
    expect(await handleDrawnixBoardCapability({
      v: 1,
      action: 'read',
      projectId: 'project-1',
      relativePath: 'notes/tutorial.md',
    })).toEqual({
      ok: false,
      error: {
        code: 'MINDMAP_INVALID_REQUEST',
        message: 'A canonical .drawnix Project File path is required.',
      },
    })
  })
})
