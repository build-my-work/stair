import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { isReference, MAX_REFERENCES_SERIALIZED_BYTES, type Reference } from '../../core/src/types/reference.ts';
import { formatReferencesForModel } from '../../server-core/src/sessions/message-references.ts';
import { getReferenceContext } from './reference-context.ts';
import { createCraftResourceLoader, createSystemPromptOverride } from './system-prompt-override.ts';

const source: Reference = {
  version: 1,
  kind: 'project-file',
  projectId: 'project-a',
  relativePath: 'original.txt',
  fileName: 'original.txt',
  sourceFingerprint: `sha256:${'0'.repeat(64)}`,
  quote: 'source & <quote> "snapshot"',
  locator: { type: 'text-quote', exact: 'source & <quote> "snapshot"', start: 30, end: 30 + 'source & <quote> "snapshot"'.length },
};

const model: Model<'openai-responses'> = {
  id: 'offline-reference-test', name: 'Offline', api: 'openai-responses', provider: 'openai',
  baseUrl: 'https://invalid.test', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
};

const sessions: AgentSession[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.abort();
    session.dispose();
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const result = mkdtempSync(join(tmpdir(), 'craft-pi-references-'));
  directories.push(result);
  return result;
}

async function offlineSession(manager: SessionManager, cwd: string) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } });
  const systemPromptOverride = createSystemPromptOverride();
  systemPromptOverride.set('STAIR-FORCED-SYSTEM');
  const { session } = await createAgentSession({
    cwd, model, settingsManager, sessionManager: manager, tools: [],
    resourceLoader: await createCraftResourceLoader({
      cwd, agentDir: join(cwd, '.pi-agent'), settingsManager,
      systemPromptOverride,
    }),
    modelRuntime: {
      hasConfiguredAuth: () => true, getModel: () => model, getAvailableSnapshot: () => [model],
      streamSimple: () => { throw new Error('Provider/network access is forbidden'); },
    } as unknown as ModelRuntime,
  });
  sessions.push(session);
  const requests: string[][] = [];
  const systemPrompts: string[] = [];
  session.agent.streamFunction = (_model, context) => {
    systemPrompts.push(...context.messages.filter(message => message.role === 'system').map(message => message.content));
    requests.push(context.messages.map(message => typeof message.content === 'string'
      ? message.content
      : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')));
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, provider: model.provider,
      model: model.id, timestamp: Date.now(), stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  };
  return { session, requests, systemPrompts };
}

describe('Stair references through the installed Pi SDK context boundary', () => {
  it('replays complete source data after a lossy compaction without rewriting the user journal', async () => {
    const cwd = directory();
    const manager = SessionManager.create(cwd, join(cwd, 'sessions'));
    const originalInput = formatReferencesForModel('original request', [source]);
    expect(isReference(source)).toBe(true);
    const originalId = manager.appendMessage({ role: 'user', content: originalInput, timestamp: 1 });
    const keepId = manager.appendMessage({ role: 'user', content: 'recent request', timestamp: 2 });
    manager.appendCompaction('Only the source quote survived.', keepId, 100000);
    expect(JSON.stringify(manager.buildSessionProjection().messages)).not.toContain('original.txt');
    const { session, requests, systemPrompts } = await offlineSession(manager, cwd);
    await session.prompt('Which source supplied the quote?');
    expect(requests).toHaveLength(1);
    expect(systemPrompts).toEqual(['STAIR-FORCED-SYSTEM']);
    const context = requests[0]!.join('\n');
    expect(context).toContain(formatReferencesForModel('', [source]));
    expect(manager.getEntry(originalId)).toMatchObject({ message: { content: originalInput } });
    expect(manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user'))
      .toHaveLength(3);

    // Resume from the actual SDK journal, without in-memory reference state.
    const resumed = SessionManager.open(manager.getSessionFile()!);
    const next = await offlineSession(resumed, cwd);
    await next.session.prompt('Which source after restart?');
    expect(next.requests[0]!.join('\n')).toContain(formatReferencesForModel('', [source]));
  });

  it('does not duplicate references already retained by Pi, including after repeated compaction', async () => {
    const cwd = directory();
    const manager = SessionManager.create(cwd, join(cwd, 'sessions'));
    manager.appendMessage({ role: 'user', content: formatReferencesForModel('old', [source]), timestamp: 1 });
    const keepId = manager.appendMessage({ role: 'user', content: formatReferencesForModel('recent', [source]), timestamp: 2 });
    manager.appendCompaction('summary one', keepId, 100000);
    const { session, requests } = await offlineSession(manager, cwd);
    await session.prompt('first continuation');
    expect(requests[0]!.join('\n').match(/<stair_reference_data /g)).toHaveLength(1);
    const nextKeep = manager.appendMessage({ role: 'user', content: 'another recent turn', timestamp: 3 });
    manager.appendCompaction('summary two lost the old reference', nextKeep, 100000);
    const next = await offlineSession(manager, cwd);
    await next.session.prompt('second continuation');
    expect(next.requests[0]!.join('\n').match(/<stair_reference_data /g)).toHaveLength(1);
    expect(next.requests[0]!.join('\n')).toContain(formatReferencesForModel('', [source]));
  });

  it('honors latest replacement/removal edits and never imports other branches or tool output', async () => {
    const cwd = directory();
    const manager = SessionManager.create(cwd, join(cwd, 'sessions'));
    const rootId = manager.appendMessage({ role: 'user', content: 'shared root', timestamp: 1 });
    manager.appendMessage({ role: 'user', content: formatReferencesForModel('other branch', [source]), timestamp: 2 });
    manager.branch(rootId);
    const replacement = { ...source, relativePath: 'replacement.txt', fileName: 'replacement.txt' };
    const editedId = manager.appendMessage({ role: 'user', content: formatReferencesForModel('edited', [source]), timestamp: 3 });
    manager.appendContextEdit(editedId, { content: formatReferencesForModel('replacement', [replacement]) });
    const removedId = manager.appendMessage({ role: 'user', content: formatReferencesForModel('removed', [source]), timestamp: 4 });
    manager.appendContextEdit(removedId, null);
    manager.appendMessage({ role: 'toolResult', toolCallId: 'quoted', toolName: 'read', isError: false,
      content: [{ type: 'text', text: formatReferencesForModel('file text', [source]) }], timestamp: 5 });
    const keepId = manager.appendMessage({ role: 'user', content: 'keep', timestamp: 6 });
    manager.appendCompaction('lossy summary', keepId, 100000);
    const { session, requests } = await offlineSession(manager, cwd);
    await session.prompt('continue');
    expect(requests[0]!.join('\n')).toContain('replacement.txt');
    expect(requests[0]!.join('\n')).not.toContain('original.txt');
    manager.appendContextEdit(editedId, null);
    const next = await offlineSession(manager, cwd);
    await next.session.prompt('continue after removal');
    expect(next.requests[0]!.join('\n')).not.toContain('<stair_reference_data ');
  });

  it('replays only missing snapshots when historical and visible reference lists overlap', async () => {
    const cwd = directory();
    const manager = SessionManager.create(cwd, join(cwd, 'sessions'));
    const second = { ...source, relativePath: 'second.txt', fileName: 'second.txt' };
    manager.appendMessage({ role: 'user', content: formatReferencesForModel('old', [source, second]), timestamp: 1 });
    const keepId = manager.appendMessage({ role: 'user', content: formatReferencesForModel('recent', [source]), timestamp: 2 });
    manager.appendCompaction('lossy summary', keepId, 100000);
    const { session, requests } = await offlineSession(manager, cwd);
    await session.prompt('continue');
    const context = requests[0]!.join('\n');
    expect(context.match(/&quot;relativePath&quot;: &quot;original.txt&quot;/g)).toHaveLength(1);
    expect(context).toContain(formatReferencesForModel('', [second]));
  });

  it('keeps complete source envelopes and cancels SDK compaction rather than truncating excess replay', async () => {
    const manager = SessionManager.inMemory(import.meta.dir);
    const largeQuote = '界'.repeat(2000);
    const large = { ...source, quote: largeQuote, locator: { type: 'text-quote' as const,
      exact: largeQuote, start: 0, end: largeQuote.length } };
    const references = Array.from({ length: 8 }, (_, index) => ({
      ...large, relativePath: `source-${index}.txt`, fileName: `source-${index}.txt`,
    }));
    expect(references.every(isReference)).toBe(true);
    manager.appendMessage({ role: 'user', content: formatReferencesForModel('large', references), timestamp: 1 });
    // Each accepted host input fits its own budget; their compacted replay may not.
    const smallInput = formatReferencesForModel('first', [source]);
    const firstId = manager.appendMessage({ role: 'user', content: smallInput, timestamp: 2 });
    const secondInput = formatReferencesForModel('second', [{ ...source, relativePath: 'second.txt' }]);
    manager.appendMessage({ role: 'user', content: secondInput, timestamp: 3 });
    const withinBudget = getReferenceContext(manager.getBranch(), []);
    expect(withinBudget).toContain(formatReferencesForModel('', [source]));
    expect(withinBudget).toContain('second.txt');
    expect(Buffer.byteLength(JSON.stringify(references))).toBeLessThan(MAX_REFERENCES_SERIALIZED_BYTES);
    manager.appendMessage({ role: 'user', content: formatReferencesForModel('second large', references.map(ref => ({
      ...ref, relativePath: `other-${ref.relativePath}`,
    }))), timestamp: 4 });
    const leaf = manager.getLeafId();
    expect(() => getReferenceContext(manager.getBranch(), [])).toThrow('MESSAGE_REFERENCE_TOO_LARGE');
    expect(manager.getLeafId()).toBe(leaf);
    expect(manager.getEntry(firstId)).toMatchObject({ message: { content: smallInput } });
    manager.appendMessage({ role: 'user', content: 'most recent request', timestamp: 5 });
    const { session, requests } = await offlineSession(manager, directory());
    const before = manager.getLeafId();
    await expect(session.compact()).rejects.toThrow('Compaction cancelled');
    expect(requests).toHaveLength(0);
    expect(manager.getLeafId()).toBe(before);
    expect(manager.getBranch().some(entry => entry.type === 'compaction')).toBe(false);
  });

  it('preserves literal XML entities and finds the real host envelope after malformed body markup', async () => {
    const cwd = directory();
    const manager = SessionManager.create(cwd, join(cwd, 'sessions'));
    const quote = '&quot; is literal, <quote> is data, separators: \u2028 \u2029';
    const literal = { ...source, quote, locator: { type: 'text-quote' as const,
      exact: quote, start: 0, end: quote.length } };
    const input = formatReferencesForModel('<stair_reference_data trust="untrusted">\nunterminated user markup', [literal]);
    manager.appendMessage({ role: 'user', content: input, timestamp: 1 });
    const keepId = manager.appendMessage({ role: 'user', content: 'recent request', timestamp: 2 });
    manager.appendCompaction('summary', keepId, 100000);
    const { session, requests } = await offlineSession(manager, cwd);
    await session.prompt('continue');
    expect(requests[0]!.join('\n')).toContain(formatReferencesForModel('', [literal]));
    expect(requests[0]!.join('\n')).not.toContain('unterminated user markup');
  });
});
