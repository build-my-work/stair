import { describe, expect, it } from 'bun:test'
import {
  createTestingBoard,
  fakeNodeWeakMap,
  withHistory,
  type PlaitBoard,
} from '@plait/core'
import { buildText } from '@plait/common'
import {
  MindTransforms,
  type MindElement,
  type PlaitMindBoard,
} from '@plait/mind'
import type { Element as SlateElement } from 'slate'
import type { DrawnixBoardUpdateCapabilityRequest } from '@craft-agent/server-core/transport'
import type {
  ProjectFileFingerprint,
  SaveDrawnixProjectFileRequest,
  SaveDrawnixProjectFileResponse,
} from '@craft-agent/shared/project-files'
import { DrawnixDocumentController } from '../drawnix-document-controller'
import {
  applyMindmapOperations,
  createDrawnixEditor,
  parseDrawnixDocument,
} from '@ttsworld/drawnix/editor'
import {
  handleDrawnixBoardCapability,
  registerOpenDrawnixBoard,
} from '../drawnix-board-registry'

const INITIAL_FINGERPRINT = `sha256:${'a'.repeat(64)}` as ProjectFileFingerprint

function snapshotDrawnixBoard(board: PlaitBoard, relativePath: string, changeSeq: number) {
  return { relativePath, changeSeq, roots: createDrawnixEditor(board).readMindmap() }
}

function createEmptyBoard(): PlaitBoard {
  return createTestingBoard([], [])
}

function savedResponse(
  request: SaveDrawnixProjectFileRequest,
  index: number,
): SaveDrawnixProjectFileResponse {
  return {
    metadata: {
      projectId: request.projectId,
      relativePath: request.relativePath,
      name: 'tutorial.drawnix',
      mimeType: 'application/vnd.drawnix+json',
      byteLength: request.content.length,
      lastModifiedMs: index,
    },
    sourceFingerprint: `sha256:${String(index).padStart(64, 'b')}` as ProjectFileFingerprint,
  }
}

describe('Drawnix document controller', () => {
  it('persists notes through the package interface and protects user edits from stale Agent writes', async () => {
    const board = createEmptyBoard()
    const editor = createDrawnixEditor(board)
    editor.updateMindmap([{ type: 'populate_empty', markdown: '# 核心点' }])
    let saved = ''
    const controller = new DrawnixDocumentController(
      editor, 'project-a', 'maps/notes.drawnix', INITIAL_FINGERPRINT,
      async request => {
        saved = request.content
        return savedResponse(request, 1)
      }, () => {},
    )
    const initial = await controller.read()
    const nodeId = initial.roots[0]!.id
    const request: DrawnixBoardUpdateCapabilityRequest = {
      v: 1,
      action: 'update',
      projectId: 'project-a',
      relativePath: 'maps/notes.drawnix',
      expectedChangeSeq: initial.changeSeq,
      operations: [{ type: 'set_note', nodeId, note: '详细解释\n个人笔记' }],
    }
    const afterAgent = await controller.update(request)
    expect(afterAgent.roots[0]).toMatchObject({ topic: '核心点', note: '详细解释\n个人笔记' })
    editor.updateMindmap([{ type: 'set_note', nodeId, note: '用户刚刚修改的备注' }])
    controller.notifyBoardChanged()
    await expect(controller.update({ ...request, expectedChangeSeq: afterAgent.changeSeq }))
      .rejects.toMatchObject({ code: 'MINDMAP_BOARD_CHANGED' })
    await controller.flush()
    const document = parseDrawnixDocument(saved)
    const reopened = createDrawnixEditor(createTestingBoard([], document.elements))
    expect(reopened.readMindmap()[0]).toMatchObject({ topic: '核心点', note: '用户刚刚修改的备注' })
  })

  it('does not reuse a read token from a previous renderer process', async () => {
    const controllerModule = new URL('../drawnix-document-controller.ts', import.meta.url).pathname
    const previousRenderer = Bun.spawnSync([process.execPath, '-e', `
      import { createTestingBoard } from '@plait/core'
      import { createDrawnixEditor } from '@ttsworld/drawnix/editor'
      import { DrawnixDocumentController } from ${JSON.stringify(controllerModule)}
      const controller = new DrawnixDocumentController(
        createDrawnixEditor(createTestingBoard([], [])), 'project-a', 'maps/restart.drawnix',
        ${JSON.stringify(INITIAL_FINGERPRINT)}, () => { throw new Error('no save expected') }, () => {},
      )
      console.log(JSON.stringify(await controller.read()))
    `], { cwd: import.meta.dir })
    expect(previousRenderer.exitCode).toBe(0)
    const stale = JSON.parse(previousRenderer.stdout.toString()) as { changeSeq: number }
    const controller = new DrawnixDocumentController(
      createDrawnixEditor(createEmptyBoard()), 'project-a', 'maps/restart.drawnix',
      INITIAL_FINGERPRINT, request => Promise.resolve(savedResponse(request, 1)), () => {},
    )

    await expect(controller.update({
      v: 1, action: 'update', projectId: 'project-a', relativePath: 'maps/restart.drawnix',
      expectedChangeSeq: stale.changeSeq,
      operations: [{ type: 'populate_empty', markdown: '# Stale overwrite' }],
    })).rejects.toMatchObject({ code: 'MINDMAP_BOARD_CHANGED' })
    expect((await controller.read()).roots).toEqual([])
  })

  it('rejects a stale capability after the user saves and reopens the same board', async () => {
    const projectId = 'reopened-project'
    const relativePath = 'maps/reopened.drawnix'
    const board = createEmptyBoard()
    applyMindmapOperations(board, [{ type: 'populate_empty', markdown: '# Original' }])
    let savedContent = ''
    let savedFingerprint = INITIAL_FINGERPRINT
    const save = async (request: SaveDrawnixProjectFileRequest) => {
      savedContent = request.content
      const response = savedResponse(request, 1)
      savedFingerprint = response.sourceFingerprint
      return response
    }
    const controller = new DrawnixDocumentController(
      createDrawnixEditor(board), projectId, relativePath, savedFingerprint, save, () => {},
    )
    let unregister = registerOpenDrawnixBoard(projectId, relativePath, controller)
    try {
      const stale = await handleDrawnixBoardCapability({ v: 1, action: 'read', projectId, relativePath })
      if (!stale.ok) throw new Error(stale.error.message)
      const nodeId = stale.snapshot.roots[0]!.id
      applyMindmapOperations(board, [{ type: 'set_topic', nodeId, topic: 'User saved this' }])
      controller.notifyBoardChanged()
      await controller.flush()
      unregister()

      const persisted = parseDrawnixDocument(savedContent)
      const reopened = new DrawnixDocumentController(
        createDrawnixEditor(createTestingBoard([], persisted.elements)),
        projectId, relativePath, savedFingerprint, save, () => {},
      )
      unregister = registerOpenDrawnixBoard(projectId, relativePath, reopened)
      expect(await handleDrawnixBoardCapability({
        v: 1, action: 'update', projectId, relativePath,
        expectedChangeSeq: stale.snapshot.changeSeq,
        operations: [{ type: 'set_topic', nodeId, topic: 'Stale overwrite' }],
      })).toMatchObject({ ok: false, error: { code: 'MINDMAP_BOARD_CHANGED' } })
      const current = await reopened.read()
      expect(current.roots[0]!.topic).toBe('User saved this')
      expect(Number.isSafeInteger(current.changeSeq)).toBe(true)
      expect(current.changeSeq).toBeGreaterThanOrEqual(0)
      expect(await handleDrawnixBoardCapability({
        v: 1, action: 'update', projectId, relativePath,
        expectedChangeSeq: current.changeSeq,
        operations: [{ type: 'insert_child', parentId: nodeId, topic: 'Fresh addition' }],
      })).toMatchObject({
        ok: true,
        snapshot: { roots: [{ topic: 'User saved this', children: [{ topic: 'Fresh addition' }] }] },
      })
    } finally {
      unregister()
    }
  })

  it('populates an empty board and applies node transforms as one live document', async () => {
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

    expect(snapshotDrawnixBoard(board, 'maps/tutorial.drawnix', 2)).toMatchObject({
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

  it('accepts an Agent-style top-level bullet hierarchy', async () => {
    const board = createEmptyBoard()
    await applyMindmapOperations(board, [{
      type: 'populate_empty',
      markdown: [
        '- Operating Systems',
        '  - Processes',
        '    - Creation',
        '    - Scheduling',
        '  - Memory',
      ].join('\n'),
    }])

    expect(snapshotDrawnixBoard(board, 'maps/os.drawnix', 1).roots).toMatchObject([{
      topic: 'Operating Systems',
      children: [
        { topic: 'Processes', children: [{ topic: 'Creation' }, { topic: 'Scheduling' }] },
        { topic: 'Memory' },
      ],
    }])
  })

  it('preserves user edits and saves each fingerprint in order', async () => {
    const board = createEmptyBoard()
    const saves: SaveDrawnixProjectFileRequest[] = []
    const controller = new DrawnixDocumentController(
      createDrawnixEditor(board),
      'project-a',
      'maps/tutorial.drawnix',
      INITIAL_FINGERPRINT,
      async request => {
        saves.push(request)
        return savedResponse(request, saves.length)
      },
      () => {},
    )

    await controller.update({
      v: 1,
      action: 'update',
      projectId: 'project-a',
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: (await controller.read()).changeSeq,
      operations: [{ type: 'populate_empty', markdown: '# Tutorial\n## Agent topic' }],
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
      projectId: 'project-a',
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: afterUserEdit.changeSeq,
      operations: [{
        type: 'insert_child',
        parentId: afterUserEdit.roots[0]!.id,
        topic: 'Agent-added topic',
      }],
    })

    expect(updated.changeSeq).toBe(afterUserEdit.changeSeq + 1)
    expect(updated.roots[0]).toMatchObject({
      topic: 'User-renamed tutorial',
      children: [{ topic: 'Agent topic' }, { topic: 'Agent-added topic' }],
    })
    expect(saves.map(save => save.expectedFingerprint)).toEqual([
      INITIAL_FINGERPRINT,
      savedResponse(saves[0]!, 1).sourceFingerprint,
      savedResponse(saves[1]!, 2).sourceFingerprint,
    ])

    const persisted = parseDrawnixDocument(saves.at(-1)!.content)
    const reopened = createTestingBoard([], persisted.elements)
    reopened.viewport = persisted.viewport
    reopened.theme = persisted.theme ?? reopened.theme
    expect(snapshotDrawnixBoard(reopened, 'maps/tutorial.drawnix', 0).roots)
      .toEqual(updated.roots)
  })

  it('rejects a stale Agent update after a user change', async () => {
    const board = createEmptyBoard()
    const controller = new DrawnixDocumentController(
      createDrawnixEditor(board),
      'project-a',
      'maps/tutorial.drawnix',
      INITIAL_FINGERPRINT,
      request => Promise.resolve(savedResponse(request, 1)),
      () => {},
    )
    const beforeChange = await controller.read()
    controller.notifyBoardChanged()
    await controller.flush()

    await expect(controller.update({
      v: 1,
      action: 'update',
      projectId: 'project-a',
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: beforeChange.changeSeq,
      operations: [{ type: 'populate_empty', markdown: '# Must not apply' }],
    })).rejects.toMatchObject({ code: 'MINDMAP_BOARD_CHANGED' })
    expect(board.children).toEqual([])
  })

  it('vetoes flush after a save failure and never claims the board was saved', async () => {
    const board = createEmptyBoard()
    const states: Array<{ saving: boolean; error: Error | null }> = []
    const failure = Object.assign(new Error('changed on disk'), {
      code: 'PROJECT_FILE_CHANGED',
    })
    const controller = new DrawnixDocumentController(
      createDrawnixEditor(board),
      'project-a',
      'maps/tutorial.drawnix',
      INITIAL_FINGERPRINT,
      () => Promise.reject(failure),
      state => states.push(state),
    )

    controller.notifyBoardChanged()
    await expect(controller.flush()).rejects.toBe(failure)
    expect(states.at(-1)).toEqual({ saving: false, error: failure })
  })

  it('retries a transient save failure without discarding the live board', async () => {
    const board = createEmptyBoard()
    let attempts = 0
    const controller = new DrawnixDocumentController(
      createDrawnixEditor(board),
      'project-a',
      'maps/tutorial.drawnix',
      INITIAL_FINGERPRINT,
      async request => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary transport failure')
        return savedResponse(request, attempts)
      },
      () => {},
    )

    controller.notifyBoardChanged()
    await expect(controller.flush()).rejects.toThrow('temporary transport failure')
    controller.retry()
    await expect(controller.flush()).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('debounces ordinary board changes while flush still saves immediately', async () => {
    const board = createEmptyBoard()
    const saves: SaveDrawnixProjectFileRequest[] = []
    const controller = new DrawnixDocumentController(
      createDrawnixEditor(board),
      'project-a',
      'maps/tutorial.drawnix',
      INITIAL_FINGERPRINT,
      async request => {
        saves.push(request)
        return savedResponse(request, saves.length)
      },
      () => {},
    )

    controller.notifyBoardChanged()
    await Promise.resolve()
    expect(saves).toHaveLength(0)
    await controller.flush()
    expect(saves).toHaveLength(1)
  })

  it('persists viewport or theme changes without invalidating the Agent outline sequence', async () => {
    const board = createEmptyBoard()
    const controller = new DrawnixDocumentController(
      createDrawnixEditor(board),
      'project-a',
      'maps/tutorial.drawnix',
      INITIAL_FINGERPRINT,
      request => Promise.resolve(savedResponse(request, 1)),
      () => {},
    )

    const before = await controller.read()
    controller.notifyPresentationChanged()
    await controller.flush()
    expect((await controller.read()).changeSeq).toBe(before.changeSeq)
  })

  it('allows only one of two concurrent updates with the same outline sequence', async () => {
    const board = createEmptyBoard()
    await applyMindmapOperations(board, [{ type: 'populate_empty', markdown: '# Original' }])
    const rootId = snapshotDrawnixBoard(board, 'maps/tutorial.drawnix', 0).roots[0]!.id
    const controller = new DrawnixDocumentController(
      createDrawnixEditor(board),
      'project-a',
      'maps/tutorial.drawnix',
      INITIAL_FINGERPRINT,
      request => Promise.resolve(savedResponse(request, 1)),
      () => {},
    )
    const beforeUpdate = await controller.read()
    const request = (topic: string) => controller.update({
      v: 1,
      action: 'update',
      projectId: 'project-a',
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: beforeUpdate.changeSeq,
      operations: [{ type: 'set_topic' as const, nodeId: rootId, topic }],
    })

    const results = await Promise.allSettled([request('First'), request('Second')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => (
      result.status === 'rejected'
      && (result.reason as { code?: string }).code === 'MINDMAP_BOARD_CHANGED'
    ))).toHaveLength(1)
  })

  it('rolls back a failed Agent batch instead of leaving an untracked partial mutation', async () => {
    const board = createTestingBoard([withHistory], [])
    await applyMindmapOperations(board, [{
      type: 'populate_empty',
      markdown: '# Original\n## Child',
    }])
    const before = snapshotDrawnixBoard(board, 'maps/tutorial.drawnix', 0)
    const originalApply = board.apply
    let applyCount = 0
    board.apply = operation => {
      applyCount += 1
      if (applyCount === 2) throw new Error('synthetic transform failure')
      originalApply(operation)
    }
    const controller = new DrawnixDocumentController(
      createDrawnixEditor(board),
      'project-a',
      'maps/tutorial.drawnix',
      INITIAL_FINGERPRINT,
      request => Promise.resolve(savedResponse(request, 1)),
      () => {},
    )

    const beforeUpdate = await controller.read()
    await expect(controller.update({
      v: 1,
      action: 'update',
      projectId: 'project-a',
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: beforeUpdate.changeSeq,
      operations: [
        { type: 'set_topic', nodeId: before.roots[0]!.id, topic: 'Changed root' },
        { type: 'set_topic', nodeId: before.roots[0]!.children[0]!.id, topic: 'Changed child' },
      ],
    })).rejects.toThrow('synthetic transform failure')
    expect(await controller.read()).toEqual(beforeUpdate)
  })

  it('rejects a batch with more than 50 operations before changing the board', async () => {
    const board = createEmptyBoard()
    await applyMindmapOperations(board, [{ type: 'populate_empty', markdown: '# Original' }])
    const before = snapshotDrawnixBoard(board, 'maps/tutorial.drawnix', 0)
    const operations = Array.from({ length: 51 }, (_, index) => ({
      type: 'set_topic' as const,
      nodeId: before.roots[0]!.id,
      topic: `Topic ${index}`,
    }))

    expect(() => applyMindmapOperations(board, operations)).toThrow(
      'Provide between 1 and 50 mind-map operations.',
    )
    expect(snapshotDrawnixBoard(board, 'maps/tutorial.drawnix', 0)).toEqual(before)
  })

  it('only allows populate_empty on an empty board', async () => {
    const board = createEmptyBoard()
    await applyMindmapOperations(board, [{ type: 'populate_empty', markdown: '# Existing' }])
    expect(() => applyMindmapOperations(board, [{
      type: 'populate_empty',
      markdown: '# Replacement',
    }])).toThrow('populate_empty can only be used by itself')
  })
})
