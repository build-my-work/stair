# 当前分支整体代码审查与长期重构评估

2026-11-16 · `codex/stair-rebuild-v2` · `d5a7157a` · 包含审查开始时的未提交工作树。

**结论：有明确的重构空间。收益最大的方向，是让会话运行、计划执行、输入恢复各自拥有完整的状态和失败处理。现有 monorepo、server-core、后端适配器和大部分产品模块可以继续使用。** 本轮确认了五个可通过受控实验复现的问题；这些问题给重构划出了具体边界。大规模拆文件、换状态库、换 agent harness 或建立新服务体系，证据都不充分。

本轮交付审查和讨论结果，未实施产品修复。所有复现使用临时配置、虚构凭据或模拟外部时序，未向真实模型、消息平台提交产品测试请求。

后续已完成 [来源追溯](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/origin.md)：B1/B2 在纯 Craft v0.15.6 也复现；B3/B5 属于 Stair 新增实现；B4 是 Stair 升级服务端协议后漏迁移上游 gateway 的集成回归。上游基线、具体提交和对照实验见补充报告。

**一、范围与方法**

这是当前代码整体评估，未按 diff 选择审查范围。结构扫描覆盖工作树中 1,424 个非测试名 JS/TS 文件，约 32.2 万行、7,627 条解析到的导入；检查了全部应用和 package 的职责、依赖方向，再深读关键业务链路。统计排除了声明、资源、playground、prototypes；部分 `test-fixtures` 会计入，Astro/MDX/Python 不在这组数字内。

“全仓范围”不代表逐行读完 32 万行。本轮深读集中在状态、持久化、跨进程协议、平台边界和产品编辑链路；纯展示组件、翻译资源和外围工具主要做结构盘点、入口抽查与现有测试验证。未做原生 Electron、打包应用或 WebUI 浏览器完整 E2E，因此不声称这些层面的全面验收。

| 范围 | 本轮深度 | 判断 |
| --- | --- | --- |
| Electron 主进程、server-core、独立 server | 启动装配、SessionManager 关键路径、RPC/transport、Browser 接口与生命周期 | 服务端抽取有效；会话内部状态与操作协议仍集中 |
| shared agent、Claude、Pi、pi-agent-server | 鉴权、事件队列、stop/retry、子进程消息、初始化与工具桥 | 两个 P1 故障；应先收紧归属和结算边界 |
| Electron renderer | App/AppShell、draft/journal、event-processor、Navigation、Workbench | 多处组件共同维持同一个业务协议；已有纯状态模块值得复用 |
| Project Files、Notes、Drawnix、PDF/EPUB | 控制器保存/flush、页面切换、服务端写队列、指纹与回执 | 一个 autosave 故障；服务端安全写入边界较成熟 |
| Browser | 本地/Remote/Null 接口、CDP 与应用路由、窗口/工具栏/捕获职责 | 适合后续分开生命周期与交互职责；不宜先拆截图路径 |
| messaging-gateway、WhatsApp worker | adapter/router/binding 结构、计划按钮路径、测试 | 模块划分可保留；计划执行调用方与服务端协议漂移 |
| WebUI | Electron renderer 复用、adapter、Node shims、入口 | 客户端平台边界值得渐进加强 |
| core、session-tools-core、shared config/sources/automations | 类型/工具定义、权限与存储依赖、自动化入口、循环边界 | 保留核心类型和既有业务 facade；收窄混合导入 |
| UI、Viewer、CLI、docs、scripts、资源工具 | 包入口、主要调用方向、脚本和测试 | 暂无足够证据支持全面重写；部分 legacy 入口应另做可达性核实 |

Claude 与 GLM 分别做了专项审查和整库架构审查，再收到双方报告及主审复现证据做交叉讨论。实际调用使用本机 Pi CLI 的 `magpie` 路由，模型请求/返回标识为 `claude/claude-opus-5-5`、`zcode/GLM-5.3`。这些是本地代理报告的模型标识，不代表独立审计了代理上游。源码读取阶段仅开放 read/grep/find/ls，讨论阶段无工具。模型意见由主审按源码和实验裁决。

**二、应先修的具体问题**

**B1 · P1 · Claude 连接鉴权通过进程全局环境串用。**

[ClaudeAgent.postInit](/Users/zhihu/code/m_code/ai/thinking-agent/packages/shared/src/agent/claude-agent.ts:949) 清空并改写全局 `process.env`；注释称也写入 per-session overrides，实际没有。[子进程环境构造](/Users/zhihu/code/m_code/ai/thinking-agent/packages/shared/src/agent/options.ts:186) 继承该全局环境，而 [SessionManager 的 overrides](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/sessions/SessionManager.ts:4817) 只提供 workspace 和 mini model。

实验调用真实 `postInit` 与 `buildClaudeSubprocessEnv`，仅替换连接查找和虚构凭据：A 初始化 → B 初始化 → A 构造下一次子进程环境。A 从 `a.example.invalid / fake-key-a` 变成 `b.example.invalid / fake-key-b`。不需要两个调用在同一时刻执行；保留 A agent 后再初始化 B，就可能在后续 spawn/options 构造时触发。实验未启动真实 Claude SDK 子进程，未测 keep-alive 各种恢复路径的发生频率。

影响是模型请求可能进入错误连接、错误账户或 endpoint，优先级高。最小修复应使每个 ClaudeAgent 保存自己的完整受管鉴权环境，构造 subprocess env 时先移除继承的受管键再叠加该会话值。不能只补写 API key 而继续继承另一个会话的 OAuth/baseURL。需要覆盖 API key、OAuth、environment、mini model、后台标题/摘要等路径；全局 summarization 的环境依赖应显式保留或单独隔离。

**B2 · P1 · Pi 旧回合的终止事件能结束新回合。**

[forceAbort](/Users/zhihu/code/m_code/ai/thinking-agent/packages/shared/src/agent/pi-agent.ts:2598) 先完成本地事件队列，再发送子进程 abort；[新回合](/Users/zhihu/code/m_code/ai/thinking-agent/packages/shared/src/agent/pi-agent.ts:2213) 重置同一队列；[事件处理](/Users/zhihu/code/m_code/ai/thinking-agent/packages/shared/src/agent/pi-agent.ts:1248) 对通用 agent event 没有所属回合校验。[子进程的 stdin 分发](/Users/zhihu/code/m_code/ai/thinking-agent/packages/pi-agent-server/src/index.ts:2029) 允许异步命令重叠，已安装 SDK 的 abort 需要等待 idle。

实验使用真实 PiAgent 的 `forceAbort`、`chatImpl`、`handleLine`，模拟子进程发送时序：停止旧回合 → 开始新 prompt → 新 prompt 被接受 → 旧 `agent_end` 到达。新生成器立即产出 `input_accepted, complete`，未等待自己的响应。属于确定的受控时序复现，未跑真实 provider E2E。

先补停止结算屏障与回合身份归属，再考虑提取生命周期对象。主进程 SessionManager 的 generation 检查不足以修复底层已经误归属到新队列的事件。方案应同时考虑 abort 超时、子进程重启、重试/压缩、后台事件；不能把所有事件机械绑定到“最近 prompt id”，也不能对缺失身份的终止事件无条件兼容。

**B3 · P2 · 文本自动保存期间撤回到原文，保存队列会停在 dirty。**

[ProjectTextDocumentController.startSave](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/components/project-files/project-text-document-controller.ts:103) 先比较当前内容与旧 `persistedContent`，后检查 `savePromise`，因此漏记第二次保存需求。

实验：原文 → 修改内容并开始保存，保存 promise 悬挂 → 撤回原文 → 等防抖到期 → 第一笔保存成功。磁盘只写入修改内容，界面当前内容是原文，状态为 dirty，之后没有第二笔自动保存。正常 flush/关闭仍可能补救，所以这不是“每次都会丢数据”。

最小修复是调整 in-flight/内容相等判断与完成后的重新调度，保留冲突和失败时的停止语义。验收必须在不调用显式 flush 的情况下，等待保存链最终自动把原文写回；同时确保保存失败不会形成无限重试。

**B4 · P2 · 消息网关的“批准计划并压缩”不符合现有执行协议。**

[网关准备](/Users/zhihu/code/m_code/ai/thinking-agent/packages/messaging-gateway/src/gateway.ts:638) 调 `setPendingPlanExecution` 后直接发 `/compact`，没有草稿消费回执与 `planExecutionId`。[服务端压缩关联](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/sessions/SessionManager.ts:8923) 同时要求这两项；[网关压缩完成处理](/Users/zhihu/code/m_code/ai/thinking-agent/packages/messaging-gateway/src/gateway.ts:761) 却再调普通 `acceptPlan`，随后尝试无 id 清理。

使用真实 SessionManager 和临时 workspace 存储，按相同服务端调用契约运行：准备记录产生 `approvedPlanMessageId`；无关联压缩不能标记 ready；随后 `acceptPlan` 抛 `PLAN_ALREADY_APPROVED`；无 id clear 保留记录。没有连接真实 Telegram/Feishu，也没有运行真实 compaction。

优先让网关调用一个服务端完整业务操作，复用现有 record、receipt、lifecycle lock、幂等 dispatch。明确无本地草稿的调用方如何产生合法空回执，不能削弱现有校验来迁就旧调用方。验收应通过真实 SessionManager 的网关集成路径验证只批准/派发一次，并覆盖重复点击和失败恢复。

**B5 · P2 · 无法恢复旧连接身份的重连，会让 Workbench 覆盖其他窗口的布局修改。**

[Workbench WRITE](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/handlers/rpc/workbench-layout.ts:107) 在没有该 clientId 基线时直接整档写入。[WS fresh connect](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/transport/server.ts:576) 会分配新 clientId；短暂断线且恢复记录仍有效时会复用旧身份，不能把问题描述成所有重连必现。[renderer restore](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/workbench/workbench-persistence.ts:121) 被 ready 状态门控，App 的 stale reconnect 主要刷新会话和草稿，未为布局恢复基线。

使用真实 READ/WRITE handler 与临时磁盘：A/B 先读相同基线，各改项目 A/B，正常三分合并保留双方；给 A 模拟 fresh clientId，再只改项目 A，项目 B 的面板从 `[b-file]` 变为 `[]`。未运行浏览器/真实 WS 断线重连实验。直接影响是工作台布局丢失，不是底层项目文件被删除。

缺基线不能退化成静默覆盖。应恢复/携带旧基线或显式项目差量，或拒绝写入并让客户端同步后重放本地变更。“现读磁盘当 baseline 再与旧 incoming 合并”也不能区分旧内容与用户删除意图，不能作为正确修复。

**额外源码问题与待验证风险。**

- [WebUI ErrorBoundary](/Users/zhihu/code/m_code/ai/thinking-agent/apps/webui/src/main.tsx:34) 实际只有 `React.Suspense`，不处理普通 render error。源码上可以确定错误恢复边界缺失；未运行浏览器故障注入，可作为小型修复单独处理。
- [项目列表 reconciliation](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/workbench/workbench-commands.ts:792) 会直接裁剪已删除项目的面板；[文本卸载清理](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/pages/ProjectFilePage.tsx:206) 的 flush 失败只记录日志并 dispose。跨窗口删除一个没有 Session、但仍有 dirty/conflict 编辑器的项目时，存在未保存内容失去恢复入口的路径。服务端删除目前只协调 Browser，不协调文档；本轮已核对源码链，未做原生多窗口复现。删除已生效后再加 flush/veto 不能恢复已失效的项目身份，需要删除前协调或保留恢复副本。
- [Drawnix 保存错误处理](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/components/project-files/drawnix-document-controller.ts:85) 把指纹冲突当普通 error；Retry 保持旧指纹，会重复报冲突。应区分冲突和暂时错误，提供保留内容/重新加载的明确选择；这支持统一行为契约，不支持统一整个控制器。
- [Pi ensureSession](/Users/zhihu/code/m_code/ai/thinking-agent/packages/pi-agent-server/src/index.ts:612) 在多次 await 后才设置 `piSession`，没有共享的初始化 promise。与并发控制命令/超时叠加可能创建多个 SDK session；尚未做初始化阻塞注入，暂列高价值验证项。
- Pi abort 与 pending pre-tool/tool request 的结算顺序需要专项实验；不能直接认定必然死锁。
- Workbench 模块级保存状态的跨 workspace 归属仍是风险项，现有 workspace 切换已存在 flush/generation 守卫，未证实跨 workspace 覆盖；B5 复现的是同 workspace 多窗口合并失效。server baseline map 还缺少 client 生命周期清理。
- [Projects RPC](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/handlers/rpc/projects.ts:43) 使用参数 workspaceId，未与请求 ctx 核对；Files/Reader/Notes 则绑定 ctx。接口约束不一致属源码事实，但现有实例级认证、可选择 workspace 的 handshake、允许空 ctx 的管理测试说明不能直接定性成“跨租户提权”。先区分全局管理 API 与当前 workspace API，再统一对应的解析和校验策略。

**三、值得投入的长期重构，按优先级排序**

**R1 · 明确会话运行与鉴权的所有权。收益高，整块迁移风险高，适合从两个故障边界开始。**

[SessionManager](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/sessions/SessionManager.ts:759) 的 ManagedSession 同时存放运行代际、stop epoch、前台输入归属、队列、steer、自动重试、权限、MCP、浏览器与产品元数据。`sendMessage`、`processEvent`、`onProcessingStopped` 共同维护它们；agent 自身另有事件队列和处理状态。B1/B2 表明正确性依赖于模块之间没有写进接口的时序。

目标是一个回合的事件、取消、结算由同一责任边界管理；鉴权属于连接/agent 实例。先在 Pi 内封住“新回合何时可开始”和“终止事件属于谁”，在 Claude 内隔离 env。接口应表达 begin/abort-and-settle/accept-event 等完整操作，避免调用方直接修改一组并列布尔字段。保留已有 `BaseAgent`、`BaseEventAdapter`、后端 factory、权限 pipeline 和 SessionManager facade。

验收需要故障注入覆盖：停止后立即重发、迟到事件、子进程断连、abort 超时、source activation retry、压缩重试、会话切换。通过后再评估是否抽独立 Turn 生命周期模块。直接把整个 `ManagedSession` 传入一个新 Controller，只是移动复杂度。

**R2 · 收口计划执行与输入恢复协议。收益高；服务端先统一业务入口，前端再减少协议参与者。**

[计划执行实现](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/sessions/SessionManager.ts:6406) 已有执行 id、消费回执、恢复 outbox、严格持久化、一次派发等重要不变量。问题是它们以多个可单独调用的方法暴露，renderer 和 gateway 各自编排，B4 已证明这种分散的实际代价。

第一步应新增/收口服务端的完整批准并压缩操作，让 gateway 使用；暂不搬走约 800 行计划状态逻辑。准备/消费操作应在明确的锁范围内完成，实际 send 不应在会重入同一锁的范围内等待。外部提交的是 plan identity 与可选草稿快照，不能自行拼造内部 ready 状态。跨重复请求、重连、停止的幂等行为由服务端保证。

前端继续复用 [SessionDraftCoordinator](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/lib/session-draft-coordinator.ts:1)、[PendingInputJournal](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/lib/send-message-recovery.ts:1)，把 submit/admission、draft restore/ACK 等顺序协议集中到可直接测试的应用逻辑中。多面板的 focus/insert/reveal 广播有合理用途，可以保留按 sessionId 寻址；给 DOM 事件加类型只能帮助约束载荷，不能证明 flush → restore → ACK 的顺序正确。

验收：无挂载输入面板时服务端仍能完成执行；两个窗口只能批准一次；失败恢复只还原已消费部分；恢复过程中继续输入不被覆盖；重复 ACK 与旧执行 id 不影响新意图。现有相关 fixture 应复用，并逐步改为直接测试导出的业务接口。

**R3 · 降低 App/AppShell 的状态协调责任。收益高，宜紧随 R2，按一条业务链迁移。**

[App 的事件订阅](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/App.tsx:1198)、[重连恢复](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/App.tsx:1455)、发送与 draft 协议共同占据顶层组件；AppShell 又负责导航、面板、资源与产品操作。维护一次输入恢复，必须同时理解 App、FreeFormInput、ChatDisplay、ChatPage 和服务端。测试中出现源码切片、转译和 `new Function`，说明真实逻辑没有合适的可测试入口。

保留 [event-processor](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/event-processor/index.ts:1) 的纯 reducer/Effect 模式、sessionAtomFamily 和 [Workbench 状态](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/workbench/workbench-state.ts:1)。优先把一次发送从本地接纳、乐观消息、服务端接受到重连恢复的完整链路放在一个责任模块，再迁移 workspace load/refresh 等边界。依赖可注入 transport、store、journal；React 负责订阅与展示。

不推荐把 3,000 行剪成一个 `useBigApp`，也不因为 App 使用 useState 就改成 atom。成功标准是调用方少维护状态、测试可以使用真实入口、workspace/session 的迟到结果仍被正确丢弃，而非行数下降。

**R4 · 让 Workbench 多写者同步拥有完整的基线与重连协议。收益中高，范围可以收窄。**

B5 表明正常写入的三分合并、transport 的连接身份恢复、renderer 的一次性 hydration 是三个独立机制；连接身份失效时没有人负责恢复合并前提。这里不需要新的状态管理库。应让布局持久化显式拥有 workspace、baseline/revision、未提交项目差量和重新同步状态，并在 fresh reconnect 后恢复前提再写。

第一步围绕当前 READ/WRITE 协议修复缺基线写入，保留已有 per-project 合并逻辑。验收覆盖短重连、过期身份、server 重启、离线期间本地编辑、另一窗口同时编辑、用户主动关闭所有面板，以及两个项目互不覆盖。仅补一条“重连后 READ”并覆盖本地状态，会转而丢失离线编辑，也不合格。

**R5 · 建立可验证的浏览器端依赖与 RPC 契约。收益中高，触及面广，适合逐条链路推进。**

[WebUI 构建配置](/Users/zhihu/code/m_code/ai/thinking-agent/apps/webui/vite.config.ts:64) 通过别名复用 Electron renderer，并为约 40 个 Node 内建模块名提供 shim。[shim 实现](/Users/zhihu/code/m_code/ai/thinking-agent/apps/webui/src/shims/node-builtins.ts:13) 混合 throw、空操作、占位返回与简化语义，例如哈希返回空字符串。这不证明当前浏览器路径已经使用这些假实现，却说明“不会运行到这里”主要依赖约定。

[shared config 桶](/Users/zhihu/code/m_code/ai/thinking-agent/packages/shared/src/config/index.ts:1) 把纯数据、默认值和 Node 存储/watch 混在一起；内部静态循环也集中于 config/workspace/source/session/automation。循环本身未证明启动崩溃，但浏览器端/测试导入负担已经可见。优先使用现有纯叶子导出，收窄 renderer 导入，补小范围边界检查；不要第一步重写整个 config 桶或改变所有 package exports。

RPC 方面，[CHANNEL_MAP](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/transport/channel-map.ts:1) 统一了名字；[buildClientApi](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/transport/build-api.ts:14) 和 [transport types](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/transport/types.ts:13) 的参数/结果仍大量经过 any，再断言为 ElectronAPI。现有 WebSocket transport、push、reconnect 应保留。可从计划执行或文档保存这一条路径开始，把请求/响应类型放在无平台依赖的协议层，用类型约束连接 handler 与 client；继续保留运行时校验与 workspace 授权。类型只能限制形状，无法自动验证业务先后顺序；gateway 直接调用 ISessionManager，B4 还必须通过业务入口与集成测试解决。

验收以浏览器可构建、import graph 不引入 Node-only 模块、客户端与 handler 类型错误能被发现为准。WebUI/桌面共同冒烟；原生能力不可用时应明确返回 unavailable，避免靠假成功维持相同接口。不需要一开始建立代码生成框架或第二套 renderer。

**R6 · 先统一文档保存的行为契约，暂不抽通用保存框架。收益中，风险可控。**

Text 与 Drawnix 都有防抖、in-flight、flush，但内容快照、changeSeq、冲突、外部修改、discard 语义并不完全相同。B3 说明值得整理行为，而“目前两份相似实现”不满足创建通用 writer 的充分理由，更不能为未实现的未来 reader 预建框架。

复用 [文档注册表](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/components/project-files/project-file-document-registry.ts:1)，为所有实现明确 flush/close/conflict 的保证。先修 B3，再用共享的行为场景验证编辑期间保存、再次编辑、撤回、冲突、失败重试、快速切换、最后一个 owner 释放，并补齐项目删除导致的非自愿卸载恢复。失败提示与内容恢复必须一起考虑；单加 toast 不能找回已经 dispose 的编辑内容。只有当第三个真实消费者或持续漂移证据出现时，再考虑提取稳定的队列算法。不能把服务端原子文件替换与 renderer 的 debounce 当成同一个抽象。

**R7 · 渐进拆分 BrowserPaneManager 内部职责。收益中，排在会话和输入协议之后。**

[BrowserPaneManager](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/main/browser-pane-manager.ts:581) 同时处理原生窗口、工具栏 IPC、popup、CDP 能力、selection、截图 readiness、telemetry 和会话归属。约 5,400 行是线索，真正的耦合成本在于改工具栏要面对窗口与截图状态。

保留 [IBrowserPaneManager](/Users/zhihu/code/m_code/ai/thinking-agent/packages/server-core/src/handlers/browser-pane-manager-interface.ts:1) 以及 Remote/Null 适配，复用已分离的 browser-cdp、application-router 和 ownership 逻辑。优先在功能变更时提取工具栏宿主或 telemetry 的完整生命周期，接口只提供该部分需要的操作，不传整个 manager。原生截图涉及隐藏窗口显现、paint 和 offscreen 状态，不宜先做机械迁移。

验收需要实际 Electron 检查窗口关闭/恢复、popup、隐藏截图、归属释放，再补 Remote/Null 契约测试；单纯 typecheck 与行数减少不足以验收这项重构。

**四、现在值得保留或暂缓的部分**

| 部分 | 判断与理由 |
| --- | --- |
| monorepo / server-core / PlatformServices / bootstrapServer | Electron 与独立 server 已复用装配和平台注入；包级主要依赖方向合理，没有迁移微服务的依据 |
| TaskRunner / ConductorSessionHost | 已以少量生命周期能力连接会话宿主，是缩小接口的现成范例 |
| BaseAgent / BaseEventAdapter / 共享 PreToolUse | 已处理真实后端差异；source activation 的 Claude/Pi 差别部分来自 SDK 能力，不能为对称而强行统一 |
| 项目文件与笔记服务端写入 | 路径约束、稳定读取、指纹、写队列、原子替换、笔记回执各有必要；不要简化为裸 read-modify-write |
| session persistence queue / 删除与退出链路 | 已发现 cancel/flush/cancel/delete、已删除会话拒绝重新排队、严格 flush 失败阻止退出等防护；本轮未确认删除后复活或退出静默丢写 |
| event-processor / Workbench state / Jotai session atoms | 已有纯逻辑与按会话分片，整体替换状态库不解决上层协议分散 |
| gateway adapter/router/binding 与自动化 facade | 已按实际职责划分；修具体调用协议即可，不需要重写平台接入层或增加全局事件总线 |
| config/source/session 静态环 | 记入边界治理，但不把循环数量当作 bug 数量；优先切掉有浏览器/测试成本的边 |
| session-mcp-server 与旧依赖 | 仓内缺少明显启动路径是待核实的可达性线索；应先核对外部打包/调用，不能凭搜索结果直接删除 |
| CLI、Viewer、docs | 本轮没有发现足以支持整体重构的职责问题，保持当前形态；文档与入口漂移按具体需要修订 |

**五、落地顺序与验收边界**

建议使用可以独立合并、独立回退的改动序列；本轮未执行这些改动。

| 顺序 | 范围 | 完成标准 |
| --- | --- | --- |
| A | 修测试夹具/运行环境，加入五个已复现问题的失败用例 | fixture 能真实到达业务断言；测试失败原因明确，不靠删断言或放宽生产校验变绿 |
| B | Claude 鉴权隔离 | 双连接与跨 auth 类型隔离；摘要/标题/子进程重建均用正确连接 |
| C | Pi 停止结算与回合归属 | 旧事件不能结束新回合；超时和断连有确定结局；不丢后台事件 |
| D | 文本 autosave 修复 | 保存中撤回可自动落盘，失败/冲突不会自旋；现有 close/flush 行为保持 |
| E | 网关计划执行协议收口 | 真实宿主契约下只执行一次，失败可恢复，身份校验不削弱 |
| E2 | Workbench fresh reconnect 基线恢复 | 另一窗口修改与本地离线修改均保留；主动删除面板仍能生效 |
| F | 前端发送/恢复应用逻辑收口 | 去掉相关源码切片测试，直接通过真实协调接口验证跨窗口/重连/新输入竞争 |
| G | 浏览器端叶子依赖与一条 RPC 类型契约 | 两端构建、类型与授权检查成立，shim 需求减少且原生能力失败显式化 |
| H | 根据实际功能变更再拆 Browser/SessionManager 装配簇 | 新模块真正拥有职责，调用方不再传整个 manager 或共享可变状态袋 |

“恢复测试基线”是较大重构的前置工作；小范围已复现故障可按局部可靠用例推进。不能用现有的 32 个失败当作以后所有回归都可忽略的理由，也不能把 32 个测试失败直接宣布为 32 个产品 bug。

**六、实际验证结果**

| 检查 | 结果 | 限制 |
| --- | --- | --- |
| `bun run typecheck:all` | 通过 | 脚本因 pages worker 不存在跳过该项 |
| `bun run lint:guards` | 通过 | raw IPC send 与 Task/Agent 工具名 guard |
| 全部源码测试分组 | 7,760 通过、32 失败、12 跳过 | 按原 runner inventory/group 规则运行 13 个普通组、22 个独立组，遇错继续收集；不是原命令一次全绿 |
| `bun run test:doc-tools` | 40 通过 | Python 工具 smoke tests |
| 五个专项复现 | 均呈现上述故障 | 模拟凭据/外部时序/compaction/新连接身份，不是模型/消息平台/浏览器 E2E |
| 原生 Electron / 打包 / 浏览器全流程 | 未运行 | 不据此给出全面运行验收结论 |

初次源码测试使用临时 profile 时缺 bundled defaults；补入仓库自带 defaults 后重新按完整分组运行，上表以该次为准。未修改个人 profile。运行环境 Bun 1.3.5，仓库 CI 配置为 1.3.10；未查询或推断远端 CI 状态。

32 个失败已归类：server-core 19 个均为旧 fixture 未提供 `createManagedSession` 必填的 projectId；Electron 普通组 3 个 browser mock 缺 `isLoading`，1 个源码切片测试缺 `useTransportConnectionState`；独立组为 Electron `ipcMain` mock 1 个、PDF 环境 `customElements` 缺失及继发初始化错误 7 个、PDF worker `?url` 的 Bun 测试加载问题 1 个。它们揭示测试与实现的接口漂移，不能直接推断对应产品功能运行失败。

当前通过的组包含 CLI、WebUI、core、messaging、WhatsApp、Pi server、独立 server、session-tools、shared、UI 和 scripts。通过只代表现有测试覆盖的行为，B1/B2/B4 正说明跨模块协议仍有覆盖缺口。

**七、审查材料**

实验过程、具体输出、模型交叉讨论和保留分歧在同目录材料中记录。主报告的结论优先于独立评审原稿；原稿中的未验证判断不应直接作为实施清单。

- [复现与检查证据](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/evidence.md)
- [Claude / GLM 交叉讨论与裁决](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/discussion.md)

审查开始时保存了既有 2,718 个文件的 SHA-256 清单；截至报告整理前全部一致。最终变更核对见证据文件。本轮新增内容仅为审查材料，不包含产品实现、修复提交或发布操作。
