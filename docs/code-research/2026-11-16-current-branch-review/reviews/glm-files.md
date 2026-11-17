> 独立评审原稿，未自动采纳。主报告与交叉讨论中的验证和纠错优先。实际调用标识：zcode/GLM-5.3。不包含内部推理日志。

# Stair 评审报告（GLM，只读静态审查）

**审查范围**：ProjectFilePage 及 reader/editor 集成、两个文档控制器与注册表、AppShell/导航/workbench 命令、server-core 的 project-files / project-notes / reader-state / workbench-layout / projects RPC、shared 的 projects storage/lifecycle、自动保存与退出 flush 生命周期。共约 45 次实质读取。所有结论均为**静态推断（proposed，未执行）**；凡有现存测试佐证的均已注明。

## 总体印象

这套代码的保存/冲突防线是认真设计过的：CAS 指纹保存（双读 + 进程内写队列，project-files.ts:712-770）、面板关闭/项目切换/Workspace 切换/关窗四条路径全部"先 flush 后 veto"（switchWorkbenchProjectAtom、SWITCH_WORKSPACE 服务端 flush、useWindowCloseHandler）、project-notes 的持久化幂等回执、reader 状态协调器的 dispose/flush 语义，均有对应测试（project-files.test.ts:836-877、workbench-compact-lifecycle.isolated.ts、project-text-document-controller.test.ts）。以下缺陷是防线的**边角缺口**，而非主线漏洞。

---

## 缺陷（按严重度排序）

### D1. 面板卸载时的后台 flush 失败被完全静默，未保存修改丢失且无任何用户可见信号
- **位置**：`apps/electron/src/renderer/pages/ProjectFilePage.tsx:206-219`（`controller.flush().catch(→ debugLog)`）；同型代码 `ProjectFileDrawnixCanvas.tsx:71-81`。
- **触发**：任何**没有前置 flush 闸门**的卸载路径。最具体的一条：`reconcileWorkbenchProjectsAtom`（`workbench/workbench-commands.ts:792-815`，由 `AppShell.tsx:716-721` 在项目列表变化时调用）直接裁剪消失项目的布局 → 面板卸载 → 卸载 flush 是 fire-and-forget。例如在另一窗口删除了当前正被编辑（dirty 或处于 conflict）文件所属的项目：项目删除本身不删工作目录里的文件（storage.ts 只删 `projects/{slug}`），但删除后 `loadProjectById` 返回 null，flush 以 `PROJECT_FILE_NOT_FOUND` 失败；若失败原因是 `PROJECT_FILE_CHANGED` 冲突，同样只写 debugLog。
- **效果**：编辑器内容随组件一起消失，未保存修改丢失，无 toast、无草稿文件。
- **为什么现有防线拦不住**：关面板（workbench-commands.ts:649）、切项目（:123）、切 Workspace（workspace.ts:96-103 服务端 veto）、关窗（useWindowCloseHandler.ts:93-105）都是在卸载**之前** flush 并 veto；reconcile 路径是唯一"先卸载、事后 flush"的路径，而卸载 cleanup 的 catch 只调 `debugLog`。
- **置信度**：代码行为高（静态）；触发频率中低。
- **最小修复**：reconcile 裁剪前对被裁剪项目执行 `flushOpenProjectFilesForProject` 并 veto（对齐 switchWorkbenchProjectAtom 的模式）；或在卸载 cleanup 的 catch 里补 toast + 复用现有"另存草稿"（`handleSaveDraftAs`）兜底。

### D2. projects.\* RPC 以调用方传入的 workspaceId 授权，与全仓其它 handler 的上下文授权不一致
- **位置**：`packages/server-core/src/handlers/rpc/projects.ts` — GET/GET_ONE/CREATE/UPDATE/DELETE/LIST_ASSETS/UPLOAD_ASSET/DELETE_ASSET 全部签名为 `(_ctx, workspaceId, ...)`，从不校验 `context.workspaceId` / `windowManager.getWorkspaceForWindow`。
- **对比**：project-files.ts:789+（`resolveAuthorizedProjectRoot`）、project-notes.ts（`authorizedWorkspace`）、reader-state.ts（`resolveWorkspaceRoot`）、workbench-layout.ts 均从请求上下文解析 workspace。
- **触发/效果**：任何 RPC 客户端（渲染端 bug、被污染的 renderer、未来接入的第三方客户端）传任意 workspaceId 即可**创建/删除/改配置**另一个 workspace 的项目；DELETE 是破坏性操作（虽有 DEFAULT_PROJECT / PROJECT_NOT_EMPTY 保护）。本机单用户模型下实际风险有限，但这是一处真实存在的授权边界不一致，且 `withProjectMutationLock` 的键（workspaceRootPath+projectId）说明锁都做对了、授权却放开了。
- **置信度**：高（源码事实）。
- **最小修复**：projects.ts 改用与 reader-state 相同的 `resolveWorkspaceRoot(context, deps)`；workspaceId 参数保留为兼容但校验 `=== context.workspaceId` 或忽略之。见重构建议 R2。

### D3. workbench-layout：客户端重连后首次写入绕过三分合并，整档覆盖另一窗口的布局
- **位置**：`packages/server-core/src/handlers/rpc/workbench-layout.ts:107-110` — `if (!baseline) { writeWorkbenchLayout(rootPath, incoming) }`，无 baseline 时直接把 incoming **全量**写盘。
- **触发链**（静态推断）：baseline 以 `(rootPath, clientId)` 为键（:99-100）；WS 重连会产生新 clientId（server.ts:834-840 的 `updateClientWorkspace` 佐证连接级身份），renderer 侧 `restoreWorkbenchLayoutsAtom` 只在启动执行一次（`workbenchPersistenceReadyAtom` 门控，workbench-persistence.ts:121+），重连后**不重读**磁盘。同 workspace 允许两个写者并存：主窗口 + 聚焦窗口（`App.tsx:2857` 将 `isFocusedMode` 传入同一 AppShell，含 WorkbenchPersistenceBridge）。于是：窗口 A、B 同 workspace 各改不同项目的布局 → A 断线重连 → A 再做任意布局改动 → 首次 WRITE 无 baseline → 用 A 内存中的整份 `layoutsByProject` 盲写，覆盖 B 对其它项目的全部修改。
- **附带**：`baselines` Map 永不清理，长驻进程 + 频繁重连会持续增长（轻微）。
- **为什么现有防线拦不住**：三分合并（:112-131）只在 baseline 存在时生效；per-project 合并逻辑本身是对的，问题只在"新 clientId 无 baseline"分支退化成盲写。
- **置信度**：代码路径高；"同 workspace 双窗口"前提中（聚焦窗口确会渲染同一 persistence 桥）。
- **最小修复**：无 baseline 时先 `readWorkbenchLayout(rootPath)` 作为 baseline 再走合并（或直接把 incoming 与磁盘 current 做同样的 per-project 合并）；同时给 `baselines` 加简单上限清理。

### D4. Drawnix 保存失败不区分"冲突"与"临时错误"，冲突时 Retry 按钮必然无效
- **位置**：`drawnix-document-controller.ts:90-97`（`runSave` 的 catch 把包括 `PROJECT_FILE_CHANGED` 在内的所有失败统一置入 `saveError`/`error` 态，`sourceFingerprint` 不变）；`ProjectFileDrawnixCanvas.tsx:127-135`（对任意 error 都渲染 Retry + Reload）。
- **触发**：外部（或另一面板/Agent note append）改动 .drawnix 文件后，画布自动保存得到指纹冲突。
- **效果**：Retry 用**过期的** `expectedFingerprint` 重试 → 必然再次 `PROJECT_FILE_CHANGED` → 死循环按钮；用户唯一出路是带 confirm 的 Reload（整板丢弃，包括 Agent 通过 `update()` 已应用到本地编辑器的操作，drawnix-document-controller.ts:135-141 先应用后 flush）。对比文本编辑器：ProjectTextDocumentController 明确区分 conflict/error（controller:135-143），UI 在 conflict 态不显示 Retry（ProjectFilePage.tsx:337-343 仅 `status === 'error'` 时渲染 Retry）。
- **置信度**：高（纯静态逻辑）。
- **最小修复**：在 DrawnixDocumentController 的 catch 里按 `code === 'PROJECT_FILE_CHANGED'` 置冲突标记，画布 UI 对冲突隐藏 Retry（或文案改为"必须重载"），对齐文本编辑器行为。

### D5. 引用跳转 / 预览切换的 flush veto 对用户完全不可见
- **位置**：`workbench-commands.ts:493-500`（`openProjectFilePreviewAtom` 替换预览面板前 flush 旧文件，失败 `return false`）；调用方 `ProjectFilePage.tsx:330-340`（`handleMarkdownLink` 里 `void openProjectFilePreview(...)` 丢弃返回值）、`AppShell.tsx` `handleRevealReference`（返回 false 但仅在引用列表 UI 上表现为"点击无反应"）。
- **触发**：当前预览的文件处于 conflict/error 态时，用户点击聊天引用或 Markdown 链接。
- **效果**：veto 机制本身工作正常（不会丢数据），但没有任何 toast/提示，表现为"点了没反应"。同理 `selectSessionFromNavigatorAtom` 在源项目 flush 失败时静默 return false。
- **置信度**：高（静态）；严重度低（UX）。
- **最小修复**：在 `openProjectFilePreviewAtom` 返回 false 的 veto 分支抛出/上抛可识别错误，由调用方 toast（复用 `projectFileEditor.saveFailed` 文案）。

---

## 长期重构建议（基于上述实际耦合/失效）

**R1. 收敛"flush-然后-veto"文档闸门为单一服务。** 同一模式现在散布在 6 处：closeWorkbenchPanelAtom（workbench-commands.ts:649）、switchWorkbenchProjectAtom（:123）、openProjectFilePreviewAtom（:493）、useWindowCloseHandler 两处（:42-63, :93-105）、App.tsx 的 Workspace 切换（:2477-2514）、NavigationContext 的 `flushOpenProjectFilesForProject`。每处都手写"flush → 复查 workbenchAtom 是否仍一致 → 才提交"的复查逻辑，细节略有差异，D1 正是漏掉 reconcile 这第七处的直接后果。**边界**：新建 `workbench/document-gate.ts`，暴露 `withProjectFileFlush(projectId, path | '*', mutate, {onVeto})`，逐处替换（可一次一处）。**验收**：现有 `workbench-commands.test.ts` 全部不变通过；新增"reconcile 裁剪遇到 flush 失败时不卸载并提示"的测试（直接锁死 D1）。

**R2. server-core 内统一 workspace 授权解析。** `resolveWorkspaceRoot`/`authorizedWorkspace`/`resolveAuthorizedProjectRoot` 四份近同实现（project-files.ts:789+、project-notes.ts:95+、reader-state.ts:63+、workbench-layout.ts:31+），而 projects.ts 缺失（D2）。**边界**：提取 `handlers/resolve-request-workspace.ts`，先让 projects.ts 采用（修复 D2），其余三处随后替换为纯委托。**验收**：现有 project-files.test.ts / project-notes 相关测试通过；新增"窗口属 workspace A，调 projects.CREATE 传 workspace B → 拒绝"测试。

**R3. 合并 EPUB/PDF reader 状态协调器。** `createEpubStateMutationCoordinator`（project-file-epub-state.ts:344+）与 `createPdfStateMutationCoordinator`（project-file-pdf-state.ts:336-461）约 110 行近乎逐字相同（enqueue 队列、revision-gap refresh、flush 循环、dispose-复活逻辑），唯一实质差异是 `mutate` 对 disposed 一个 reject 一个 throw。这类复制已有漂移迹象，将来修 flush bug 必须改两处。**边界**：提取泛型 `createReaderStateCoordinator<Mutation, State, Response>` 于两文件之间新建的 `reader-state-coordinator.ts`，两个入口薄包装并显式选择 disposed 错误语义。**验收**：`project-file-epub-state.test.ts` 与 `project-file-pdf-state.test.ts` 原样通过。

**不建议动的**：
- **不要合并三种文档控制器本体**（ProjectTextDocumentController / DrawnixDocumentController / reader 协调器）。文本的 debounce+persistedContent 追踪、Drawnix 的 editor.serialize + changeSeq 乐观并发、reader 的进度去抖是三种真实不同的语义，强行统一会造出投机抽象。
- **不要按行数拆 ProjectFilePage/AppShell**。大文件≠缺陷；四个 reader 分支与 AppShell 的巨型 context 是本质复杂度，现有测试（workbench-compact-lifecycle 等）依赖其结构。
- **不要重构 secure-project-note-file.ts 的 FFI 层**。fd/handle-pin 的防替换设计成熟，跨平台行为有布局测试锁定，收益低风险高。
- **不要动 project-notes 的持久化回执机制**。pending→complete 两阶段恢复逻辑复杂但正确，且是防重复追加的关键。

## 明确核查过、未发现缺陷的点（避免误报）

- 文本控制器"保存中再编辑→换新指纹续存"与"undo 回到已保存内容自动清错"（有测试覆盖，controller test:36-84）。
- Workspace 切换的服务端先-flush-后改映射（workspace.ts:96-106，测试 project-files.test.ts:836-877 证明 veto 生效），我最初怀疑的"切换后授权错位导致保存必败"不成立。
- ProjectFilePage 的加载效应：`cancelled` 闭包 + 渲染期同步身份门控（response/binaryResponse 按 projectId+relativePath 过滤）正确防止 A 文件字节配 B 文件身份。
- EPUB/PDF/Drawnix 卸载时"先 flush 完成才反注册"的顺序、异步 load 中 disposed 检查后同步注册的无窗口期。
- 面板按 `panel.id` 作 Fragment key，重排/隐藏（display:none）不卸载编辑器，自动保存跨路由存活。
- `.drawnix` 不会同时创建文本控制器（`isEditableProjectTextFile` 走 `classifyProjectTextFile`，drawnix 扩展名不在任何文本集合中）。