import { describe, expect, it } from 'bun:test'
import type {
  ProjectFileFingerprint,
  SaveProjectTextFileRequest,
  SaveProjectTextFileResponse,
} from '@craft-agent/shared/project-files'
import {
  ProjectTextDocumentController,
  type ProjectTextDocumentState,
} from '../project-text-document-controller'

const INITIAL_FINGERPRINT = `sha256:${'a'.repeat(64)}` as ProjectFileFingerprint

function responseFor(
  request: SaveProjectTextFileRequest,
  character: string,
): SaveProjectTextFileResponse {
  return {
    metadata: {
      projectId: request.projectId,
      relativePath: request.relativePath,
      name: 'notes.md',
      mimeType: 'text/markdown',
      byteLength: request.content.length,
      lastModifiedMs: Date.now(),
    },
    sourceFingerprint: `sha256:${character.repeat(64)}` as ProjectFileFingerprint,
  }
}

describe('Project 文本文档控制器', () => {
  it('合并快速修改，并在 flush 时保存最新内容', async () => {
    const requests: SaveProjectTextFileRequest[] = []
    const states: ProjectTextDocumentState[] = []
    const controller = new ProjectTextDocumentController(
      'project-a',
      'notes.md',
      'initial',
      INITIAL_FINGERPRINT,
      async request => {
        requests.push(request)
        return responseFor(request, 'b')
      },
      state => states.push(state),
    )

    controller.updateContent('one')
    controller.updateContent('latest')
    await controller.flush()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ content: 'latest', expectedFingerprint: INITIAL_FINGERPRINT })
    expect(states.at(-1)).toEqual({ status: 'saved', error: null })
  })

  it('保存期间继续编辑时使用新指纹再次保存', async () => {
    const requests: SaveProjectTextFileRequest[] = []
    let resolveFirst: ((response: SaveProjectTextFileResponse) => void) | undefined
    const controller = new ProjectTextDocumentController(
      'project-a',
      'notes.md',
      'initial',
      INITIAL_FINGERPRINT,
      request => {
        requests.push(request)
        if (requests.length === 1) {
          return new Promise(resolve => { resolveFirst = resolve })
        }
        return Promise.resolve(responseFor(request, 'c'))
      },
      () => {},
      0,
    )

    controller.updateContent('first')
    const flush = controller.flush()
    controller.updateContent('second')
    resolveFirst?.(responseFor(requests[0]!, 'b'))
    await flush

    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      content: 'second',
      expectedFingerprint: `sha256:${'b'.repeat(64)}`,
    })
  })

  it('冲突后保留草稿，flush 继续 veto', async () => {
    const states: ProjectTextDocumentState[] = []
    const controller = new ProjectTextDocumentController(
      'project-a',
      'notes.md',
      'initial',
      INITIAL_FINGERPRINT,
      async () => { throw new Error('PROJECT_FILE_CHANGED: changed on disk') },
      state => states.push(state),
      0,
    )

    controller.updateContent('unsaved draft')
    await expect(controller.flush()).rejects.toThrow('changed on disk')
    expect(controller.content).toBe('unsaved draft')
    expect(states.at(-1)?.status).toBe('conflict')
  })

  it('失败后回到已保存内容会清除旧错误，后续编辑可以重新保存', async () => {
    const requests: SaveProjectTextFileRequest[] = []
    let attempt = 0
    const controller = new ProjectTextDocumentController(
      'project-a',
      'notes.md',
      'initial',
      INITIAL_FINGERPRINT,
      async request => {
        requests.push(request)
        attempt += 1
        if (attempt === 1) throw new Error('temporary save failure')
        return responseFor(request, 'b')
      },
      () => {},
      0,
    )

    controller.updateContent('first draft')
    await expect(controller.flush()).rejects.toThrow('temporary save failure')
    controller.updateContent('initial')
    controller.updateContent('second draft')
    await expect(controller.flush()).resolves.toBeUndefined()

    expect(requests).toHaveLength(2)
    expect(requests[1]?.content).toBe('second draft')
  })

  it('冲突后显式丢弃草稿会恢复已保存内容并解除 flush veto', async () => {
    const states: ProjectTextDocumentState[] = []
    const controller = new ProjectTextDocumentController(
      'project-a',
      'notes.md',
      'initial',
      INITIAL_FINGERPRINT,
      async () => { throw new Error('PROJECT_FILE_CHANGED: changed on disk') },
      state => states.push(state),
      0,
    )

    controller.updateContent('unsaved draft')
    await expect(controller.flush()).rejects.toThrow('changed on disk')
    controller.discardChanges()

    expect(controller.content).toBe('initial')
    expect(states.at(-1)).toEqual({ status: 'clean', error: null })
    await expect(controller.flush()).resolves.toBeUndefined()
  })
})
