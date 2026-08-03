import { describe, expect, it } from 'bun:test'
import type { SourceFingerprint } from '@craft-agent/core'
import type {
  SaveProjectTextFileRequest,
  SaveProjectTextFileResponse,
} from '@craft-agent/shared/protocol'
import {
  ProjectTextDocumentController,
  type ProjectTextDocumentState,
} from '../project-text-document-controller'

const INITIAL_FINGERPRINT = `sha256:${'a'.repeat(64)}` as SourceFingerprint

function responseFor(
  request: SaveProjectTextFileRequest,
  fingerprintCharacter: string,
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
    sourceFingerprint:
      `sha256:${fingerprintCharacter.repeat(64)}` as SourceFingerprint,
  }
}

describe('Project text document controller', () => {
  it('coalesces rapid changes and flushes the latest content', async () => {
    const requests: SaveProjectTextFileRequest[] = []
    const states: ProjectTextDocumentState[] = []
    const controller = new ProjectTextDocumentController(
      'project-1',
      'notes.md',
      'initial',
      INITIAL_FINGERPRINT,
      async request => {
        requests.push(request)
        return responseFor(request, 'b')
      },
      state => states.push(state),
      () => {},
    )

    controller.updateContent('one')
    controller.updateContent('two')
    controller.updateContent('latest')
    await controller.flush()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      expectedFingerprint: INITIAL_FINGERPRINT,
      content: 'latest',
    })
    expect(states.at(-1)).toEqual({ status: 'saved', error: null })
  })

  it('saves edits made during an in-flight save with the returned fingerprint', async () => {
    const requests: SaveProjectTextFileRequest[] = []
    let resolveFirst: ((response: SaveProjectTextFileResponse) => void) | undefined
    const controller = new ProjectTextDocumentController(
      'project-1',
      'notes.md',
      'initial',
      INITIAL_FINGERPRINT,
      request => {
        requests.push(request)
        if (requests.length === 1) {
          return new Promise(resolve => {
            resolveFirst = resolve
          })
        }
        return Promise.resolve(responseFor(request, 'c'))
      },
      () => {},
      () => {},
      0,
    )

    controller.updateContent('first edit')
    const flush = controller.flush()
    expect(requests).toHaveLength(1)
    controller.updateContent('second edit')
    resolveFirst?.(responseFor(requests[0]!, 'b'))
    await flush

    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      expectedFingerprint: `sha256:${'b'.repeat(64)}`,
      content: 'second edit',
    })
  })

  it('stops after a conflict, preserves the draft, and does not reload it away', async () => {
    const states: ProjectTextDocumentState[] = []
    let saveCount = 0
    let reloadCount = 0
    const controller = new ProjectTextDocumentController(
      'project-1',
      'notes.md',
      'initial',
      INITIAL_FINGERPRINT,
      async () => {
        saveCount += 1
        throw new Error('PROJECT_FILE_CHANGED: changed on disk')
      },
      state => states.push(state),
      () => {
        reloadCount += 1
      },
      0,
    )

    controller.updateContent('unsaved draft')
    await expect(controller.flush()).rejects.toThrow('changed on disk')
    controller.updateContent('newer unsaved draft')
    controller.onExternalChange()
    await Promise.resolve()

    expect(controller.content).toBe('newer unsaved draft')
    expect(saveCount).toBe(1)
    expect(reloadCount).toBe(0)
    expect(states.at(-1)?.status).toBe('conflict')
  })

  it('reloads an externally changed file only when the editor is clean', () => {
    let reloadCount = 0
    const controller = new ProjectTextDocumentController(
      'project-1',
      'notes.md',
      'initial',
      INITIAL_FINGERPRINT,
      async request => responseFor(request, 'b'),
      () => {},
      () => {
        reloadCount += 1
      },
    )

    controller.onExternalChange()
    expect(reloadCount).toBe(1)
    controller.updateContent('dirty')
    controller.onExternalChange()
    expect(reloadCount).toBe(1)
    controller.dispose()
  })
})
