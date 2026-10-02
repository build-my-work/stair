import { afterAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { join } from 'node:path'

const profile = process.env.CRAFT_CONFIG_DIR
if (!profile?.includes('stair-task-boundaries-')) throw new Error('Disposable profile required')
const config = await import('@craft-agent/shared/config')
if (config.CONFIG_DIR !== profile) throw new Error('Config imported before the test profile')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { createProject } = await import('@craft-agent/shared/projects')
const { saveSession, loadSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { saveTaskSpec, loadTaskSpec, taskYamlPath } = await import('@craft-agent/shared/tasks')
const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
const { SessionManager, createManagedSession } = await import('../../sessions/SessionManager')
const { WsRpcServer } = await import('../../transport/server')
const { WsRpcClient } = await import('../../transport/client')
const { registerTasksHandlers } = await import('./tasks')

const workspaceA = { ...createWorkspaceAtPath(join(profile, 'workspace-a'), 'A'), rootPath: join(profile, 'workspace-a') }
const workspaceB = { ...createWorkspaceAtPath(join(profile, 'workspace-b'), 'B'), rootPath: join(profile, 'workspace-b') }
const secondProject = createProject(workspaceA.rootPath, { name: 'Second Project' })
config.saveConfig({ workspaces: [workspaceA, workspaceB], activeWorkspaceId: workspaceA.id } as never)
const manager = new SessionManager()
const server = new WsRpcServer({ host: '127.0.0.1', port: 0 })
registerTasksHandlers(server, { sessionManager: manager, platform: { logger: console } } as never)
manager.setEventSink(server.push.bind(server))
await server.listen()
const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
  workspaceId: workspaceA.id, autoReconnect: false, requestTimeout: 3_000,
})
client.connect()

afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  client.destroy()
  server.close()
})

async function session(id: string, workspace = workspaceA, fields: { projectId?: string; taskDraft?: boolean; taskSlug?: string } = {}) {
  const managed = createManagedSession({ id, name: `Original ${id}`, projectId: workspace.defaultProjectId!, ...fields }, workspace, { messagesLoaded: true })
  // Seed a real persisted session without starting a provider or changing user data.
  ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(id, managed)
  await saveSession({
    id, name: `Original ${id}`, workspaceRootPath: workspace.rootPath, projectId: managed.projectId,
    createdAt: 1, lastUsedAt: 1, messages: [], ...fields,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  })
  return managed
}

function yaml(id: string, title: string, project?: string) {
  return `id: ${id}\ntitle: ${title}\ngoal: Preserve Task ownership\n${project ? `project: ${project}\n` : ''}nodes:\n  - id: run\n    prompt: Verify the binding\n`
}

for (const binding of ['attachToExistingSession', 'orchestratorSessionId'] as const) {
  test(`a rejected cross-Project ${binding} leaves the original Task bytes and session unchanged`, async () => {
    const target = await session(`cross-project-${binding}`, workspaceA, { taskDraft: binding === 'orchestratorSessionId' })
    const slug = `preserve-${binding.toLowerCase()}`
    saveTaskSpec(workspaceA.rootPath, {
      id: slug, runner: 'conduct', title: 'Original title', goal: 'Original goal', project: target.projectId,
      nodes: [{ id: 'run', kind: 'session', prompt: 'Original body' }],
    })
    const original = readFileSync(taskYamlPath(workspaceA.rootPath, slug), 'utf8')
    await expect(client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
      yaml: yaml(slug, 'Rejected replacement', secondProject.id), [binding]: target.id,
    })).rejects.toThrow('CROSS_PROJECT_SESSION')
    expect(readFileSync(taskYamlPath(workspaceA.rootPath, slug), 'utf8')).toBe(original)
    expect(loadSession(workspaceA.rootPath, target.id)?.taskSlug).toBeUndefined()
  })
}

for (const binding of ['attachToExistingSession', 'orchestratorSessionId'] as const) {
  test(`a Task cannot ${binding} from another Workspace when Project is omitted`, async () => {
    const target = await session(`foreign-${binding}`, workspaceB, { taskDraft: binding === 'orchestratorSessionId' })
    const slug = `foreign-${binding.toLowerCase()}`
    await expect(client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
      yaml: yaml(slug, 'Foreign Task'), [binding]: target.id,
    })).rejects.toThrow('CROSS_WORKSPACE_SESSION')
    expect(loadTaskSpec(workspaceA.rootPath, slug)).toBeNull()
    expect(loadSession(workspaceB.rootPath, target.id)?.taskSlug).toBeUndefined()
    expect(loadSession(workspaceB.rootPath, target.id)?.name).toBe(`Original ${target.id}`)
  })

  test(`an unfiltered Task inherits the ${binding} target's Project without creating another Session`, async () => {
    const target = await session(`unfiltered-${binding}`, workspaceA, {
      projectId: secondProject.id, taskDraft: binding === 'orchestratorSessionId',
    })
    const slug = `unfiltered-${binding.toLowerCase()}`
    const beforeIds = manager.getSessions().map(session => session.id)
    const result = await client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
      yaml: yaml(slug, 'Unfiltered Task'), [binding]: target.id,
    })
    await sessionPersistenceQueue.flushAll()
    expect(result.orchestratorSessionId).toBe(target.id)
    expect(manager.getSessions().map(session => session.id)).toEqual(beforeIds)
    expect(loadTaskSpec(workspaceA.rootPath, slug)?.spec?.project).toBe(secondProject.id)
    expect(loadSession(workspaceA.rootPath, target.id)).toMatchObject({ projectId: secondProject.id, taskSlug: slug, taskDraft: false })
  })
}

test('a missing or differently bound attach target cannot write a Task spec', async () => {
  const occupied = await session('occupied', workspaceA, { taskSlug: 'original-task' })
  for (const targetId of ['missing-target', occupied.id]) {
    const slug = `rejected-${targetId}`
    await expect(client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
      yaml: yaml(slug, 'Rejected binding'), attachToExistingSession: targetId,
    })).rejects.toThrow('session is missing or already bound')
    expect(loadTaskSpec(workspaceA.rootPath, slug)).toBeNull()
  }
  expect(loadSession(workspaceA.rootPath, occupied.id)?.taskSlug).toBe('original-task')
})

test('a Workspace-scoped client cannot create a Task in another Workspace', async () => {
  const target = await session('foreign-request', workspaceB)
  await expect(client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceB.id, {
    yaml: yaml('foreign-request', 'Foreign request'), attachToExistingSession: target.id,
  })).rejects.toThrow('CROSS_WORKSPACE_TASK')
  expect(loadTaskSpec(workspaceB.rootPath, 'foreign-request')).toBeNull()
  expect(loadSession(workspaceB.rootPath, target.id)?.taskSlug).toBeUndefined()
})

test('reusing a Task slug without an attach target cannot replace its existing Project', async () => {
  const slug = 'immutable-project'
  saveTaskSpec(workspaceA.rootPath, {
    id: slug, runner: 'conduct', title: 'Original task', goal: 'Keep the original Project', project: workspaceA.defaultProjectId,
    nodes: [{ id: 'run', kind: 'session', prompt: 'Original body' }],
  })
  const original = readFileSync(taskYamlPath(workspaceA.rootPath, slug), 'utf8')
  const beforeIds = manager.getSessions().map(session => session.id)
  await expect(client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
    yaml: yaml(slug, 'Cross-Project replacement', secondProject.id),
  })).rejects.toThrow('CROSS_PROJECT_TASK')
  expect(readFileSync(taskYamlPath(workspaceA.rootPath, slug), 'utf8')).toBe(original)
  expect(manager.getSessions().map(session => session.id)).toEqual(beforeIds)
})

test('fresh unfiltered creation and a missing draft still create one correctly scoped Session', async () => {
  for (const orchestratorSessionId of [undefined, 'deleted-generated-draft']) {
    const slug = orchestratorSessionId ? 'missing-draft-fallback' : 'fresh-unfiltered'
    const beforeIds = manager.getSessions().map(session => session.id)
    const result = await client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
      yaml: yaml(slug, 'Valid Task'), orchestratorSessionId,
    })
    await sessionPersistenceQueue.flushAll()
    expect(manager.getSessions().filter(session => !beforeIds.includes(session.id)).map(session => session.id))
      .toEqual([result.orchestratorSessionId])
    expect(loadSession(workspaceA.rootPath, result.orchestratorSessionId))
      .toMatchObject({ projectId: workspaceA.defaultProjectId, taskSlug: slug })
    expect(loadTaskSpec(workspaceA.rootPath, slug)?.spec?.title).toBe('Valid Task')
  }
})

test('an invalid fresh Project leaves no Task file or orphan Session', async () => {
  const beforeIds = manager.getSessions().map(session => session.id)
  await expect(client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
    yaml: yaml('invalid-fresh-project', 'Rejected Task', workspaceB.defaultProjectId),
  })).rejects.toThrow('not found in workspace')
  expect(loadTaskSpec(workspaceA.rootPath, 'invalid-fresh-project')).toBeNull()
  expect(manager.getSessions().map(session => session.id)).toEqual(beforeIds)
})

test('a Session persistence failure restores the exact prior Task bytes and binding metadata', async () => {
  const target = await session('persistence-failure')
  const slug = 'preserve-on-failure'
  saveTaskSpec(workspaceA.rootPath, {
    id: slug, runner: 'conduct', title: 'Original title', goal: 'Original goal', project: target.projectId,
    nodes: [{ id: 'run', kind: 'session', prompt: 'Original body' }],
  })
  const path = taskYamlPath(workspaceA.rootPath, slug)
  // Keep formatting/comments, not just an equivalent parsed spec, after rollback.
  const original = `# Original formatting survives\n${readFileSync(path, 'utf8')}`
  writeFileSync(path, original)
  chmodSync(join(workspaceA.rootPath, 'sessions', target.id), 0o500)
  try {
    await expect(client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
      yaml: yaml(slug, 'Rejected on disk failure'), attachToExistingSession: target.id,
    })).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(await manager.getSession(target.id)).toMatchObject({ name: `Original ${target.id}` })
    expect((await manager.getSession(target.id))?.taskSlug).toBeUndefined()
    expect(loadSession(workspaceA.rootPath, target.id)?.taskSlug).toBeUndefined()
  } finally {
    chmodSync(join(workspaceA.rootPath, 'sessions', target.id), 0o700)
    await sessionPersistenceQueue.flushAll()
  }
})

test('a failed concurrent save cannot remove a later successful save with identical Task bytes', async () => {
  const failedTarget = await session('concurrent-failure')
  const validTarget = await session('concurrent-success')
  const slug = 'concurrent-task'
  const spec = yaml(slug, 'The successful Task', failedTarget.projectId)
  const originalWrite = fsPromises.writeFile
  let release!: () => void
  let enter!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  let injected = false
  const write = spyOn(fsPromises, 'writeFile').mockImplementation(async (path, data, options) => {
    if (!injected && String(path) === join(workspaceA.rootPath, 'sessions', failedTarget.id, 'session.jsonl.tmp')) {
      injected = true
      enter()
      await blocked
      throw new Error('Controlled Task persistence failure')
    }
    return originalWrite(path, data, options)
  })
  const first = client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
    yaml: spec, attachToExistingSession: failedTarget.id,
  }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
  let second: ReturnType<typeof client.invoke> | undefined
  try {
    await Promise.race([entered, Bun.sleep(2_000).then(() => { throw new Error('Task persistence never started') })])
    second = client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
      yaml: spec, attachToExistingSession: validTarget.id,
    })
    await Bun.sleep(20)
    release()
    expect((await first).ok).toBe(false)
    expect(await second).toMatchObject({ orchestratorSessionId: validTarget.id })
    expect(loadTaskSpec(workspaceA.rootPath, slug)?.spec?.title).toBe('The successful Task')
    expect(loadSession(workspaceA.rootPath, failedTarget.id)?.taskSlug).toBeUndefined()
    expect(loadSession(workspaceA.rootPath, validTarget.id)?.taskSlug).toBe(slug)
  } finally {
    release()
    await first
    await second?.catch(() => {})
    write.mockRestore()
    await sessionPersistenceQueue.flushAll()
  }
})

test('an SDK settings failure after commit keeps the successful Task and defers runtime refresh', async () => {
  const target = await session('runtime-update-failure')
  const slug = 'durable-before-runtime'
  let sawCommittedBinding = false
  let disposed = false
  target.isProcessing = true
  target.agent = {
    setModel() {
      sawCommittedBinding = loadSession(workspaceA.rootPath, target.id)?.taskSlug === slug
      throw new Error('Controlled SDK configuration failure')
    },
    isProcessing: () => true,
    dispose() { disposed = true },
  } as never
  try {
    const result = await client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
      yaml: `${yaml(slug, 'Saved Task')}defaults:\n  model: test-task-model\n`,
      attachToExistingSession: target.id,
    })
    await sessionPersistenceQueue.flushAll()
    expect(result.orchestratorSessionId).toBe(target.id)
    expect(sawCommittedBinding).toBe(true)
    expect(disposed).toBe(false)
    expect(loadTaskSpec(workspaceA.rootPath, slug)?.spec?.defaults?.model).toBe('test-task-model')
    expect(loadSession(workspaceA.rootPath, target.id)).toMatchObject({ taskSlug: slug, model: 'test-task-model' })
  } finally {
    target.isProcessing = false
    target.agent = null
  }
})

test('binding a cold Session respects the connection lock restored from disk', async () => {
  const target = await session('cold-locked-connection')
  const stored = loadSession(workspaceA.rootPath, target.id)!
  await saveSession({ ...stored, llmConnection: 'original-connection', connectionLocked: true })
  target.messagesLoaded = false
  target.llmConnection = undefined
  target.connectionLocked = false
  const result = await client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
    yaml: `${yaml('cold-locked-task', 'Cold Session Task')}defaults:\n  llmConnection: replacement-connection\n`,
    attachToExistingSession: target.id,
  })
  await sessionPersistenceQueue.flushAll()
  expect(result.orchestratorSessionId).toBe(target.id)
  expect(loadSession(workspaceA.rootPath, target.id)).toMatchObject({
    taskSlug: 'cold-locked-task', connectionLocked: true, llmConnection: 'original-connection',
  })
})

test('a rejected Task save cannot roll back an external edit made immediately after its atomic write', async () => {
  const target = await session('external-task-edit')
  const slug = 'preserve-external-edit'
  saveTaskSpec(workspaceA.rootPath, {
    id: slug, runner: 'conduct', title: 'Original title', goal: 'Original goal', project: target.projectId,
    nodes: [{ id: 'run', kind: 'session', prompt: 'Original body' }],
  })
  const path = taskYamlPath(workspaceA.rootPath, slug)
  const external = yaml(slug, 'New external edit', target.projectId)
  const originalRename = fs.renameSync
  let edited = false
  const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    originalRename(from, to)
    if (!edited && String(to) === path) {
      edited = true
      writeFileSync(path, external)
    }
  })
  try {
    await expect(client.invoke(RPC_CHANNELS.tasks.CREATE, workspaceA.id, {
      yaml: `${yaml(slug, 'Will be rejected', target.projectId)}cwd: ${join(profile, 'missing-directory')}\n`,
      attachToExistingSession: target.id,
    })).rejects.toThrow('Invalid Task working directory')
    expect(edited).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(external)
    expect(loadSession(workspaceA.rootPath, target.id)?.taskSlug).toBeUndefined()
  } finally {
    rename.mockRestore()
  }
})
