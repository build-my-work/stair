import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// WS2 keep-alive: when a background agent finishes while the session is IDLE, the
// completion is delivered between turns (via the persistent-query background sink →
// processEvent). Nothing consumes the result, so the agent "never returned the
// result". processEvent must wake the session with a system-generated follow-up so
// the agent reads the output and presents it — but ONLY when idle, only under
// keep-alive, and at most once per task.

type TaskCompletedEvent = {
  type: 'task_completed'
  taskId: string
  status: 'completed' | 'failed' | 'stopped'
  outputFile?: string
  summary?: string
}

describe('background task completion surfacing (idle keep-alive)', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-bgsurface-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string, opts?: { keepAlive?: boolean; processing?: boolean }) {
    const workspace = { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession(
      { id, name: 'bg surface test', projectId: 'project-general' },
      workspace as never,
      { messagesLoaded: true },
    )
    managed.isProcessing = opts?.processing ?? false
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    // keepBackgroundTasksAlive is a readonly field resolved from env at construction;
    // override it per-test to exercise both flag states deterministically.
    ;(sm as unknown as { keepBackgroundTasksAlive: boolean }).keepBackgroundTasksAlive = opts?.keepAlive ?? true
    return managed
  }

  function registerRunningTask(sessionId: string, taskId: string, intent?: string) {
    const managed = (sm as unknown as {
      sessions: Map<string, { backgroundTaskRegistry: Map<string, unknown> }>
    }).sessions.get(sessionId)!
    managed.backgroundTaskRegistry.set(taskId, {
      taskId,
      startTime: Date.now(),
      status: 'running',
      ...(intent ? { intent } : {}),
    })
  }

  function spyOnSendMessage() {
    const calls: Array<{ msg: string; hidden?: boolean }> = []
    ;(sm as unknown as {
      sendMessage: (id: string, msg: string, a?: unknown, s?: unknown, opts?: { hidden?: boolean }) => Promise<void>
    }).sendMessage = async (_id, msg, _a, _s, opts) => {
      calls.push({ msg, hidden: opts?.hidden })
    }
    return calls
  }

  async function fireTaskCompleted(sessionId: string, event: TaskCompletedEvent) {
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId)!
    await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, event)
  }

  it('surfaces a completed task to an idle keep-alive session with intent + output file', async () => {
    const sessionId = 'idle-complete'
    buildSession(sessionId, { keepAlive: true, processing: false })
    registerRunningTask(sessionId, 'task_1', "Look up today's AI news")
    const calls = spyOnSendMessage()

    await fireTaskCompleted(sessionId, {
      type: 'task_completed',
      taskId: 'task_1',
      status: 'completed',
      outputFile: '/tmp/tasks/task_1.output',
    })

    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('background-task-completed')
    expect(calls[0]!.msg).toContain("Look up today's AI news")
    expect(calls[0]!.msg).toContain('/tmp/tasks/task_1.output')
    expect(calls[0]!.msg).toContain('Present it to the user now')
    // An agent's output file is its whole transcript: never tell the agent to read it.
    expect(calls[0]!.msg).not.toContain('Read that output file')
    // Loop guard: the nudge must tell the agent not to re-spawn a background agent.
    expect(calls[0]!.msg).toContain('Do NOT spawn another background agent')
    // Must be hidden so it never renders as a user-authored transcript bubble.
    expect(calls[0]!.hidden).toBe(true)
  })

  it('does NOT surface while a turn is active (agent sees the notification via the live stream)', async () => {
    const sessionId = 'in-turn'
    buildSession(sessionId, { keepAlive: true, processing: true })
    registerRunningTask(sessionId, 'task_2')
    const calls = spyOnSendMessage()

    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'task_2', status: 'completed' })

    expect(calls).toEqual([])
  })

  it('does NOT surface when keep-alive is OFF', async () => {
    const sessionId = 'keepalive-off'
    buildSession(sessionId, { keepAlive: false, processing: false })
    registerRunningTask(sessionId, 'task_3')
    const calls = spyOnSendMessage()

    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'task_3', status: 'completed' })

    expect(calls).toEqual([])
  })

  it('surfaces at most once even if a duplicate terminal notification arrives', async () => {
    const sessionId = 'dupe'
    buildSession(sessionId, { keepAlive: true, processing: false })
    registerRunningTask(sessionId, 'task_4', 'Investigate flake')
    const calls = spyOnSendMessage()

    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'task_4', status: 'completed' })
    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'task_4', status: 'completed' })

    expect(calls.length).toBe(1)
  })

  it('surfaces a failure with a status-appropriate message', async () => {
    const sessionId = 'failed'
    buildSession(sessionId, { keepAlive: true, processing: false })
    registerRunningTask(sessionId, 'task_5', 'Crunch numbers')
    const calls = spyOnSendMessage()

    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'task_5', status: 'failed' })

    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('background-task-failed')
    expect(calls[0]!.msg).toContain('did not complete successfully')
    expect(calls[0]!.hidden).toBe(true)
  })

  it('never wakes the session for a task it did not see launched (e.g. a subagent\'s own background command)', async () => {
    const sessionId = 'unseen'
    const managed = buildSession(sessionId, { keepAlive: true, processing: false })
    const calls = spyOnSendMessage()

    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'b_subagent', status: 'completed', outputFile: '/tmp/tasks/b_subagent.output' })

    expect(calls).toEqual([])
    const entry = managed.backgroundTaskRegistry.get('b_subagent') as { untracked?: boolean; status: string }
    expect(entry).toMatchObject({ status: 'completed', untracked: true })
  })

  it('tracks a background command from its launch and reports it as a command, not an agent', async () => {
    const sessionId = 'shell'
    const managed = buildSession(sessionId, { keepAlive: true, processing: false })
    const calls = spyOnSendMessage()
    const process = (event: unknown) => (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, event)

    await process({ type: 'shell_backgrounded', toolUseId: 'toolu_1', shellId: 'b_build', intent: 'Run the test suites', command: 'bun test' })
    const started = managed.backgroundTaskRegistry.get('b_build') as { status: string; kind?: string; startTime: number; intent?: string }
    expect(started).toMatchObject({ status: 'running', kind: 'shell', intent: 'Run the test suites' })

    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'b_build', status: 'completed', outputFile: '/tmp/tasks/b_build.output' })
    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toContain('The background command you started ("Run the test suites") has finished.')
    expect(calls[0]!.msg).toContain('/tmp/tasks/b_build.output')
    expect(calls[0]!.msg).not.toContain('background agent')
  })

  it('reports untracked completions without an invented start time', async () => {
    const sessionId = 'list'
    const managed = buildSession(sessionId, { keepAlive: true, processing: true })
    await fireTaskCompleted(sessionId, { type: 'task_completed', taskId: 'b_unseen', status: 'completed' })
    const listed = (sm as unknown as { listBackgroundTasks: (id: string) => Array<{ taskId: string; untracked?: boolean }> }).listBackgroundTasks(managed.id)
    expect(listed.find(t => t.taskId === 'b_unseen')?.untracked).toBe(true)
  })

  it('wakes the session for its own task even when the launch was not seen', async () => {
    const sessionId = 'own-unseen'
    const managed = buildSession(sessionId, { keepAlive: true, processing: false })
    const calls = spyOnSendMessage()

    await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, {
      type: 'task_completed', taskId: 'b_own', toolUseId: 'toolu_own', launchedHere: true, status: 'completed', outputFile: '/tmp/tasks/b_own.output',
    })

    expect(calls.length).toBe(1)
    const entry = managed.backgroundTaskRegistry.get('b_own') as { untracked?: boolean; startUnknown?: boolean }
    expect(entry).toMatchObject({ startUnknown: true })
    expect(entry.untracked).toBeUndefined()
  })
})

