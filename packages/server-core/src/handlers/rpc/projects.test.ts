import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as config from '@craft-agent/shared/config'
import {
  createProject,
  loadProject,
  loadProjectById,
} from '@craft-agent/shared/projects'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import {
  createSession as createStoredSession,
  loadSession,
} from '@craft-agent/shared/sessions'
import { createWorkspaceAtPath } from '@craft-agent/shared/workspaces'
import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { registerProjectsHandlers } from './projects'

describe('Project RPC deletion', () => {
  let sandbox = ''

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'stair-project-rpc-'))
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  function register(workspace: { id: string; rootPath: string }) {
    const handlers = new Map<string, HandlerFn>()
    const server: RpcServer = {
      handle: (channel, handler) => handlers.set(channel, handler),
      push: () => {},
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }
    registerProjectsHandlers(server, {
      sessionManager: {},
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps)
    return handlers
  }

  function requestContext() {
    return { clientId: 'test', workspaceId: null, webContentsId: null }
  }

  it('rejects deleting the default Project', async () => {
    const rootPath = join(sandbox, 'workspace-default')
    const workspace = { ...createWorkspaceAtPath(rootPath, 'Workspace'), rootPath }
    const project = loadProjectById(rootPath, workspace.defaultProjectId)!
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace as never)

    try {
      const remove = register(workspace).get(RPC_CHANNELS.projects.DELETE)!
      await expect(remove(requestContext(), workspace.id, project.config.slug))
        .rejects.toThrow('DEFAULT_PROJECT')
      expect(loadProject(rootPath, project.config.slug)).not.toBeNull()
    } finally {
      lookup.mockRestore()
    }
  })

  it('rejects deleting a Project that still owns a Session', async () => {
    const rootPath = join(sandbox, 'workspace-busy')
    const workspace = { ...createWorkspaceAtPath(rootPath, 'Workspace'), rootPath }
    const project = createProject(rootPath, { name: 'Busy' })
    const session = await createStoredSession(rootPath, { projectId: project.id })
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace as never)

    try {
      const remove = register(workspace).get(RPC_CHANNELS.projects.DELETE)!
      await expect(remove(requestContext(), workspace.id, project.slug))
        .rejects.toThrow('PROJECT_NOT_EMPTY')
      expect(loadProject(rootPath, project.slug)).not.toBeNull()
      expect(loadSession(rootPath, session.id)?.projectId).toBe(project.id)
    } finally {
      lookup.mockRestore()
    }
  })

  it('deletes an empty non-default Project through the guarded domain path', async () => {
    const rootPath = join(sandbox, 'workspace-empty')
    const workspace = { ...createWorkspaceAtPath(rootPath, 'Workspace'), rootPath }
    const project = createProject(rootPath, { name: 'Empty' })
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace as never)

    try {
      const remove = register(workspace).get(RPC_CHANNELS.projects.DELETE)!
      await remove(requestContext(), workspace.id, project.slug)
      expect(loadProject(rootPath, project.slug)).toBeNull()
    } finally {
      lookup.mockRestore()
    }
  })
})
