> 独立评审原稿，未自动采纳。主报告与交叉讨论中的验证和纠错优先。实际调用标识：claude/claude-opus-5-5。不包含内部推理日志。

# Stair 只读评审（Claude 第 1 轮）

**结论：** 我找到 2 个我有把握的实质缺陷，都在 Pi 后端的回合和会话生命周期里。persistence-queue、stdout-backpressure、transport 里没找到我能确认的缺陷，所以没有凑数。所有复现都是静态推演，没有执行过。

## 缺陷 1：Pi 被停止的旧回合，其尾部事件会串进下一个回合

**位置**
- `packages/shared/src/agent/pi-agent.ts:2213`：`chatTurn` 用 `eventQueue.reset()` 开始新回合。
- `pi-agent.ts:2598-2637`：`forceAbort` 先在 2620 行把队列标记完成，2637 行才给子进程发 `abort`。
- `pi-agent.ts:1248-1339`：`handleSubprocessEvent` 不检查事件属于哪个回合，1337 行收到 `agent_end` 就结束队列。
- `packages/pi-agent-server/src/index.ts:2033`：`processMessage` 没有被 await，所以 `abort` 和 `prompt` 在子进程里并发处理。
- `index.ts:1525`：发出的 `event` 不带 prompt id。
- 停止入口在 `packages/server-core/src/sessions/SessionManager.ts:9518`：Pi 没有 `stopTurn`，所以直接走 `forceAbort`。

**触发方式**
- **重定向：** 回合运行中用户发新消息，但这时 `canSteerNow()` 为 false。这会走 `pi-agent.ts:2661` 的 `forceAbort(Redirect)`，把新消息放进队列，在 `onProcessingStopped` 后立即重放（`SessionManager.ts:8649-8690`）。
- **快速重发：** 用户点 Stop 后马上又发消息。
- **重试兜底：** event-adapter 的兜底计时器（`event-adapter.ts:258-275`）先把队列结束了，之后 SDK 才晚到地发出 `auto_retry_start`，重试的那次运行也会串进下一回合。

**后果（静态推演）**
1. 子进程在 `await piSession.abort()` 期间才发出旧运行的 `message_end(aborted)` 和 `agent_end`。
2. 主进程这时已经 `reset()` 并发出了新的 `prompt`，所以旧的 `agent_end` 被算进新回合，让新回合立刻结束，看起来是空回复。
3. 新运行之后的真实事件被放进一个已完成的队列，下次 `reset()` 时被清掉。
4. 最终 Craft 的对话记录里少了这条回复，但 Pi SDK 自己的日志里有，两边历史不一致。
5. 另外，如果新 prompt 赶在旧运行结束前到达子进程，会被当成 `followUp` 排队（`index.ts:1544`）。

**为什么现有保护拦不住**
- 只有 `prompt_accepted` 按 id 做了关联（`pi-agent.ts:991`），普通事件没有。
- `settlePendingSteers` 在没有待投递 steer 时直接返回（`pi-agent.ts:2680`）。
- Pi 没有实现 `settleStoppedTurnInput`（`SessionManager.ts:9521` 的分支对 Pi 不生效）。Claude 有 `stopTurn`/`stoppedTurnInputReceipt` 这套机制（`claude-agent.ts:3077-3114`），Pi 没有对应的东西。
- `resetRecoveryState` 只清计时器，不管外部晚到的事件。
- 测试没有覆盖"abort 之后旧的 `agent_end` 晚到"这种情况。

**置信度：** 中高。主进程这一侧的机制是确定的；子进程的输出时序取决于 abort 需要多久，所以是一个真实存在的竞态。

**最小修复**
- 子进程的 `handleAbort` 在 `await piSession.abort()` 之后发一条 `{type:'abort_settled'}`。stdout 是先进先出的，旧运行的事件一定在这条确认之前到达，和 `settle_steers` 用的是同一个前提。
- PiAgent 在 `forceAbort`/`abort` 时记下一个"等待确认"的 promise。`chatTurn` 在 2213 行 `reset()` 之前先 await 它，并设一个超时，超时就 kill 子进程。
- 另一个办法：子进程给每个 `event` 带上当前的 `promptId`，主进程丢掉和 `steeringTurnId` 不匹配的事件。比第一种多改一点协议。
- 想核实的测试：模拟子进程在新 prompt 发出之后再发一个旧的 `agent_end`，断言新回合没有被提前结束。

## 缺陷 2：子进程的 `ensureSession` 可以并发执行，会建出两个 AgentSession

**位置**
- `packages/pi-agent-server/src/index.ts:612-826`：没有单次执行保护，`piSession` 在 814 行才赋值。
- `index.ts:2033`：消息并发处理。
- `index.ts:1581-1585`：`handleRegisterTools` 只在 `piSession` 已存在时才设置 `toolsChanged`。
- `index.ts:1498-1510`：`handlePrompt` 重建会话时也有同样的时间窗口。
- 主进程一侧：`pi-agent.ts:629` 和 `2066-2091`，`set_auto_compaction` 在 15 秒超时后会继续往下走。

**触发方式（静态推演）**
1. 第一次 `ensureSession` 由 `set_auto_compaction` 引起，超过 15 秒还没完成（`createAuthenticatedRuntime`、`createCraftResourceLoader`、`createAgentSession` 慢都可能导致）。
2. 主进程超时后继续发 `register_tools`，接着发 `prompt`。
3. `handlePrompt` 看到 `piSession` 还是 null，于是第二次并发调用 `ensureSession`。

**后果**
- 会出现两个 SDK 会话。
- 恢复会话时，两个 `PiSessionManager.open` 打开同一个日志文件。
- `piSession` 被后完成的那个覆盖，而这个回合跑在函数内部的局部 `session` 上。之后的 abort、steer、compact 都作用在另一个会话上，Stop 停不下正在跑的回合。
- 另一个会话从不 dispose，泄漏了。
- 两次 `session_id_update` 中后到的那个会被持久化，它可能对应一个不含这段对话的会话。
- 另外，如果 `register_tools` 在 `buildProxyTools()` 之后、`piSession` 赋值之前到达，`toolsChanged` 不会被设置，新会话会一直缺少会话工具，直到下一次 `register_tools`。

**为什么现有保护拦不住**
- 只有主进程按顺序 await 各个 RPC。一旦超时，这个前提就不成立了。
- 子进程这边完全不做串行化。

**置信度：** 中。机制是确定的；触发需要首次建会话超过 15 秒，我没有验证 runtime 刷新是不是走网络。

**最小修复**
- 加一个 `let sessionCreation: Promise<AgentSession> | null`，`ensureSession` 发现正在创建时直接返回这个 promise。
- `handleRegisterTools` 改为在 `piSession || sessionCreation` 时都设置 `toolsChanged`。
- 用一个工具版本号代替 819 行无条件的 `toolsChanged = false`：在 `buildProxyTools` 时记下版本，建完后只有版本没变才清掉标志。

## 低置信度观察（未计入缺陷）

- `index.ts:1622-1640` 的 `handleAbort` 只处理了 `pendingPreToolUse`，没有处理 `pendingToolExecutions` 和 `prefetchCache` 里的 promise；代理工具的 `execute` 也不接收 AbortSignal（`index.ts:997`）。
- 如果 Pi SDK 的 `abort()` 会等工具执行完，那么一个长时间的 MCP 调用会把 abort 拖到主进程返回结果为止。采用缺陷 1 的修复后，这会直接变成下一回合的启动延迟。
- 需要先读一下 SDK 的 abort 语义再判断。如果属实，修法是把 `pendingToolExecutions` 也用 `{content:'Aborted', isError:true}` 结掉。

## 已检查、确认没问题的点

- **删除会话与正在进行的写入：** `deleteSessionAsync`（`storage.ts:519-526`）在存储事务里先 flush 再删，没有问题。
- **`persistSession` 的守卫：** `SessionManager.ts:3117` 已经挡住了会话删除后再写入的情况。
- **退出时 strict flush 失败：** Electron 会取消退出并提示用户（`apps/electron/src/main/index.ts:1414-1427`）。
- **persistence-queue：** 同一会话串行写、失败标记保留到下次成功、写失败时回滚元数据签名，这几处语义都是自洽的。
- **stdout-backpressure：** 不复制、不缓存待发数据；`wait(signal)` 在 abort 时会放行，符合 SDK 监听器的约定。
- **transport client：** 断线时会 reject 所有挂起的请求（`client.ts:751-757`）；输入丢失的情况已经由 `reconcileInput` 处理。

## 长期重构建议

**1. 抽一个 Pi 回合通道，让回合身份成为后端契约的一部分**
- **依据：** 缺陷 1。`chatTurn`、`forceAbort`、`handleSubprocessEvent` 和 adapter 的兜底计时器分别在改队列、id、计时器这些状态，没有一个统一的回合身份。Claude 已经有 stopped-turn 回执，Pi 没有。
- **抽取边界：** 新建 `backend/pi/turn-channel.ts`，管理 `turnId`、`EventQueue`、`pendingPromptId`、`steeringTurnId`、`abortReason`，以及 abort 确认的 promise。PiAgent 只负责创建通道和把事件交给它。子进程协议只多两个东西：`event.turnId` 和 `abort_settled`。
- **兼容性：** 主进程收到不带 `turnId` 的事件时按旧行为处理，保持与 upstream 兼容。
- **验收测试：**
  - 旧回合的 `agent_end` 不会结束新回合。
  - 兜底计时器触发后，晚到的重试事件会被丢弃。
  - steer 回执的顺序不变。
  - 现有的 `pi-steering`、`pi-compaction` 测试原样通过。

**2. 子进程命令分发分层，加单次执行的会话工厂**
- **依据：** 缺陷 2，以及 `handleInit`、`handlePrompt` 重建、`handleShutdown` 三处各自手写的销毁序列（unsubscribe、`steerDelivery.dispose`、`piSession.dispose`）。
- **抽取边界：** 新建 `session-lifecycle.ts`，统一管理 `piSession`、取消订阅、`steerDelivery`、`promptOverride`、工具版本号，只暴露 `ensure()`、`replace()`、`dispose()`。
- **分层方式：**
  - 生命周期类消息（init、ensure_session_ready、compact、set_auto_compaction、update_runtime_config、set_model、prompt 准入阶段）经过一个异步互斥锁。prompt 只在准入阶段持锁，不持到回合结束。
  - 控制类消息（abort、各种 response、steer、settle_steers、cancel_ephemeral_query、token_update）保持立即处理。
- **验收测试：**
  - 并发的 `ensure_session_ready` 和 `prompt` 只创建一个会话。
  - 会话创建期间收到的 `register_tools` 会触发重建。
  - prompt 运行中收到 re-init，旧会话会被 dispose。

**3. SessionManager：先统一"回合令牌"的判断，不拆文件**
- **依据：** grep 显示有几十处手写的 `processingGeneration !== x || (stopEpoch ?? 0) !== y` 组合（例如 1855、1869、9201、9525、9697、10094、12384 行），漏写一处就会出现过期回合继续写状态的问题。
- **抽取边界：** 只引入一个 `TurnToken {generation, stopEpoch}` 和 `isCurrentTurn(managed, token)` 纯函数，然后机械地替换调用点，不改任何行为。
- **验收测试：** 现有测试全部原样通过，再给令牌语义补单元测试。

## 不建议重构的部分

- **persistence-queue：** 刚加固过，strict 语义有测试；不要并进 storage 事务，也不要换成通用队列。
- **stdout-backpressure：** 小而正确，不要给它加消息缓存或重排。
- **event-adapter 的重试和溢出状态机：** 只在外面加回合门控，不要改内部。
- **SessionManager：** 不要因为它有 13k 行就按文件大小拆分。
- **transport：** 不需要改。
- **Pi SDK 接入方式：** 保持 `createAgentSession`、`continueRecent`、`findById` 的用法不变，以维持 upstream 兼容。