> 独立评审原稿，未自动采纳。主报告与交叉讨论中的验证和纠错优先。实际调用标识：claude/claude-opus-5-5。不包含内部推理日志。

# 架构评估终稿（后端与依赖方向为主）

## 0. 总体结论

- **服务端抽取确实完成了。** Electron（`apps/electron/src/main/index.ts:636-723`）和独立 server（`packages/server/src/index.ts:146-235`）都通过 `bootstrapServer`（`packages/server-core/src/bootstrap/headless-start.ts:331-436`）组装，`PlatformServices` 注入也真实生效。messaging-gateway 只依赖 `ISessionManager` 类型，依赖方向正确。
- **主要问题不在包结构，而在状态归属。** 同一个会话的状态分散在 7 处：`ManagedSession`（`SessionManager.ts:759-1074`，约 120 个字段）、agent 实例、sessionId 为键的全局回调注册表、mode-state、`toolMetadataStore` 单例、`process.env`，以及客户端（renderer 和消息网关）各自持有的多步协议状态。大部分时序约束只写在注释里，接口本身不表达。
- 下面的重构候选里，有两项本身就是在修确认的缺陷。

---

## 1. 重构候选（按收益/风险排序）

### ① Claude 鉴权从 `process.env` 改为按会话传入子进程 env（收益高，风险低）

**证据和耦合**
- `ClaudeAgent.postInit()` 先删除 auth 变量，再把当前连接的凭据写入全局 `process.env`（`packages/shared/src/agent/claude-agent.ts:963-987`）。
- `SessionManager.reinitializeAuth()` 做同样的事（`SessionManager.ts:2933-2940`）。它在启动时和 RPC 保存连接时都会被调用（`handlers/rpc/llm-connections.ts:315,499,567`）。
- 子进程 env 由 `{...process.env, ...envOverrides}` 构成（`agent/options.ts:186-193`）。但 `envOverrides` 只含 `CRAFT_WORKSPACE_PATH` 和 HAIKU 模型（`SessionManager.ts:4817-4823`），不含凭据。
- 注释写的是"applies to process.env + envOverrides"（`config/llm-connections.ts:1110`），实际代码只写了 `process.env`。

**已付成本**：注释里自己承认"concurrent sessions mutating process.env"（`options.ts:183-184`）。当前靠"postInit 离 spawn 足够近"这个隐性时序来兜底。

**建议职责和接口**：`ClaudeAgent` 持有 `private authEnv: Record<string,string>`，`postInit` 只填它，不再写 `process.env`。`getDefaultOptions`/`getTextCompletionOptions` 改成接收 `{...envOverrides, ...authEnv}`。`buildClaudeSubprocessEnv` 先从继承来的 env 中剔除受管 auth 键，再叠加会话值。

**复用**：`resetManagedAnthropicAuthEnvVars` 已有的"受管键 + baseline"概念，可以直接用作剔除名单和 `authType: 'environment'` 的回退来源。

**为何不大改**：不需要设计 provider 级的 auth 抽象，Pi 已经显式传 env（`pi-agent.ts:545`）。

**第一步和验收**
- 第一步：只改 `buildClaudeSubprocessEnv`，增加 `authEnv` 参数。
- 验收：单测构造两个连接不同的 ClaudeAgent（API key+baseUrl 和 OAuth）各自 postInit，断言两者 options.env 中的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` 互不串用。

**可反驳点**：summarization client 依赖 `process.env`（`resetSummarizationClient`），所以 `reinitializeAuth` 写全局 env 这一步要保留。只要子进程 env 不再继承它，就不会互相污染。

### ② Accept & Compact 收口为一个服务端命令（收益高，风险中，同时修 bug B1）

**证据和耦合**
- 服务端对计划执行有严格的多步协议：
  1. `setPendingPlanExecution` 生成 `executionId`（`SessionManager.ts:6470-6582`）；
  2. `/compact` 只有在同时具备草稿消费回执和 `options.planExecutionId` 时，才会打上 `compactionTurn` 关联（`:8923-8929`）；
  3. 关联后 `markCompactionComplete` 置为就绪（`:6683-6715`）；
  4. 最后 `onProcessingStopped` 自动 dispatch（`:10255-10268`）。
- 这个协议以 8 个方法的形式泄漏到 `ISessionManager`（`session-manager-interface.ts:208-243`），由客户端自己编排。
- 消息网关另写了一套简化版：`setPendingPlanExecution` + `sendMessage('/compact')`，收到 `compaction_complete` 后再 `acceptPlan` + 不带 id 的 `clearPendingPlanExecution`（`messaging-gateway/src/gateway.ts:631-641, 761-779, 355`）。

**已付成本**：网关这条路径实际不可用（见 B1），而网关测试完全 mock 了这几个方法（`__tests__/gateway-button-perm.test.ts:128-131`），所以协议漂移不会被测试发现。

**建议接口**：`acceptPlanWithCompaction(sessionId, planMessageId, opts?: { draftSnapshot?, references? }): Promise<{ executionId }>`。由服务端在同一把 lifecycle lock 内完成 set → consume（无草稿时写空回执）→ 发送带 `planExecutionId` 的 `/compact`。完成后的 dispatch 本来就在服务端。

**复用**：现有的 `withSessionLifecycleLock`、`consumeSessionDraftForPlan`、自动 dispatch 分支都可以直接用，不新增状态机。

**为何不大改**：renderer 侧的草稿协调（`session-draft-coordinator.ts`）有本地编辑竞争语义，暂时保留它的多步调用。先让网关和将来的 CLI 走单命令。

**第一步和验收**
- 第一步：在 server-core 实现该方法，只让网关改用，删除 `pendingCompactAccepts`。
- 验收：用**真实 SessionManager**（参照现有 `pending-plan-*.fixture.ts`）写一个网关集成测试，断言最终只有一条 approval 消息，且 pending 记录被清除。

**可反驳点**：如果要求草稿回执的本意就是"只有 renderer 能发起"，那就需要显式声明一种"无草稿发起者"的回执语义。这是一个需要明确做出的决策。

### ③ 收拢 sessionId 为键的全局状态，明确归属方（收益中，风险低）

**证据**
- 回调注册表由两方写入，且语义不一致：
  - `ClaudeAgent` 构造时用 `register`（**整体替换**）（`claude-agent.ts:932`），销毁时整体 `unregister`（`:3276`）；
  - Pi 只做 unregister（`pi-agent.ts:2768,2781`）；
  - SessionManager 在 agent 构造之后 `merge` 浏览器、pages、prWatch 等回调（`SessionManager.ts:5141,5772`），并在 `:4557,8130,13224` 也做 unregister。
- 其他同类全局状态：
  - `initializeModeState(sessionId)`（`claude-agent.ts:922`）；
  - `toolMetadataStore` 单例 `_sessionDir`（`interceptor-common.ts:33,451`）；
  - SessionManager 每次创建 agent 都改写 `process.env.CRAFT_SESSION_DIR` 并调用 `setSessionDir`（`SessionManager.ts:4790-4791, 9085`）。Claude CLI 不运行拦截器（`claude-agent.ts:433` 注释），Pi 显式传 env，主进程的读取都带显式 dir（`tool-matching.ts:352`、`pi/event-adapter.ts:956`）。因此这两处写入基本是遗留代码。

**已付成本**：正确性依赖"merge 必须在 agent 构造之后，且每次重建都经过 `getOrCreateAgent`"这一顺序。

**建议接口**：只有一个归属方，即 SessionManager 在会话级 register。agent 用 `merge` 加自己的键（`queryFn`/`spawnSessionFn`），销毁时只删自己的键。只需加一个函数：`removeSessionScopedToolCallbacks(sessionId, keys)`。不要做成通用 registry 框架。

**第一步和验收**
- 第一步：`claude-agent.ts:932` 改为 merge，`:3276` 改为只删自己的键；删除 `SessionManager.ts:4787-4791` 中写 env 的那段。
- 验收：新增测试"merge 宿主回调 → 销毁 agent → 宿主回调仍在"；`interceptor-common` 和 pi event-adapter 的现有测试通过。

**可反驳点**：当前路径下这不是实际 bug，收益主要是去掉时序约束。

### ④ 从 `getOrCreateAgent` 中抽出纯装配代码（长期收益最高，风险低到中）

**证据**
- `getOrCreateAgent` 约 1500 行（`SessionManager.ts:4737` 到约 6270）。里面混着：sources/MCP pool、闭包式 sessionConfig、浏览器工具（约 5060-5395）、权限请求（5396）、计划提交（5542）、spawn（5698）、会话工具回调（5772-6160）、source 激活（6165）。
- agent 创建点有 4 个，各自拼一份配置子集：`:4935`、`:7717`（标题）、`:11438`、`:12833`。
- `ISessionManager` 有约 90 个方法。Electron thin-client 只是为了满足 `HandlerDeps`，就构造了一个从不 `initialize()` 的完整 SessionManager（`apps/electron/src/main/index.ts:1100-1110`）。

**已付成本**：13230 行的单文件；几十个 `.fixture.ts` 都必须构造整个 SM 才能测一个分支。

**建议做法和复用**：照抄仓库里已有的模式 `buildPagesToolCallbacks`、`buildPrWatchToolCallbacks`、`buildDecisionToolCallbacks`、`buildMcpSourceToolCallbacks`（`SessionManager.ts:86-93`）：纯函数加窄参数，不引入类层级，也不引入事件总线。

**为何不大改**：`sendMessage`（9 个位置参数，含内部参数 `_isAuthRetry`/`internalContinuation`，`:8227-8258`）、`processEvent`、`onProcessingStopped` 里有密集的 generation/stopEpoch 不变量和大量回归 fixture。现在拆出 TurnController 风险高、收益不确定。装配代码行数多、不变量少，适合先动。

**第一步和验收**
- 第一步：把浏览器工具回调搬到 `sessions/browser-tool-callbacks.ts`，签名为 `buildBrowserToolCallbacks({ sid, workspaceId, projectId, bpm, log })`。
- 验收：`browser-window-scope.test`、`browser-password-redaction.test`、`sessions-browser-release.test` 通过，SessionManager 减少约 330 行，行为不变。

**可反驳点**：纯搬移会让 diff 变大、git blame 断开，需要接受这个代价。

### ⑤ PreToolUse 判定后的处理收口（收益中，风险中）

**证据**
- `runPreToolUseChecks` 已经共享，但拿到结果之后的处理在 Claude（`claude-agent.ts:1445-1600`）和 Pi（`pi-agent.ts:1413-1550`）各写了一份，而且已经分叉：
  - `source_activation_needed`：Claude 阻断，并让模型告诉用户"重发请求"；Pi 激活 source、入队 `source_activated`，然后重跑整条检查管线；
  - `prompt` 等待逻辑（`pendingPermissions` 加 PermissionRequest 组装）重复了一份；
  - `__PERMISSION_BLOCK__` 以字符串形式塞进 debug 通道，再由 `SessionManager.ts:5001-5025` 解析，形成跨包的字符串协议。

**建议接口**：`awaitPermissionPrompt(checkResult, ctx): Promise<boolean>`，加上一个类型化回调 `onPermissionBlocked?(payload)`，替代这个 marker 字符串。source 激活策略作为参数传入（`availability: 'immediate' | 'next-turn'`，`session-tools-core/src/context.ts:436-437` 已经说明 Claude SDK 在 query 开始时冻结 mcpServers），不强行统一。

**第一步和验收**
- 第一步：只抽出 prompt 等待。
- 验收：新增 parity 测试，断言同一 checkResult 在两个 backend 下产生字段完全一致的 PermissionRequest；现有 `session-tool-parity.test` 通过。

**可反驳点**：分叉中有一部分可能是有意为之（SDK 能力差异），不要为了"对称"而统一行为。

### ⑥（低优先）把客户端传输契约移出 Electron 应用

WebUI 通过相对路径直接引用 Electron 源码中的 `channel-map`、`build-api`、`source-oauth` 和 `ElectronAPI` 类型（`apps/webui/src/adapter/web-api.ts:14-23`）。服务端已经独立，客户端契约还没有。
- 第一步：把 `channel-map.ts` 和 `build-api.ts` 移到 `packages/shared/src/protocol/` 下，Electron 侧改为 re-export。
- 验收：`webui:typecheck` 不再出现 `../../../electron`。

---

## 2. 不值得重构的部分

1. **TaskRunner / `ConductorSessionHost`**（`tasks/TaskRunner.ts:53-66`）：接口窄，先订阅再发送（`:239,442`），可以 mock。唯一的小问题是 `SessionCompletionEvent` 从 SessionManager 导入（`:24`），下次碰到时顺手移到小类型文件即可。
2. **`PlatformServices`、`bootstrapServer`、`BaseEventAdapter`、`CredentialManager`**：抽象规模和实际差异相符，再加接口只会增加维护成本。`headless-start.ts:380-397` 的 duck-typing 只是表面问题。
3. **shared 内的 config↔credentials↔sessions 环**（结构扫描的第一个环）：主要经由 barrel 文件和函数内调用形成，不是顶层求值依赖。打破它需要大范围重组，收益很低。约束好"不新增顶层副作用"就够了。
4. **`packages/session-mcp-server`：应删除，不值得重构。** 仓库里没有任何启动它的代码，它的 `__CALLBACK__` stderr 协议和 HTTP 回调是为 Codex/Copilot 设计的，而工厂只剩 `anthropic` 和 `pi`（`backend/factory.ts:132-145`）。`@github/copilot-sdk` 依赖也一并检查。删除前先确认外部打包流程没有引用它。

---

## 3. 确认的 bug 与设计风险

**确认 bug（通过阅读代码路径推断，未实际运行）**
- **B1 网关的 Accept & Compact 不可用。**
  1. 网关的 `/compact` 没有 `planExecutionId`，也没有消费回执，所以服务端不会关联（`SessionManager.ts:8926`）；
  2. 因此 `markCompactionComplete` 返回 false，服务端不会自动 dispatch；
  3. 网关随后调用 `acceptPlan`，此时 `pendingPlanExecution.approvedPlanMessageId` 已经被设置（`:6487`），于是抛出 `PLAN_ALREADY_APPROVED`（`:6411-6413`）；
  4. 即使 planPath 不匹配、没有抛错，后面不带 id 的 `clearPendingPlanExecution` 也会被身份校验忽略（`:7178-7181`），记录残留。
- **B2 Claude 多连接场景下凭据可能串用（高置信度，建议用双连接复现）。** 见候选①。触发条件：至少两个 Anthropic 系连接，且某个子进程在另一个连接 `postInit`/`reinitializeAuth` 之后才 spawn（关闭 keep-alive 时每轮都 spawn；开启时在首轮和恢复重启时 spawn）。
- **B3（轻微）独立 server 的"非本地地址且无 TLS"拒绝检查发生得太晚。** 检查在 `bootstrapServer` 已 `listen`（`headless-start.ts:409`）并打印 token（`server/index.ts:281-283`）之后才执行（`:289-310`）。

**仅设计风险**
- Pi/Claude turn anchor 读-改-写用非原子的 `writeFile`（`SessionManager.ts:300-318`）。文件损坏会被 catch 静默当成空索引，导致分支回退到全量历史。
- thin-client 中未初始化的 SessionManager 注册了全部核心 handler（`index.ts:1100-1110`）。如果有 LOCAL_ONLY 通道走到 `waitForInit`，会永久挂起。
- `drafts.json` 是一个全局文件，内联 base64 附件，每次保存都整体重写（`config/storage.ts:1200, 1529-1533`），有规模风险。plan 回执也放在这里，位置不合适。
- `sendMessage` 的位置参数里混入内部参数，外部调用方都用两参数形式，容易误用。
- 网关测试 mock 整个 `ISessionManager`，协议漂移无法被测试发现。

---

## 4. 实际覆盖范围（约 55 次工具调用）

**深读的部分**
- SessionManager：头部、`ManagedSession`、类字段、`getOrCreateAgent` 前约 400 行、`sendMessage` 准入段、计划执行全部方法、compaction 关联、`onProcessingStopped` 片段、`refreshTitle`、`reinitializeAuth`/`initialize`。
- `AgentBackend` 类型、BaseAgent 方法清单、Claude 的 `postInit`/chat options/PreToolUse、Pi 的 PreToolUse、`options.ts`、`interceptor-common`、`resolveAuthEnvVars`。
- `BaseEventAdapter`、回调注册表、TaskRunner 接口和派发、`platform.ts`、bootstrap、server 入口、Electron 主进程两条启动路径、`HandlerDeps`/`ISessionManager`。
- 消息网关的计划路径、`config/storage` 清单和 drafts 段、`session-tools-core` 的 context、`session-mcp-server`、工厂、根 `package.json` 脚本、`run-source-tests`、WebUI 的导入。

**只看了清单或没读的部分**：renderer/ui 全部组件、`browser-pane-manager.ts`、`pi-agent-server`、whatsapp worker、automations/decisions/pr-watch/sources 内部实现、`processEvent` 和 `sendMessage` 的大部分主体、transport server/codec、CLI 主体。

**留给主审交叉验证的问题**
- B2 需要双连接实测；
- B1 需确认"无草稿发起者"是否属于被有意禁止的场景；
- ④ 的搬移粒度是否值得接受 blame 断开的代价。