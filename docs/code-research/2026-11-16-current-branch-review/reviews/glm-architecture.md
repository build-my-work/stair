> 独立评审原稿，未自动采纳。主报告与交叉讨论中的验证和纠错优先。实际调用标识：zcode/GLM-5.3。不包含内部推理日志。

# 全仓库应用层架构评估（终稿）

以下结论基于对当前工作树的实际阅读（约 45 次实质性工具调用，深入阅读约 30 个文件、结构盘点约 20 次），聚焦指定的应用层与产品模块。覆盖率声明见文末。

---

## 一、重构候选（按收益/风险排序）

### 1. 收拢 Draft/Plan/Compaction 协议：淘汰 `craft:*`/`stair:*` DOM 事件总线（高收益 / 中风险）

**现状与证据**
- 渲染层存在**第三套通信机制**：Jotai atoms、React context 之外，还有一条非类型化的 `window.dispatchEvent(CustomEvent)` 总线。事件类型包括 `craft:flush-input`、`craft:restore-input`、`stair:draft-references-changed`、`stair:draft-attachments-changed`（`apps/electron/src/renderer/App.tsx:427-440`）、`craft:compaction-failed`（App.tsx:547 监听 / FreeFormInput.tsx:784 派发）、`craft:submit-input`（ChatDisplay.tsx:1284 派发 / FreeFormInput.tsx:1523 监听）、`craft:approve-plan`、`craft:approve-plan-with-compact`（ChatDisplay.tsx:1947/1961）、`craft:compaction-complete`（App.tsx:1299）、`stair:reveal-chat-reference`（AppShell.tsx:1484 / ChatDisplay.tsx:1498）、`craft:insert-text`/`craft:focus-input`/`craft:paste-files`。
- 该总线承载的是**最关键的顺序性协议**：flush 本地编辑 → 原子 restore → 合并 → ACK（App.tsx 中 `recoverFailedCompactionDraft` 的注释本身就承认这个 ordering 依赖 `queuedRestoreId` 路径）。这些语义散落在 App.tsx（529-583 outbox redelivery、1846 起的 send admission）、FreeFormInput.tsx（693-1523 约 12 个 addEventListener）、ChatPage.tsx（244/279/307）、ChatDisplay.tsx。
- **已付出的最痛成本**：测试被迫用“源码切片转译”来覆盖真实回调——`components/app-shell/input/__tests__/draft-consumption-protocol.fixture.ts:30-45` 用 `sourceBetween(inputSource, 'const syncToParent = React.useCallback', ...)` 从生产 JSX 源文本中切出函数体再用 Bun.Transpiler 执行。任何重命名/挪动一个标记字符串就破坏测试。这是“逻辑不可抽出”的直接症状。

**建议**
- 复用**已有的好抽象**：`SessionDraftCoordinator`（`lib/session-draft-coordinator.ts`，已是可注入 persistence 的纯类，有完整单测）和 `PendingInputJournal`（`lib/send-message-recovery.ts`）。问题只在它与 UI 之间的黏合层。
- 第一步（可独立落地）：新建 `lib/draft-event-bus.ts`，定义 `interface DraftUiEventBus { dispatch(e: DraftUiEvent): void; on<T>(type, h): () => void }`，把约 16 个事件名收敛为一个可辨识联合类型；实现层仍包装 `window`。逐个替换 `addEventListener('craft:...')` 调用点。**验收**：`draft-consumption-protocol.fixture.ts` 与 `draft-content-protocol.integration.test.ts` 全部通过且不再需要 `sourceBetween` 切 FreeFormInput（只需切更小的、被抽出的纯函数）；grep 无裸 `'craft:'`/`'stair:'` 字符串散落。
- 第二步：把 plan-approve / compaction-complete 的编排从 App.tsx 挪进一个 `PlanApprovalCoordinator`（与 SessionDraftCoordinator 同构）。
- **为何不必一步到位**：不需要改成 Redux/新框架，atoms 架构本身是健康的；也不必先拆 App.tsx。总线类型化后，App 瘦身和其他拆分会自然变容易。

**可反驳点**：DOM 事件总线的存在理由是跨组件层级、免 props 穿透、且在多面板（同一输入组件多实例按 sessionId 过滤）下天然支持广播。如果主审认为多实例按 sessionId 路由是核心需求，那么替代方案应是“带 sessionId 寻址的类型化总线”而不是砍掉总线。

---

### 2. SessionManager（13,230 行、203 方法）按职责簇拆分为协作服务（高收益 / 中高风险）

**现状与证据**
- `packages/server-core/src/sessions/SessionManager.ts` 单类混合至少 8 个职责域：会话 CRUD/持久化（3116-3243 enqueuePersist/flush）、agent 运行时生命周期（4516-4737 disposeManagedAgentRuntime/tryRefreshAgentRuntime/getOrCreateAgent）、**plan 审批与执行状态机（6406-7254，约 850 行自成体系：setPendingPlanExecution/dispatchPendingPlanExecution/cancelPendingPlanExecution/reconcileStoredPendingPlanExecution）**、auth/credential 请求生命周期（3244-3580 prepareAuthRequest/completeAuthRequest/handleCredentialInput）、config watcher 与 9 种 broadcast 扇出（2623-2910）、turn 后决策（auto-label/标题/suggestion trace，1545-2020）、Drawnix 面板代理（2362-2455，含谨慎的 quorum 发现握手）、unread/badge/steering。
- **关键杠杆已存在**：`handlers/session-manager-interface.ts:28` 起的 `ISessionManager`（400+ 行）已经是 handler 层编程的接口；`messaging-gateway/src/gateway.ts:12` 也只依赖 `ISessionManager`。也就是说“门面”已经定义，缺的只是把实现内部的簇分离出去。

**建议**
- 不改对外接口、不重写：保留 `SessionManager` 作为组合根 + 门面，抽出 3-4 个内聚类，各自接收 `{ getManagedSession, persist, emit, rpcServer }` 窄依赖：
  1. `PendingPlanExecutionService`（6406-7254 的状态机 + `pendingPlanRecoveryDraft`）——它连 SessionDraftCoordinator 的 renderer 侧都有对偶（App.tsx:2147-2158），独立后两侧协议可对齐测试。
  2. `SessionAuthRequests`（3244-3580，owner token 生命周期）。
  3. `WorkspaceConfigFanout`（2623-2910 的 9 个 broadcastXxx）。
  4. `TurnDecisionPipeline`（1545-2020，含 automationLoopGuard）。
- **第一步**：抽 PendingPlanExecutionService。它内部状态（pendingPlanBySession 等）相对封闭，且已有 `pending-plan-workspace-authorization.fixture.ts` 等测试锚点。**验收**：`bun test packages/server-core` 相关 fixture 通过；SessionManager.ts 净减 ~800 行；`ISessionManager` 无签名变化。
- **跨文件耦合的具体代价**：任何 plan 流改动都要同时理解 SessionManager（服务端状态机）+ App.tsx 2147-2158（renderer 的 consume/prepare 回调）+ FreeFormInput 的 approve-plan 事件 + `handlers/rpc/sessions.ts` 的通道——四个文件没有一个共享的类型层来描述这个协议（`shared/agent/plan-types.ts` 只覆盖一小部分）。

**为何不必大改**：13k 行里大量是已在正确位置的会话核心循环；整体迁移会破坏所有用源码路径直接 import SessionManager 的测试 fixture（如 `draft-consumption-protocol.fixture.ts:33` 用绝对路径 `join(repo, 'packages/server-core/src/sessions/SessionManager.ts')` 动态 import），增量抽簇则每次只动一个 fixture。

**可反驳点**：如果团队认为“单类 + 单文件”便于全文检索和 hot-fix，且 CI 时长尚可接受，那么拆分的短期收益主要是可测性与 review 粒度，需要主审权衡。

---

### 3. BrowserPaneManager（5,395 行、155 方法）按“窗口宿主 / 能力面 / 工具栏 UI / 遥测”组合拆分（中高收益 / 中风险）

**现状与证据**
- `apps/electron/src/main/browser-pane-manager.ts` 至少混 7 个职责：① BrowserWindow/WebContentsView 生命周期与布局（createInstance:700、destroyInstance:907、layout*:3407-3611、setupWindowListeners:5035）；② **Agent 能力面**（navigate/clickElement/fillElement/screenshot/waitFor/evaluate…，即 `IBrowserPaneManager` 的 interaction 段，1900-2810）；③ 截图管线（2099-2622，含 hidden-capture 救援、paint 等待）；④ 原生工具栏 UI（loadNativeOverlayPage:3158、loadToolbarPage:3706、pushToolbarState:3782、registerToolbarIpc:3804——一段约 200 行自含的 IPC 注册）；⑤ 弹窗/登录窗管理（registerPopupWindow:4673-4810）；⑥ console/network/download 遥测与会话权限（4811-5023）；⑦ selection overlay 与 agent-control 视觉（1026-1189、3142-3557）。
- **接口面已经收拢得很好**：`packages/server-core/src/handlers/browser-pane-manager-interface.ts` 的 `IBrowserPaneManager` 是唯一被 SessionManager 依赖的契约；`RemoteBrowserPaneManager`（每会话一实例的 WS 代理，RemoteBrowserPaneManager.ts:38）与 `NullBrowserPaneManager`（null-object，null-browser-pane-manager.ts:31）都实现它。**问题纯粹在本地实现内部**：改工具栏按钮要打开和改 CDP click 相同的 5k 行文件，review 冲突面巨大。
- 注意能力分发有两层：`dispatchCapability`(4095)（browser 工具）与 `browser-application-router.ts`（app 级路由）已经分离——这是可复用的先例。

**建议**
- 第一步：抽 `ToolbarIpcController`（registerToolbarIpc + pushToolbarState + toolbar 加载重试），依赖仅 `{ getInstance, webContentsSend }`。这是最自包含的块。**验收**：搬移后 `apps/electron` typecheck + 既有 browser-pane 测试通过；BrowserPaneManager.ts 减 ~600 行。
- 第二步：抽 `BrowserTelemetry`（console/network/download 环形缓冲 + 权限决策日志），它对 BrowserInstance 的依赖只是挂 session observers。
- **复用**：`BrowserCDP`（独立文件）证明“大而内聚的辅助类放旁边”是本仓库成熟模式；不需要引入新框架。`IBrowserPaneManager` 保持不动，Remote/Null 零影响。

**为何不必一步到位**：拆分只为可维护性，接口契约稳定意味着没有行为风险窗口的需求；截图管线（③）与窗口生命周期深度交织（hidden window reveal、offscreen capture），强拆风险大于收益。

---

### 4. `@craft-agent/shared/config` 的 Node/浏览器混装分离（中收益 / 低风险，但触及面广）

**现状与证据**
- `packages/shared/src/config/index.ts:1-15` 桶式再导出 `storage.ts`（首行即 `import { existsSync, mkdirSync, readFileSync, writeFileSync... } from 'fs'`）、`watcher.ts:19-22`（fs/os/path）、`preferences.ts:1-2`（fs）、`validators.ts:16-17`（fs）——同时桶里也装着 renderer 必需的 `draft-content.ts`（纯类型+纯函数）和 `theme.ts`。
- 直接代价在 WebUI：`apps/webui/vite.config.ts:64-100` 用 **~40 个 Node 内建模块名映射到 `shims/node-builtins.ts`**（该 shim 的 fs 函数全是 `throw new Error('... not available in browser')`），另加 `ws`、`open`、electron-log、Sentry 的 shim。这依赖“未触达路径不会被调用”的脆弱不变量：任何人往被 renderer 引用的模块里加一个真实调用点，运行时才爆炸，静态检查不报。
- 好的先例已在仓库内：`@craft-agent/shared/config/draft-content` 子路径导出（package.json exports 已支持），`session-draft-coordinator.ts:3` 正是这么用的。

**建议**
- 给 shared 的 `exports` 增加 `"./config/server"`（或 exports 条件 `node`），把 storage/watcher/preferences/validators 挪到 Node-only 子路径；`config/index.ts` 只留类型、draft-content、theme、llm-connections 的纯部分。renderer/webui 依赖逐个改窄导入。
- **第一步**：先只迁移 `renderer` 内 16 处 dynamic import 与高频静态 import 里能机械替换的（grep 可得清单）。**验收**：`bun run typecheck:all` 通过；WebUI 构建产物中不再出现 fs/path shim 被实际打包（可用 bundle 分析确认），shim 映射表只减不增。
- **上游维护成本**：shared 还反向依赖 session-tools-core（packageEdges: runtime 10 条），本次不动它——这条边值得主审单独评估，但证据不足以在本轮下结论。

**可反驳点**：如果 WebUI 被定位为二等公民/实验特性，维持 shim 的成本可接受；那么此项可降级为“新增 lint 规则禁止 renderer 代码 import config 桶”即可（仓库已有 `lint:guards` 文化，`check-raw-sends.sh` 是现成模板）。

---

### 5. 统一 Project File 文档控制器的防抖保存队列（中等偏低收益 / 低风险）

**现状与证据**
- `DrawnixDocumentController`（`components/project-files/drawnix-document-controller.ts:28-167`）与 `ProjectTextDocumentController`（`project-text-document-controller.ts:22-101`）各自实现了**同一套** debounce(800ms) + fingerprint OCC + save-in-flight 合并 + retry/discard/flush 状态机，代码约 70% 同构；差异只在 serialize/冲突语义（Drawnix 用 changeSeq 乐观锁 + MINDMAP_BOARD_CHANGED；Text 用 expectedFingerprint + PROJECT_FILE_CHANGED）。
- 服务端已有统一入口：`withProjectFileWriteQueue`（`server-core/src/handlers/rpc/project-files.ts:783`）+ `readStableProjectFile`（:609，O_NOFOLLOW + stat 双校验）+ `fingerprint`（:653）。客户端却每个 reader 重写一遍队列。
- 当前成本：三处（text/drawnix/未来 reader）行为漂移——例如 Text 有 `discardChanges`，Drawnix 没有；`flush()` 的重入循环两份实现 subtly 不同。每加一种 reader（如未来的 xlsx viewer）都要再抄一遍。

**建议**
- 抽 `lib/documents/debounced-fingerprinted-writer.ts`：接口 `{ update(content), retry(), discard?(), flush(), onStateChange }`，参数化 `save(request) => { sourceFingerprint }` 和 encode/serialize。两个控制器各减到 ~60 行差异层。
- 复用已有注册表 `project-file-document-registry.ts`（flush 协议已统一，`OpenProjectFileDocument.flush()`）。
- **验收**：现有 `__tests__` 里 drawnix/text 控制器与 `flushOpenProjectFiles*` 测试全部通过；新增一个“两个控制器 flush 语义等价”的对照测试。

**可反驳点**：两个控制器语义差异（mindmap 的 read/update capability、changeSeq）可能让“通用队列”抽象税超过复制成本；如果差异面将来继续分化，保留两份具体实现反而更诚实。建议先写对照测试再决定是否合并。

---

### 6. App.tsx / AppShellContextType 巨型 prop-bag 的分域拆解（长期收益最大 / 短期风险最高，建议排最后）

**现状与证据**
- `App.tsx`（3,046 行）单组件持有 ~25 个 useState、~20 个 ref、40+ 个 handler，并在 2569-2643 手工组装 `AppShellContextType`（`context/AppShellContext.tsx:34` 起，约 230 行接口、60+ 字段）。`AppShell.tsx`（3,546 行）再向下转译。每个新功能都要：App.tsx 加 handler → context 加字段 → AppShell 加 prop → 叶子组件消费。这是仓库最高的“新增功能边际成本”。
- 仓储已付出的成本示例：`handleEffects`（App.tsx:1080-1190）在组件闭包里手写 effect 分发器，无法单测；`loadSessionsFromServer`（715-770）里 workspace 切换代际守卫（`workspaceTransitionGenerationRef`、`isCurrentSessionLoad`）与业务逻辑纠缠。
- **健康的部分不要动**：`atoms/sessions.ts`（sessionAtomFamily + sessionMetaMapAtom 防内存泄漏设计，注释明确）、`event-processor/`（纯函数 reducer，是该仓库最好的模式）、`workbench/workbench-state.ts`（atom 层干净）。

**建议（增量）**
- 第一批：把“权限/凭据队列”（pendingPermissions/pendingCredentials + handleEffects 的两个 case + respond 回调，约 150 行）抽成 `hooks/usePermissionQueue.ts`，内部用 atom 而非 useState。同理抽 `useWorkspaceSwitcher`（handleSelectWorkspace/BySlug/refresh + 代际守卫）。
- **验收**：每抽一个 hook，`App.tsx` 行数下降、`AppShellContextType` 删 2-3 个字段，WebUI 冒烟（webui 复用同一 App 组件，必须一起验）。
- **为何不能一步到位**：webui 通过 `@` 别名整树复用 electron renderer（`apps/webui/src/App.tsx:20` lazy `import('@/App')`），App 的任何大手术同时是 WebUI 的大手术；而事件总线（候选 1）和协调器先稳住后，这里的风险才可控。

---

## 二、明确不值得重构的部分

1. **event-processor**（`renderer/event-processor/`）：纯函数 reducer + 显式 Effect 副作用通道 + handler 分文件，是这个代码库的架构标杆。它已经给出了 App 拆分的目标形态，不要动它，向它靠拢。
2. **传输层三件套** `WsRpcClient` / `buildClientApi` / `CHANNEL_MAP`（`apps/electron/src/transport/`）：Electron renderer 与 WebUI 共用同一 WS RPC 协议和 API 代理，是 WebUI 得以薄壳复用整个 renderer 的根基（`web-api.ts:86` 直接 buildClientApi + 覆盖 LOCAL_ONLY 方法）。改成别的 IPC 抽象纯属倒退。
3. **server-core 的 Project Files 安全面**（`handlers/rpc/project-files.ts` 的 readStableProjectFile/withProjectFileWriteQueue/atomicReplace + `secure-project-note-file.ts` 的 posix/win32 双实现）：TOCTOU 防护（O_NOFOLLOW、stat 快照双比对、growth probe）、路径逃逸校验、平台差异处理都做得非常细致，且配套测试密（`project-files.test.ts`、`task-project-boundaries.fixture.ts` 等）。除非发现具体漏洞，结构重组这里的风险收益比极差。
4. **messaging-gateway 与 pi-agent-server 的现状**：gateway 已按 access-control/binding-store/router/renderer/pending-senders 分文件；pi-agent-server 是“一个关注点一个小模块+同名单测”（30 文件 5k 行）。它们是“已经做完的拆分”，不是重构对象。

---

## 三、确认 bug 与仅设计风险的区分

**本轮未发现可当场确认的实现 bug**（我没有运行任何代码，静态阅读仅发现以下值得核实的疑点，均属“待验证”而非结论）：

待验证疑点（可能是 bug，也可能是未读到的上下文使然）：
- `App.tsx` `recoverFailedCompactionDraft`（约 441-507 行）：`deferRestore(transportWorkspaceIdRef.current, ...)` 与紧随的 `restoreInput(windowWorkspaceId, ...)` 使用了两个不同的 workspace 变量。若两者在远程 workspace 场景可分离，deferred 重放与直接恢复会落在不同 workspace 作用域。建议主审核对 `deferRestore`/`takeDeferredRestores` 的 workspace 匹配语义。
- `apps/webui/src/adapter/web-api.ts:22-46`：`webFilePicker` 只返回**文件名**（无路径），而 Electron 侧对话框返回绝对路径。若 renderer 某处把返回值当路径去 `readFileAttachment`，WebUI 的附件流程会静默失败。注释称“actual file reading is handled elsewhere”——需要追踪确认。
- `shims/node-builtins.ts` 的 throw-on-call 语义意味着任何“以为不会被走到”的 shared 代码路径在 WebUI 被走到时是运行时异常而非编译错误——这是 shim 策略的固有属性（设计风险），但也让真实的 WebUI 回归只能靠手工测试发现。

仅设计风险（非 bug）：
- 16 个 DOM CustomEvent 构成的非类型化总线承载顺序敏感协议（候选 1 的全部内容）。
- App/AppShell/SessionManager/BrowserPaneManager 四个巨文件的 review 与合并冲突成本。
- shared config 桶的 Node 混入导致 WebUI 的 40-shim 依赖。
- `workbench-commands.ts:7-9` 与 `NavigationContext.tsx:62` 反向 import `components/project-files/project-file-document-registry`（状态层→组件层），该文件其实是纯逻辑，只是放错了目录——一行搬家即可修，顺带做。

---

## 四、实际覆盖范围声明

- **深入阅读**（结构+关键段落逐行）：App.tsx（约 800 行分布在 328-2900 区间）、AppShell.tsx（状态区与职责盘点）、NavigationContext.tsx、AppShellContext.tsx、event-processor 四件套、session-draft-coordinator.ts（头部 120 行+全部字段）、workbench-state/commands、atoms/sessions（导出面）、project-files 渲染层（document-registry、两个 document controller、drawnix-board-registry）、server-core handlers/rpc/project-files.ts（584-935 区间）、pdf-state 双侧开头、browser-pane-manager.ts（头部 110 行+155 方法全清单）、IBrowserPaneManager 全文、RemoteBrowserPaneManager 头部、NullBrowserPaneManager 头部、SessionManager.ts（方法全清单+2362/1080 等三段）、session-manager-interface 头部、webui（App.tsx、web-api.ts 关键段、vite.config 全部 alias 段、两个 shim）、shared（package.json exports、config/index、若干 fs import 盘点）、transport（build-api 全文、channel-map 头部）、main/index.ts 头部、browser-application-router 头部、messaging-gateway/gateway.ts 头部、docs/build/test（package.json scripts、run-source-tests、draft-consumption fixture）。
- **结构盘点未深入**：packages/ui 组件内部（TurnCard 1966 行仅看导出）、session-tools-core、apps/cli、apps/viewer 内部、messaging-whatsapp-worker、SessionManager 13k 行中的多数方法体、browser-pane-manager 各方法实现体、i18n 资源。
- 静态扫描给出的 shared 内部大环（resolve→config→sources→…）我按提示未当作缺陷：其成员经 index 桶再导出是主因，真实依赖方向需逐边核实，本轮未验证。
- 未读取任何密钥/个人配置；未修改任何文件。

**给主审的反驳入口**：候选 1 的“总线是否值得保留”、候选 2 的“单类可检索性 vs 可测性”、候选 4 的“WebUI 战略地位决定投入”、候选 5 的“抽象税 vs 复制税”是我认为最值得交叉讨论的四个权衡点。