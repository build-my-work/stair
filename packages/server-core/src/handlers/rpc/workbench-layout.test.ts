import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as config from '@craft-agent/shared/config'
import { createProject } from '@craft-agent/shared/projects'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { createSession } from '@craft-agent/shared/sessions'
import { createWorkspaceAtPath } from '@craft-agent/shared/workspaces'
import type { HandlerFn, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import {
  WORKBENCH_LAYOUT_FILE,
  registerWorkbenchLayoutHandlers,
} from './workbench-layout'

describe('Workbench layout RPC', () => {
  let rootPath = ''

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), 'stair-workbench-layout-'))
  })

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true })
  })

  function register() {
    const handlers = new Map<string, HandlerFn>()
    const server: RpcServer = {
      handle: (channel, handler) => handlers.set(channel, handler),
      push: () => undefined,
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    }
    registerWorkbenchLayoutHandlers(server, {
      sessionManager: {},
      oauthFlowStore: {},
      platform: { logger: console },
    } as unknown as HandlerDeps)
    return handlers
  }

  it('round-trips sanitized semantic layouts for the active Workspace', async () => {
    const workspace = { ...createWorkspaceAtPath(rootPath, 'Workspace'), rootPath }
    const project = createProject(rootPath, { name: 'Project A' })
    const session = await createSession(rootPath, { projectId: project.id })
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace as never)

    try {
      const handlers = register()
      const context = { clientId: 'renderer', workspaceId: workspace.id, webContentsId: null }
      const document = {
        version: 1,
        layoutsByProject: {
          [project.id]: {
            primary: {
              id: 'primary-a',
              kind: 'session',
              sessionId: session.id,
              widthRatio: 2,
            },
            auxiliary: [{
              id: 'invalid-session',
              kind: 'session',
              sessionId: 'missing',
              widthRatio: 1,
            }, {
              id: 'file-a',
              kind: 'project-file',
              relativePath: 'notes.md',
              presentation: 'explicit',
              chatTargetSessionId: session.id,
              widthRatio: 1,
            }],
            previewPanelId: null,
            focusedPanelId: 'file-a',
          },
        },
      }

      const written = await handlers.get(RPC_CHANNELS.workbenchLayout.WRITE)!(
        context,
        document,
      )
      expect(written.layoutsByProject[project.id].auxiliary).toHaveLength(1)
      expect(await handlers.get(RPC_CHANNELS.workbenchLayout.READ)!(context)).toEqual(written)
      expect(readFileSync(join(rootPath, WORKBENCH_LAYOUT_FILE), 'utf8'))
        .not.toContain('invalid-session')
    } finally {
      lookup.mockRestore()
    }
  })

  it('returns an empty current document for corrupt storage without rewriting it', async () => {
    const workspace = { ...createWorkspaceAtPath(rootPath, 'Workspace'), rootPath }
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace as never)
    const filePath = join(rootPath, WORKBENCH_LAYOUT_FILE)
    writeFileSync(filePath, '{broken', 'utf8')

    try {
      const read = register().get(RPC_CHANNELS.workbenchLayout.READ)!
      expect(await read({
        clientId: 'renderer',
        workspaceId: workspace.id,
        webContentsId: null,
      })).toEqual({ version: 1, layoutsByProject: {} })
      expect(readFileSync(filePath, 'utf8')).toBe('{broken')
    } finally {
      lookup.mockRestore()
    }
  })
})
