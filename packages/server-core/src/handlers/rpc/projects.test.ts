import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as config from '@craft-agent/shared/config'
import { createProject } from '@craft-agent/shared/projects'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'

import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { registerProjectsHandlers } from './projects'

describe('Project note target invalidation', () => {
  let sandbox = ''

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'craft-project-update-'))
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('clears Session note routes only when the Project root changes', async () => {
    const workspaceRoot = join(sandbox, 'workspace')
    const firstRoot = join(sandbox, 'project-a')
    const secondRoot = join(sandbox, 'project-b')
    await Promise.all([
      mkdir(workspaceRoot),
      mkdir(firstRoot),
      mkdir(secondRoot),
    ])
    const project = createProject(workspaceRoot, {
      name: 'Project',
      workingDirectory: firstRoot,
    })
    const workspace = {
      id: 'workspace-1',
      name: 'Workspace',
      slug: 'workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    }
    const workspaceLookup = spyOn(config, 'getWorkspaceByNameOrId')
      .mockImplementation(id =>
        id === workspace.id || id === workspace.name ? workspace : null)
    const clears: Array<[string, string]> = []
    const unbound: Array<[string, string]> = []
    const handlers = new Map<string, HandlerFn>()
    const server: RpcServer = {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      push: () => {},
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }
    registerProjectsHandlers(server, {
      sessionManager: {
        clearProjectNoteTargetsForProject: async (
          workspaceId: string,
          projectId: string,
        ) => {
          clears.push([workspaceId, projectId])
        },
        unbindSessionsFromProject: async (
          workspaceId: string,
          projectId: string,
        ) => {
          unbound.push([workspaceId, projectId])
          return 1
        },
      },
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps)

    try {
      const update = handlers.get(RPC_CHANNELS.projects.UPDATE)!
      await update(
        {} as any,
        workspace.id,
        project.slug,
        { name: 'Renamed' },
      )
      expect(clears).toEqual([])

      await update(
        {} as any,
        workspace.name,
        project.slug,
        { workingDirectory: secondRoot },
      )
      expect(clears).toEqual([[workspace.id, project.id]])

      const remove = handlers.get(RPC_CHANNELS.projects.DELETE)!
      await remove({} as any, workspace.id, project.slug)
      expect(unbound).toEqual([[workspace.id, project.id]])
    } finally {
      workspaceLookup.mockRestore()
    }
  })
})
