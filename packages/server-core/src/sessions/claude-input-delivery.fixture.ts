import { afterAll, expect, mock, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentEvent } from '@craft-agent/core/types'
import type { NonNullableUsage, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

const configDir = mkdtempSync(join(tmpdir(), 'claude-input-delivery-profile-'))
process.env.CRAFT_CONFIG_DIR = configDir
copyFileSync(resolve(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'), join(configDir, 'config-defaults.json'))
const sdk = await import('@anthropic-ai/claude-agent-sdk')
const { createPushableInputStream } = await import('@craft-agent/shared/agent/backend/claude/persistent-input')
type Output = ReturnType<typeof createPushableInputStream<SDKMessage>>
const prompts: SDKUserMessage[] = []
const outputStreams: Output[] = []
let produce: (input: SDKUserMessage, output: Output) => Promise<void>
let queries = 0
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...sdk,
  query: ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => {
    queries++
    const output = createPushableInputStream<SDKMessage>()
    outputStreams.push(output)
    options.abortController?.signal.addEventListener('abort', () => output.end(), { once: true })
    void (async () => {
      const input = typeof prompt === 'string'
        ? (async function* (): AsyncGenerator<SDKUserMessage> { yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null } })()
        : prompt
      for await (const message of input) {
        prompts.push(message)
        await produce(message, output)
      }
      output.end()
    })().catch(error => { output.end(); throw error })
    return Object.assign(output.stream, {
      close: () => output.end(),
      interrupt: async () => {},
      setMaxThinkingTokens: async () => {},
      applyFlagSettings: async () => {},
    })
  },
}))
// Keep ClaudeAgent's prompt/hooks/adapter intact. Seal only native spawning and
// its ~/.claude.json repair so this fixture cannot read or mutate user data.
const optionsModule = await import('@craft-agent/shared/agent/options')
mock.module(resolve(import.meta.dir, '../../../shared/src/agent/options.ts'), () => ({
  ...optionsModule,
  getDefaultOptions: () => ({ env: process.env }),
}))
const { ClaudeAgent } = await import('@craft-agent/shared/agent/claude-agent')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { CONFIG_DIR } = await import('@craft-agent/shared/config')
if (CONFIG_DIR !== configDir) throw new Error('Claude delivery fixture needs isolated config')
const fixtures: Array<{ root: string; agent: InstanceType<typeof ClaudeAgent> }> = []
afterAll(() => {
  for (const fixture of fixtures) { fixture.agent.destroy(); rmSync(fixture.root, { recursive: true, force: true }) }
  for (const output of outputStreams) output.end()
  rmSync(configDir, { recursive: true, force: true })
})

function createAgent(persistent: boolean) {
  process.env.CRAFT_KEEP_BG_AGENTS_ALIVE = persistent ? '1' : '0'
  const root = mkdtempSync(join(tmpdir(), 'claude-delivery-workspace-'))
  const workspace = { ...createWorkspaceAtPath(root, 'Claude delivery'), rootPath: root }
  const agent = new ClaudeAgent({
    model: 'claude-sonnet-4-6', isHeadless: true, skipConfigWatcher: true, workspace,
    session: { id: randomUUID(), projectId: workspace.defaultProjectId, workspaceRootPath: root, createdAt: 1, lastUsedAt: 1 },
  })
  fixtures.push({ root, agent })
  return agent
}

function assistant(inputId: string | undefined, parent: string | null = null, text = 'Accepted reply'): SDKMessage {
  return {
    type: 'assistant', uuid: randomUUID(), session_id: 'isolated-sdk-session', parent_tool_use_id: parent,
    user_message_uuid: inputId,
    message: {
      type: 'message', id: randomUUID(), role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as SDKMessage
}

function delta(inputId: string | undefined, text: string): SDKMessage {
  return {
    type: 'stream_event', uuid: randomUUID(), session_id: 'isolated-sdk-session', parent_tool_use_id: null,
    user_message_uuid: inputId,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  } as SDKMessage
}

function result(inputId: string | undefined, options: { turns?: number; blocked?: boolean; error?: boolean } = {}): SDKMessage {
  const usage: NonNullableUsage = {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: 'not_available', iterations: [], output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: 'standard', speed: 'standard',
  }
  const common = {
    type: 'result' as const, uuid: randomUUID(),
    session_id: 'isolated-sdk-session', user_message_uuid: inputId, user_message_uuids: inputId ? [inputId] : [],
    duration_ms: 1, duration_api_ms: options.turns === 0 ? 0 : 1, is_error: options.error === true, num_turns: options.turns ?? 1,
    total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], stop_reason: null,
  }
  return options.error
    ? { ...common, subtype: 'error_during_execution' as const, errors: ['Post-submit execution failed'] }
    : { ...common, subtype: 'success' as const, result: options.blocked ? 'UserPromptSubmit blocked this input' : '' }
}

async function collect(agent: InstanceType<typeof ClaudeAgent>, message: string, events: AgentEvent[] = []) {
  for await (const event of agent.chat(message)) events.push(event)
  return events
}

test('per-turn text input preserves its wire text and acknowledges only a matching main reply', async () => {
  const agent = createAgent(false)
  const start = prompts.length
  produce = async (input, output) => {
    output.push(assistant('another-input'))
    output.push(assistant(input.uuid, 'subagent-tool'))
    const matching = assistant(input.uuid)
    if (matching.type === 'assistant') {
      matching.user_message_uuid = 'batched-later-input'
      matching.user_message_uuids = [input.uuid!, 'batched-later-input']
    }
    output.push(matching)
    output.push(delta(input.uuid, 'Duplicate delivery frame'))
    output.push(result(input.uuid))
  }
  const events = await collect(agent, 'Keep the complete original text')
  expect(prompts).toHaveLength(start + 1)
  expect(prompts[start]!.uuid).toBeDefined()
  expect(typeof prompts[start]!.message.content).toBe('string')
  expect(prompts[start]!.message.content).toContain('Keep the complete original text')
  expect(events.filter(event => event.type === 'input_accepted')).toHaveLength(1)
})

test('same-text persistent turns reject a late prior UUID and subagent reply before acknowledging the new UUID', async () => {
  const agent = createAgent(true)
  const start = prompts.length
  const queryCount = queries
  const waiting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let firstId: string | undefined
  produce = async (input, output) => {
    if (!firstId) {
      firstId = input.uuid
      output.push(delta(input.uuid, 'First reply'))
      output.push(assistant(input.uuid))
      output.push(result(input.uuid))
      return
    }
    output.push(assistant(firstId, null, 'Late first-turn reply'))
    output.push(assistant(input.uuid, 'background-subagent'))
    output.push(delta(firstId, 'Before matching main response'))
    waiting.resolve()
    await release.promise
    output.push(delta(input.uuid, 'Actual second-turn response'))
    output.push(result(input.uuid))
  }
  const firstEvents = await collect(agent, 'Same user text')
  const secondEvents: AgentEvent[] = []
  const second = collect(agent, 'Same user text', secondEvents)
  await waiting.promise
  for (let n = 0; n < 100 && !secondEvents.some(event => event.type === 'text_delta' && event.text.includes('Before matching')); n++) await Bun.sleep(1)
  expect(secondEvents.some(event => event.type === 'text_delta' && event.text.includes('Before matching'))).toBe(true)
  expect(secondEvents.some(event => event.type === 'input_accepted')).toBe(false)
  expect(prompts[start]!.uuid).toBeDefined()
  expect(prompts[start + 1]!.uuid).not.toBe(prompts[start]!.uuid)
  release.resolve()
  await second
  expect(firstEvents.filter(event => event.type === 'input_accepted')).toHaveLength(1)
  expect(secondEvents.filter(event => event.type === 'input_accepted')).toHaveLength(1)
  expect(queries - queryCount).toBe(1)
})

test('blocked/empty result and auth status with a current UUID cannot prove Claude delivery', async () => {
  const agent = createAgent(false)
  produce = async (input, output) => {
    output.push({ type: 'auth_status', isAuthenticating: false, output: [], error: 'Credential preflight failed', uuid: randomUUID(), session_id: 'isolated-sdk-session', user_message_uuid: input.uuid } as SDKMessage)
    output.push({ type: 'user', message: { role: 'user', content: 'Replayed input' }, parent_tool_use_id: null, isReplay: true, uuid: input.uuid, session_id: 'isolated-sdk-session' } as SDKMessage)
    // Native W4e's shouldQuery=false branch returns zero-turn success with
    // echoed UUIDs even when a prompt hook blocked the model request.
    output.push(result(input.uuid, { turns: 0, blocked: true }))
  }
  const events = await collect(agent, 'An input blocked before model execution')
  expect(events.some(event => event.type === 'complete')).toBe(true)
  expect(events.some(event => event.type === 'input_accepted')).toBe(false)
})

test('Claude missing-skill preflight never enters query or acknowledges the input', async () => {
  const agent = createAgent(false)
  const queryCount = queries
  const events = await collect(agent, '[skill:deleted-skill] Execute the instructions')
  expect(events.some(event => event.type === 'error' && event.message.includes('Skill(s) not found'))).toBe(true)
  expect(events.some(event => event.type === 'input_accepted')).toBe(false)
  expect(queries).toBe(queryCount)
})

for (const error of [false, true]) {
  test(`a correlated ${error ? 'execution error' : 'empty success'} result after a model turn proves delivery without assistant content`, async () => {
    const agent = createAgent(false)
    produce = async (input, output) => { output.push(result(input.uuid, { turns: 1, error })) }
    const events = await collect(agent, 'An input that ran without assistant content')
    expect(events.filter(event => event.type === 'input_accepted')).toHaveLength(1)
    expect(events.some(event => event.type === 'complete')).toBe(true)
  })
}

for (const error of [false, true]) {
  test(`resuming a correlated ${error ? 'execution error' : 'empty success'} result after execution never submits the input twice`, async () => {
    const agent = createAgent(false)
    agent.setSessionId('previous-sdk-session')
    const queryCount = queries
    const start = prompts.length
    produce = async (input, output) => { output.push(result(input.uuid, { turns: 1, error })) }
    const events = await collect(agent, 'Resume an input that ran without assistant content')
    expect(queries - queryCount).toBe(1)
    expect(prompts).toHaveLength(start + 1)
    expect(events.filter(event => event.type === 'input_accepted')).toHaveLength(1)
    expect(events.some(event => event.type === 'info' && event.message === 'Restoring conversation context...')).toBe(false)
    expect(events.some(event => event.type === 'complete')).toBe(true)
  })
}

test('an uncorrelated zero-turn resume result still restores context and retries once', async () => {
  const agent = createAgent(false)
  agent.setSessionId('unavailable-sdk-session')
  const queryCount = queries
  const start = prompts.length
  let first = true
  produce = async (input, output) => {
    output.push(first ? result(undefined, { turns: 0 }) : result(input.uuid, { turns: 1 }))
    first = false
  }
  const events = await collect(agent, 'A prompt whose first resume never reached the model')
  expect(queries - queryCount).toBe(2)
  expect(prompts).toHaveLength(start + 2)
  expect(prompts[start + 1]!.uuid).not.toBe(prompts[start]!.uuid)
  expect(events.filter(event => event.type === 'input_accepted')).toHaveLength(1)
  expect(events.some(event => event.type === 'info' && event.message === 'Restoring conversation context...')).toBe(true)
  expect(events.some(event => event.type === 'complete')).toBe(true)
})

for (const delivered of [true, false]) {
  test(`soft Stop settles ${delivered ? 'a late matching delivery' : 'a rejected input'} before recovery without killing the persistent query`, async () => {
    const agent = createAgent(true)
    const queryCount = queries
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: AgentEvent[] = []
    produce = async (input, output) => {
      ready.resolve()
      await release.promise
      if (delivered) output.push(delta(input.uuid, 'This old response must not reach the stopped transcript'))
      output.push(result(input.uuid, { turns: delivered ? 1 : 0, blocked: !delivered }))
    }
    const running = collect(agent, 'Stopped input with its own UUID', events)
    await ready.promise
    expect(agent.stopTurn()).toBe(true)
    let settled = false
    const receipt = agent.settleStoppedTurnInput().then(accepted => { settled = true; return accepted })
    await running
    expect(settled).toBe(false)
    expect(events.some(event => event.type === 'input_accepted')).toBe(false)
    release.resolve()
    expect(await receipt).toBe(delivered)
    expect(events.some(event => event.type === 'text_delta' && event.text.includes('old response'))).toBe(false)
    produce = async (input, output) => {
      output.push(assistant(input.uuid))
      output.push(result(input.uuid))
    }
    const next = await collect(agent, 'A new input after Stop settlement')
    expect(next.filter(event => event.type === 'input_accepted')).toHaveLength(1)
    expect(queries - queryCount).toBe(1)
  })
}

test('a missing-skill failure at public chat entry cannot inherit the previous accepted input receipt', async () => {
  const agent = createAgent(true)
  produce = async (input, output) => {
    output.push(assistant(input.uuid))
    output.push(result(input.uuid))
  }
  await collect(agent, 'An earlier accepted input')
  expect(await agent.settleStoppedTurnInput()).toBe(true)
  const queryCount = queries
  const failing = agent.chat('[skill:deleted-skill] New input never submitted')
  const first = await failing.next()
  expect(first.value).toMatchObject({ type: 'error' })
  expect(await agent.settleStoppedTurnInput()).toBe(false)
  expect(queries).toBe(queryCount)
  await failing.return(undefined)
})
