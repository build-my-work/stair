import { describe, expect, it } from 'bun:test'
import type {
  CreateProjectEntryRequest,
  ProjectDirectoryEntry,
  ProjectFileFingerprint,
  SaveDrawnixProjectFileRequest,
} from '@craft-agent/shared/project-files'
import { createDrawnixMindmap } from '../drawnix-mindmap-create'

const EMPTY_FINGERPRINT = `sha256:${'a'.repeat(64)}` as ProjectFileFingerprint

describe('Drawnix mind-map creation', () => {
  it('creates missing directories, saves native Drawnix content, and opens the canvas', async () => {
    const directories: CreateProjectEntryRequest[] = []
    const files: CreateProjectEntryRequest[] = []
    const saves: SaveDrawnixProjectFileRequest[] = []
    const opened: string[] = []

    const result = await createDrawnixMindmap({
      v: 1,
      action: 'create',
      projectId: 'project-a',
      relativePath: 'mindmaps/tutorial.drawnix',
      markdown: '# Tutorial\n## Setup\n## Concepts',
    }, {
      activeProjectId: () => 'project-a',
      api: {
        listProjectDirectoryEntries: async () => ({ entries: [], truncated: false }),
        createProjectDirectory: async request => {
          directories.push(request)
          return {
            name: request.name,
            relativePath: request.name,
            type: 'directory',
          }
        },
        createDrawnixProjectFile: async request => {
          files.push(request)
          return {
            name: request.name,
            relativePath: `${request.parentRelativePath}/${request.name}`,
            type: 'file',
          }
        },
        readProjectTextFile: async request => ({
          metadata: {
            projectId: request.projectId,
            relativePath: request.relativePath,
            name: 'tutorial.drawnix',
            mimeType: 'application/vnd.drawnix+json',
            byteLength: 0,
            lastModifiedMs: 1,
          },
          text: '',
          sourceFingerprint: EMPTY_FINGERPRINT,
        }),
        saveDrawnixProjectFile: async request => {
          saves.push(request)
          return {
            metadata: {
              projectId: request.projectId,
              relativePath: request.relativePath,
              name: 'tutorial.drawnix',
              mimeType: 'application/vnd.drawnix+json',
              byteLength: request.content.length,
              lastModifiedMs: 2,
            },
            sourceFingerprint: `sha256:${'b'.repeat(64)}` as ProjectFileFingerprint,
          }
        },
      },
      openProjectFile: async input => {
        opened.push(input.relativePath)
        return true
      },
    })

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        relativePath: 'mindmaps/tutorial.drawnix',
        changeSeq: 0,
        roots: [{
          topic: 'Tutorial',
          children: [{ topic: 'Setup' }, { topic: 'Concepts' }],
        }],
      },
    })
    expect(directories).toEqual([{ projectId: 'project-a', name: 'mindmaps' }])
    expect(files).toEqual([{
      projectId: 'project-a',
      parentRelativePath: 'mindmaps',
      name: 'tutorial.drawnix',
    }])
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({
      projectId: 'project-a',
      relativePath: 'mindmaps/tutorial.drawnix',
      expectedFingerprint: EMPTY_FINGERPRINT,
    })
    expect(JSON.parse(saves[0]!.content)).toMatchObject({
      type: 'drawnix',
      version: 1,
      elements: [{ type: 'mindmap' }],
    })
    expect(opened).toEqual(['mindmaps/tutorial.drawnix'])
  })

  it('does not touch the filesystem when the Session Project is not active', async () => {
    let apiCalls = 0
    const unavailable = async (): Promise<never> => {
      apiCalls += 1
      throw new Error('must not be called')
    }

    const result = await createDrawnixMindmap({
      v: 1,
      action: 'create',
      projectId: 'project-a',
      relativePath: 'mindmaps/tutorial.drawnix',
      markdown: '# Tutorial',
    }, {
      activeProjectId: () => 'project-b',
      api: {
        listProjectDirectoryEntries: unavailable,
        createProjectDirectory: unavailable,
        createDrawnixProjectFile: unavailable,
        readProjectTextFile: unavailable,
        saveDrawnixProjectFile: unavailable,
      },
      openProjectFile: unavailable,
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'MINDMAP_PROJECT_NOT_ACTIVE',
        message: 'Open the Session Project in Stair before creating its Drawnix mind map.',
      },
    })
    expect(apiCalls).toBe(0)
  })

  it('preserves an existing target instead of overwriting it', async () => {
    let saved = false
    let opened = false
    const existingError = Object.assign(new Error('target already exists'), {
      code: 'PROJECT_FILE_ALREADY_EXISTS',
    })
    const existingDirectory: ProjectDirectoryEntry = {
      name: 'mindmaps',
      relativePath: 'mindmaps',
      type: 'directory',
    }

    const result = await createDrawnixMindmap({
      v: 1,
      action: 'create',
      projectId: 'project-a',
      relativePath: 'mindmaps/tutorial.drawnix',
      markdown: '# Tutorial',
    }, {
      activeProjectId: () => 'project-a',
      api: {
        listProjectDirectoryEntries: async () => ({
          entries: [existingDirectory],
          truncated: false,
        }),
        createProjectDirectory: async () => existingDirectory,
        createDrawnixProjectFile: async () => { throw existingError },
        readProjectTextFile: async () => { throw new Error('must not read') },
        saveDrawnixProjectFile: async () => {
          saved = true
          throw new Error('must not save')
        },
      },
      openProjectFile: async () => {
        opened = true
        return true
      },
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'PROJECT_FILE_ALREADY_EXISTS',
        message: 'target already exists',
      },
    })
    expect(saved).toBe(false)
    expect(opened).toBe(false)
  })
})
