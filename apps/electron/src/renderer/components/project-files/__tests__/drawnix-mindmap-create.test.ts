import { describe, expect, it } from 'bun:test'
import type {
  CreateProjectEntryRequest,
  CreateDrawnixProjectFileWithContentRequest,
  ProjectDirectoryEntry,
} from '@craft-agent/shared/project-files'
import { createDrawnixMindmap } from '../drawnix-mindmap-create'
import { discoverDrawnixBoards } from '../drawnix-board-registry'

describe('Drawnix mind-map creation', () => {
  it('D01: refuses an older Workspace server before creating any parent directories', async () => {
    let mutations = 0
    const unavailable = async (): Promise<never> => {
      mutations += 1
      throw new Error('must not write')
    }
    const result = await createDrawnixMindmap({
      v: 1, action: 'create', projectId: 'project-a',
      relativePath: 'maps/complete.drawnix', markdown: '# Root',
    }, {
      activeProjectId: () => 'project-a',
      api: {
        isChannelAvailable: () => false,
        listProjectDirectoryEntries: unavailable,
        createProjectDirectory: unavailable,
        createDrawnixProjectFileWithContent: unavailable,
      },
      openProjectFile: unavailable,
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'MINDMAP_CREATE_UNAVAILABLE' } })
    expect(mutations).toBe(0)
  })

  it('creates missing directories, saves native Drawnix content, and opens the canvas', async () => {
    const directories: CreateProjectEntryRequest[] = []
    const files: CreateDrawnixProjectFileWithContentRequest[] = []
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
        isChannelAvailable: () => true,
        listProjectDirectoryEntries: async () => ({ entries: [], truncated: false }),
        createProjectDirectory: async request => {
          directories.push(request)
          return {
            name: request.name,
            relativePath: request.name,
            type: 'directory',
          }
        },
        createDrawnixProjectFileWithContent: async request => {
          files.push(request)
          return {
            name: request.name,
            relativePath: `${request.parentRelativePath}/${request.name}`,
            type: 'file',
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
      content: expect.any(String),
    }])
    expect(JSON.parse(files[0]!.content)).toMatchObject({
      type: 'drawnix',
      version: 1,
      elements: [{ type: 'mindmap' }],
    })
    expect(opened).toEqual(['mindmaps/tutorial.drawnix'])
  })

  it('rechecks the active Project at execution after a successful discovery', async () => {
    let apiCalls = 0
    let activeProjectId = 'project-a'
    expect(discoverDrawnixBoards({
      v: 1, projectId: 'project-a', relativePath: 'mindmaps/tutorial.drawnix',
    }, activeProjectId)).toEqual({ ok: true, boardCount: 0, canCreate: true })
    activeProjectId = 'project-b'
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
      activeProjectId: () => activeProjectId,
      api: {
        isChannelAvailable: () => true,
        listProjectDirectoryEntries: unavailable,
        createProjectDirectory: unavailable,
        createDrawnixProjectFileWithContent: unavailable,
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

  it('D01: creates a populated file without depending on a second read/save request', async () => {
    let content: string | undefined
    const result = await createDrawnixMindmap({
      v: 1, action: 'create', projectId: 'project-a',
      relativePath: 'complete.drawnix', markdown: '# Complete\n## Child',
    }, {
      activeProjectId: () => 'project-a',
      api: {
        isChannelAvailable: () => true,
        listProjectDirectoryEntries: async () => ({ entries: [], truncated: false }),
        createProjectDirectory: async request => ({ name: request.name, relativePath: request.name, type: 'directory' }),
        createDrawnixProjectFileWithContent: async request => {
          content = request.content
          return { name: request.name, relativePath: request.name, type: 'file' }
        },
      },
      openProjectFile: async () => true,
    })
    expect(result).toMatchObject({ ok: true, snapshot: { roots: [{ topic: 'Complete' }] } })
    expect(JSON.parse(content!)).toMatchObject({
      type: 'drawnix', elements: [{ data: { topic: { children: [{ text: 'Complete' }] } } }],
    })
  })

  it.each(['rejected', 'exception'])('D01: reports the persisted file when opening the Canvas fails with %s', async failure => {
    const files: CreateDrawnixProjectFileWithContentRequest[] = []
    const result = await createDrawnixMindmap({
      v: 1, action: 'create', projectId: 'project-a',
      relativePath: 'complete.drawnix', markdown: '# Complete',
    }, {
      activeProjectId: () => 'project-a',
      api: {
        isChannelAvailable: () => true,
        listProjectDirectoryEntries: async () => ({ entries: [], truncated: false }),
        createProjectDirectory: async request => ({ name: request.name, relativePath: request.name, type: 'directory' }),
        createDrawnixProjectFileWithContent: async request => {
          files.push(request)
          return { name: request.name, relativePath: request.name, type: 'file' }
        },
      },
      openProjectFile: async () => {
        if (failure === 'exception') throw new Error('Canvas unavailable')
        return false
      },
    })
    expect(result).toMatchObject({ ok: false, error: {
      code: 'MINDMAP_CREATED_NOT_OPENED', message: expect.stringContaining('Do not retry creation'),
    } })
    expect(files).toHaveLength(1)
    expect(JSON.parse(files[0]!.content).elements[0].data.topic.children[0].text).toBe('Complete')
  })

  it('preserves an existing target instead of overwriting it', async () => {
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
        isChannelAvailable: () => true,
        listProjectDirectoryEntries: async () => ({
          entries: [existingDirectory],
          truncated: false,
        }),
        createProjectDirectory: async () => existingDirectory,
        createDrawnixProjectFileWithContent: async () => { throw existingError },
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
    expect(opened).toBe(false)
  })
})
