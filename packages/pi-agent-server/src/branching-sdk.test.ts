import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';

const children: ChildProcessWithoutNullStreams[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(duplicate = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'stair-pi-branch-'));
  directories.push(cwd);
  const parentPath = join(cwd, 'parent');
  const childPath = join(cwd, 'child');
  mkdirSync(parentPath);
  mkdirSync(childPath);
  const manager = SessionManager.create(cwd, join(parentPath, '.pi-sessions'));
  manager.appendMessage({ role: 'user', content: 'ORIGINAL-REFERENCE-CONTEXT', timestamp: 1 });
  const reply: AssistantMessage = {
    role: 'assistant', content: [{ type: 'text', text: 'selected reply' }],
    api: 'openai-completions', provider: 'custom-endpoint', model: 'branch-test',
    timestamp: 2, stopReason: 'stop', usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const anchor = manager.appendMessage(reply);
  const futureUser = manager.appendMessage({ role: 'user', content: 'FUTURE-INPUT-MUST-NOT-LEAK', timestamp: 3 });
  manager.appendMessage({ ...reply, timestamp: 4, content: [{ type: 'text', text: duplicate ? 'selected reply' : 'future reply' }] });
  manager.appendCompaction('FUTURE-COMPACTION-MUST-NOT-LEAK', futureUser, 100000);
  writeFileSync(join(parentPath, 'session.jsonl'), [
    { id: 'parent', workspaceRootPath: cwd, sdkCwd: cwd, sdkSessionId: manager.getSessionId() },
    { id: 'selected-host-message', type: 'assistant', content: 'selected reply', timestamp: 2 },
    { id: 'future-host-message', type: 'user', content: 'FUTURE-INPUT-MUST-NOT-LEAK', timestamp: 3 },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  return { cwd, parentPath, childPath, manager, anchor, reply };
}

async function worker(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const env: NodeJS.ProcessEnv = { CRAFT_CONFIG_DIR: f.cwd };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn(process.execPath, [join(import.meta.dir, 'index.ts')], { cwd: f.cwd, env });
  children.push(child);
  const messages: any[] = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  createInterface({ input: child.stdout }).on('line', line => {
    try { messages.push(JSON.parse(line)); } catch { /* SDK diagnostic output is not protocol. */ }
  });
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
  const wait = async (predicate: (message: any) => boolean) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const message = messages.find(predicate);
      if (message) return message;
      if (child.exitCode !== null) break;
      await Bun.sleep(10);
    }
    throw new Error('Pi worker response missing: ' + stderr.slice(-2000));
  };
  send({
    type: 'init', apiKey: 'local-test-only', model: 'pi/branch-test', thinkingLevel: 'off',
    cwd: f.cwd, workingDirectory: f.cwd, workspaceRootPath: f.cwd,
    sessionId: 'child', sessionPath: f.childPath, plansFolderPath: join(f.childPath, 'plans'),
    providerType: 'pi_compat', authType: 'api_key', baseUrl: 'http://127.0.0.1:1/v1',
    customEndpoint: { api: 'openai-completions' }, customModels: ['branch-test'],
    branchFromSdkSessionId: f.manager.getSessionId(), branchFromSessionPath: f.parentPath,
    branchFromMessageId: 'selected-host-message', ...overrides,
  });
  await wait(message => message.type === 'ready');
  send({ type: 'ensure_session_ready', id: 'branch-preflight' });
  const result = await wait(message => message.type === 'ensure_session_ready_result' || message.type === 'error');
  return { result, messages, send, wait };
}

describe('Pi branch cutoff through the real worker and installed SDK', () => {
  it('recovers a unique legacy reply and durably excludes future inputs and compactions', async () => {
    const f = fixture();
    // A newer unrelated SDK file must not override the persisted parent identity.
    const unrelated = SessionManager.create(f.cwd, join(f.parentPath, '.pi-sessions'));
    unrelated.appendMessage({ ...f.reply, content: [{ type: 'text', text: 'WRONG-SDK-LINEAGE' }] });
    const { result } = await worker(f);
    expect(result.type).toBe('ensure_session_ready_result');
    const file = SessionManager.findById(f.cwd, result.sessionId, join(f.childPath, '.pi-sessions'))!;
    const reopened = SessionManager.open(file);
    expect(reopened.getBranch().filter(entry => entry.type === 'message').at(-1)?.id).toBe(f.anchor);
    const retained = JSON.stringify(reopened.getBranch());
    expect(retained).toContain('ORIGINAL-REFERENCE-CONTEXT');
    expect(retained).not.toContain('FUTURE-INPUT');
    expect(retained).not.toContain('FUTURE-COMPACTION');
    expect(retained).not.toContain('WRONG-SDK-LINEAGE');
    expect(JSON.stringify(SessionManager.open(f.manager.getSessionFile()!).getBranch())).toContain('FUTURE-INPUT');
    const resumed = await worker(f, { sdkSessionId: result.sessionId });
    expect(resumed.result.sessionId).toBe(result.sessionId);
    expect(readdirSync(join(f.childPath, '.pi-sessions'))).toHaveLength(1);
  }, 30000);

  it('rejects ambiguous legacy replies before creating an SDK child', async () => {
    const f = fixture(true);
    const { result } = await worker(f);
    expect(result.type).toBe('error');
    expect(result.message).toContain('uniquely');
    expect(readdirSync(join(f.childPath, '.pi-sessions'))).toEqual([]);
  }, 15000);

  it('uses the exact recorded anchor even when reply text repeats', async () => {
    const f = fixture(true);
    const { result } = await worker(f, { branchFromSdkTurnId: f.anchor });
    expect(result.type).toBe('ensure_session_ready_result');
    const file = SessionManager.findById(f.cwd, result.sessionId, join(f.childPath, '.pi-sessions'))!;
    expect(JSON.stringify(SessionManager.open(file).getBranch())).not.toContain('FUTURE-INPUT');
  }, 15000);

  it('rejects a missing anchor or parent lineage instead of falling back to full history', async () => {
    const f = fixture();
    const missingAnchor = await worker(f, { branchFromSdkTurnId: 'missing-entry' });
    expect(missingAnchor.result.type).toBe('error');
    const missingParent = await worker(f, { branchFromSdkSessionId: 'missing-sdk-session' });
    expect(missingParent.result.type).toBe('error');
    expect(readdirSync(join(f.childPath, '.pi-sessions'))).toEqual([]);
  }, 30000);

  it('rejects an anchor pointing at a different message', async () => {
    const f = fixture();
    const wrongAnchor = f.manager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'user')!.id;
    const { result } = await worker(f, { branchFromSdkTurnId: wrongAnchor });
    expect(result.type).toBe('error');
    expect(result.message).toContain('does not match');
    expect(readdirSync(join(f.childPath, '.pi-sessions'))).toEqual([]);
  }, 15000);

  it('branches a legacy plan at its exact SubmitPlan result without importing later approval', async () => {
    const f = fixture();
    const planPath = join(f.parentPath, 'plans', 'plan.md');
    f.manager.appendMessage({ ...f.reply, stopReason: 'toolUse', content: [{
      type: 'toolCall', id: 'submit-this-plan', name: 'mcp__session__SubmitPlan', arguments: { planPath },
    }] });
    const planAnchor = f.manager.appendMessage({ role: 'toolResult', toolCallId: 'submit-this-plan',
      toolName: 'mcp__session__SubmitPlan', content: [{ type: 'text', text: 'Plan submitted' }],
      isError: false, timestamp: 5 });
    f.manager.appendMessage({ role: 'user', content: 'LATER-PLAN-APPROVAL-MUST-NOT-LEAK', timestamp: 6 });
    f.manager.appendMessage({ ...f.reply, timestamp: 7 });
    writeFileSync(join(f.parentPath, 'session.jsonl'), [
      { id: 'parent', workspaceRootPath: f.cwd, sdkCwd: f.cwd, sdkSessionId: f.manager.getSessionId() },
      { id: 'submit-tool', type: 'tool', toolName: 'mcp__session__SubmitPlan', toolUseId: 'submit-this-plan', toolInput: { planPath } },
      { id: 'selected-host-plan', type: 'plan', content: 'Plan content', planPath, timestamp: 5 },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    const { result } = await worker(f, { branchFromMessageId: 'selected-host-plan' });
    expect(result.type).toBe('ensure_session_ready_result');
    const file = SessionManager.findById(f.cwd, result.sessionId, join(f.childPath, '.pi-sessions'))!;
    const reopened = SessionManager.open(file);
    expect(reopened.getBranch().filter(entry => entry.type === 'message').at(-1)?.id).toBe(planAnchor);
    expect(JSON.stringify(reopened.getBranch())).not.toContain('LATER-PLAN-APPROVAL');
  }, 15000);

  it('correlates replies without provider IDs to persisted assistant entries, including after tool refresh', async () => {
    const f = fixture();
    const requests: unknown[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json());
      return new Response([
        { id: 'same-optional-provider-id', object: 'chat.completion.chunk', created: 1, model: 'branch-test',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'local reply' }, finish_reason: null }] },
        { id: 'same-optional-provider-id', object: 'chat.completion.chunk', created: 1, model: 'branch-test',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    try {
      const w = await worker(f, { baseUrl: `http://127.0.0.1:${server.port}/v1` });
      expect(w.result.type).toBe('ensure_session_ready_result');
      for (const id of ['first', 'second']) {
        if (id === 'second') w.send({ type: 'register_tools', tools: [{ name: 'local_test', description: 'unused', inputSchema: { type: 'object', properties: {} } }] });
        const previous = w.messages.length;
        w.send({ type: 'prompt', id, message: 'LOCAL-' + id, systemPrompt: 'Only reply, do not call tools.' });
        await w.wait(message => message.type === 'event' && message.event.type === 'agent_end' && w.messages.indexOf(message) >= previous);
      }
      const ends = w.messages.filter(message => message.type === 'event' && message.event.type === 'message_end' && message.event.message.role === 'assistant');
      const anchors = w.messages.filter(message => message.type === 'event' && message.event.type === 'pi_turn_anchor');
      expect(ends).toHaveLength(2);
      expect(anchors).toHaveLength(2);
      expect(ends[0].event.message.id).toBeUndefined();
      expect(new Set(ends.map(message => message.event.sdkMessageId)).size).toBe(2);
      const file = SessionManager.findById(f.cwd, w.result.sessionId, join(f.childPath, '.pi-sessions'))!;
      const journal = SessionManager.open(file);
      for (let index = 0; index < ends.length; index++) {
        expect(anchors[index].event.sdkMessageId).toBe(ends[index].event.sdkMessageId);
        expect(w.messages.indexOf(anchors[index])).toBeGreaterThan(w.messages.indexOf(ends[index]));
        expect(journal.getEntry(anchors[index].event.sdkTurnAnchor)).toMatchObject({ type: 'message', message: { role: 'assistant' } });
      }
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests)).not.toContain('FUTURE-INPUT');
      expect(JSON.stringify(requests[1])).toContain('LOCAL-first');
      expect(readdirSync(join(f.childPath, '.pi-sessions'))).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  }, 30000);
});
