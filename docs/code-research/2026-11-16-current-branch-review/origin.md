# 五项已复现缺陷的来源归因

2026-11-16 补充追溯。结论：**两项继承自 Craft，两项来自 Stair 新增实现，一项是 Stair 改变服务端协议后漏迁移上游调用方造成的集成回归。**

不是按文件名、作者姓名或最后一次 blame 判定。逐项核对了共同祖先、上游 main、引入提交及当前方法体；对两项 P1 和网关流程做了纯上游代码的受控对照实验。

**比较基准**

- Stair：`codex/stair-rebuild-v2`，HEAD `d5a7157a01e9fee2441e6a5ad8bf875ed78b59b1`，含此前审查的 WIP。
- 当前分支与 Craft 的共同祖先：[`8df01c5d` / v0.15.6](https://github.com/craft-ai-agents/craft-agents-oss/commit/8df01c5d0ac73c35add5954e6f190ce038d35845)。归因以 git 祖先关系和 patch 为准；二开提交经 rebase，不能按作者日期推断相对顺序。
- 本次在线查询确认的 Craft main：[`3ce9fc12` / v0.15.9](https://github.com/craft-ai-agents/craft-agents-oss/commit/3ce9fc12837541d688a59a8f0a2e9755ceb89ac2)，与本地 upstream/main 一致。
- 纯上游实验使用 v0.15.6 的独立 detached worktree。workspace package 指向该检出自身；复用本机已安装的外部依赖，无重新安装，不是 release 二进制验证。

| 原报告问题 | 来源 | 证据与具体责任边界 |
| --- | --- | --- |
| B1 Claude 鉴权串用 · P1 | **Craft 上游已有** | 当前 `postInit` 与 v0.15.6、v0.15.9 方法体相同。纯 v0.15.6 也复现 A 获得 B 的地址与虚构 key |
| B2 Pi 旧终止事件结束新回合 · P1 | **Craft 上游已有** | `forceAbort`、`handleSubprocessEvent` 在三份代码中相同。纯 v0.15.6 同样提前产出 complete |
| B3 文本 autosave 撤回后停滞 · P2 | **Stair 新增实现** | 上游两个基准均无该 controller；当前整个文件与 Stair 引入提交 `5ea86dcb` 相同 |
| B4 网关批准并压缩失效 · P2 | **Stair 协议升级后的集成回归** | gateway 整个文件与上游相同；Stair 强化了被调用方协议，未迁移 gateway。相同服务端调用序列在纯上游可接受并清理，在 Stair 抛 `PLAN_ALREADY_APPROVED` |
| B5 fresh reconnect 覆盖其他窗口布局 · P2 | **Stair Workbench 实现** | 上游无该布局持久化 handler；当前整个文件与 Stair `75e049e0` 相同，含缺 client baseline 时整档写入的分支 |

**B1：鉴权问题的关键实现来自 Craft。**

[上游当前 postInit](https://github.com/craft-ai-agents/craft-agents-oss/blob/3ce9fc12837541d688a59a8f0a2e9755ceb89ac2/packages/shared/src/agent/claude-agent.ts#L1046) 仍清空并改写全局 `process.env`，没有把鉴权值真正写入会话 overrides。其完整方法体与当前 Stair 相同；当前 `buildClaudeSubprocessEnv` 与共同祖先也相同。v0.15.9 对环境构造新增了 ToolSearch / refusal fallback 开关，但没有修复鉴权归属。

当前关键 `postInit` 逻辑可追溯到 Craft [`8e4104df` / v0.5.0](https://github.com/craft-ai-agents/craft-agents-oss/commit/8e4104df808f653278cbe2b3026918ca5982b21b)。更早版本已有全局鉴权和部分 baseURL override，未对全部历史版本做首次故障二分，所以这里不声称所有形式的串用最早都始于 v0.5.0。

纯上游实验只 mock 连接查找和虚构 key，调用真实 `postInit` / 环境构造：A 初始化 → B 初始化 → A 构造环境，结果是 `https://b.example.invalid` 与 `fake-key-b`。没有真实 SDK spawn 或网络请求。**因此不能把这个问题归因于 Stair 的 Project/Workbench/输入恢复改动。**

**B2：Pi 问题也继承自 Craft，并非当前未提交 IPC 改动引入。**

[上游 forceAbort](https://github.com/craft-ai-agents/craft-agents-oss/blob/3ce9fc12837541d688a59a8f0a2e9755ceb89ac2/packages/shared/src/agent/pi-agent.ts#L2450) 与 [通用事件处理](https://github.com/craft-ai-agents/craft-agents-oss/blob/3ce9fc12837541d688a59a8f0a2e9755ceb89ac2/packages/shared/src/agent/pi-agent.ts#L1161) 的方法体在 v0.15.6、v0.15.9、当前 Stair 三者相同。新回合 reset 队列的关键步骤也来自上游。

纯 v0.15.6 上模拟同样时序：停止旧回合 → 启动新 prompt → 旧 `agent_end` 到达，新回合直接产出 complete。上游没有 Stair 新增的 input_accepted 事件，所以输出事件列表略有差异，错误的提前结算一致。

这证明 Stair 的输入恢复改动和当前 stdout/backpressure WIP 不是该故障的必要条件。实际产品触发频率、SDK 真实停止时序仍未 E2E 测量。上游当前仍保留相同错误机制，可按通用 backend 问题修复并回馈 Craft。

**B3：文本保存问题来自 Stair 的首版 controller。**

Stair `5ea86dcb28ae2aadbc83636dd1685da554053116`（`feat(stair): add project file workbench`）新增了 [ProjectTextDocumentController](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/components/project-files/project-text-document-controller.ts:103)。当前整个文件的 git blob 与该提交相同；Craft v0.15.6 和 v0.15.9 均不存在此文件。

`startSave` 中先比较 current/persisted，后处理 in-flight 的顺序从首版就存在。归因到这套 Stair 新增自动保存实现，适合在 Stair 局部修复并加入撤回时序测试。

**B4：上游 gateway 没变，Stair 的被调用协议变了。**

[`gateway.ts`](https://github.com/craft-ai-agents/craft-agents-oss/blob/8df01c5d0ac73c35add5954e6f190ce038d35845/packages/messaging-gateway/src/gateway.ts#L631) 整个文件在 Craft v0.15.6、v0.15.9、当前 Stair 完全相同。其原流程是 set pending → compact → acceptPlan → clear pending。这个调用序列与上游当时的 SessionManager API 相容。

Stair 至少有两个关键协议变更：

1. `146ca1da8cdaf63df716fdd7a4a032db2494d73b`（`fix(stair): make plan execution and input recovery durable`）：引入执行身份、耐久消费回执、压缩回合关联与身份限定清理；该提交已经同时要求 receipt 和 `planExecutionId`。后续 `40474a9d` 改写了周边代码，因此仅看当前 blame 会漏掉更早来源。
2. `6d14dfdb1bc7a1310506aed4ef301bc54ba0f8fe`（`fix(stair): deduplicate approvals by submitted plan identity`）：加入 `assertPlanApprovalAvailable`，准备 compact 时记录 approved plan identity，随后普通 accept 被判重复批准。这对应当前复现里的明确异常。

相同的受控服务端调用序列，在 v0.15.6 得到 ready=true、一次 approval send、pending 被清理；在 Stair 得到 ready=false、`PLAN_ALREADY_APPROVED`、零次 approval send、pending 残留。sendMessage 被本地 recorder 替换，未运行真实压缩/消息平台 E2E。

**应修复调用方与新业务入口的适配，保留二开已有的幂等、回执和防重复保护。** 不能因为 gateway 的文件来自 Craft，就把当前组合下的回归归给 Craft。

**B5：Workbench 持久化和缺基线兜底都是 Stair 的代码。**

`0a4bdce0ae8d3f1db31c86fdde7206640bb7e136`（`feat(stair): persist and refine workbench layouts`）引入这套布局持久化；`75e049e0620722c4ad76013e2b8002b894c2efb9`（`feat(stair): integrate native browser and project-scoped workbench`）增加 clientId 基线和三分合并，同时保留“无基线就整档写入”的兜底。当前 [handler](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/handlers/rpc/workbench-layout.ts:97) 整个文件与后一个提交相同。

当前复现的特定机制是新连接身份失去基线后退回整档覆盖。更早首版本来就是整档写入，因此不把加入三分合并本身描述成退步；它改进了正常多窗口写入，但遗漏了 fresh reconnect 的协议闭环。修复归属 Stair Workbench。

**重构空间的来源也要分层看。**

下面的行数只说明结构来源与增长，不能用来计算 bug 比例或直接证明必须拆文件。

| 模块 | Craft v0.15.6 | Craft v0.15.9 | 当前 Stair 工作树 | 归因判断 |
| --- | ---: | ---: | ---: | --- |
| SessionManager | 10,302 | 10,458 | 13,229 | 上游已是大型协调类；Stair 增加 Project、可靠输入/计划等职责 |
| App | 2,320 | 2,320 | 3,045 | 上游已有顶层协调负担；Stair 增加跨窗口与恢复协议 |
| AppShell | 2,935 | 2,935 | 3,545 | 上游已较集中；Stair Workbench 与产品操作进一步叠加 |
| BrowserPaneManager | 3,901 | 3,901 | 5,394 | 上游已有原生窗口/交互复杂度；Stair 增加项目归属、选择应用与窗口行为 |
| shared/config/storage | 3,219 | 3,219 | 3,865 | 上游已混合多类配置/存储；Stair 增加草稿协议等职责 |

其他直接比对结果：

- WebUI 的 `ErrorBoundary`、Node shims 文件与上游完全相同，属于继承的实现/技术债。
- `buildClientApi` 文件与共同祖先完全相同；string/any RPC 契约边界不是 Stair 新造的问题。
- DOM CustomEvent 协调在 Craft 已存在；Stair 加入更多输入/恢复事件。重构应针对新增的顺序协议，而非把所有 DOM 事件都视为二开错误。
- SessionDraftCoordinator、PendingInputJournal、Project Text Controller 和 Workbench 持久化是 Stair 增量，需由 Stair 维护它们与上游调用方的适配。
- Projects RPC 使用传入 workspaceId 而忽略 ctx 的形态，Craft 已有；它仍是契约策略问题，本轮没有据此升级为安全漏洞。

**测试失败中已追清的一组：19 个缺 projectId 的 fixture。**

必填检查来自 Stair `41a7030e9a8ed436a75c6bc36f80bad0c6fb78b7`（`feat(stair): rebuild foundation and workbench`），当前 [createManagedSession](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/sessions/SessionManager.ts:1234) 会拒绝无 projectId 的会话。相关五个测试文件中，background-task-stop、browser-password-redaction、handoff-summary、turn-usage 四个与 Craft v0.15.6 完全相同；automation-loop-and-retry 有后续改动，但失败的构造同样缺该字段。

在纯 v0.15.6 隔离检出运行这五个文件：**32 pass / 0 fail**。这支持“二开加严实体约束后，继承夹具漏适配”的归因。其余 13 个失败没有逐个做同等来源对照，不合并归责。

**修复的归属建议**

- Craft 通用修复：B1、B2；保持不依赖 Stair Project/Workbench，方便向上游回馈。
- Stair 功能修复：B3、B5；围绕现有文档与 Workbench 语义处理。
- Stair 集成修复：B4；把保留的上游客户端迁移到二开完整业务操作，同时补真实宿主契约测试。

本轮没有修改产品代码，没有提交上游 issue/PR。实验输出和边界见 [来源对照证据](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/origin-evidence.md)。
