import { describe, expect, it } from 'bun:test'
import { ClaudeAgent, claudeThinkingKey } from '../claude-agent.ts'
import { createPushableInputStream } from '../backend/claude/persistent-input.ts'
import { AbortReason } from '../core/index.ts'

// Keep-alive: a Stop tears the persistent query down and only ends the turn's channel, so the turn
// learns it was aborted from its state (and takes the interruption path, not the empty-response
// recovery that would clear the SDK session and re-run the message).
describe('ClaudeAgent keep-alive Stop', () => {
  async function agentInPersistentTurn() {
    const agent = Object.create(ClaudeAgent.prototype) as any
    const thinking = { thinking: { type: 'adaptive' as const }, effort: 'high' as const }
    agent.persistentInput = createPushableInputStream()
    agent.fakeQuery = { applyFlagSettings: async () => {}, setMaxThinkingTokens: async () => {} }
    agent.currentQuery = agent.fakeQuery
    agent.persistentThinkingKey = claudeThinkingKey(thinking)
    agent.pendingSteers = { pause: () => {} }
    await agent.beginPersistentTurn({ type: 'user', uuid: 'foreground-input', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null }, {}, thinking)
    return agent
  }

  it('marks the running turn aborted on forceAbort', async () => {
    const agent = await agentInPersistentTurn()
    const turn = agent.activeTurnState
    expect(turn).toEqual({ aborted: false })
    agent.forceAbort(AbortReason.UserStop)
    expect(turn.aborted).toBe(true)
  })

  it('starts every turn unaborted', async () => {
    const agent = await agentInPersistentTurn()
    agent.forceAbort(AbortReason.UserStop)
    // forceAbort drops currentQuery; restore the fake so the next turn reuses the live query
    // (the first-turn branch would call the real SDK query()).
    agent.currentQuery = agent.fakeQuery
    await agent.beginPersistentTurn({ type: 'user', message: { role: 'user', content: 'again' }, parent_tool_use_id: null }, {}, { thinking: { type: 'adaptive' }, effort: 'high' })
    expect(agent.activeTurnState).toEqual({ aborted: false })
  })

  it('ends the stopped turn\'s channel at once', async () => {
    const agent = await agentInPersistentTurn()
    const channel = agent.activeTurnChannel
    agent.forceAbort(AbortReason.UserStop)
    expect(agent.activeTurnChannel).toBeNull()
    expect(channel.isEnded).toBe(true)
  })

  it('does not start a turn when a Stop lands during the live thinking update', async () => {
    const agent = await agentInPersistentTurn()
    let release!: () => void
    agent.fakeQuery.applyFlagSettings = () => new Promise<void>(resolve => { release = resolve })
    agent.currentQuery = agent.fakeQuery
    const starting = agent.beginPersistentTurn({ type: 'user', message: { role: 'user', content: 'next' }, parent_tool_use_id: null }, {}, { thinking: { type: 'adaptive' }, effort: 'low' })
    await new Promise(resolve => setTimeout(resolve, 0))
    agent.forceAbort(AbortReason.UserStop)
    release()
    await expect(starting).rejects.toThrow('Persistent query closed')
  })

  it('never lets an aborted query\'s consumer tear down the next query', async () => {
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.debug = () => {}
    let finishOld!: () => void
    const oldIterator = { next: () => new Promise(resolve => { finishOld = () => resolve({ done: true, value: undefined }) }) }
    agent.persistentIterator = oldIterator
    agent.persistentInput = createPushableInputStream()
    agent.startPersistentConsumer()

    // The next turn starts a new query while the old consumer is still draining.
    const newInput = createPushableInputStream()
    const newIterator = { next: () => new Promise(() => {}) }
    agent.persistentIterator = newIterator
    agent.persistentInput = newInput
    agent.startPersistentConsumer()
    expect(agent.persistentConsumerIterator).toBe(newIterator)

    finishOld()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent.persistentIterator).toBe(newIterator)
    expect(agent.persistentInput).toBe(newInput)
    expect(agent.persistentConsumerIterator).toBe(newIterator)
  })

  // Found 2026-10-11: a Stop hard-aborted the query and killed the step's three background
  // research agents, whose work then had to be redone. stopTurn interrupts the turn only.
  describe('stopTurn', () => {
    function withInterrupt(agent: any, interrupt: () => Promise<void>) {
      agent.debug = () => {}
      agent.config = {}
      agent.fakeQuery.interrupt = interrupt
      agent.currentQuery = agent.fakeQuery
      agent.persistentAbortController = new AbortController()
      return agent
    }

    it('ends the turn at once and interrupts it without closing the query', async () => {
      let interrupts = 0
      const agent = withInterrupt(await agentInPersistentTurn(), async () => { interrupts++ })
      const turn = agent.activeTurnState
      const channel = agent.activeTurnChannel

      expect(agent.stopTurn()).toBe(true)

      expect(turn.aborted).toBe(true)
      expect(channel.isEnded).toBe(true)
      expect(agent.activeTurnChannel).toBeNull()
      expect(interrupts).toBe(1)
      // The query (and its background agents) lives on
      expect(agent.currentQuery).toBe(agent.fakeQuery)
      expect(agent.persistentInput).not.toBeNull()
      expect(agent.persistentAbortController.signal.aborted).toBe(false)
      clearTimeout(agent.stoppedTurn.fallback)
    })

    it('keeps the stopped turn\'s leftovers, up to its result, away from the next turn', async () => {
      const agent = withInterrupt(await agentInPersistentTurn(), async () => {})
      const messages: any[] = []
      let deliver!: (value: any) => void
      agent.persistentIterator = { next: () => new Promise(resolve => { deliver = (value) => resolve({ done: false, value }) }) }
      agent.startPersistentConsumer()
      agent.stopTurn()

      const next = await agent.beginPersistentTurn({ type: 'user', message: { role: 'user', content: 'use the password' }, parent_tool_use_id: null }, {}, { thinking: { type: 'adaptive' }, effort: 'high' })
      const reading = (async () => { for await (const message of next) messages.push(message) })()
      const send = async (value: any) => { deliver(value); await new Promise(resolve => setTimeout(resolve, 0)) }

      await send({ type: 'assistant', id: 'old-tail' })
      await send({ type: 'result', subtype: 'error_during_execution', id: 'old-result' })
      expect(agent.stoppedTurn).toBeNull()
      await send({ type: 'assistant', id: 'new' })
      await send({ type: 'result', subtype: 'success', id: 'new-result' })
      await reading

      expect(messages.map(m => m.id)).toEqual(['new', 'new-result'])
    })

    it('hard-stops the query when the turn never ends or the interrupt fails', async () => {
      const silent = withInterrupt(await agentInPersistentTurn(), async () => {})
      silent.stoppedTurnResultWaitMs = 10
      const controller = silent.persistentAbortController
      silent.stopTurn()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(controller.signal.aborted).toBe(true)
      expect(silent.currentQuery).toBeNull()

      const failing = withInterrupt(await agentInPersistentTurn(), async () => { throw new Error('query closed') })
      const failingController = failing.persistentAbortController
      failing.stopTurn()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(failingController.signal.aborted).toBe(true)
    })

    it('waits for the stopped result and retains a matching late delivery proof without emitting its reply', async () => {
      const agent = withInterrupt(await agentInPersistentTurn(), async () => {})
      const output = createPushableInputStream<any>()
      agent.persistentIterator = output.stream[Symbol.asyncIterator]()
      agent.startPersistentConsumer()
      agent.stopTurn()
      let settled = false
      const receipt = agent.settleStoppedTurnInput().then((accepted: boolean) => { settled = true; return accepted })
      output.push({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: 'foreground-input' })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      output.push({ type: 'result', num_turns: 1, user_message_uuid: 'foreground-input' })
      expect(await receipt).toBe(true)
      expect(agent.currentQuery).toBe(agent.fakeQuery)
      expect(agent.persistentAbortController.signal.aborted).toBe(false)
      output.end()
    })

    it('retains consumer delivery evidence even when Stop ends the unread foreground channel', async () => {
      const agent = withInterrupt(await agentInPersistentTurn(), async () => {})
      const output = createPushableInputStream<any>()
      agent.persistentIterator = output.stream[Symbol.asyncIterator]()
      agent.startPersistentConsumer()
      output.push({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: 'foreground-input' })
      await new Promise(resolve => setTimeout(resolve, 0))
      agent.stopTurn()
      const receipt = agent.settleStoppedTurnInput()
      output.push({ type: 'result', num_turns: 0 })
      expect(await receipt).toBe(true)
      output.end()
    })

    it('rejects unrelated, replayed, subagent and progress frames when settling a stopped input', async () => {
      const agent = withInterrupt(await agentInPersistentTurn(), async () => {})
      const output = createPushableInputStream<any>()
      agent.persistentIterator = output.stream[Symbol.asyncIterator]()
      agent.startPersistentConsumer()
      agent.stopTurn()
      const receipt = agent.settleStoppedTurnInput()
      output.push({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: 'old-input' })
      output.push({ type: 'assistant', parent_tool_use_id: 'child', user_message_uuid: 'foreground-input' })
      output.push({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: 'foreground-input', isReplay: true })
      output.push({ type: 'stream_event', parent_tool_use_id: null, user_message_uuid: 'foreground-input', event: { type: 'ping' } })
      output.push({ type: 'auth_status', user_message_uuid: 'foreground-input' })
      output.push({ type: 'result', num_turns: 0, user_message_uuid: 'foreground-input' })
      expect(await receipt).toBe(false)
      output.end()
    })

    it('settles the stopped receipt on hard-stop fallback and never reuses it for the next input', async () => {
      const agent = withInterrupt(await agentInPersistentTurn(), async () => {})
      agent.stoppedTurnResultWaitMs = 5
      agent.stopTurn()
      expect(await agent.settleStoppedTurnInput()).toBe(false)
      expect(agent.currentQuery).toBeNull()
      agent.persistentInput = createPushableInputStream()
      agent.currentQuery = agent.fakeQuery
      await agent.beginPersistentTurn({ type: 'user', uuid: 'next-input', message: { role: 'user', content: 'next' }, parent_tool_use_id: null }, {}, { thinking: { type: 'adaptive' }, effort: 'high' })
      expect(await agent.settleStoppedTurnInput()).toBe(false)
      agent.forceAbort(AbortReason.UserStop)
    })

    it('declines without a live keep-alive turn, so the caller hard-stops', async () => {
      const agent = withInterrupt(await agentInPersistentTurn(), async () => {})
      agent.activeTurnChannel.end()
      agent.activeTurnChannel = null
      expect(agent.stopTurn()).toBe(false)
      agent.currentQuery = null
      expect(agent.stopTurn()).toBe(false)
    })
  })
})
