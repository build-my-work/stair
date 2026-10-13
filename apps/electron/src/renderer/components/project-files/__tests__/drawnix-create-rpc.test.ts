import { expect, it, spyOn } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as config from '@craft-agent/shared/config'
import { createWorkspaceAtPath } from '@craft-agent/shared/workspaces'
import { createProject } from '@craft-agent/shared/projects'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { WsRpcServer, WsRpcClient } from '@craft-agent/server-core/transport'
import { registerProjectFileHandlers } from '@craft-agent/server-core/handlers/rpc/project-files'
import type { HandlerDeps } from '@craft-agent/server-core/handlers'
import { createDrawnixMindmap } from '../drawnix-mindmap-create'

it('D01 / DRAWNIX-03: creates complete content over authenticated RPC before opening the Canvas', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stair-drawnix-create-rpc-'))
  const root = join(directory, 'project')
  mkdirSync(root)
  const workspaceRoot = join(directory, 'workspace')
  const workspace = { ...createWorkspaceAtPath(workspaceRoot, 'Workspace'), rootPath: workspaceRoot }
  const project = createProject(workspaceRoot, { name: 'Project', workingDirectory: root })
  const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => id === workspace.id ? workspace as never : null)
  const token = 'drawnix-create-test-token-with-enough-entropy'
  const server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async value => value === token })
  registerProjectFileHandlers(server, {
    sessionManager: {}, oauthFlowStore: {}, platform: { logger: console },
  } as unknown as HandlerDeps)
  let client: WsRpcClient | undefined
  try {
    await server.listen()
    client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token, workspaceId: workspace.id, autoReconnect: false,
    })
    const connection = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RPC handshake timed out')), 2_000)
      const off = client!.onConnectionStateChanged(state => {
        if (state.status === 'connected') { clearTimeout(timer); off(); resolve() }
      })
    })
    client.connect()
    await connection
    const connected = client
    let opened = false
    const result = await createDrawnixMindmap({
      v: 1, action: 'create', projectId: project.id,
      relativePath: 'maps/complete.drawnix', markdown: '# RPC Root\n## RPC Child',
    }, {
      activeProjectId: () => project.id,
      api: {
        isChannelAvailable: channel => connected.isChannelAvailable(channel),
        listProjectDirectoryEntries: request => connected.invoke(RPC_CHANNELS.projectFiles.LIST_DIRECTORY_ENTRIES, request),
        createProjectDirectory: request => connected.invoke(RPC_CHANNELS.projectFiles.CREATE_DIRECTORY, request),
        createDrawnixProjectFileWithContent: request => connected.invoke(RPC_CHANNELS.projectFiles.CREATE_DRAWNIX_FILE_WITH_CONTENT, request),
      },
      openProjectFile: async request => {
        expect(request.projectId).toBe(project.id)
        expect(JSON.parse(readFileSync(join(root, request.relativePath), 'utf8')).elements[0].data.topic.children[0].text)
          .toBe('RPC Root')
        opened = true
        return true
      },
    })
    expect(result).toMatchObject({ ok: true, snapshot: { roots: [{ topic: 'RPC Root', children: [{ topic: 'RPC Child' }] }] } })
    expect(opened).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(root, 'maps/complete.drawnix'), 'utf8'))
    if (!result.ok) throw new Error('Creation failed')
    expect(onDisk.elements[0].id).toBe(result.snapshot.roots[0]!.id)

    await expect(client.invoke(RPC_CHANNELS.projectFiles.CREATE_DRAWNIX_FILE_WITH_CONTENT, {
      projectId: project.id, name: 'missing-content.drawnix',
    })).rejects.toThrow('PROJECT_FILE_INVALID_REQUEST')
    expect(existsSync(join(root, 'missing-content.drawnix'))).toBe(false)
  } finally {
    client?.destroy()
    await server.close()
    lookup.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10_000)
