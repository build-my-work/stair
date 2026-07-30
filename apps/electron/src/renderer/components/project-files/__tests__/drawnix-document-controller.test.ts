import { describe, expect, it } from 'bun:test'
import {
  createTestingBoard,
  fakeNodeWeakMap,
  type PlaitBoard,
} from '@plait/core'
import { buildText } from '@plait/common'
import {
  MindTransforms,
  type MindElement,
  type PlaitMindBoard,
} from '@plait/mind'
import type { Element as SlateElement } from 'slate'
import type { SourceFingerprint } from '@craft-agent/core'
import type {
  SaveDrawnixProjectFileRequest,
  SaveDrawnixProjectFileResponse,
} from '@craft-agent/shared/protocol'
import {
  DrawnixDocumentController,
  applyMindmapOperations,
  parseNativeDrawnixDocument,
  snapshotDrawnixBoard,
} from '../drawnix-document-controller'

const INITIAL_FINGERPRINT =
  `sha256:${'a'.repeat(64)}` as SourceFingerprint

function createEmptyBoard(): PlaitBoard {
  return createTestingBoard([], [])
}

describe('Drawnix document controller', () => {
  it('populates an empty Board from Markdown and then applies node transforms', async () => {
    const board = createEmptyBoard()

    await applyMindmapOperations(board, [{
      type: 'populate_empty',
      markdown: '# Tutorial\n## Setup\n### Install\n## Concepts',
    }])
    const initial = snapshotDrawnixBoard(board, 'maps/tutorial.drawnix', 1)
    const setup = initial.roots[0]!.children[0]!

    await applyMindmapOperations(board, [
      { type: 'set_topic', nodeId: setup.id, topic: 'Environment setup' },
      { type: 'insert_child', parentId: setup.id, topic: 'Verify install' },
      { type: 'insert_sibling', nodeId: setup.id, topic: 'First project' },
    ])

    expect(snapshotDrawnixBoard(
      board,
      'maps/tutorial.drawnix',
      2,
    )).toMatchObject({
      changeSeq: 2,
      roots: [{
        topic: 'Tutorial',
        children: [
          {
            topic: 'Environment setup',
            children: [{ topic: 'Install' }, { topic: 'Verify install' }],
          },
          { topic: 'First project' },
          { topic: 'Concepts' },
        ],
      }],
    })
  })

  it('accepts the top-level bullet hierarchy naturally produced by an Agent', async () => {
    const board = createEmptyBoard()

    await applyMindmapOperations(board, [{
      type: 'populate_empty',
      markdown: [
        '- Operating Systems',
        '  - Processes',
        '    - Creation',
        '    - Scheduling',
        '  - Memory',
        '  - File Systems',
      ].join('\n'),
    }])

    expect(snapshotDrawnixBoard(
      board,
      'maps/operating-systems.drawnix',
      1,
    ).roots).toMatchObject([{
      topic: 'Operating Systems',
      children: [
        {
          topic: 'Processes',
          children: [{ topic: 'Creation' }, { topic: 'Scheduling' }],
        },
        { topic: 'Memory' },
        { topic: 'File Systems' },
      ],
    }])
  })

  it('preserves a user edit, saves fingerprint-by-fingerprint, and reopens identically', async () => {
    const board = createEmptyBoard()
    const saved: SaveDrawnixProjectFileRequest[] = []
    let saveCount = 0
    const save = async (
      request: SaveDrawnixProjectFileRequest,
    ): Promise<SaveDrawnixProjectFileResponse> => {
      saved.push(request)
      saveCount += 1
      return {
        metadata: {
          projectId: request.projectId,
          relativePath: request.relativePath,
          name: 'tutorial.drawnix',
          mimeType: 'application/json',
          byteLength: request.content.length,
          lastModifiedMs: saveCount,
        },
        sourceFingerprint:
          `sha256:${String(saveCount).padStart(64, 'b')}` as SourceFingerprint,
      }
    }
    const controller = new DrawnixDocumentController(
      board,
      'project-1',
      'maps/tutorial.drawnix',
      INITIAL_FINGERPRINT,
      save,
      () => {},
    )

    const populated = await controller.update({
      v: 1,
      action: 'update',
      projectId: 'project-1',
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: 0,
      operations: [{
        type: 'populate_empty',
        markdown: '# Tutorial\n## Agent topic',
      }],
    })

    fakeNodeWeakMap(board)
    MindTransforms.setTopic(
      board as PlaitMindBoard,
      board.children[0] as MindElement,
      buildText('User-renamed tutorial') as SlateElement,
    )
    controller.notifyBoardChanged()
    await controller.flush()
    const afterUserEdit = await controller.read()

    const updated = await controller.update({
      v: 1,
      action: 'update',
      projectId: 'project-1',
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: afterUserEdit.changeSeq,
      operations: [{
        type: 'insert_child',
        parentId: afterUserEdit.roots[0]!.id,
        topic: 'Agent-added topic',
      }],
    })

    expect(populated.changeSeq).toBe(1)
    expect(afterUserEdit.changeSeq).toBe(2)
    expect(updated.changeSeq).toBe(3)
    expect(updated.roots[0]).toMatchObject({
      topic: 'User-renamed tutorial',
      children: [
        { topic: 'Agent topic' },
        { topic: 'Agent-added topic' },
      ],
    })
    expect(saved).toHaveLength(3)
    expect(saved[0]!.expectedFingerprint).toBe(INITIAL_FINGERPRINT)
    expect(saved[1]!.expectedFingerprint).toBe(
      `sha256:${String(1).padStart(64, 'b')}`,
    )
    expect(saved[2]!.expectedFingerprint).toBe(
      `sha256:${String(2).padStart(64, 'b')}`,
    )

    const persisted = parseNativeDrawnixDocument(saved.at(-1)!.content)
    const reopened = createTestingBoard([], persisted.elements)
    reopened.viewport = persisted.viewport
    reopened.theme = persisted.theme ?? reopened.theme
    expect(snapshotDrawnixBoard(
      reopened,
      'maps/tutorial.drawnix',
      0,
    ).roots).toEqual(updated.roots)
  })

  it('rejects a stale Agent update after the open Board changes', async () => {
    const board = createEmptyBoard()
    const controller = new DrawnixDocumentController(
      board,
      'project-1',
      'maps/tutorial.drawnix',
      INITIAL_FINGERPRINT,
      async request => ({
        metadata: {
          projectId: request.projectId,
          relativePath: request.relativePath,
          name: 'tutorial.drawnix',
          mimeType: 'application/json',
          byteLength: request.content.length,
          lastModifiedMs: 1,
        },
        sourceFingerprint: `sha256:${'b'.repeat(64)}`,
      }),
      () => {},
    )
    const beforeChange = await controller.read()

    controller.notifyBoardChanged()
    await controller.flush()

    try {
      await controller.update({
        v: 1,
        action: 'update',
        projectId: 'project-1',
        relativePath: 'maps/tutorial.drawnix',
        expectedChangeSeq: beforeChange.changeSeq,
        operations: [{
          type: 'populate_empty',
          markdown: '# Must not apply',
        }],
      })
      throw new Error('Expected stale update to fail')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('MINDMAP_BOARD_CHANGED')
    }
    expect(board.children).toEqual([])
  })

  it('only allows populate_empty on an empty Board', async () => {
    const board = createEmptyBoard()
    await applyMindmapOperations(board, [{
      type: 'populate_empty',
      markdown: '# Existing',
    }])

    await expect(applyMindmapOperations(board, [{
      type: 'populate_empty',
      markdown: '# Replacement',
    }])).rejects.toThrow(
      'populate_empty can only be used by itself on a completely empty board.',
    )
  })
})
