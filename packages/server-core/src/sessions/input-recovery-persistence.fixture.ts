import { afterAll, expect, spyOn, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = new URL('../../../..', import.meta.url).pathname
const profile = mkdtempSync(join(tmpdir(), 'stair-input-recovery-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(join(repo, 'apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
const { SessionManager, createManagedSession } = await import('./SessionManager')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSession, saveSessionStrict, loadSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { saveConfig, restoreSessionDraftAtomic, getSessionDraft } = await import('@craft-agent/shared/config')
const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
const { registerSessionsHandlers } = await import('../handlers/rpc/sessions')
const { WsRpcServer } = await import('../transport/server')
const { WsRpcClient } = await import('../transport/client')
const workspace = { ...createWorkspaceAtPath(join(profile, 'workspace'), 'Recovery'), rootPath: join(profile, 'workspace') }
saveConfig({ workspaces: [workspace], activeWorkspaceId: workspace.id } as never)

afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  rmSync(profile, { recursive: true, force: true })
})

for (const ending of ['complete', 'abort', 'iterator-end'] as const) {
  test(`I05/I08: ${ending} with failed recovery persistence retains the outbox and finishes cleanup`, async () => {
    const manager = new SessionManager()
    const id = `recovery-${ending}`
    const managed = createManagedSession({ id, name: 'Recovery test', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
    const internals = manager as unknown as {
      sessions: Map<string, typeof managed>
      getOrCreateAgent: () => Promise<typeof agent>
      decisionFeatureActive: () => boolean
    }
    internals.sessions.set(id, managed)
    internals.decisionFeatureActive = () => false
    await saveSession({ id, name: 'Recovery test', workspaceRootPath: workspace.rootPath, projectId: managed.projectId,
      createdAt: 1, lastUsedAt: 1, messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
    // The external producer ends before confirming input. Production SessionManager owns
    // acceptance, cleanup, persistence and the renderer/conductor notifications below.
    const agent = {
      getModel: () => 'controlled', setAllSources() {}, getSessionId() {}, isCompactionInFlight: () => false,
      chat: async function* () {
        if (ending === 'complete') yield { type: 'complete' as const }
        if (ending === 'abort') throw new DOMException('Request was aborted.', 'AbortError')
      },
    }
    internals.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
    const events: Array<Record<string, any>> = []
    manager.setEventSink((_channel, _target, event) => { events.push(event as Record<string, any>) })
    const completions: Array<{ reason: string }> = []
    const off = manager.onSessionComplete(event => { completions.push(event) })
    const actualWrite = fs.writeFile
    let failedWrites = 0
    let failRecovery = true
    const write = spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (failRecovery && String(path) === join(workspace.rootPath, 'sessions', id, 'session.jsonl.tmp')
        && String(data).includes('"queuedRestoreId":"input-')) {
        failedWrites++
        throw Object.assign(new Error('Controlled recovery ENOSPC'), { code: 'ENOSPC' })
      }
      return actualWrite(path, data, options)
    })
    const acks: string[] = []
    try {
      await manager.sendMessage(id, 'RECOVER-WITHOUT-LOSS', undefined, undefined,
        { optimisticMessageId: `client-${id}` }, undefined, undefined, messageId => { acks.push(messageId) })
      // sendMessage must own its async cleanup, not leave a rejected promise behind.
      expect(failedWrites).toBeGreaterThan(0)
      expect(acks).toHaveLength(1)
      expect(managed.isProcessing).toBe(false)
      expect(events.filter(event => event.type === 'error' && event.error.includes('recovery'))).toHaveLength(1)
      expect(events.filter(event => event.type === 'interrupted')).toHaveLength(0)
      expect(events.filter(event => event.type === 'complete')).toHaveLength(1)
      expect(completions).toEqual([expect.objectContaining({ reason: 'error' })])
      const user = managed.messages.find(message => message.role === 'user')!
      expect(user).toMatchObject({ content: 'RECOVER-WITHOUT-LOSS', isQueued: true, queuedRestoreId: `input-${acks[0]}` })
      expect(managed.messageQueue).toHaveLength(0)
      // Failure is truthful: the last successful image still holds the original input intent.
      expect(loadSession(workspace.rootPath, id)?.messages.find(message => message.type === 'user'))
        .toMatchObject({ id: acks[0], content: 'RECOVER-WITHOUT-LOSS', pendingDelivery: true })
      failRecovery = false
      await manager.flushSession(id)
      expect(loadSession(workspace.rootPath, id)?.messages.find(message => message.type === 'user'))
        .toMatchObject({ id: acks[0], content: 'RECOVER-WITHOUT-LOSS', queuedRestoreId: user.queuedRestoreId })
    } finally {
      failRecovery = false
      write.mockRestore()
      off()
      await sessionPersistenceQueue.flushAll()
    }
  })
}

test('I02/I09: turn completion cannot recover an input still awaiting its queue admission write', async () => {
  const manager = new SessionManager()
  const id = 'completion-during-queue-admission'
  const managed = createManagedSession({ id, name: 'Queue admission', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
  const internals = manager as unknown as {
    sessions: Map<string, typeof managed>
    getOrCreateAgent: () => Promise<typeof agent>
    decisionFeatureActive: () => boolean
  }
  internals.sessions.set(id, managed)
  internals.decisionFeatureActive = () => false
  await saveSession({ id, name: 'Queue admission', workspaceRootPath: workspace.rootPath, projectId: managed.projectId,
    createdAt: 1, lastUsedAt: 1, messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
  let finishFirst!: () => void
  let firstEntered!: () => void
  const firstGate = new Promise<void>(resolve => { finishFirst = resolve })
  const entered = new Promise<void>(resolve => { firstEntered = resolve })
  const inputs: string[] = []
  const agent = {
    getModel: () => 'controlled', setAllSources() {}, getSessionId() {}, isCompactionInFlight: () => false,
    chat: async function* (message: string) {
      inputs.push(message)
      yield { type: 'input_accepted' as const }
      if (message === 'FIRST') { firstEntered(); await firstGate }
      yield { type: 'complete' as const }
    },
  }
  internals.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  const events: Array<Record<string, any>> = []
  manager.setEventSink((_channel, _target, event) => { events.push(event as Record<string, any>) })
  const first = manager.sendMessage(id, 'FIRST')
  await entered
  let writeEntered!: () => void
  let releaseWrite!: () => void
  const writeStarted = new Promise<void>(resolve => { writeEntered = resolve })
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
  const actualWrite = fs.writeFile
  let gated = false
  const write = spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
    if (!gated && String(path) === join(workspace.rootPath, 'sessions', id, 'session.jsonl.tmp')
      && String(data).includes('"content":"SECOND"')) {
      gated = true
      writeEntered()
      await writeGate
    }
    return actualWrite(path, data, options)
  })
  const second = manager.sendMessage(id, 'SECOND')
  try {
    await writeStarted
    finishFirst()
    await first
    expect(managed.messages.find(message => message.content === 'SECOND')?.queuedRestoreId).toBeUndefined()
    expect(events.filter(event => event.type === 'interrupted')).toHaveLength(0)
    releaseWrite()
    await second
    for (let n = 0; n < 200 && (inputs.length < 2 || managed.isProcessing); n++) await Bun.sleep(5)
    expect(inputs).toEqual(['FIRST', 'SECOND'])
    expect(managed.isProcessing).toBe(false)
    await manager.flushSession(id)
    expect(loadSession(workspace.rootPath, id)?.messages.filter(message => message.type === 'user')
      .map(message => [message.content, message.queuedRestoreId, message.pendingDelivery]))
      .toEqual([['FIRST', undefined, undefined], ['SECOND', undefined, undefined]])
  } finally {
    finishFirst()
    releaseWrite()
    await Promise.allSettled([first, second])
    write.mockRestore()
    await sessionPersistenceQueue.flushAll()
  }
})

for (const failure of ['receipt-write', 'redirect'] as const) {
  test(`I03/I05/I08: ${failure} after midstream admission cannot reject ownership or complete the active turn`, async () => {
    const manager = new SessionManager()
    const id = `midstream-${failure}`
    const managed = createManagedSession({ id, name: 'Midstream input', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
    const internals = manager as unknown as {
      sessions: Map<string, typeof managed>
      decisionFeatureActive: () => boolean
    }
    internals.sessions.set(id, managed)
    internals.decisionFeatureActive = () => false
    await saveSession({ id, name: 'Midstream input', workspaceRootPath: workspace.rootPath, projectId: managed.projectId,
      createdAt: 1, lastUsedAt: 1, messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
    const sdkInputs: Array<{ message: string; messageId: string }> = []
    managed.isProcessing = true
    managed.processingGeneration = 1
    managed.agent = {
      getModel: () => 'controlled', takePendingSteers: () => [], settlePendingSteers: async () => [],
      redirect(message: string, metadata: { messageId: string }) {
        sdkInputs.push({ message, messageId: metadata.messageId })
        if (failure === 'redirect') throw new Error('Controlled redirect failure after durable admission')
        return true
      },
    } as never
    const server = new WsRpcServer({ host: '127.0.0.1', port: 0 })
    registerSessionsHandlers(server, { sessionManager: manager, platform: { logger: console } } as never)
    manager.setEventSink(server.push.bind(server))
    await server.listen()
    const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: workspace.id, autoReconnect: false, requestTimeout: 3_000,
    })
    const events: Array<Record<string, any>> = []
    let receivedError!: () => void
    const errorEvent = new Promise<void>(resolve => { receivedError = resolve })
    client.on(RPC_CHANNELS.sessions.EVENT, event => {
      events.push(event)
      if (event.type === 'error') receivedError()
    })
    client.connect()
    const actualWrite = fs.writeFile
    let writes = 0
    const write = spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (String(path) === join(workspace.rootPath, 'sessions', id, 'session.jsonl.tmp')) {
        writes++
        if (failure === 'receipt-write' && writes === 2) throw new Error('Controlled receipt persistence failure')
      }
      return actualWrite(path, data, options)
    })
    try {
      const ack = await client.invoke(RPC_CHANNELS.sessions.SEND_MESSAGE, id, 'DURABLE-MIDSTREAM', undefined, undefined,
        { optimisticMessageId: `client-${id}` })
      await errorEvent
      // The post-ACK error and any erroneous complete are adjacent RPC pushes.
      await Bun.sleep(10)
      expect(ack).toEqual({ accepted: true, messageId: sdkInputs[0]!.messageId })
      expect(sdkInputs).toHaveLength(1)
      expect(managed.isProcessing).toBe(true)
      expect(events.filter(event => event.type === 'complete')).toHaveLength(0)
      expect(loadSession(workspace.rootPath, id)?.messages.find(message => message.type === 'user'))
        .toMatchObject({ id: ack.messageId, content: 'DURABLE-MIDSTREAM', isQueued: true, pendingDelivery: true })

      // A new host only sees the first durable image. It must restore that uncertain
      // input instead of treating the stale queued flag as permission to replay it.
      sessionPersistenceQueue.cancel(id)
      const cold = new SessionManager()
      const restored = createManagedSession({ id, name: 'Midstream input', projectId: managed.projectId }, workspace)
      const coldInternals = cold as unknown as {
        sessions: Map<string, typeof restored>
        getOrCreateAgent: () => Promise<never>
      }
      coldInternals.sessions.set(id, restored)
      let restartedTurns = 0
      coldInternals.getOrCreateAgent = async () => { restartedTurns++; throw new Error('Cold recovery must not start an Agent') }
      await cold.getSession(id)
      await Bun.sleep(10)
      expect(restartedTurns).toBe(0)
      expect(restored.messageQueue).toHaveLength(0)
      expect(restored.messages.find(message => message.role === 'user'))
        .toMatchObject({ id: ack.messageId, queuedRestoreId: `input-${ack.messageId}`, isQueued: true })
    } finally {
      write.mockRestore()
      managed.isProcessing = false
      await sessionPersistenceQueue.flushAll()
      client.destroy()
      server.close()
    }
  })
}

for (const reader of ['getSession', 'onClientConnected'] as const) {
  test(`I04/I08: ${reader} publishes only the outbox in its durable snapshot`, async () => {
    const id = `outbox-race-${reader}`
    const manager = new SessionManager()
    const managed = createManagedSession({ id, name: 'Concurrent outbox', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
    const internals = manager as unknown as { sessions: Map<string, typeof managed> }
    internals.sessions.set(id, managed)
    managed.messages = [
      { id: 'message-a', role: 'user', content: 'INPUT-A', timestamp: 1, isQueued: true, queuedRestoreId: 'input-message-a' },
      { id: 'message-b', role: 'user', content: 'INPUT-B', timestamp: 2, pendingDelivery: true },
    ]
    managed.isProcessing = true
    managed.processingGeneration = 1
    managed.lastSentMessageIds = ['message-b']
    managed.agent = { forceAbort() {} } as never
    await saveSessionStrict({ id, name: 'Concurrent outbox', projectId: managed.projectId, workspaceRootPath: workspace.rootPath,
      createdAt: 1, lastUsedAt: 1,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      messages: managed.messages.map(({ role, ...message }) => ({ ...message, type: role })) })

    const firstEntered = Promise.withResolvers<void>()
    const firstRelease = Promise.withResolvers<void>()
    const secondEntered = Promise.withResolvers<void>()
    const secondRelease = Promise.withResolvers<void>()
    let attempts = 0
    const actualWrite = fs.writeFile
    const write = spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (String(path) === join(workspace.rootPath, 'sessions', id, 'session.jsonl.tmp')) {
        attempts++
        if (attempts === 1) { firstEntered.resolve(); await firstRelease.promise }
        else if (attempts === 2) {
          secondEntered.resolve()
          await secondRelease.promise
          throw Object.assign(new Error('Controlled new outbox ENOSPC'), { code: 'ENOSPC' })
        }
      }
      return actualWrite(path, data, options)
    })
    const publications: Array<{ restoreId: string; ids: string[]; diskRestoreId?: string }> = []
    // Use the renderer's real durable draft operation, then simulate a client
    // exit before its receipt can ACK the session row.
    const acceptRestore: Parameters<typeof manager.setEventSink>[0] = (_channel, _target, event) => {
      if (event.type !== 'interrupted' || !event.queuedRestoreId) return
      publications.push({ restoreId: event.queuedRestoreId, ids: event.queuedMessageIds ?? [],
        diskRestoreId: loadSession(workspace.rootPath, id)?.messages.find(message => message.id === 'message-b')?.queuedRestoreId })
      restoreSessionDraftAtomic(id, managed.projectId, event.queuedRestoreId, { text: event.queuedMessages?.join('\n\n') ?? '' })
    }
    manager.setEventSink(acceptRestore)
    let reading: Promise<unknown> | undefined
    let stopping: Promise<unknown> | undefined
    try {
      if (reader === 'getSession') reading = manager.getSession(id)
      else manager.onClientConnected('review-client', workspace.id)
      await firstEntered.promise
      stopping = manager.cancelProcessing(id).catch(error => error)
      firstRelease.resolve()
      await secondEntered.promise
      for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve))
      const premature = publications.filter(publication => publication.ids.includes('message-b'))
      secondRelease.resolve()
      expect(await stopping).toBeInstanceOf(Error)
      await reading?.catch(() => {})
      write.mockRestore()
      managed.isProcessing = false

      // Cold recovery reads the last successful disk image. B still carries
      // pendingDelivery, so its new host uses deterministic input-message-b.
      // Publishing Stop's uncommitted random id earlier would duplicate B in
      // the durable draft even though both restores are individually idempotent.
      expect(loadSession(workspace.rootPath, id)?.messages.find(message => message.id === 'message-b'))
        .toMatchObject({ pendingDelivery: true })
      const cold = new SessionManager()
      const restarted = createManagedSession({ id, name: 'Concurrent outbox', projectId: managed.projectId }, workspace, { messagesLoaded: false })
      const coldInternals = cold as unknown as { sessions: Map<string, typeof restarted> }
      coldInternals.sessions.set(id, restarted)
      cold.setEventSink(acceptRestore)
      await cold.getSession(id)
      expect(premature).toHaveLength(0)
      expect(getSessionDraft(id)?.text).toBe('INPUT-A\n\nINPUT-B')
      expect(publications.filter(publication => publication.ids.includes('message-b')))
        .toEqual([{ restoreId: 'input-message-b', ids: ['message-b'], diskRestoreId: 'input-message-b' }])
    } finally {
      firstRelease.resolve(); secondRelease.resolve()
      await Promise.allSettled([reading, stopping].filter(Boolean) as Promise<unknown>[])
      managed.isProcessing = false
      write.mockRestore()
      await sessionPersistenceQueue.flushAll()
    }
  }, 5_000)
}
