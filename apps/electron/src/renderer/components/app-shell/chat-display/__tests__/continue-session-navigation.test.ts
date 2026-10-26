import { describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'

// Exercise the actual callback at its async RPC boundary, without mounting unrelated chat tooling.
const source = readFileSync(new URL('../../ChatDisplay.tsx', import.meta.url), 'utf8')
const start = source.indexOf('  const handleContinueWithCodingMode = useCallback(')
const end = source.indexOf("\n  // A background task's full output", start)
if (start < 0 || end < 0) throw new Error('Continue-session callback boundary changed')
const compiled = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  const { session, useCallback, continuationRequestRef, continuationScopeRef, window, toast, t, navigate, routes } = deps;
  ${source.slice(start, end)}
  return handleContinueWithCodingMode;
`)
const createHandler = new Function('deps', compiled)

function fixture() {
  let resolve!: (result: { sessionId: string }) => void
  let reject!: (error: Error) => void
  const pending = new Promise<{ sessionId: string }>((yes, no) => { resolve = yes; reject = no })
  const sessionCommand = mock(() => pending)
  const navigate = mock(async () => {})
  const toast = { loading: mock(() => 'toast-1'), dismiss: mock(() => {}), error: mock(() => {}) }
  const continuationRequestRef: { current: symbol | null } = { current: null }
  const continuationScopeRef = { current: {
    sessionId: 'source-chat', workspaceId: 'workspace-a', projectId: 'project-a', isFocusedPanel: true,
  } }
  const run = createHandler({
    session: { id: 'source-chat', workspaceId: 'workspace-a', projectId: 'project-a' },
    useCallback: (callback: unknown) => callback,
    continuationRequestRef, continuationScopeRef,
    window: { electronAPI: { sessionCommand } }, toast, t: (key: string) => key, navigate,
    routes: { view: { allSessions: (id: string) => `allSessions/session/${id}` } },
  }) as (codingMode: boolean) => Promise<void>
  return { run, resolve, reject, sessionCommand, navigate, toast, continuationRequestRef, continuationScopeRef }
}

describe('Coding continuation navigation ownership', () => {
  it('opens the continued conversation when the originating panel is still current', async () => {
    const f = fixture()
    const run = f.run(true)
    f.resolve({ sessionId: 'continued-chat' })
    await run
    expect(f.sessionCommand).toHaveBeenCalledWith('source-chat', { type: 'continueInNewSession', codingMode: true })
    expect(f.navigate).toHaveBeenCalledWith('allSessions/session/continued-chat')
  })

  it.each(['session', 'workspace', 'project', 'focus'] as const)(
    'does not steal navigation after the originating %s changes', async change => {
      const f = fixture()
      const run = f.run(false)
      if (change === 'session') f.continuationScopeRef.current.sessionId = 'different-chat'
      if (change === 'workspace') f.continuationScopeRef.current.workspaceId = 'workspace-b'
      if (change === 'project') f.continuationScopeRef.current.projectId = 'project-b'
      if (change === 'focus') f.continuationScopeRef.current.isFocusedPanel = false
      f.resolve({ sessionId: 'continued-chat' })
      await run
      expect(f.navigate).not.toHaveBeenCalled()
      expect(f.toast.dismiss).toHaveBeenCalledWith('toast-1')
    },
  )

  it('does not navigate after the originating ChatDisplay unmounts', async () => {
    const f = fixture()
    const run = f.run(true)
    f.continuationRequestRef.current = null
    f.resolve({ sessionId: 'continued-chat' })
    await run
    expect(f.navigate).not.toHaveBeenCalled()
  })

  it('admits only one continuation while the current request is pending', async () => {
    const f = fixture()
    const first = f.run(true)
    const second = f.run(true)
    expect(f.sessionCommand).toHaveBeenCalledTimes(1)
    f.resolve({ sessionId: 'continued-chat' })
    await Promise.all([first, second])
    expect(f.navigate).toHaveBeenCalledTimes(1)
    expect(f.continuationRequestRef.current).toBeNull()
  })

  it('releases the request guard after a failed RPC', async () => {
    const f = fixture()
    const run = f.run(true)
    f.reject(new Error('connection interrupted'))
    await run
    expect(f.toast.error).toHaveBeenCalled()
    expect(f.continuationRequestRef.current).toBeNull()
    expect(f.navigate).not.toHaveBeenCalled()
  })
})
