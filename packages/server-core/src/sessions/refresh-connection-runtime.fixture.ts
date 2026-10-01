import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type { SessionManager } from './SessionManager.ts'

// Connection resolution reads CONFIG_DIR at import time. Keep both fixtures
// and module cache separate from the grouped source suite and user profiles.
const configDir = mkdtempSync(join(tmpdir(), 'runtime-refresh-profile-'))
process.env.CRAFT_CONFIG_DIR = configDir
afterAll(() => rmSync(configDir, { recursive: true, force: true }))
copyFileSync(
  resolve(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'),
  join(configDir, 'config-defaults.json'),
)
writeFileSync(join(configDir, 'config.json'), JSON.stringify({
  workspaces: [],
  activeWorkspaceId: null,
  activeSessionId: null,
  defaultLlmConnection: 'slug-A',
  llmConnections: ['slug-A', 'slug-B'].map(slug => ({
    slug,
    name: slug,
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    baseUrl: 'https://runtime-refresh.test',
    piAuthProvider: 'openai',
    customEndpoint: { api: 'openai-completions' },
    defaultModel: 'test-vision',
    models: [
      { id: 'test-vision', name: 'Vision', contextWindow: 128_000, supportsImages: true },
      { id: 'test-text', name: 'Text', contextWindow: 64_000, supportsImages: false },
    ],
    createdAt: 1,
  })),
}))

const { CONFIG_DIR } = await import('@craft-agent/shared/config/paths')
if (CONFIG_DIR !== configDir) throw new Error('Runtime-refresh fixture requires an isolated config module cache')
const { resolveBackendContext } = await import('@craft-agent/shared/agent/backend')
const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
const { SessionManager: SessionManagerRuntime, createManagedSession } = await import('./SessionManager.ts')
const { buildRestartRequiredSignature } = await import('./runtime-config.ts')

// Regression coverage for the stale-Pi-subprocess bug where toggling
// `supportsImages` on a custom-endpoint model wrote to disk but never reached
// the live agent.
//
// Two failure modes are guarded here:
//   1. `getOrCreateAgent` deferred refresh whenever `managed.isProcessing` was
//      true, but `sendMessage` flips that flag *before* calling
//      `getOrCreateAgent` — which made the refresh branch dead code on the
//      send path. The send-path refresh allows a host-owned startup while
//      external SAVE defers until that host turn is idle.
//   2. Saving a connection had no notification path to active sessions, so
//      capability changes only propagated lazily after the next send.
//      `refreshConnectionRuntime` now pushes updates from the SAVE handler.

interface AgentStub {
  isProcessing: () => boolean
  updateRuntimeConfig: jest.Mock
  dispose: () => void
  disposeForRestart?: () => Promise<void>
}

function createAgentStub(opts: {
  isProcessing?: boolean
  refreshSucceeds?: boolean
  refreshDelayMs?: number
} = {}): AgentStub {
  const delay = opts.refreshDelayMs ?? 0
  const result = opts.refreshSucceeds ?? true
  return {
    isProcessing: () => opts.isProcessing ?? false,
    updateRuntimeConfig: jest.fn().mockImplementation(async () => {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      return result
    }),
    dispose: () => { /* no-op for tests */ },
  }
}

function injectSession(
  sm: SessionManager,
  id: string,
  workspaceRoot: string,
  llmConnection: string,
  agent: AgentStub | null,
  opts: { backendRuntimeSignature?: string; backendRestartSignature?: string; isProcessing?: boolean } = {},
) {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id, name: id, llmConnection, projectId: 'project-general' },
    workspace as never,
    { messagesLoaded: true },
  ) as unknown as { agent: AgentStub | null; backendRuntimeSignature?: string; backendRestartSignature?: string; isProcessing: boolean; llmConnection?: string }
  managed.agent = agent
  // Force a stale runtime signature so the helper's comparison always reaches
  // the refresh branch — the signature it computes from real disk config will
  // never equal this sentinel.
  managed.backendRuntimeSignature = opts.backendRuntimeSignature ?? '__stale_runtime_signature_for_test__'
  // Pre-compute the restart signature against the same resolution the helper
  // will use, so by default tests route through the in-place refresh path.
  // Tests that want the restart-required path pass an explicit sentinel.
  if (opts.backendRestartSignature !== undefined) {
    managed.backendRestartSignature = opts.backendRestartSignature
  } else {
    const workspaceConfig = loadWorkspaceConfig(workspaceRoot)
    const ctx = resolveBackendContext({
      sessionConnectionSlug: llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
    })
    managed.backendRestartSignature = buildRestartRequiredSignature({
      connection: ctx.connection,
      provider: ctx.provider,
      authType: ctx.authType,
      resolvedModel: ctx.resolvedModel,
    })
  }
  managed.isProcessing = opts.isProcessing ?? false
  managed.llmConnection = llmConnection
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  return managed
}

describe('refreshConnectionRuntime', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-refresh-'))
    sm = new SessionManagerRuntime()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('pushes updateRuntimeConfig to sessions on the matching connection slug', async () => {
    const matchingAgent = createAgentStub()
    const otherAgent = createAgentStub()
    injectSession(sm, 'matching', tmpRoot, 'slug-A', matchingAgent)
    injectSession(sm, 'other', tmpRoot, 'slug-B', otherAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(matchingAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(otherAgent.updateRuntimeConfig).not.toHaveBeenCalled()
  })

  it('skips sessions whose agent is mid-stream (defers, does not yank)', async () => {
    const busyAgent = createAgentStub({ isProcessing: true })
    injectSession(sm, 'busy', tmpRoot, 'slug-A', busyAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(busyAgent.updateRuntimeConfig).not.toHaveBeenCalled()
  })

  it('defers external SAVE while the host owns a turn even if the backend is idle', async () => {
    const idleAgent = createAgentStub({ isProcessing: false })
    const managed = injectSession(sm, 'host-owned', tmpRoot, 'slug-A', idleAgent, { isProcessing: true })
    const originalSignature = managed.backendRuntimeSignature

    await sm.refreshConnectionRuntime('slug-A')

    expect(idleAgent.updateRuntimeConfig).not.toHaveBeenCalled()
    expect(managed.agent).toBe(idleAgent)
    expect(managed.backendRuntimeSignature).toBe(originalSignature)
  })

  it('refreshes through the actual send-path getter after the host claims processing (Fix 1 regression)', async () => {
    // sendMessage claims host ownership before selecting its backend. That
    // getter must apply drift before chat, despite managed.isProcessing=true.
    const idleAgent = createAgentStub({ isProcessing: false })
    const managed = injectSession(sm, 'sending', tmpRoot, 'slug-A', idleAgent, { isProcessing: true })
    const selected = await (sm as unknown as {
      getOrCreateAgent(session: ReturnType<typeof injectSession>): Promise<AgentStub>
    }).getOrCreateAgent(managed)

    expect(selected).toBe(idleAgent)
    expect(idleAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(idleAgent.updateRuntimeConfig.mock.calls[0]?.[0]).toMatchObject({
      model: 'test-vision',
      providerType: 'pi_compat',
      runtime: {
        baseUrl: 'https://runtime-refresh.test',
        piAuthProvider: 'openai',
        customEndpoint: { api: 'openai-completions' },
        customModels: [
          { id: 'test-vision', contextWindow: 128_000, supportsImages: true },
          { id: 'test-text', contextWindow: 64_000, supportsImages: false },
        ],
      },
    })
  })

  it('is a no-op when there is no agent yet (cold session)', async () => {
    injectSession(sm, 'cold', tmpRoot, 'slug-A', null)

    await expect(sm.refreshConnectionRuntime('slug-A')).resolves.toBeUndefined()
  })

  it('disposes the runtime when in-place refresh fails so the next send rebuilds it', async () => {
    const failingAgent = createAgentStub({ refreshSucceeds: false })
    const managed = injectSession(sm, 'failing', tmpRoot, 'slug-A', failingAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(failingAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })

  it('skips in-place refresh and forces recreation when a restart-required field changed', async () => {
    // `update_runtime_config` cannot propagate `piAuthProvider`, slug,
    // providerType, or authType cleanly. When any of those drift, the helper
    // must dispose the runtime instead of marking it refreshed (which would
    // record the new signature against a stale subprocess).
    const agent = createAgentStub()
    const managed = injectSession(sm, 'auth-changed', tmpRoot, 'slug-A', agent, {
      backendRestartSignature: '__stale_restart_signature__',
    })

    await sm.refreshConnectionRuntime('slug-A')

    expect(agent.updateRuntimeConfig).not.toHaveBeenCalled()
    expect(managed.agent).toBeNull()
  })

  it('serializes concurrent refresh requests via the per-session mutex', async () => {
    // SAVE handler is fire-and-forget (Finding 1) so its refresh can be
    // mid-flight when sendMessage triggers another via getOrCreateAgent.
    // Without a mutex, both fire updateRuntimeConfig and the subprocess can
    // race a chat against the still-pending update.
    //
    // The first call holds the lock long enough for the second to see it,
    // wait, and re-evaluate from the post-refresh state — at which point the
    // signature matches and the second call is a no-op.
    const agent = createAgentStub({ refreshDelayMs: 50 })
    injectSession(sm, 'concurrent', tmpRoot, 'slug-A', agent)

    const [first, second] = await Promise.all([
      sm.refreshConnectionRuntime('slug-A'),
      sm.refreshConnectionRuntime('slug-A'),
    ])

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    // Only one updateRuntimeConfig — the second call awaited the first via
    // the mutex, then saw matching signatures and bailed.
    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
  })

  it('records customModels with the per-model supportsImages flag in the IPC payload', async () => {
    // End-to-end shape check: when the session's connection resolves to a
    // pi_compat connection with explicit per-model `supportsImages`, the
    // helper must forward that field on `customModels` so the Pi subprocess
    // can re-register the model with `input: ['text', 'image']`.
    const agent = createAgentStub()
    injectSession(sm, 'shape-check', tmpRoot, 'slug-A', agent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    const payload = agent.updateRuntimeConfig.mock.calls[0]?.[0]
    expect(payload).toBeDefined()
    expect(payload).toMatchObject({
      model: 'test-vision',
      providerType: 'pi_compat',
      runtime: {
        baseUrl: 'https://runtime-refresh.test',
        piAuthProvider: 'openai',
        customEndpoint: { api: 'openai-completions' },
      },
    })
    // The runtime envelope mirrors what `pi-agent.ts:requestRuntimeConfigUpdate`
    // unpacks — `customModels` shape preserves `supportsImages` when set.
    expect(payload.runtime.customModels).toEqual([
      { id: 'test-vision', contextWindow: 128_000, supportsImages: true },
      { id: 'test-text', contextWindow: 64_000, supportsImages: false },
    ])
    for (const model of payload.runtime.customModels) {
      expect(typeof model.id).toBe('string')
      expect(typeof model.supportsImages).toBe('boolean')
    }
  })
})
