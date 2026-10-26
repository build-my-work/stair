import { afterEach, expect, test } from 'bun:test'
import { SESSION_TOOL_REGISTRY, type SessionToolContext } from '@craft-agent/session-tools-core'
import { PiAgent } from '../pi-agent.ts'
import { ClaudeAgent } from '../claude-agent.ts'
import { AbortReason, type BackendConfig } from '../backend/types.ts'
import { PendingSteers } from '../backend/claude/pending-steers.ts'
import { cleanupSessionScopedTools, getLastPlanFilePath, getSessionScopedTools, registerSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from '../session-scoped-tools.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

for (const backend of ['pi', 'claude'] as const) {
  for (const toolName of ['source_oauth_trigger', 'SubmitPlan'] as const) {
    const states = backend === 'claude'
      ? ['live', 'stopped', 'replaced', 'soft-stopped', 'soft-replaced'] as const
      : ['live', 'stopped', 'replaced'] as const
    for (const state of states) {
      test(`${backend}: ${toolName} delayed completion belongs to its ${state} turn`, async () => {
        const sessionId = `handoff-origin-${backend}-${toolName}-${state}`
        const def = SESSION_TOOL_REGISTRY.get(toolName)!
        const args = toolName === 'SubmitPlan' ? { planPath: '/fixture/plan.md' } : { sourceSlug: 'source' }
        const original = def.handler!
        const refresh = Promise.withResolvers<string | null>()
        const entered = Promise.withResolvers<void>()
        def.handler = async (context, args) => {
          const ctx = Object.create(context) as SessionToolContext
          if (toolName === 'SubmitPlan') {
            ctx.fs = { ...context.fs, exists: () => true, readFile: () => '# Fixture plan' }
            entered.resolve()
            await refresh.promise
            return original(ctx, args)
          }
          ctx.loadSourceConfig = () => ({ slug: 'source', name: 'Source', type: 'mcp',
            isAuthenticated: true, mcp: { authType: 'oauth', transport: 'http', url: 'https://example.test' } }) as any
          ctx.credentialManager = { ...context.credentialManager!, refresh: async () => {
            entered.resolve()
            return refresh.promise
          } }
          return original(ctx, args)
        }
        cleanups.push(() => { def.handler = original; cleanupSessionScopedTools(sessionId); unregisterSessionScopedToolCallbacks(sessionId) })
        const calls: string[] = []
        let execute!: () => Promise<unknown>
        let stop!: () => void
        let nextTurn!: () => Promise<void>
        if (backend === 'pi') {
          const agent = new PiAgent({ provider: 'pi', isHeadless: true,
            workspace: { id: 'origin-ws', name: 'Origin', rootPath: '/tmp/stair-tool-origin' },
            session: { id: sessionId, workspaceRootPath: '/tmp/stair-tool-origin', createdAt: 1, lastUsedAt: 1 },
          } as BackendConfig) as any
          agent.send = () => {}
          agent.emitAutomationEvent = () => {}
          agent._isProcessing = true
          agent.onAuthRequest = agent.onPlanSubmitted = () => calls.push('old')
          execute = () => agent.executeSessionTool(toolName, args)
          stop = () => agent.forceAbort(AbortReason.UserStop)
          nextTurn = async () => {
            agent.turnAbort = new AbortController()
            agent._isProcessing = true
            agent.onAuthRequest = agent.onPlanSubmitted = () => calls.push('new')
          }
        } else {
          const agent = Object.create(ClaudeAgent.prototype) as any
          agent.config = { session: { id: sessionId } }
          agent.pendingSteers = new PendingSteers()
          agent.keepBackgroundTasksAlive = true
          agent.persistentInput = {}
          agent.debug = () => {}
          agent.onAuthRequest = agent.onPlanSubmitted = () => calls.push('old')
          // Supply the constructor's callback registration without starting a provider or config watcher.
          registerSessionScopedToolCallbacks(sessionId, { onAuthRequest: request => agent.onAuthRequest(request),
            onPlanSubmitted: path => agent.onPlanSubmitted(path) })
          const turns: AsyncGenerator[] = []
          nextTurn = async () => {
            // Pause the actual chat lifecycle at its first info event, before any SDK/provider work.
            agent.pinnedPreferencesPrompt = 'intentionally stale preferences'
            agent.preferencesDriftNotified = false
            if (turns.length) agent.onAuthRequest = agent.onPlanSubmitted = () => calls.push('new')
            const turn = agent.chatTurn('fixture')
            turns.push(turn)
            expect((await turn.next()).value.type).toBe('info')
          }
          await nextTurn()
          cleanups.push(async () => { for (const turn of turns) await turn.return(undefined) })
          const server = getSessionScopedTools(sessionId, '/tmp/stair-tool-origin', 'origin-ws') as any
          execute = () => server.instance._registeredTools[toolName].handler(args, {})
          stop = () => {
            if (state.startsWith('soft-')) {
              agent.currentQuery = { interrupt: async () => {} }
              agent.activeTurnChannel = { end() {} }
              expect(agent.stopTurn()).toBe(true)
              clearTimeout(agent.stoppedTurn.fallback)
            } else {
              agent.forceAbort(AbortReason.UserStop)
            }
          }
        }
        const pending = execute().catch(error => ({ isError: true, error }))
        await entered.promise
        if (state !== 'live') stop()
        if (state.endsWith('replaced')) await nextTurn()
        refresh.resolve(null)
        await pending
        expect(calls).toEqual(state === 'live' ? ['old'] : [])
        if (toolName === 'SubmitPlan') expect(getLastPlanFilePath(sessionId)).toBe(state === 'live' ? '/fixture/plan.md' : null)
      })
    }
  }
}
