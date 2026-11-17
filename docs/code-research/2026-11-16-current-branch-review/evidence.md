# 复现与检查证据

本文件记录已运行的实验，不构成产品修复。所有实验导入当前工作树的实现，源码保持不变；配置、文件写入均在临时目录。未发送真实模型或消息平台请求。代码中的 key 都是测试虚构值。

基准分支 `codex/stair-rebuild-v2`，HEAD `d5a7157a`。开始时 2,718 个文件的 SHA-256 截至报告写入后仍一致；仅新增本审查目录。测试环境 Bun 1.3.5；CI 配置 1.3.10，未运行远端 CI。

**检查记录**

- `bun run typecheck:all`：退出 0；pages worker 不存在由脚本跳过。
- `bun run lint:guards`：退出 0。
- `bun run test:doc-tools`：40 tests，OK。
- 源码测试：原命令遇错停止；本次用原 `collectTestInventory` / `getTestGroup` 按相同分组逐组执行并继续收集，35 组汇总 7,760 pass / 32 fail / 12 skip。完整结构化计数见 [test-summary.json](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/test-summary.json)。临时 runner 结束码是 0，因为它负责收集结果；不能把它解释成测试全绿。
- 初次临时 profile 缺 config-defaults 的失败不计为生产缺陷；复制仓库 bundled defaults 后运行上述完整分组。
- 未运行打包、真实 Electron 多窗口、WebUI 浏览器全流程、真实 provider/消息平台测试。

全部临时原始执行日志保留在 `/tmp/stair-review-20261116`，该目录可能被系统清理；下方保存了五个实验的完整源码与结果。独立模型原稿只保存最终答复文本，不保存内部推理或原始流日志。

**32 个源码测试失败的归因**

| 分组 | 数量 | 已观察原因 |
| --- | ---: | --- |
| server-core | 19 | 五个测试文件的旧 fixture 缺 createManagedSession 必填 projectId，未到业务断言 |
| Electron browser manager | 3 | mock webContents 缺 isLoading |
| Electron attachment hydration | 1 | 截取源码执行的 fixture 未注入 useTransportConnectionState；嵌套失败不重复计数 |
| 独立 window manager lifecycle | 1 | Electron mock 未导出 ipcMain |
| 独立 PDF resize | 7 | 引入 diff Web Component 时 customElements 缺失，随后出现 Button 初始化继发错误 |
| 独立 ChatPage loading | 1 | Bun 测试加载器不能按 Vite 规则处理 pdf.worker.min.mjs?url 默认导出 |

这些归因帮助恢复测试基线，不代替在支持的 CI/runtime 上复核，也不代表相关产品功能已通过验收。

## B1 Claude 鉴权环境串用

运行命令：

```sh
bun /tmp/stair-review-20261116/repro-claude-auth.ts
```

实验代码：

```typescript
import { mock } from 'bun:test';
process.env.CRAFT_CONFIG_DIR = '/tmp/stair-review-20261116/test-config';
const root = '/Users/zhihu/code/m_code/ai/thinking-agent';
const storagePath = `${root}/packages/shared/src/config/storage.ts`;
const credentialsPath = `${root}/packages/shared/src/credentials/index.ts`;
const storage = await import(storagePath);
const credentials = await import(credentialsPath);
const connections: Record<string, any> = {
  a: { slug: 'a', providerType: 'anthropic', authType: 'api_key', baseUrl: 'https://a.example.invalid' },
  b: { slug: 'b', providerType: 'anthropic', authType: 'api_key', baseUrl: 'https://b.example.invalid' },
};
mock.module(storagePath, () => ({ ...storage, getLlmConnection: (slug: string) => connections[slug] }));
mock.module(credentialsPath, () => ({ ...credentials, getCredentialManager: () => ({ getLlmApiKey: async (slug: string) => `fake-key-${slug}` }) }));
const { ClaudeAgent } = await import(`${root}/packages/shared/src/agent/claude-agent.ts`);
const { buildClaudeSubprocessEnv } = await import(`${root}/packages/shared/src/agent/options.ts`);
const a: any = Object.create(ClaudeAgent.prototype);
const b: any = Object.create(ClaudeAgent.prototype);
a.config = { connectionSlug: 'a', envOverrides: { CRAFT_WORKSPACE_PATH: '/tmp/review-workspace-a' } };
b.config = { connectionSlug: 'b', envOverrides: { CRAFT_WORKSPACE_PATH: '/tmp/review-workspace-b' } };
await a.postInit();
const firstA = buildClaudeSubprocessEnv(a.config.envOverrides);
await b.postInit();
const nextA = buildClaudeSubprocessEnv(a.config.envOverrides);
console.log(JSON.stringify({
  scenario: 'A postInit → B postInit → A builds subprocess options',
  before: { baseUrl: firstA.ANTHROPIC_BASE_URL, fakeKey: firstA.ANTHROPIC_API_KEY },
  after: { baseUrl: nextA.ANTHROPIC_BASE_URL, fakeKey: nextA.ANTHROPIC_API_KEY },
  reproduced: nextA.ANTHROPIC_BASE_URL === connections.b.baseUrl,
  boundary: 'Actual postInit and buildClaudeSubprocessEnv; only connection and fake credential lookup mocked. No subprocess/provider request.',
}, null, 2));
```

观察输出：

```text
{
  "scenario": "A postInit → B postInit → A builds subprocess options",
  "before": {
    "baseUrl": "https://a.example.invalid",
    "fakeKey": "fake-key-a"
  },
  "after": {
    "baseUrl": "https://b.example.invalid",
    "fakeKey": "fake-key-b"
  },
  "reproduced": true,
  "boundary": "Actual postInit and buildClaudeSubprocessEnv; only connection and fake credential lookup mocked. No subprocess/provider request."
}
```

## B2 Pi 迟到终止事件

运行命令：

```sh
CRAFT_CONFIG_DIR=/tmp/stair-review-20261116/test-config bun /tmp/stair-review-20261116/repro-pi-late-end.ts
```

实验代码：

```typescript
import {PiAgent} from '/Users/zhihu/code/m_code/ai/thinking-agent/packages/shared/src/agent/pi-agent.ts';
import {AbortReason} from '/Users/zhihu/code/m_code/ai/thinking-agent/packages/shared/src/agent/core/session-lifecycle.ts';
const agent=new PiAgent({provider:'pi',isHeadless:true,workspace:{id:'review-pi',name:'Review',rootPath:'/tmp/stair-review-20261116/repro-workspace'} as any});
const internal=agent as any;const sent:any[]=[];let oldTerminal:any;
internal.subprocess={stdin:{writable:true}};internal.ensureSubprocess=async()=>{};
internal.send=(message:any)=>{sent.push(message);if(message.type==='abort')oldTerminal={type:'event',event:{type:'agent_end',messages:[],willRetry:false}};if(message.type==='prompt'){
 internal.handleLine(JSON.stringify({type:'prompt_accepted',id:message.id}));
 if(oldTerminal)internal.handleLine(JSON.stringify(oldTerminal));
}};
internal._isProcessing=true;agent.forceAbort(AbortReason.UserStop);
const events:any[]=[];for await(const event of internal.chatImpl('new input'))events.push(event);
console.log(JSON.stringify({scenario:'Stop old turn → start actual new chatImpl generator → deliver old agent_end after new prompt',sent:sent.map(x=>({type:x.type,id:x.id})),events,completedWithoutNewTurnResponse:events.some(x=>x.type==='complete')},null,2));
internal.subprocess=null;agent.destroy();
```

观察输出：

```text
{
  "scenario": "Stop old turn → start actual new chatImpl generator → deliver old agent_end after new prompt",
  "sent": [
    {
      "type": "abort"
    },
    {
      "type": "prompt",
      "id": "turn-1"
    }
  ],
  "events": [
    {
      "type": "input_accepted"
    },
    {
      "type": "complete"
    }
  ],
  "completedWithoutNewTurnResponse": true
}
```

## B3 文本 autosave 撤回

运行命令：

```sh
bun /tmp/stair-review-20261116/repro-autosave.ts
```

实验代码：

```typescript
import {ProjectTextDocumentController} from '/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/components/project-files/project-text-document-controller.ts';
const calls:any[]=[];const states:any[]=[];let finish:any;
const ctl=new ProjectTextDocumentController('p','notes.md','original',`sha256:${'a'.repeat(64)}`,request=>{calls.push(request);return new Promise(resolve=>{finish=resolve})},state=>states.push(state),5);
ctl.updateContent('edited');await Bun.sleep(20);
ctl.updateContent('original');await Bun.sleep(20);
finish({sourceFingerprint:`sha256:${'b'.repeat(64)}`,metadata:{projectId:'p',relativePath:'notes.md',name:'notes.md',mimeType:'text/markdown',byteLength:6,lastModifiedMs:Date.now()}});
await Bun.sleep(40);
console.log(JSON.stringify({scenario:'edit → autosave pending → revert to original → debounce expires → first save completes',writes:calls.map(x=>x.content),current:ctl.content,lastState:states.at(-1),expected:'a second autosave must persist original without explicit flush',reproduced:calls.length===1&&ctl.content==='original'&&states.at(-1)?.status==='dirty'},null,2));
ctl.dispose();
```

观察输出：

```text
{
  "scenario": "edit → autosave pending → revert to original → debounce expires → first save completes",
  "writes": [
    "edited"
  ],
  "current": "original",
  "lastState": {
    "status": "dirty",
    "error": null
  },
  "expected": "a second autosave must persist original without explicit flush",
  "reproduced": true
}
```

## B4 Gateway 计划执行契约

运行命令：

```sh
bun /tmp/stair-review-20261116/repro-gateway-plan.ts
```

实验代码：

```typescript
import { copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
const root = '/Users/zhihu/code/m_code/ai/thinking-agent';
const sandbox = mkdtempSync('/tmp/stair-review-20261116/gateway-plan-');
process.env.CRAFT_CONFIG_DIR = join(sandbox, 'config');
const { mkdirSync } = await import('node:fs');
mkdirSync(process.env.CRAFT_CONFIG_DIR, { recursive: true });
copyFileSync(join(root, 'apps/electron/resources/config-defaults.json'), join(process.env.CRAFT_CONFIG_DIR, 'config-defaults.json'));
const { SessionManager, createManagedSession } = await import(`${root}/packages/server-core/src/sessions/SessionManager.ts`);
const { createWorkspaceAtPath } = await import(`${root}/packages/shared/src/workspaces/index.ts`);
const { saveSession, sessionPersistenceQueue } = await import(`${root}/packages/shared/src/sessions/index.ts`);
const workspaceRoot = join(sandbox, 'workspace');
const workspace = createWorkspaceAtPath(workspaceRoot, 'Gateway plan review');
const sm = new SessionManager();
const id = 'gateway-plan-review';
const planPath = join(workspaceRoot, 'review-plan.md');
const managed = createManagedSession({ id, projectId: workspace.defaultProjectId }, { ...workspace, rootPath: workspaceRoot }, { messagesLoaded: true });
managed.messages = [{ id: 'plan-review', role: 'plan', content: 'A submitted plan', planPath, timestamp: Date.now() }] as any;
(sm as any).sessions.set(id, managed);
await saveSession({ id, workspaceRootPath: workspaceRoot, projectId: workspace.defaultProjectId, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any);
// Exact gateway preparation call; its /compact supplies neither a receipt nor executionId.
const record = await sm.setPendingPlanExecution(id, planPath);
const ready = await sm.markCompactionComplete(id, record.executionId);
let approvalError = '';
try { await sm.acceptPlan(id, planPath); } catch (error) { approvalError = String(error); }
await sm.clearPendingPlanExecution(id);
await sessionPersistenceQueue.flushAll();
console.log(JSON.stringify({
  scenario: 'Gateway setPendingPlanExecution → uncorrelated compaction completion → acceptPlan → no-id clear',
  approvedPlanMessageId: record.approvedPlanMessageId,
  markCompactionComplete: ready,
  approvalError,
  pendingStillPresent: !!managed.pendingPlanExecution,
  boundary: 'Real SessionManager lifecycle and disposable disk storage; compaction event simulated, no messaging/provider connection.',
}, null, 2));
```

观察输出：

```text
[session] Session gateway-plan-review: set pending plan execution for /tmp/stair-review-20261116/gateway-plan-pQTW2a/workspace/review-plan.md
[session] Session gateway-plan-review: compaction completion has no correlated pending plan; ignored
[session] Session gateway-plan-review: pending plan clear ignored (identity mismatch — no-identity command on an identified record)
{
  "scenario": "Gateway setPendingPlanExecution → uncorrelated compaction completion → acceptPlan → no-id clear",
  "approvedPlanMessageId": "plan-review",
  "markCompactionComplete": false,
  "approvalError": "Error: PLAN_ALREADY_APPROVED: this submitted plan already has an approval",
  "pendingStillPresent": true,
  "boundary": "Real SessionManager lifecycle and disposable disk storage; compaction event simulated, no messaging/provider connection."
}
```

## B5 Workbench fresh reconnect

运行命令：

```sh
bun /tmp/stair-review-20261116/repro-workbench-reconnect.ts
```

实验代码：

```typescript
import { spyOn } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
const repo = '/Users/zhihu/code/m_code/ai/thinking-agent';
const sandbox = mkdtempSync('/tmp/stair-review-20261116/workbench-reconnect-');
process.env.CRAFT_CONFIG_DIR = join(sandbox, 'config');
mkdirSync(process.env.CRAFT_CONFIG_DIR);
copyFileSync(join(repo, 'apps/electron/resources/config-defaults.json'), join(process.env.CRAFT_CONFIG_DIR, 'config-defaults.json'));
const config = await import(`${repo}/packages/shared/src/config/index.ts`);
const { createWorkspaceAtPath } = await import(`${repo}/packages/shared/src/workspaces/index.ts`);
const { createProject } = await import(`${repo}/packages/shared/src/projects/index.ts`);
const { RPC_CHANNELS } = await import(`${repo}/packages/shared/src/protocol/index.ts`);
const { registerWorkbenchLayoutHandlers } = await import(`${repo}/packages/server-core/src/handlers/rpc/workbench-layout.ts`);
const rootPath = join(sandbox, 'workspace');
const workspace = { ...createWorkspaceAtPath(rootPath, 'Workbench review'), rootPath };
const projectA = createProject(rootPath, { name: 'Project A' });
const projectB = createProject(rootPath, { name: 'Project B' });
const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace as any);
const handlers = new Map<string, any>();
registerWorkbenchLayoutHandlers({ handle: (key: string, handler: any) => handlers.set(key, handler), push() {}, invokeClient: async () => undefined, hasClientCapability: () => false, findClientsWithCapability: () => [] } as any, { sessionManager: {}, platform: { logger: console } } as any);
const read = handlers.get(RPC_CHANNELS.workbenchLayout.READ);
const write = handlers.get(RPC_CHANNELS.workbenchLayout.WRITE);
const windowA = { clientId: 'window-a', workspaceId: workspace.id, webContentsId: 1 };
const windowB = { clientId: 'window-b', workspaceId: workspace.id, webContentsId: 2 };
const empty = () => ({ primary: null, auxiliary: [], previewPanelId: null, focusedPanelId: null });
const withFile = (id: string) => ({ primary: null, auxiliary: [{ id, kind: 'project-file', relativePath: `${id}.md`, presentation: 'explicit', chatTargetSessionId: null, widthRatio: 1 }], previewPanelId: null, focusedPanelId: id });
const baseline = { version: 1, layoutsByProject: { [projectA.id]: empty(), [projectB.id]: empty() } };
await write(windowA, baseline);
await read(windowA);
await read(windowB);
const aDocument = { ...baseline, layoutsByProject: { ...baseline.layoutsByProject, [projectA.id]: withFile('a-file') } };
await write(windowA, aDocument);
await write(windowB, { ...baseline, layoutsByProject: { ...baseline.layoutsByProject, [projectB.id]: withFile('b-file') } });
const beforeReconnect = await read({ ...windowB, clientId: 'observer-before' });
// A reconnect after server retention expires receives a new clientId; renderer retains its local layout.
await write({ ...windowA, clientId: 'window-a-fresh' }, { ...aDocument, layoutsByProject: { ...aDocument.layoutsByProject, [projectA.id]: withFile('a-file-after-reconnect') } });
const afterReconnect = await read({ ...windowB, clientId: 'observer-after' });
console.log(JSON.stringify({
  scenario: 'A and B share baseline → independent project edits → A obtains fresh clientId → A changes only project A',
  projectBBefore: beforeReconnect.layoutsByProject[projectB.id].auxiliary.map((panel: any) => panel.id),
  projectBAfter: afterReconnect.layoutsByProject[projectB.id].auxiliary.map((panel: any) => panel.id),
  reproduced: beforeReconnect.layoutsByProject[projectB.id].auxiliary.length === 1 && afterReconnect.layoutsByProject[projectB.id].auxiliary.length === 0,
  boundary: 'Actual READ/WRITE handlers and disk storage; fresh-client reconnect context simulated, not a running browser/WebSocket reconnect.',
}, null, 2));
lookup.mockRestore();
```

观察输出：

```text
{
  "scenario": "A and B share baseline → independent project edits → A obtains fresh clientId → A changes only project A",
  "projectBBefore": [
    "b-file"
  ],
  "projectBAfter": [],
  "reproduced": true,
  "boundary": "Actual READ/WRITE handlers and disk storage; fresh-client reconnect context simulated, not a running browser/WebSocket reconnect."
}
```

