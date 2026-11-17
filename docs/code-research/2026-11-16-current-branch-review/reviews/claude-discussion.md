> 独立评审原稿，未自动采纳。主报告与交叉讨论中的验证和纠错优先。实际调用标识：claude/claude-opus-5-5。不包含内部推理日志。

# Claude 对 GLM 方案的交叉讨论

我没有运行主审的四个复现，下文引用的都是主审给出的证据。我和 GLM 观点重合，不能当作结论正确的证明。

## 一、修订我自己的原结论

- **B2（Claude 鉴权串用）升级为 P1。** 主审的复现说明不需要并发：A 在 B `postInit` 之后重建 options，就会拿到 B 的 baseUrl 和 key，keep-alive 也兜不住。验收必须覆盖所有受管键：API key、OAuth、`environment`、miniModel。
- **原④"先从 getOrCreateAgent 抽纯装配"降级到协议修复之后。** 已验证的故障都在协议层，搬移装配一个也修不了。而且 19 个 server-core fixture 目前是红的，搬完也没法验收。
- **原③"回调注册表归属"降为碰到时顺手处理**，它不是 bug。
- **原⑥"把 channel-map 搬到 shared"降级。** 搬文件不会让 `any` 消失，应该先补类型。
- **session-mcp-server 删除**维持低优先，前提是确认打包流程不引用它。
- **我漏掉了两处**：Pi 旧 `agent_end` 误结算（P1）和 text autosave，都以主审证据为准。

## 二、对 GLM 建议的评价

**同意：**
1. event-processor、ws 传输三件套、project-files 安全面、gateway 现有分文件结构都应保留，这和主审的反证一致。
2. GLM 在 Project File 一项给出的反驳点（先写对照测试，再决定是否合并）比它自己的主张更站得住。
3. config 做 Node/浏览器分离的方向正确，但范围应收窄，见 Q5。

**不同意或应缩小：**
1. "本轮未发现确认 bug"已不成立，主审复现了 4 个。
2. SessionManager 拆成四个服务、依赖 `{getManagedSession, persist, emit, rpcServer}`：这等于把整个 ManagedSession 交出去，耦合没有减少，只是换了文件。
3. 把 DraftUiEventBus 作为第一步：给事件改名并类型化，不会改变 flush→restore→ACK 的顺序协议，源码切片测试也依然存在。
4. 拆 BrowserPaneManager 的 toolbar：CDP、router、ownership 已经抽出，native 截图生命周期不能机械拆分，而且没有已验证故障支撑，移出前 5。
5. "shim 全部 throw"需要校准。实际是 no-op、fallback、throw 混合。真正的风险是假实现掩盖了平台依赖，其中 no-op 比 throw 更危险，因为它静默。
6. 依据"70% 同构"抽通用 writer：只有两份实现，冲突语义也不同（changeSeq 对 fingerprint），应暂缓。

## 三、六个指定问题

**Q1 先收口协议，800 行暂不搬，这样最合算。**
- 服务端新增单一入口 `acceptPlanWithCompaction`：在同一把 lifecycle lock 内完成 set → 写显式"无草稿发起者"回执 → 发送带 `planExecutionId` 的 `/compact`。
- 网关删除 `pendingCompactAccepts`，以及后续的 `acceptPlan` 和不带 id 的 `clear`。
- 以后若要把 PendingPlanExecution 搬出去，不传 ManagedSession，只给一个窄 host：
  - `withLifecycleLock(sid, fn)`
  - `getPlanRecord/setPlanRecord(sid)`
  - `persist(sid)`（走严格 flush）
  - `dispatch(sid, exec)`
- dispatch 的触发点仍留在 `onProcessingStopped`，和 generation/stopEpoch 放在一起。
- 搬移的前提有两个：先修好 fixture，再有基于真实 SM 的网关集成测试。

**Q2 只在上层检查 generation 挡不住。** 误归属发生在 PiAgent 内部：`chatTurn` reset 之后，`handleSubprocessEvent` 把旧的 `agent_end` 当成当前回合结束，新生成器随即产出 complete。上层看到的是一个属于新 generation、看起来完全合法的事件。屏障因此必须放在 PiAgent 里，分两步：
- **(a) 停止结算屏障**：`forceAbort` 后进入 settling 状态，确认旧回合 idle（对应 SDK 的 abort → waitForIdle）之后才发送新 prompt。超时就重启子进程，而不是放行。
- **(b) 回合身份**：由 pi-agent-server 给事件附上 turnId，PiAgent 丢弃不匹配的事件。

对无 turnId 的事件静默兼容，等于保留漏洞。server 和 client 同仓同步发布，没有理由兼容。如果确实必须兼容，就只依赖 (a) 做串行化并记日志，不能用"没有 id 就算当前回合"。

**Q3 只改名不够。**
- 把 FreeFormInput 里 flush/restore/merge/ACK 的步骤收进现有的 SessionDraftCoordinator / PendingInputJournal，测试直接调用这些方法，从而去掉 `sourceBetween`。
- DOM 事件只保留为按 sessionId 寻址的通知，用来支持多面板。事件名顺手集中到一个常量加类型联合即可，不叫 bus。
- 不新建 PlanApprovalCoordinator。服务端改成单命令后，renderer 侧只剩草稿相关的部分，放进现有 coordinator 就够了。

**Q4 同意。**
- 修复：`startSave` 先检查 `savePromise`，如果在飞就置 `saveAgain` 后返回；或者在 finally 里重新比较 current 和 persisted。
- 参数化契约测试对两个控制器都跑以下场景：在途期间编辑后又撤回、flush、retry、关闭。
- 通用 writer 暂缓。

**Q5 同意先切叶子导入并加 guard。**
- 仿照 `check-raw-sends.sh` 在 lint:guards 里加规则：renderer、webui、ui 禁止导入 config 桶以及 storage/watcher，只放行已证明 browser-safe 的子路径（draft-content 是现成先例）。
- 测试里误引入 DOM runtime 的链路，也用同一个 guard 查出来。
- 不改 config/index 的导出。"读配置会创建工作区"这个副作用单独记录。

**Q6 渐进增强契约。**
- 在 CHANNEL_MAP 旁加一个只有类型、没有运行时的 `ChannelContracts`。先覆盖计划执行、草稿、项目文件保存这几类通道。
- `HandlerFn` 和 `buildClientApi` 按 key 推导参数与返回值，未覆盖的通道暂时保持 `any`。guard 要求新增通道必须带合约。
- 网关走的是 ISessionManager，所以跨客户端契约还需要随 Q1 一起收窄计划相关方法。
- 合约类型稳定之后，再放进 shared 的叶子模块，替换 WebUI 里的 `../../../electron` 相对导入。

## 四、前 5 项（按长期收益与现实风险排序）

1. Pi 回合身份加停止结算屏障（P1，回合所有权，中风险）
2. Claude 鉴权改为按会话传 env（P1，低风险）
3. 计划执行收口为服务端单入口，网关迁移过去（协议漂移，低到中风险）
4. renderer 提交/恢复协议收进现有 coordinator，消除源码切片测试
5. browser-safe 导入 guard 加关键通道类型合约

不进前 5、但应随手修的小项：text autosave 加契约测试、`main.tsx` 的 ErrorBoundary、server 的 TLS 检查顺序。

## 五、第一批 3 个可独立交付的改动

前置工作：修复 19 个 server-core fixture 缺 `projectId` 的问题，否则第 3 项无法验收。

1. **Claude `authEnv`**
   - 改动：`buildClaudeSubprocessEnv` 先剔除继承来的受管键，再叠加会话自己的值。`postInit` 不再写 `process.env`，summarization 所需的全局写入单独隔离。
   - 验收：双 agent 测试，覆盖全部受管键。
2. **PiAgent settling 屏障（只做 a，不改协议）**
   - 验收：主审的 stub 时序下，旧 `agent_end` 不再结算新回合。
3. **`acceptPlanWithCompaction` 加网关迁移**
   - 验收：用真实 SM 测试，最终只有一条 approval，pending 记录被清除。

## 六、分区

- **共识：** 不按文件大小拆分，不引入总线、容器或新框架。保留 event-processor、传输层、项目文件安全面。WebUI 风险的根源是导入方向，不是 shim 本身。
- **尚存分歧：**
  - 是否需要 DOM 事件的类型联合文件：我认为可有可无，GLM 认为是第一步。
  - "无草稿发起者"回执是否被有意禁止，需要产品方面确认。
  - SessionManager 是否要做最终拆分。
- **需要后续实验：**
  - Pi abort 与 pre-tool/tool 桥之间是否死锁
  - `ensureSession` single-flight 的故障注入
  - Claude 真实 SDK 的双连接 spawn
  - ErrorBoundary 的真实浏览器验证
  - GLM 提出的 `deferRestore` 两个 workspace 变量问题
  - `webFilePicker` 只返回文件名、不返回路径的问题
  - Bun 1.3.5 与 1.3.10 的测试差异