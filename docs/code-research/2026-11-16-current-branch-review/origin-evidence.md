# 来源对照实验记录

上游基准：Craft v0.15.6 / `8df01c5d0ac73c35add5954e6f190ce038d35845`。独立 detached 检出：`/tmp/stair-origin-review-20261116/craft-v0.15.6`，已核对该工作树无源码修改。

只读来源比对包含线上确认的 v0.15.9 / `3ce9fc12837541d688a59a8f0a2e9755ceb89ac2`；两项 P1 的受控运行复现是在 v0.15.6 执行，不声称运行了 v0.15.9 release。

运行环境复用本机 Bun 1.3.5 与已安装外部依赖；`@craft-agent/*` workspace 链接指向隔离检出自身。配置与文件写入均在独立临时目录。未使用用户真实凭据，未调用真实模型或消息平台。

完整方法体比对结果见 [origin-block-comparison.json](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/origin-block-comparison.json)。v0.15.9 的环境构造函数有工具搜索/拒绝 fallback 开关变化，但鉴权仍继承全局环境；不能把该函数整体描述成三个版本完全相同。

## Craft 上的 Claude 鉴权复现

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

## Craft 上的 Pi 迟到终止事件复现

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
      "type": "complete"
    }
  ],
  "completedWithoutNewTurnResponse": true
}
```

## 网关调用契约：Craft

```text
[session] Session plan-comparison: set pending plan execution for /tmp/stair-origin-review-20261116/plan-compare-S7kkV6/workspace/plan.md
[session] Session plan-comparison: compaction marked complete for pending plan
[session] Session plan-comparison: cleared pending plan execution
{
  "repo": "/tmp/stair-origin-review-20261116/craft-v0.15.6",
  "ready": true,
  "approvalError": null,
  "approvalSends": 1,
  "pendingStillPresent": false,
  "boundary": "Real SessionManager operations and storage, compaction completion simulated, sendMessage replaced with a local recorder; no external model/messaging calls."
}
```

## 同一脚本网关调用契约：Stair

```text
[session] Session plan-comparison: set pending plan execution for /tmp/stair-origin-review-20261116/plan-compare-gLlOhR/workspace/plan.md
[session] Session plan-comparison: compaction completion has no correlated pending plan; ignored
[session] Session plan-comparison: pending plan clear ignored (identity mismatch — no-identity command on an identified record)
{
  "repo": "/Users/zhihu/code/m_code/ai/thinking-agent",
  "ready": false,
  "approvalError": "Error: PLAN_ALREADY_APPROVED: this submitted plan already has an approval",
  "approvalSends": 0,
  "pendingStillPresent": true,
  "boundary": "Real SessionManager operations and storage, compaction completion simulated, sendMessage replaced with a local recorder; no external model/messaging calls."
}
```

## 网关对照脚本

同一脚本分别传入两个源码根目录。真实 SessionManager 和磁盘操作；只把实际发送替换为本地 recorder，并模拟压缩完成。

```typescript
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
const repo = process.argv[2]!;
const sandbox = mkdtempSync('/tmp/stair-origin-review-20261116/plan-compare-');
process.env.CRAFT_CONFIG_DIR = join(sandbox, 'config');
mkdirSync(process.env.CRAFT_CONFIG_DIR);
copyFileSync(join(repo, 'apps/electron/resources/config-defaults.json'), join(process.env.CRAFT_CONFIG_DIR, 'config-defaults.json'));
const { SessionManager, createManagedSession } = await import(`${repo}/packages/server-core/src/sessions/SessionManager.ts`);
const { createWorkspaceAtPath } = await import(`${repo}/packages/shared/src/workspaces/index.ts`);
const { saveSession, sessionPersistenceQueue } = await import(`${repo}/packages/shared/src/sessions/index.ts`);
const rootPath = join(sandbox, 'workspace');
const workspace = { ...createWorkspaceAtPath(rootPath, 'Plan comparison'), rootPath };
const sm = new SessionManager();
const id = 'plan-comparison';
const planPath = join(rootPath, 'plan.md');
const managed = createManagedSession({ id, projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true, permissionMode: 'ask' });
managed.messages = [{ id: 'plan-message', role: 'plan', content: 'A plan', planPath, timestamp: Date.now() }];
sm.sessions.set(id, managed);
await saveSession({ id, workspaceRootPath: rootPath, projectId: workspace.defaultProjectId, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } });
const sends: string[] = [];
sm.sendMessage = async (_id: string, message: string) => { sends.push(message); };
const record = await sm.setPendingPlanExecution(id, planPath);
await sm.markCompactionComplete(id, record?.executionId);
const ready = managed.pendingPlanExecution?.awaitingCompaction === false;
let approvalError: string | null = null;
try { await sm.acceptPlan(id, planPath); } catch (error) { approvalError = String(error); }
await sm.clearPendingPlanExecution(id);
await sessionPersistenceQueue.flushAll();
console.log(JSON.stringify({ repo, ready, approvalError, approvalSends: sends.length, pendingStillPresent: !!managed.pendingPlanExecution, boundary: 'Real SessionManager operations and storage, compaction completion simulated, sendMessage replaced with a local recorder; no external model/messaging calls.' }, null, 2));
```

## 上游夹具验证

```sh
CRAFT_CONFIG_DIR=/tmp/stair-origin-review-20261116/test-profile bun test \
  packages/server-core/src/sessions/automation-loop-and-retry.test.ts \
  packages/server-core/src/sessions/background-task-stop.test.ts \
  packages/server-core/src/sessions/browser-password-redaction.test.ts \
  packages/server-core/src/sessions/handoff-summary.test.ts \
  packages/server-core/src/sessions/turn-usage.test.ts
```

```text
(pass) SessionManager turn usage > keeps a Claude session cost at the SDK running total instead of the sum of totals [3.31ms]
(pass) SessionManager turn usage > reads a branch's parent from memory, else from its header on disk [1.17ms]

 32 pass
 0 fail
 85 expect() calls
Ran 32 tests across 5 files. [632.00ms]
```

其他两个 P1 实验沿用 [前次复现源码](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/evidence.md)，只把导入根目录和临时配置目录替换成隔离检出对应路径。Pi 上游没有 Stair 新增的 input_accepted 输出，错误提前 complete 的结果一致。
