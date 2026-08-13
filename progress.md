# 产品 Stair 的重建进度记录

## 总览

- 重建基线：`upstream/main@50ffa143ab76`。
- 当前分支：`codex/stair-rebuild-v2`。
- 产品原则：不保留旧用户数据，只重建已经确认的产品能力。
- 已完成：阶段 1—18、21—26。
- 仍进行中：阶段 19 的少量 Computer Use 指针场景、阶段 20 的 native Browser 滚动闪烁最终像素复验。
- 当前文档：`task_plan.md` 记录计划与约束，`findings.md` 记录结论与原因，本文件记录执行和验证时间线。

## 2026-08-06：领域模型与 Workbench 初版

### 阶段 1：仓库盘点与领域不变量

- 核对 Craft 上游、Stair 二开、旧检查点和当前未提交范围。
- 确认用户要求清空应用数据，但保留外部 Project 工作目录。
- 为 Workspace 增加必需的 `defaultProjectId`。
- 为 Session 增加必需且不可变的 `projectId`。
- 更新共享类型、bundle、服务端入口和旧测试夹具。
- shared 完整测试暴露 4 个缺少 `defaultProjectId` 的旧 Workspace 夹具，修正后转绿。
- server-core 完整测试暴露 35 个缺少 Project 归属的旧 Session 夹具，统一修正后 227 项通过。
- `typecheck:all` 因上游 `session-tools-core` 缺少 `tsconfig.base.json` 中断；shared、server-core 和 Electron 改为独立验证。

### 阶段 2：最小 Workbench 与导航边界

- 建立可为空的 Primary、有序 Auxiliary 和显式聚焦/打开/关闭命令。
- 普通 Project/Session 选择不再自动增加 Auxiliary。
- 将 Project 过滤落实到 Session 读取、选择和任务入口。
- 迁移 AppShell 与 NavigationProvider 到新的 Workbench 边界。
- 修复就绪状态关闭处理器的错误接线，避免重新认证分支引用尚未存在的 Navigation 上下文。
- 完整 Renderer 源码测试在正确工作目录下通过 493 项。
- Electron main 完整测试仍有 8 个 `BrowserPaneManager` 失败；确认 `apps/electron/src/main` 相对上游无差异，单列为基线或环境问题。
- `build:validate` 因上游缺少 `validate-assets.ts` 无法完成；Renderer、main、preload 和 copy 构建分别通过。

### 阶段 3：壳层布局

- 固定 Sidebar 与 Navigator。
- 只允许内容视口承担横向滚动。
- 取消布局组件对 Workbench 内部状态的分散写入。
- 验证 Project 切换、Primary 为空和 Auxiliary 顺序。

### 阶段 4：资源与 Add Chat

- 分开用户 Add Chat 和后台 Agent 投递。
- 用户 Add Chat 创建可见 Session 并聚焦；后台投递不改变布局。
- 为文件预览、Browser 和阅读器建立各自生命周期。
- 加入八 Panel 容量预检和明确错误传播。

### 阶段 5：持久化与历史处理

- 不实现旧 Stair 数据或布局迁移。
- 只保存必要布局与用户偏好。
- 确认 `scripts/stair-dev.ts` 同时设置应用名和 `~/.stair` 配置目录。

### 阶段 6：自动验证

- 聚焦测试、Renderer 源码测试、相关 package 测试和独立 typecheck 完成。
- lint 的既有错误和警告与本次补丁片段分开记录。
- `git diff --check` 用于每轮最终差异检查。

### 阶段 7：真实 Electron 验收

- 验证默认启动不隐式创建 Panel。
- 验证 Project/Session 选择、Add Chat、横向 Workbench 和 Panel 关闭。
- ScreenCaptureKit、窗口标识和锁屏造成的不可用场景均记录为环境限制，没有冒充通过。

### 阶段 8：审查后回归修复

- 独立审查发现早期事件丢失、陈旧 task 回退、旧 Session 污染和 Project 过滤所有权缺口。
- 为四类问题先补失败测试，再修复权威数据源和过滤边界。
- 重跑相关 package、Renderer、typecheck 和 UI 路径。

### 阶段 9：Project File Preview

- 初版错误地让普通 Project File 选择替换 Primary。
- 用户澄清后改为：所有 Project File 都使用单一复用 Preview Auxiliary；Browser 不参与 Preview。
- 增加普通选择、重复选择、跨格式替换和容量边界测试。
- Computer Use 因 ScreenCaptureKit 失败时，保留结构与运行时证据并在新窗口补验。

### 阶段 10：Panel 宽度稳定

- 第一次修复只阻止反向显露，Panel 仍随壳层宽度变化而缩放。
- 继续追踪后分离“可见裁剪宽度”和“Panel 稳定尺寸基准”。
- 真实 Electron 验证 Sidebar/Navigator 切换时 Panel 宽度不变。

### 阶段 11：选择动作回归

- 复现 Add Chat 刚创建 Session 却立即提示引用无效。
- 根因是异步动作捕获了创建前的 `sessionMetaMap`。
- 改用创建接口返回的 Session 处理当前动作，并把无绑定 Browser 目标规范化为 `undefined`。
- 容量错误和阅读器错误改为保留具体原因。

### 阶段 12：已有文件 Panel 显露

- 红测试证明成功激活已有 Project File 后没有可重复的显露信号。
- 增加运行时 reveal revision，并让 Workbench 容器消费。
- 完成重复选择和视口外 Panel 的测试。

### 阶段 13：Browser 原生表面同步

- 复现 DOM Panel 与 Electron View 在滚动期间短暂错位。
- 持续几何更新与真实遮挡处理被拆分。
- 加入 Browser 表面同步和生命周期覆盖。

## 2026-08-07：原生 Browser 静态边界

### 阶段 14：关闭相邻 Panel 后的静态裁剪

- 根据用户澄清重新复现：问题发生在关闭 Project File Panel 后，而非普通滚动时。
- 在布局稳定后重算 Browser View 几何，不销毁 Browser 运行时。
- 验证关闭、重新排列和静止状态。

### 阶段 15：固定 Sidebar 边界

- 发现 Browser 可见矩形没有完整扣除固定左 Sidebar。
- 将 Sidebar 纳入不可穿透边界。
- 验证 Sidebar 展开、收起与窗口缩放。

## 2026-08-08：系统审计与外部挑战

### 阶段 16：原生表面系统审计

- 审计 `React → DOM geometry → IPC → Electron View` 全链路。
- 明确 reducer 与 mock 测试不能替代真实像素验收。
- 将持续缩放/滚动、真实遮挡和壳层动画分开处理。

### 阶段 17：Claude 与 Kimi 审查

- 使用 Claude 和 Kimi 挑战状态所有权、异步事件顺序、Project 隔离和 Browser 生命周期。
- 所有建议回到代码定义、调用者和测试逐条核实。
- 最终没有增加新框架或兼容层，继续收紧单一 Workbench 命令模型。

## 2026-08-10：原生表面门控与检查点审计

### 阶段 18：壳层运动门控

- 壳层动画开始时暂停原生表面，DOM 稳定后按最新几何恢复。
- 双 Browser 重载验收触发 `MaxListenersExceededWarning`。
- 失败测试复现 12 个累积 host `closed` 监听器；移除每个 lease 的单独注册后转绿。
- 锁屏前已完成主要 UI 矩阵，开发进程保留供解锁后手测。

### 阶段 19：最终 Computer Use 复验

- 书签菜单、地址栏和多 Browser 路径完成可执行部分。
- 多次遇到陈旧 AX element、`elementHasNoFrame`、`noWindowsAvailable` 和 Electron 标识歧义。
- 处理原则是每次重新获取窗口与可访问性树，不复用旧索引。
- 孤立 Browser Close 等指针专属场景尚未正式关闭。

### 阶段 20：滚动闪烁

- 用户观察到 Browser 在滚动中闪烁。
- 确认整段手势暂停原生表面虽能避免错位，但会产生明显空白闪烁。
- 结论是门控范围需要收窄到未提交的壳层运动或真实遮挡。
- 最终像素复验保留为进行中。

### 阶段 21：旧检查点审计

- 对比 `6be3dd4b`、`6dc6c9fb` 和 `upstream/main`。
- 旧分支把领域模型、PanelStack、Side Chat、Browser 和布局时序绑在一起，继续叠加风险高。
- 决定从干净上游按阶段重建产品能力，不保留用户数据。

## 2026-08-11：干净重建与 Panel 聚焦

### 阶段 22：从上游完成 Phase 1—2

- 从 `upstream/main@50ffa143ab76` 建立 `codex/stair-rebuild-v2`。
- Phase 1 完成 Workspace/Project/Session 强不变量。
- Phase 2 完成最小 Workbench、导航边界和 AppShell 接线。
- 初次真实启动发现 `CRAFT_CONFIG_DIR` 不会自动重定向 Workspace；停止 UI 变更后改用显式预置临时 Workspace。
- 完成审查后四类回归的红测试和最小修复。
- 最终确认本地 HEAD 与上游基线 SHA 一致后再继续未提交实现。

### 阶段 23：点击 Session 时自动显露 Panel

- 复现点击非 Primary Session 后焦点 id 改变，但横向视口不移动。
- 第一版 `scrollIntoView` 在真实 UI 中失败并滚动页面根节点，出现灰色离屏视口。
- 改为由 `WorkbenchContainer` 计算最近水平差值并调用自有 `scrollTo`。
- 聚焦测试、完整 Renderer 测试和真实 Electron 几何验收通过。

## 2026-08-12：简化、Navigator 收起与文档整理

### 阶段 24：简化全部未提交改动

- 按 `code-simplifier` 检查当前所有未提交改动，明确排除 `promo/`。
- 只清理本次代码中的重复判断和可直接表达的状态推导。
- 未修改无关上游代码，也未引入新的辅助函数或抽象层。
- 聚焦测试、完整 Renderer、Electron typecheck 和差异检查通过。
- 变更 Renderer 文件的广义 lint 有 4 个既有错误和 43 个警告；实际简化片段为 0 个 lint 错误。

### 阶段 25：Navigator 独立收起

- 增加持久化 `navigatorVisible`。
- 在桌面 TopBar 增加 Navigator 切换按钮，并补齐 7 份 locale。
- AppShell 在收起时把 Navigator 宽度设为 0，同时隐藏它的 sash。
- Workbench、Panel、Navigation、Project 和 Session 模型均未改变。
- TopBar 聚焦测试 2/2 通过。
- 完整 Renderer 497/497 通过，共 886 个断言。
- Electron typecheck、locale JSON、`git diff --check` 和聚焦 lint 通过；聚焦 lint 为 0 个错误、15 个既有警告。
- 真实 Renderer 验证宽度 `300 → 0 → 300`，sash `2 → 1 → 2`，URL、选择和 Panels 不变。
- 焦点模式下第一次点击只退出焦点模式，不改变 Navigator 偏好。
- 验收结束时 Navigator 已恢复显示，开发版继续运行供用户测试。

### 阶段 26：三份工作文档中文化

- 明确只处理 `task_plan.md`、`findings.md` 和 `progress.md`，不改产品代码。
- 完整盘点 26 个阶段、架构结论、验证结果和错误记录。
- 将英文自然语言改写为中文；代码标识、命令、文件名、路径、测试名和固定产品术语保留原文。
- 重复的补丁失败、窗口失效和基线错误按根因合并，保留阶段与最终处置。
- 文档结构改为：计划负责约束，调研负责原因，进度负责时间线，减少三份文件之间的逐句重复。
- 机器检查确认 26 个阶段齐全、没有纯英文正文行、Markdown 表格列数一致、三个未跟踪文档均无空白格式错误。

## 验证结果汇总

| 检查 | 结果 | 说明 |
|---|---|---|
| shared 领域测试 | 通过 | 旧 Workspace 夹具补齐 `defaultProjectId` |
| server-core 完整测试 | 通过 | 227 项；旧 Session 夹具补齐 `projectId` |
| Renderer 源码测试（Phase 2） | 通过 | 493 项；必须从源码工作目录运行，避免发现 `release` 副本 |
| Renderer 完整测试（Phase 25） | 通过 | 497/497，共 886 个断言 |
| TopBar Navigator 聚焦测试 | 通过 | 2/2 |
| Electron typecheck | 通过 | 覆盖当前 Renderer 与共享接线 |
| locale JSON 校验 | 通过 | 7 份目录文件均可解析 |
| `git diff --check` | 通过 | 未发现空白或补丁格式问题 |
| 中文文档结构检查 | 通过 | 26 个阶段完整，无纯英文正文行，表格列数一致 |
| 聚焦 lint | 通过 | 0 个错误；警告为既有问题 |
| Electron main 完整测试 | 基线失败 | 8 个 `BrowserPaneManager` 失败；main 相对上游无改动 |
| `typecheck:all` | 基线阻断 | 上游 `session-tools-core` 缺少 `tsconfig.base.json` |
| `build:validate` | 基线阻断 | 上游缺少 `apps/electron/scripts/validate-assets.ts` |
| Computer Use 指针专属场景 | 部分未覆盖 | 受 AX 几何框、窗口标识、隐藏文档和锁屏限制 |

## 错误处理摘要

- 补丁上下文不匹配时，补丁均被原子拒绝；随后按精确小范围拆分，没有通过模糊替换写文件。
- 读取输出过长时，改为按符号、标题或短行段读取，没有重复消耗同一失败路径。
- 测试命令误发现 `release` 副本后，固定 Renderer 源码工作目录。
- 真实 UI 元素失效后总是重新获取窗口和 AX 树，不复用过期索引。
- 上游基线失败始终与本次回归分开，未为追求全绿而扩大修改范围。
- 详细错误、发生阶段与处置见 `task_plan.md` 的“错误与处置记录”。

## 五问恢复检查

1. 当前在哪里：`codex/stair-rebuild-v2`，基于 `upstream/main@50ffa143ab76`。
2. 最终目标是什么：不保留旧数据，以最小边界重建 Stair 产品能力。
3. 已完成什么：重建方案阶段 0—3，包括领域不变量、最小 Workbench、Project Files、文本文档生命周期及配套验证。
4. 还剩什么：重建方案阶段 4—9；旧分支阶段 19—20 只保留为历史问题记录。
5. 下一步如何验证：等待用户确认后，从阶段 4 的 EPUB/PDF Fixture 和统一文档边界开始，不提前接入引用或 Browser。

## 当前快照

- 普通导航默认不创建 Panel。
- 点击已有非 Primary Session 会聚焦并自动滚入可视区域。
- Navigator 可以独立收起和恢复，Workbench 布局保持不变。
- Project File 普通打开复用唯一 Preview，显式打开才新增持久 Auxiliary，Primary 不变。
- 文本文档支持 dirty、自动保存、比较保存和关闭前 flush；阶段 3 已完成真实 Electron 验收。
- 阶段 4—9 尚未开始；`promo/` 仍不在范围内。

## 2026-08-12：彻底完成阶段 0（完成）

- 用户确认权威进度文件为 `docs/stair-rebuild-plan.md`，并要求彻底完成阶段 0。
- 已确认 HEAD 与 `upstream/main` 均为 `50ffa143ab76`。
- 已确认通用环境变量能力存在，但 Stair 专属开发/构建入口、数据命名空间和端口尚未实现。
- 下一步先建立失败测试，再以现有多实例和配置路径机制完成最小实现。
- 已加入品牌、userData、脚本环境、打包资源、独立深链和系统提示测试。
- 红测试：20 项通过、5 项失败、3 个缺失模块错误，符合实现前预期。
- 首轮实现后 31 项通过、1 项测试输入错误；已修正该测试的 Backend 参数。
- 第二轮聚焦测试 32/32 通过，共 90 个断言。
- `packages/shared` 与 `apps/electron` TypeScript 检查均通过。
- 同一聚焦测试复跑仍为 32/32 通过，`git diff --check` 通过。
- locale parity 与 sorted 检查通过；coverage 检查被上游缺失的 `scripts/check-i18n-coverage.ts` 阻断。
- 根目录没有 ESLint 9 配置，聚焦 lint 将改走各 package 的既有入口。
- 阶段 0 Electron 聚焦 lint 以 0 个错误通过，仅报告 `main.tsx` 两条既有 localStorage 警告；shared 聚焦 lint 同样 0 个错误。
- Electron 全量 lint 的 9 个错误均落在阶段 0 之外的既有/阶段 1—2 WIP，已与本阶段结果分开记录。
- 默认 `bun run electron:build` 成功，证明 Craft 构建入口未被阶段 0 破坏。
- `bun run stair:build` 成功生成 `apps/electron/release/mac-arm64/Stair.app`；electron-builder 已加载 Stair 配置及 Craft 父配置并完成 ad-hoc 签名。
- 成品包已确认包含 `stair-main.cjs`、主进程、Renderer 和 Stair 图标，bundle id 为 `io.github.build-my-work.stair`，构建期 Renderer 品牌为 Stair。
- 成品检查同时发现 macOS 尚未注册 `stair://`，且打包入口未显式选择包内 Stair 窗口图标；已先补回归断言，等待最小修复后重新打包。
- 新增断言先以 2 项通过、1 项失败复现该缺口；随后按 electron-builder 官方 `protocols.name/schemes` 配置声明 `stair://`，并让打包入口按平台选择包内 Stair 图标。

## 2026-08-12：阶段 0 用户状态路径收口（完成）

- 用户确认继续修改，范围限定为数据与日志路径，不改变 Project、Session、Workbench 业务逻辑。
- 修复前 Craft 5173 与 Stair 5193 可并行运行，Stair Electron 子进程已使用 `~/.stair/electron`，但窗口状态和部分日志路径仍存在 `~/.craft-agent` 硬编码。
- 下一步先区分真实运行时读写、注释和测试夹具，再以失败测试冻结最小范围。
- 第一轮审计已定位共享层真实数据路径：credentials、interceptor、默认 Workspace、docs、release notes、provider cache 和 Browser prerequisite；`permissions-config.ts` 已正确支持覆盖，排除在修改范围外。
- 第二轮审计已定位 Electron/Server 路径：审计日志、注销配置、slug 检查、窗口状态、三类日志和 messaging 目录。
- 方案冻结为“现有 `CONFIG_DIR` 接线”：默认 Craft 不变；显式 Stair 配置目录控制全部自有状态；外部 Project 工作目录不变。
- 已核对现有子进程测试模式，下一步先增加关键路径行为测试和生产源码硬编码扫描，使当前实现按预期转红。
- 已确认主日志可用 electron-log 现有 `resolvePathFn` 配置，不需要改 Electron 日志库或新增依赖。
- 已增加生产代码架构守卫；首轮结果为 3 项通过、1 项预期失败，准确列出 13 个绕过集中配置的文件。
- 首次更新记录时补丁标记错误，补丁被原子拒绝且没有文件改动；已按精确原文重新应用。
- 两次相关测试检索因 zsh 展开可空 glob 报错；已切换为 `rg --files`/`-g`，不影响代码和测试结果。
- 关键路径行为子进程首次退出码为 0，但窗口日志污染 stdout 导致 JSON 解析失败；已改为提取带固定前缀的结果行后重跑。
- 第一轮 13 个路径接线后，相关回归 29/29、shared/server-core/Electron 类型检查和两套聚焦 lint 均通过。
- 更宽扫描发现 Renderer 与 Agent 仍有实际产品路径硬编码；新增第二轮红测试后为 12 项通过、5 项失败，准确覆盖待补边界。
- 第二轮实现后 24/24 转绿；随后复核实际 handler 注册链，将配置目录 RPC 从 Electron 旧 core 入口移到当前使用的 `server-core` 入口。
- 阶段 0 与路径相关的聚焦回归扩至 81/81，共 1423 个断言；三层类型检查、locale JSON、parity、排序和补丁格式均通过。
- shared/Electron 聚焦 lint 为 0 error；Electron 两条 warning 位于本次未改旧行。
- `lint:ipc-sends`、`lint:tool-name-checks`、`lint:i18n:strings` 均因上游对应 shell 脚本不存在而无法运行，已与本次结果分开记录。
- 首次 package 级并行测试因命令包含递归清理临时目录而被执行策略在启动前拒绝；确认没有残留测试进程，改为不在命令中删除后重跑。
- 第二次 package 级测试暴露两项测试环境问题：server-core 临时目录未执行启动初始化，Renderer 又发现了打包副本；两者不计为产品回归，按真实启动夹具和源码工作目录重跑。
- Renderer 源码全量 497/497 通过；server-core 在完整隔离夹具下 228/229，唯一失败是既有测试依赖全局 `slug-A` 连接，使用当前默认配置单跑 8/8 通过。
- shared 隔离全量首轮 2202 通过、5 失败；五项同源于 interceptor 测试夹具仍写 Craft 固定目录，已改为 `CONFIG_DIR` 后重跑。
- 成品复核又发现阶段 0 的独立深链只完成了主进程协议注册：Renderer 的十个用户入口和 `server-core` 内部路由仍固定使用 `craftagents://`。先增加产品 scheme、路由和源码边界红测试，首轮分别失败，证明 Stair 入口会被当作外部 URL。
- 最小修复由 Vite 注入当前产品 scheme，Renderer 统一通过一个被十处复用的链接构造函数生成 URL；服务端和窗口 URL 安全分类器只把当前产品 scheme 当作内部深链。Craft 默认仍是 `craftagents`，Stair 使用 `stair`。
- 深链补齐后聚焦回归 58/58 通过，共 123 个断言；默认 Craft 与 Stair scheme 均有行为覆盖。
- 补齐深链后，`bun run electron:build` 与 `bun run stair:build` 均以退出码 0 完成；Stair 成品的包名、bundle id、入口、图标和 `stair://` 注册均通过检查。
- 第一次追加深链进度时引用了 `findings.md` 中才存在的上下文，组合补丁被原子拒绝且未修改任何文件；按各文档真实末尾拆分后成功记录。
- Stair 单独运行期间，`~/.craft-agent` 的 289 个文件摘要前后均为 `b349821476f3463c65932da57ecef3018be79b9f347ab6bef124bbfcc68d3cd8`，证明本次运行未改写 Craft 数据。
- 真实日志确认 Stair 的配置监听、Workspace、credentials、主日志、消息网关日志和 Electron userData 均位于 `~/.stair`；默认 Craft 继续使用原有目录。
- Computer Use 分别确认 Craft Agents 与 Stair 窗口，并在 Stair Appearance 设置中看到 `~/.stair/tool-icons/tool-icons.json`。
- 用户要求使用当前选中的 `os` Project 验收，因此没有清空、迁移或删除 `~/.stair`；该调整已写入权威方案。
- 阶段 0—2 至此完成，阶段 3 未开始。

## 2026-08-12：开始重建方案阶段 3

- 将阶段 3 状态更新为进行中，范围限定为 Project Files 与文本文档。
- 已先增加阶段 3 红测，覆盖规范化 Project 相对路径、符号链接隔离、Workspace/Project 授权、SHA-256 比较保存、唯一 Preview、显式 Auxiliary，以及 flush 失败时的布局 veto。
- 红测按预期因 `project-files` 协议/服务、Document Registry 与 Workbench 文件命令尚不存在而失败；这是本阶段实现前的基线，不是既有回归。
- 一次聚焦类型检查把 `--cwd` 放在 `bun run` 之后，仅输出 Bun 用法且未执行检查；已改用 `bun --cwd <dir> run typecheck`，不把该次结果计为通过。
- 明确不提前实现 EPUB/PDF、引用、Add Note、原生 Browser 或旧数据迁移。
- 下一步先盘点 Craft 当前文件 API、旧 Stair 行为规格与当前 Workbench 命令边界，再增加失败测试。

## 2026-08-12：完成重建方案阶段 3

- 完成共享 Project File 路径、分类、DTO、RPC channel、事件与路由协议；7 份 locale 已补齐并通过数量、parity 和排序检查。
- 完成服务端 Project 授权与文件边界：只使用显式 `workingDirectory`，拒绝绝对路径、路径穿越、符号链接、特殊文件和跨 Workspace Project；目录按层懒加载并限制 500 项。
- 完成稳定文本读取与比较保存：SHA-256 fingerprint、同文件串行队列、临时文件原子替换、父目录同步，并保留 BOM、CRLF/LF、末尾换行和原权限。
- 完成 Workbench `project-file` Panel：唯一 Preview 是 Auxiliary，普通点击替换或聚焦 Preview；右键“Open in New Panel”创建显式持久 Auxiliary，Primary 始终不变。
- 完成文档控制器与页面：Markdown/代码预览、源码编辑、dirty、800 ms 自动保存、保存合并、重试、冲突、Cmd-S 和 flush veto。
- Preview 替换、Panel 关闭、Project 切换与应用退出都在状态变化前等待 Document Registry；失败会保留布局和草稿。
- 聚焦回归 44/44 通过，共 486 个断言。
- shared 源码全量 3012 项通过、12 项跳过、0 项失败，共 5830 个断言；server-core 234/234 通过，共 481 个断言；Renderer 506/506 通过，共 918 个断言。
- shared、server-core、Electron 三层类型检查均通过；`git diff --check`、locale parity/排序与阶段 3 聚焦 lint 通过。
- Electron main 源码套件 343 项通过、8 项失败；8 项均为未修改的既有 `BrowserPaneManager` 基线失败。根目录 `bun test` 还会发现 `release` 中的旧源码副本，并混入同一组既有 Browser/headless 失败，因此不计为阶段 3 回归。
- `bun run electron:build` 与 `bun run stair:build` 均通过；构建仍报告上游 `session-tools-core` 缺失 `tsconfig.base.json` 的警告和既有大 chunk 警告。
- Computer Use 在当前 `os` Project 完成真实验收：刷新文件树，普通文件 Preview 原位复用，右键显式 Panel 与 Preview 并存，文本自动保存成功，修改后立即关闭 Panel 仍先 flush 成功。
- 验收只创建了 `stair-stage3-acceptance.md` 临时文件；最终内容写盘验证后，文件、Preview 和显式 Panel 均已清理，现有用户文件未修改。
- 独立目录包 `Stair.app` 仍复现“进程存在但无窗口”，发生在业务主进程日志加载前；阶段 3 使用真实 `bun run stair:dev` Electron 窗口完成验收，该问题留到阶段 9。
- Stair 5193 与 Craft 5173 开发进程均已恢复；Stair 保持在 `os` 的 Project Files 视图供继续手工测试。
- 阶段 3 至此完成，等待用户确认后再进入阶段 4。

## 2026-08-13：阶段 3 审查修复与交付收口

- 独立审查确认原实现仍有三处生命周期缺口：Workspace 切换没有先 flush、窗口关闭的 3 秒兜底可能抢在保存完成前退出、自动更新安装没有等待 Project File flush。
- Workspace 切换现在由服务端在改变窗口映射前请求当前 Renderer flush；失败会拒绝切换，Renderer 保留当前 Workspace、Workbench 和草稿。
- 窗口关闭现在先取消主进程兜底计时器，再等待文档 flush；自动更新先 flush，失败时恢复 `ready` 状态并阻止 `quitAndInstall`，成功后才进入清理和安装。
- 文档控制器补齐冲突恢复：内容回到已保存版本时清除错误状态；页面提供带确认的“重新加载”，显式放弃草稿后可继续编辑和自动保存。
- 保存逻辑不再折叠末尾换行，允许空文件，只按原文件换行风格转换内容；含 NUL 的文本被拒绝，常见 dotfile 被识别为可编辑文本。
- Project File 专用错误码已纳入共享协议白名单，并增加传输层保持错误类型的回归测试。
- 审查后聚焦回归 52/52 通过，共 188 个断言、11 个文件；shared/server-core/Renderer 完整源码回归分别为 2211/239/508 项通过，均为 0 项失败。
- shared、server-core、Electron 三层类型检查通过；7 份 locale 各 1661 个 key，parity 与排序检查通过；聚焦 lint 为 0 error。
- 本轮新增测试先复现上述缺口，再以最小实现转绿；阶段 4 仍未开始，`promo/` 未触碰。
