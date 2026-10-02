import { expect, test } from 'bun:test';
import { createAgentSession, createExtensionRuntime, SessionManager, type Extension, type ModelRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { createCraftSettingsManager } from './session-settings.ts';
import { PiSteerDelivery, UnknownSteerIdsError } from './steer-delivery.ts';

async function fixture(extensions: Extension[] = []) {
  const model: Model<'openai-responses'> = {
    id: 'offline-steering-test', name: 'Offline', api: 'openai-responses', provider: 'openai',
    baseUrl: 'https://invalid.test', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
  };
  const loader: ResourceLoader = {
    getExtensions: () => ({ extensions, errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [{ name: 'expanded', description: 'Template', content: 'EXPANDED $@', source: 'test', filePath: '/tmp/expanded.md' }], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Offline steering test', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd: import.meta.dir, model, settingsManager: createCraftSettingsManager(),
    sessionManager: SessionManager.inMemory(import.meta.dir), resourceLoader: loader, tools: [],
    modelRuntime: {
      hasConfiguredAuth: () => true, getModel: () => model, getAvailableSnapshot: () => [model],
      streamSimple: () => { throw new Error('Provider/network access is forbidden'); },
    } as unknown as ModelRuntime,
  });
  const calls: string[][] = [];
  const releases: (() => void)[] = [];
  session.agent.streamFunction = (_model, context, options) => {
    calls.push(context.messages.filter(m => m.role === 'user').map(m =>
      typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('')));
    const stream = createAssistantMessageEventStream();
    let finished = false;
    const finish = (reason: 'stop' | 'aborted' = 'stop') => {
      if (finished) return;
      finished = true;
      const message: AssistantMessage = {
        role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: reason,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
      if (reason === 'aborted') stream.push({ type: 'error', reason, error: message });
      else stream.push({ type: 'done', reason, message });
    };
    releases.push(() => finish());
    options?.signal?.addEventListener('abort', () => finish('aborted'), { once: true });
    if (options?.signal?.aborted) finish('aborted');
    return stream;
  };
  const receipts: Array<{ type: string; id: string }> = [];
  const steering = new PiSteerDelivery(session, receipt => receipts.push(receipt));
  const waitForCalls = async (count: number) => {
    for (let i = 0; calls.length < count && i < 100; i++) await Bun.sleep(1);
    expect(calls).toHaveLength(count);
  };
  return { session, steering, calls, releases, receipts, waitForCalls };
}

test('identical steers are acknowledged by their actual SDK message starts, with template expansion preserved', async () => {
  const f = await fixture();
  f.steering.beginTurn('turn');
  const turn = f.session.prompt('same text');
  try {
    await f.waitForCalls(1);
    await f.steering.enqueue('one', 'same text', 'turn');
    await f.steering.enqueue('two', 'same text', 'turn');
    await f.steering.enqueue('two', 'same text', 'turn');
    await f.steering.enqueue('template', '/expanded marker', 'turn');
    expect(f.receipts).toEqual([]);
    f.releases[0]!();
    await f.waitForCalls(2);
    expect(f.calls[1]).toEqual(['same text', 'same text', 'same text', 'EXPANDED marker']);
    expect(f.receipts).toEqual([
      { type: 'steer_consumed', id: 'one' },
      { type: 'steer_consumed', id: 'two' },
      { type: 'steer_consumed', id: 'template' },
    ]);
    f.releases[1]!();
    await turn;
    expect(await f.steering.settle({ id: 'settlement', turnId: 'turn', steerIds: ['one', 'two', 'template'] })).toEqual([]);
  } finally {
    await f.session.abort();
    await turn;
    f.steering.dispose();
    f.session.dispose();
  }
});

test('a command rejected by the SDK does not block the next turn and retains cancellation identity', async () => {
  const sourceInfo = { path: '/tmp/pi-steering-extension', source: 'test', scope: 'temporary' as const, origin: 'top-level' as const };
  const f = await fixture([{
    path: sourceInfo.path, resolvedPath: sourceInfo.path, sourceInfo,
    handlers: new Map(), tools: new Map(), messageRenderers: new Map(), flags: new Map(), shortcuts: new Map(),
    commands: new Map([['blocked', { name: 'blocked', sourceInfo, handler: async () => {} }]]),
  }]);
  f.steering.beginTurn('turn');
  const turn = f.session.prompt('initial');
  try {
    await f.waitForCalls(1);
    await f.steering.enqueue('rejected', '/blocked', 'turn');
    expect(f.receipts).toEqual([{ type: 'steer_rejected', id: 'rejected' }]);
    await f.session.abort();
    await turn;
    // A definitely rejected input needs no cancellation RPC from the host.
    f.steering.beginTurn('next-turn');
    const next = f.session.prompt('next');
    await f.waitForCalls(2);
    await f.steering.enqueue('rejected-again', '/blocked', 'next-turn');
    await f.steering.enqueue('pending', 'pending', 'next-turn');
    expect(await f.steering.settle({ id: 'settlement', turnId: 'next-turn', steerIds: ['rejected-again', 'pending'] }))
      .toEqual(['rejected-again', 'pending']);
    await next;
  } finally {
    await f.session.abort();
    await turn;
    f.steering.dispose();
    f.session.dispose();
  }
});

test('cancellation settles unconsumed steers and prevents them from entering the next prompt', async () => {
  const f = await fixture();
  f.steering.beginTurn('turn');
  const turn = f.session.prompt('initial');
  try {
    await f.waitForCalls(1);
    await f.steering.enqueue('one', 'queued one', 'turn');
    await f.steering.enqueue('two', 'queued two', 'turn');
    const request = { id: 'settlement', turnId: 'turn', steerIds: ['one', 'two'] };
    const unknownRequest = { ...request, id: 'startup-settlement', steerIds: ['startup-rejected', 'one', 'two'] };
    const rejected = await f.steering.settle(unknownRequest).catch(error => error);
    expect(rejected).toBeInstanceOf(UnknownSteerIdsError);
    expect(rejected).toMatchObject({ code: 'unknown_steer_ids', unknownIds: ['startup-rejected'] });
    expect(f.session.getSteeringMessages()).toEqual(['queued one', 'queued two']);
    expect(await f.steering.settle(request)).toEqual(['one', 'two']);
    expect(await f.steering.settle(request)).toEqual(['one', 'two']);
    // Once a cancellation exists, mismatched requests cannot receive the
    // no-side-effects error code or start a second cancellation.
    const mismatch = await f.steering.settle(unknownRequest).catch(error => error);
    expect(mismatch).not.toBeInstanceOf(UnknownSteerIdsError);
    expect(mismatch.message).toContain('identity mismatch');
    await turn;
    expect(f.receipts).toEqual([]);
    expect(f.session.getSteeringMessages()).toEqual([]);
    f.steering.beginTurn('next-turn');
    const next = f.session.prompt('next');
    await expect(f.steering.settle(request)).rejects.toThrow('different turn');
    await f.waitForCalls(2);
    expect(f.calls[1]).toEqual(['initial', 'next']);
    f.releases[1]!();
    await next;
  } finally {
    await f.session.abort();
    await turn;
    f.steering.dispose();
    f.session.dispose();
  }
});

test('the SDK cancellation barrier waits for a delayed user-message listener before classifying delivery', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sourceInfo = { path: '/tmp/pi-steering-delay', source: 'test', scope: 'temporary' as const, origin: 'top-level' as const };
  const f = await fixture([{
    path: sourceInfo.path, resolvedPath: sourceInfo.path, sourceInfo,
    tools: new Map(), messageRenderers: new Map(), flags: new Map(), shortcuts: new Map(), commands: new Map(),
    handlers: new Map([['message_start', [async (event: any) => {
      if (event.message.role === 'user' && event.message.content.some((part: any) => part.text === 'late receipt')) {
        entered.resolve();
        await release.promise;
      }
    }]]]),
  }]);
  f.steering.beginTurn('turn');
  const turn = f.session.prompt('initial');
  try {
    await f.waitForCalls(1);
    await f.steering.enqueue('late', 'late receipt', 'turn');
    f.releases[0]!();
    await entered.promise;
    let settled = false;
    const barrier = f.steering.settle({ id: 'settlement', turnId: 'turn', steerIds: ['late'] })
      .then(ids => { settled = true; return ids; });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    expect(f.receipts).toEqual([]);
    release.resolve();
    expect(await barrier).toEqual([]);
    expect(f.receipts).toEqual([{ type: 'steer_consumed', id: 'late' }]);
  } finally {
    release.resolve();
    await f.session.abort();
    await turn;
    f.steering.dispose();
    f.session.dispose();
  }
});
