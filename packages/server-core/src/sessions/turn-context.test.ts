import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSession } from '../../../shared/src/sessions/storage.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Transient per-turn guidance (the interruption notice, decision-model suggestions) reaches the
// agent as `ChatOptions.turnContext`, never inside the message: the message is what gets stored
// and what is resent after a source activation.
describe('sendMessage turn context', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-turn-context-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  async function sessionWithAgent(id: string) {
    const workspace = { id: 'ws-test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: 'turn context test', projectId: 'proj-test' }, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    await saveSession({ id, projectId: 'proj-test', workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any)
    const calls: Array<{ message: string; options?: { turnContext?: string } }> = []
    const agent = {
      getModel: () => 'claude-sonnet-4-6',
      setAllSources: () => {},
      getSessionId: () => 'sdk-session',
      chat: async function* (message: string, _attachments?: unknown, options?: { turnContext?: string }) {
        calls.push({ message, options })
        yield { type: 'complete' }
      },
    }
    ;(sm as any).getOrCreateAgent = async () => agent
    // Hermetic: the real pre-turn checks read the developer's decision-layer settings.
    let suggestionHint: string | null = null
    ;(sm as any).startPreTurnDecisions = async () => ({ thinkingOverride: null, suggestionHint })
    sm.setEventSink(() => {})
    return { managed, calls, setSuggestionHint: (hint: string | null) => { suggestionHint = hint } }
  }

  it('sends the interruption notice as turn context, not as part of the message', async () => {
    const { managed, calls } = await sessionWithAgent('interrupted')
    managed.wasInterrupted = true
    await sm.sendMessage(managed.id, 'try again, but shorter')
    expect(calls[0]!.message).toBe('try again, but shorter')
    expect(calls[0]!.options?.turnContext).toContain('interrupted by the user')
    expect(managed.messages.find(m => m.role === 'user')?.content).toBe('try again, but shorter')
    expect(managed.wasInterrupted).toBe(false)

    await sm.sendMessage(managed.id, 'thanks')
    expect(calls[1]!.options).toBeUndefined()
  })

  it('adds a suggestion hint after the interruption notice', async () => {
    const { managed, calls, setSuggestionHint } = await sessionWithAgent('suggested')
    managed.wasInterrupted = true
    setSuggestionHint('<system-reminder>hint</system-reminder>')
    await sm.sendMessage(managed.id, 'file the bug in Linear')
    expect(calls[0]!.message).toBe('file the bug in Linear')
    expect(calls[0]!.options?.turnContext).toMatch(/interrupted by the user[\s\S]*<system-reminder>hint<\/system-reminder>$/)
  })

  it('gives a /compact turn no turn context', async () => {
    const { managed, calls } = await sessionWithAgent('interrupted-compact')
    managed.wasInterrupted = true
    await sm.sendMessage(managed.id, '/compact')
    expect(calls[0]).toEqual({ message: '/compact', options: undefined })
  })
})
