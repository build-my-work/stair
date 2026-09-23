import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
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

  function register(
    workspace: { id: string; rootPath: string },
    beginBrowserProjectDeletion: (
      workspaceId: string,
      projectId: string,
    ) => Promise<void> = mock(async () => {}),
    finishBrowserProjectDeletion: (
      workspaceId: string,
      projectId: string,
      deleted: boolean,
    ) => Promise<void> = mock(async () => {}),
  ) {
    const handlers = new Map<string, HandlerFn>()
    const server: RpcServer = {
      handle: (channel, handler) => handlers.set(channel, handler),
      push: () => {},
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }
    registerProjectsHandlers(server, {
      sessionManager: {
        beginBrowserProjectDeletion,
        finishBrowserProjectDeletion,
      },
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
    const destroyForProject = mock(async () => {})

    try {
      const remove = register(workspace, destroyForProject).get(RPC_CHANNELS.projects.DELETE)!
      await expect(remove(requestContext(), workspace.id, project.config.slug))
        .rejects.toThrow('DEFAULT_PROJECT')
      expect(destroyForProject).not.toHaveBeenCalled()
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
    const destroyForProject = mock(async () => {})

    try {
      const remove = register(workspace, destroyForProject).get(RPC_CHANNELS.projects.DELETE)!
      await expect(remove(requestContext(), workspace.id, project.slug))
        .rejects.toThrow('PROJECT_NOT_EMPTY')
      expect(destroyForProject).not.toHaveBeenCalled()
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
    const destroyForProject = mock(async (_workspaceId: string, _projectId: string) => {})
    const finishProjectDeletion = mock(async (
      _workspaceId: string,
      _projectId: string,
      _deleted: boolean,
    ) => {})

    try {
      const remove = register(
        workspace,
        destroyForProject,
        finishProjectDeletion,
      ).get(RPC_CHANNELS.projects.DELETE)!
      await remove(requestContext(), workspace.id, project.slug)
      expect(loadProject(rootPath, project.slug)).toBeNull()
      expect(destroyForProject).toHaveBeenCalledWith(workspace.id, project.id)
      expect(finishProjectDeletion).toHaveBeenCalledWith(workspace.id, project.id, true)
    } finally {
      lookup.mockRestore()
    }
  })

  it('keeps the Project when Browser cleanup fails', async () => {
    const rootPath = join(sandbox, 'workspace-cleanup-failure')
    const workspace = { ...createWorkspaceAtPath(rootPath, 'Workspace'), rootPath }
    const project = createProject(rootPath, { name: 'Cleanup Failure' })
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace as never)
    const cleanupError = new Error('Browser cleanup failed')
    const finishProjectDeletion = mock(async (
      _workspaceId: string,
      _projectId: string,
      _deleted: boolean,
    ) => {})

    try {
      const remove = register(
        workspace,
        mock(async () => { throw cleanupError }),
        finishProjectDeletion,
      ).get(RPC_CHANNELS.projects.DELETE)!
      await expect(remove(requestContext(), workspace.id, project.slug))
        .rejects.toThrow('Browser cleanup failed')
      expect(loadProject(rootPath, project.slug)).not.toBeNull()
      expect(finishProjectDeletion).toHaveBeenCalledWith(workspace.id, project.id, false)
    } finally {
      lookup.mockRestore()
    }
  })

  it('does not update a Project after its deletion lock has started', async () => {
    const rootPath = join(sandbox, 'workspace-delete-update-race')
    const workspace = { ...createWorkspaceAtPath(rootPath, 'Workspace'), rootPath }
    const project = createProject(rootPath, { name: 'Delete Update Race' })
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace as never)
    let releaseDeletion!: () => void
    let markDeletionStarted!: () => void
    const deletionStarted = new Promise<void>(resolve => { markDeletionStarted = resolve })
    const deletionReleased = new Promise<void>(resolve => { releaseDeletion = resolve })
    const handlers = register(
      workspace,
      mock(async () => {
        markDeletionStarted()
        await deletionReleased
      }),
    )

    try {
      const remove = handlers.get(RPC_CHANNELS.projects.DELETE)!
      const update = handlers.get(RPC_CHANNELS.projects.UPDATE)!
      const deletion = remove(requestContext(), workspace.id, project.slug)
      await deletionStarted
      const updating = update(
        requestContext(),
        workspace.id,
        project.slug,
        { name: 'Must Not Survive' },
      )
      let updateSettled = false
      void updating.then(
        () => { updateSettled = true },
        () => { updateSettled = true },
      )
      await Bun.sleep(10)
      expect(updateSettled).toBe(false)

      releaseDeletion()
      await deletion
      await expect(updating).rejects.toThrow(`Project not found: ${project.slug}`)
      expect(loadProject(rootPath, project.slug)).toBeNull()
    } finally {
      releaseDeletion?.()
      lookup.mockRestore()
    }
  })
})
