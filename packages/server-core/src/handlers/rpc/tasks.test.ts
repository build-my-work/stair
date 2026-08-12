import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as config from '@craft-agent/shared/config'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { createWorkspaceAtPath } from '@craft-agent/shared/workspaces'
import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { registerTasksHandlers } from './tasks'

const TASK_YAML = `
id: stale-draft
title: Stale draft
goal: Verify fresh fallback
project: project-a
nodes:
  - id: run
    prompt: Run the task
`

describe('Task Project ownership guards', () => {
  let sandbox = ''

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'stair-task-project-'))
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  function requestContext() {
    return { clientId: 'test', workspaceId: null, webContentsId: null }
  }

  function register(sessionManager: Record<string, unknown>) {
    const handlers = new Map<string, HandlerFn>()
    const server: RpcServer = {
      handle: (channel, handler) => handlers.set(channel, handler),
      push: () => {},
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }
    registerTasksHandlers(server, {
      sessionManager,
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps)
    return handlers.get(RPC_CHANNELS.tasks.CREATE)!
  }

  it('falls back to a fresh same-Project orchestrator when the generated draft is gone', async () => {
    const rootPath = join(sandbox, 'workspace')
    const workspace = { ...createWorkspaceAtPath(rootPath, 'Workspace'), rootPath }
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace as never)
    const createdOptions: Array<Record<string, unknown>> = []
    const sessionManager = {
      getSession: async () => null,
      adoptGeneratedTaskOrchestrator: async () => false,
      createSession: async (_workspaceId: string, options: Record<string, unknown>) => {
        createdOptions.push(options)
        return { id: 'fresh-orchestrator' }
      },
      applyTaskLabel: async () => undefined,
      setSessionSources: async () => {},
    }

    try {
      const result = await register(sessionManager)(requestContext(), workspace.id, {
        yaml: TASK_YAML,
        orchestratorSessionId: 'deleted-draft',
      })

      expect(result.orchestratorSessionId).toBe('fresh-orchestrator')
      expect(createdOptions).toHaveLength(1)
      expect(createdOptions[0]?.projectId).toBe('project-a')
    } finally {
      lookup.mockRestore()
    }
  })

  it('reports a missing attach target as missing instead of cross-Project', async () => {
    const rootPath = join(sandbox, 'workspace')
    const workspace = { ...createWorkspaceAtPath(rootPath, 'Workspace'), rootPath }
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace as never)
    const sessionManager = {
      getSession: async () => null,
      bindExistingSessionToTask: async () => false,
    }

    try {
      await expect(register(sessionManager)(requestContext(), workspace.id, {
        yaml: TASK_YAML,
        attachToExistingSession: 'deleted-session',
      })).rejects.toThrow('session is missing or already bound')
    } finally {
      lookup.mockRestore()
    }
  })
})
