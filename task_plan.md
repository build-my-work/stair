# 产品 Stair 的能力重建计划

## 目标

从已核对的 `upstream/main` 基线重建 Stair 的产品能力，不保留旧用户数据和旧布局迁移逻辑。最终模型必须满足：固定的 Sidebar 与 Navigator、只在内容区横向滚动的 Workbench、可为空的 Primary、显式且有序的 Auxiliary、严格的 Project 隔离，以及不隐式创建 Panel 的普通导航。

## 当前阶段

阶段 33 已完成：阶段 0—4 功能等价回归已经收口并完成审查与验证；停止在阶段 4，不进入阶段 5。

## 成功条件

- 普通 Project、Session 和资源选择不会隐式新增 Auxiliary。
- 每个 Session 永久归属一个 Project，所有读取和写入都按 Project 过滤。
- Workbench 只有一个状态所有者，UI 通过显式命令改变布局。
- Sidebar 与 Navigator 固定；只有 `ContentViewport` 承担横向滚动。
- Navigator、Sidebar 和焦点模式互不串改偏好状态。
- Project File 使用可复用的 Preview Panel；Browser 保持持久 Auxiliary 语义。
- 后台消息投递不改变可见布局；用户显式操作才可创建或聚焦 Panel。
- 自动测试、类型检查、差异检查和真实 Electron 验收都有可追溯结果。

## 阶段计划

### 阶段 1：仓库盘点与不变量地图

- [x] 核对分支、HEAD、工作区状态、上游基线和数据目录。
- [x] 追踪 Project、Session、Navigation、Panel 与原生 Browser 的调用链。
- [x] 区分 Craft 原有逻辑、Stair 二开逻辑和无关用户改动。
- **状态：** 完成

### 阶段 2：Project 与 Session 领域不变量

- [x] 为 Workspace 建立 `defaultProjectId`。
- [x] 让 Session 必须携带不可变的 `projectId`。
- [x] 修正服务端、共享类型、测试夹具与创建入口。
- [x] 以失败测试证明跨 Project 读取和旧 Session 污染问题。
- **状态：** 完成

### 阶段 3：Workbench 状态、导航与壳层布局

- [x] 建立单一 Workbench 状态与显式命令层。
- [x] 将普通选择定义为替换 Primary 或聚焦已有 Panel。
- [x] 将 Sidebar、Navigator 与内容滚动边界分开。
- **状态：** 完成

### 阶段 4：资源 Panel、Add Chat 与原生表面

- [x] 区分用户显式 Add Chat 与后台 Agent 投递。
- [x] 为 Project File、Browser 和阅读器明确 Panel 生命周期。
- [x] 约束原生 Browser 表面只服从已提交的 DOM 几何。
- **状态：** 完成

### 阶段 5：持久化、历史与旧逻辑移除

- [x] 只持久化产品需要的布局和偏好。
- [x] 不迁移旧 Stair 用户数据或旧布局。
- [x] 保留用户外部 Project 工作目录，不把它当作应用状态删除。
- **状态：** 完成

### 阶段 6：自动化验证

- [x] 运行聚焦测试、完整 Renderer 测试和相关包测试。
- [x] 运行 Electron、共享包与服务端类型检查。
- [x] 区分本次回归、上游基线失败和环境限制。
- **状态：** 完成

### 阶段 7：Computer Use 验收与交付

- [x] 在真实开发版 Electron 中验证核心导航和布局。
- [x] 记录窗口不可用、屏幕捕获受限和锁屏造成的证据缺口。
- [x] 保持开发进程可供用户继续手工验收。
- **状态：** 完成

### 阶段 8：独立审查修复

- [x] 修复早期事件丢失、陈旧 task 回退、旧 Session 污染和 Project 过滤归属问题。
- [x] 先补回归测试，再做最小修复。
- [x] 重跑包级、完整和 UI 验证。
- **状态：** 完成

### 阶段 9：Project File 选择语义

- [x] 撤销“普通选择替换 Primary”的错误实现。
- [x] 将所有 Project File 格式统一为单个可复用 Preview Auxiliary。
- [x] 保持 Browser 为持久 Auxiliary，不纳入 Preview 复用。
- **状态：** 完成

### 阶段 10：壳层切换时保持 Panel 宽度稳定

- [x] 区分可见裁剪宽度和稳定的 Panel 尺寸基准。
- [x] 修复 Sidebar 或 Navigator 切换导致 Panel 反向显露和缩放。
- [x] 完成真实 Electron 几何验收。
- **状态：** 完成

### 阶段 11：选择动作回归修复

- [x] 修复刚创建 Session 被陈旧 `sessionMetaMap` 拒绝的问题。
- [x] 以创建接口返回的 Session 作为本次动作的权威值。
- [x] 统一 Browser、Project File 与 Panel 容量错误传播。
- **状态：** 完成

### 阶段 12：聚焦已有 Project File Panel

- [x] 增加运行时 reveal 请求，不把它持久化为布局状态。
- [x] 成功激活已有文件后让对应 Panel 进入可视区域。
- [x] 以失败测试和 Electron 验收覆盖重复聚焦。
- **状态：** 完成

### 阶段 13：Browser 原生表面滚动同步

- [x] 复现 DOM Panel 与 Electron View 短暂错位。
- [x] 将连续滚动中的几何更新与真实遮挡分开。
- [x] 补充同步和生命周期测试。
- **状态：** 完成

### 阶段 14：Project Files 关闭时的 Browser 生命周期

- [x] 按用户澄清重新复现静态裁剪问题。
- [x] 修正关闭相邻 Panel 后 Browser 原生表面的边界。
- [x] 避免把关闭动作误判为普通滚动。
- **状态：** 完成

### 阶段 15：固定左侧 Sidebar 的原生表面边界

- [x] 把固定 Sidebar 纳入 Browser 可见边界。
- [x] 保证原生表面不会覆盖 Sidebar。
- [x] 验证 Sidebar 展开、收起和窗口缩放。
- **状态：** 完成

### 阶段 16：原生表面边界系统审计

- [x] 审计 React、DOM 几何、IPC 与 Electron View 全链路。
- [x] 区分持续缩放、滚动与真实遮挡。
- [x] 记录仍需真实像素验证的边界。
- **状态：** 完成

### 阶段 17：独立架构挑战

- [x] 使用 Claude 与 Kimi 对状态所有权、事件顺序和原生表面边界进行反向审查。
- [x] 对审查意见逐项回到代码和测试核实。
- [x] 只采纳有证据且属于当前范围的改动。
- **状态：** 完成

### 阶段 18：原生 Browser 的壳层运动门控

- [x] 壳层动画期间暂停原生表面呈现，并在稳定后恢复。
- [x] 修复重复重载时累积 host `closed` 监听器的问题。
- [x] 覆盖双 Browser、重载和恢复路径。
- **状态：** 完成

### 阶段 19：解锁后的最终 Computer Use 复验

- [x] 完成锁屏前可执行的 UI 矩阵。
- [ ] 在稳定可见窗口中补齐指针专属场景。
- [ ] 关闭仍无法通过辅助功能命中的孤立 Browser Panel。
- **状态：** 进行中（历史验收项，不阻塞干净重建）

### 阶段 20：原生 Browser 滚动闪烁

- [x] 确认整段手势暂停原生表面会造成明显闪烁。
- [x] 收集连续滚动与静态遮挡的差异证据。
- [ ] 在不破坏现有几何模型的前提下完成最终像素级复验。
- **状态：** 进行中（已被干净重建收窄，仍保留历史记录）

### 阶段 21：检查点分支审计

- [x] 审计 `6be3dd4b`、`6dc6c9fb` 与 `upstream/main` 的差异。
- [x] 判断旧检查点耦合过深，不适合作为继续叠加的稳定基础。
- [x] 形成从干净上游重建产品能力的方案。
- **状态：** 完成

### 阶段 22：干净重建的阶段 1—2

- [x] 从 `upstream/main` 的 `50ffa143ab76` 建立当前重建分支。
- [x] 完成 Project、Session 不变量和最小 Workbench 模型。
- [x] 通过审查暴露的四类回归后补测试并修复。
- [x] 完成包级、Renderer、类型、构建和 Electron 验收。
- **状态：** 完成

### 阶段 23：聚焦 Session Panel 时自动显露

- [x] 复现点击非 Primary Session 后焦点状态变化但视口不移动。
- [x] 使用运行时 revision 请求和容器自有 `scrollTo`。
- [x] 禁止使用会滚动页面根节点的 `scrollIntoView`。
- [x] 验证返回 Primary、重复聚焦和横向滚动。
- **状态：** 完成

### 阶段 24：简化全部未提交改动

- [x] 按 `code-simplifier` 约束盘点全部未提交代码，忽略 `promo/`。
- [x] 只简化本次引入的冗余，不扩大到上游代码。
- [x] 保持行为、测试与架构边界不变。
- [x] 完成聚焦、完整、类型和差异检查。
- **状态：** 完成

### 阶段 25：Navigator 独立收起

- [x] 由 AppShell 持有持久化的 `navigatorVisible` 偏好。
- [x] 在桌面 TopBar 增加符合 Craft 现有视觉和状态模式的切换入口。
- [x] Navigator 收起时宽度归零并隐藏对应 sash，Workbench 状态不变。
- [x] 验证 `300 → 0 → 300` 像素、sash `2 → 1 → 2`，URL、选择与 Panels 不变。
- **状态：** 完成

### 阶段 26：工作文档全面中文化

- [x] 明确范围为 `task_plan.md`、`findings.md`、`progress.md`。
- [x] 盘点三份文档的阶段、结论、验证结果和错误记录。
- [x] 将重复过程记录按根因合并，同时保留事实与处置结论。
- [x] 将三份文档的自然语言改写为中文，保留技术标识、命令、文件名和测试名。
- [x] 检查 Markdown 结构、残余英文自然语言和事实完整性。
- **状态：** 完成

### 阶段 27：彻底完成重建方案的阶段 0

- [x] 确认权威进度文件为 `docs/stair-rebuild-plan.md`。
- [x] 核对 HEAD 与 `upstream/main` 均为 `50ffa143ab76`。
- [x] 确认当前只有通用 `CRAFT_APP_NAME`、`CRAFT_CONFIG_DIR` 和多实例端口机制，没有 Stair 专属入口。
- [x] 冻结阶段 0 的失败测试与最小实现边界。
- [x] 实现 Stair 品牌、专属开发/构建入口、独立数据命名空间和不冲突端口。
- [x] 运行聚焦测试、类型检查、lint、构建和差异检查。
- [x] 完成 Craft/Stair 并行启动与数据隔离验收。
- [x] 更新权威进度文档并记录全部结果。
- **状态：** 完成

### 阶段 28：收口阶段 0 的用户状态路径

- [x] 审计所有真实读写 `~/.craft-agent` 的运行时路径，排除注释、测试夹具和外部 Project 目录。
- [x] 先增加 `CRAFT_CONFIG_DIR` 隔离失败测试。
- [x] 仅将阶段 0 范围内的路径接入现有 `CONFIG_DIR`，默认 Craft 行为保持不变。
- [x] 运行聚焦测试、类型检查、lint、构建和差异检查。
- [x] 重启 Stair，并验证 5173/5193、Electron userData、窗口状态和日志互不串用。
- [x] 更新权威中文进度文档，将阶段 0 标记为完成。
- **状态：** 完成

### 阶段 29：重建方案阶段 3——Project Files 与文本文档

- [x] 盘点 Craft 当前文件能力、旧 Stair 规格与阶段 2 Workbench 接口。
- [x] 先用失败测试冻结 Project 文件树、安全路径与 Project 授权边界。
- [x] 实现一个可复用 Preview 和显式 Project File Auxiliary，保持 Primary 不变。
- [x] 实现文本读取、编辑、dirty、自动保存、flush 与关闭 veto。
- [x] 覆盖替换 Preview、关闭 Panel、切换 Project 和退出应用前的 flush。
- [x] 运行包级测试、Renderer 测试、三层类型检查、构建和真实 Electron 验收。
- [x] 更新中文权威方案、调研与进度记录。
- **状态：** 完成

## 关键问题与结论

| 问题 | 结论 |
|---|---|
| 哪些工作区改动属于当前重建 | 只处理可追溯到 Stair 重建、Panel 聚焦、Navigator 收起和配套测试的改动；`promo/` 不在范围内 |
| Stair 的应用数据放在哪里 | 开发版通过 `scripts/stair-dev.ts` 使用 `~/.stair`；不能只设置 `CRAFT_APP_NAME=Stair` |
| 是否迁移历史用户数据 | 不迁移；用户明确要求只保留产品能力 |
| 哪些旧测试应该保留 | 保留表达产品不变量的测试；替换只约束旧副作用或旧布局模型的测试 |
| 哪些状态可以持久化 | 用户偏好和必要布局可以持久化；一次性 reveal、动画门控和当前动作上下文只存在于运行时 |
| Workbench 如何避免再度耦合 | 单一状态所有者加显式命令；Navigation 不直接写 Panel 细节，Panel 也不充当消息总线 |

## 已确认的架构决策

| 决策 | 原因 |
|---|---|
| 不做历史数据和布局迁移 | Stair 是重新建立边界的新产品形态，用户已授权清空应用数据 |
| 保留外部 Project 工作目录 | 清理范围只包括 Stair 自有状态，不能删除用户项目文件 |
| 使用单一 Workbench 状态与显式命令 | 分散可写 atom 和导航副作用是旧耦合的主要来源 |
| 默认不创建 Panel | 普通导航只替换 Primary 或聚焦已有内容；新建 Auxiliary 必须是显式动作 |
| Session 的 `projectId` 不可变 | 跨 Project 移动会破坏历史、权限和布局归属 |
| Add Chat 与后台投递分开 | 前者要求可见并聚焦，后者必须保持布局中立 |
| Project File 共用一个 Preview Auxiliary | 文件是临时预览资源；重复选择应复用，而不是无限增加 Panel |
| Browser 使用持久 Auxiliary | Browser 有独立运行时、地址和历史，生命周期不同于文件预览 |
| reveal 请求不持久化 | 它是一次性视口动作，不是可恢复布局 |
| Panel 显露由 `WorkbenchContainer` 自有滚动完成 | 避免 `scrollIntoView` 连带滚动页面根节点和固定壳层 |
| Navigator 收起由 AppShell 管理 | 它是壳层偏好，不能污染 Workbench、Navigation 或 Project 状态 |
| 自动检查通过后再做真实 Electron 验收 | UI 验收应针对已知可运行候选版本，并补足 DOM 到原生 View 的证据 |

## 错误与处置记录

下表将同根因的重复尝试合并，保留发生阶段、影响和最终处置。

| 错误或限制 | 发生阶段 | 最终处置 |
|---|---|---|
| 首次把共享路由/类型路径误认为 `renderer/shared` | 阶段 2 | 按相对导入定位到 `apps/electron/src/shared` |
| 多次组合补丁因上下文陈旧或空补丁片段被原子拒绝 | 阶段 9、15、20、22、24、26 | 读取精确小范围上下文，按文件和语义拆成小补丁；拒绝的补丁均未改动文件 |
| 大范围源码或文档读取超过上下文限制 | 阶段 1、22、26 | 改为按符号、标题和小行段读取，不重复同一大范围输出 |
| Board 后退需要按两次 | 早期 UI 验收 | 语义历史压栈改为同步；语义 URL 未变化时跳过重复压栈 |
| Electron lint 报 8—9 个错误和大量警告 | 阶段 2、24 | 核对均为上游或当前补丁片段外问题；本次新增 Workbench、Navigation 与简化代码无 lint 错误 |
| 计划检查脚本没有可执行位 | 阶段 6 | 通过 `bash` 显式执行只读检查 |
| 红测试无法导入尚未实现的 atom 或命令 | 阶段 9、12、23、25 | 作为预期失败证据，完成最小实现后原样重跑转绿 |
| 初版把 Project File 当成 Primary，且一度把 Browser 纳入通用 Preview | 阶段 9 | 按用户澄清改为文件专用复用 Preview；Browser 保持持久 Auxiliary |
| `jotai/vanilla` 不导出 `Store` 类型 | 阶段 9 | 使用 `ReturnType<typeof createStore>` 推断 |
| 首个宽度修复只阻止反向显露，Panel 仍会缩放 | 阶段 10 | 分离可见裁剪宽度与稳定尺寸基准 |
| 新建 Session 后被陈旧 `sessionMetaMap` 拒绝 | 阶段 11 | 使用创建接口返回的 Session 校验本次动作 |
| Browser 目标字段收到 `null`，但命令只接受可选值 | 阶段 11 | 无绑定 Session 时规范化为 `undefined` |
| 从 monorepo 根目录运行聚焦 ESLint 找不到正确配置 | 阶段 11 | 改在 `apps/electron` 目录运行 |
| Panel 达上限时返回了泛化引用错误 | 阶段 11 | 直接返回八 Panel 预检错误，并保留阅读器回调中的具体错误 |
| 仅设置 `CRAFT_APP_NAME=Stair` 导致读取 Craft 数据 | 阶段 11 | 始终通过 `scripts/stair-dev.ts` 同时设置 `CRAFT_CONFIG_DIR=~/.stair` |
| Computer Use 遇到 ScreenCaptureKit 失败、超时、陈旧元素、无可访问性几何、`noWindowsAvailable` 和 Electron 标识歧义 | 阶段 9、12、19、23、25 | 每次重新解析精确应用和可访问性树；不复用陈旧索引；无法覆盖的指针场景明确记为证据缺口 |
| 重载后出现 `MaxListenersExceededWarning` | 阶段 18 | 用失败测试复现 12 个 host `closed` 监听器，移除每个 lease 的单独注册，保留 WindowManager 生命周期 |
| Mac 锁屏或文档 `visibility=hidden` 使 Splash 动画停在零时刻 | 阶段 18、25 | 保留锁屏前验收和确定性测试证据，开发进程继续运行供前台手测 |
| `packages/server-core` 路径判断错误 | 阶段 1 | Session bundle 实际位于 `packages/shared/src/sessions/bundle.ts` |
| `typecheck:all` 因上游缺少 `tsconfig.base.json` 停在 `session-tools-core` | 阶段 1 | 记录为基线失败；独立验证 shared、server-core 和 Electron |
| shared、server-core 的旧夹具缺少 `defaultProjectId` 或 `projectId` | 阶段 1 | 更新共享夹具模式，不放宽新领域不变量；完整测试转绿 |
| Workbench 首次类型检查遇到 atom overload 和可选测试值问题 | 阶段 2 | 使用 Jotai 导出的 `Getter`/`Setter`，并将测试期望规范化为 `null` |
| `bun test src/renderer` 误发现 `release` 中的打包副本 | 阶段 2 | 以 `apps/electron/src/renderer` 为工作目录运行源码测试，493 项通过 |
| Electron main 完整测试有 8 个 `BrowserPaneManager` 失败 | 阶段 2 | 确认 `apps/electron/src/main` 相对上游无差异，记录为无关基线或环境失败 |
| `CRAFT_CONFIG_DIR` 本身不重定向默认 Workspace | 阶段 2 | 验证旧目录 mtime 后，在临时配置中显式预置独立 Workspace 根目录 |
| 首个关闭处理器补丁改到了重新认证分支 | 阶段 2 | 核对四个调用点，仅在 `NavigationProvider` 的就绪状态使用新处理器 |
| `build:validate` 引用上游不存在的 `validate-assets.ts` | 阶段 2 | 单独报告基线缺失；Renderer、main、preload 和 copy 构建均独立通过 |
| 独立审查发现早期事件丢失、陈旧 task 回退、旧 Session 污染和过滤归属缺口 | 阶段 22 | 先增加四类失败回归，再只修复已确认的 Phase 1—2 路径 |
| 一次 `git rev-parse --short=12 HEAD upstream/main` 用法错误 | 阶段 22 | 分别解析两个 revision，均为 `50ffa143ab76` |
| `scrollIntoView` 没有移动目标横向视口，反而滚动页面根节点 | 阶段 23 | 改为计算最近水平差值，只调用 `WorkbenchContainer.scrollTo` |
| 默认 `rg` 不支持一次 added-line 扫描使用的 look-ahead | 阶段 24 | 使用 `rg --pcre2` 重跑；失败扫描未影响实现判断 |
| 组合命令因末尾记忆索引无匹配而返回 1 | 阶段 24 | 将 `git diff --check` 成功与查询未命中分开记录并独立执行 |
| Locale 首次在不存在的 Renderer `i18n` 目录查找 | 阶段 25 | 使用 `packages/shared/src/i18n/locales` 的集中式目录 |
| HMR 后真实窗口仍显示旧 TopBar | 阶段 25 | 只重启准确的开发进程，确认 Vite 加载新 AppShell 与 TopBar |
| 计划完成检查仍发现阶段 19—20 进行中 | 阶段 24—26 | 保留为历史原生 Browser 验收项，不为追求全绿而虚假标记完成 |
| 阶段 0 的并行源码/历史检查输出超过显示上限并被截断 | 阶段 27 架构盘点 | 保留已确认的摘要，后续只读取具体脚本区段和单个历史文件，不重复广泛搜索 |
| 第二轮并行入口检查再次因宽泛 `rg` 命中大量 Electron API 行而截断 | 阶段 27 入口盘点 | 停止宽泛搜索；后续只读 `setupI18n`、Renderer 入口、WindowManager 和单个构建文件的精确区段 |
| 深链与自动更新测试搜索中的未引用 glob 被 zsh 当成必需路径并报 `no matches found` | 阶段 27 测试盘点 | 不重复该命令；改用 `rg --files` 先列出测试文件，再对明确文件或目录搜索 |
| 阶段 0 首轮聚焦测试为 20 pass、5 fail、3 errors | 阶段 27 红测试 | 属于预期红态：三个新模块尚不存在，Stair scheme 和 Stair 系统提示尚未实现；保留同一测试集用于转绿 |
| 阶段 0 首轮转绿为 31 pass、1 fail | 阶段 27 品牌实现 | 唯一失败是测试未传 Backend 名称却断言它存在；将输入改为 `Craft Agents Backend`，继续验证受保护服务名不被品牌替换 |
| 阶段 0 第二轮聚焦测试为 32 pass、0 fail | 阶段 27 品牌实现 | 品牌、userData、脚本环境、深链和系统提示回归全部转绿；继续静态检查与真实构建验收 |
| 从仓库根目录对阶段 0 文件运行 `bunx eslint` 失败 | 阶段 27 静态检查 | 根目录没有 ESLint 9 flat config；改用 `apps/electron` 与 `packages/shared` 的既有 package lint 入口，不据此判断代码失败 |
| `lint:i18n:coverage` 报 `scripts/check-i18n-coverage.ts` 不存在 | 阶段 27 i18n 检查 | parity 与 sorted 已通过；coverage 属于上游脚本缺失，作为基线阻断记录，不伪报通过 |
| 一次并行 lint 调度脚本多写了右括号并产生 JavaScript 语法错误 | 阶段 27 静态检查 | 未执行任何仓库命令；立即修正调度脚本后重跑 |
| Electron 全量 lint 为 9 errors、120 warnings | 阶段 27 静态检查 | 9 个错误均位于非阶段 0 的既有/阶段 1—2 WIP 文件；阶段 0 Electron 聚焦 lint 单独运行并以 0 errors 通过 |
| 第二次并行成品检查调度也多写了右括号 | 阶段 27 成品检查 | 未执行仓库命令；修正后重跑并获得完整成品证据，后续不再复制该调度骨架 |
| 首个 `Stair.app` 的 `Info.plist` 没有 `stair://` 注册，打包入口也未指定包内窗口图标 | 阶段 27 成品检查 | 先增加构建配置回归测试，再补 `protocols` 和 `CRAFT_APP_ICON`；重新打包检查真实 plist 与资源哈希 |
| 阶段 0 真实并行启动后，少数运行时路径仍写入 `~/.craft-agent` | 阶段 28 数据隔离 | 不扩展业务逻辑；审计实际读写点，统一复用已有 `CONFIG_DIR`，并用双实例进程和文件路径验证 |
| 数据目录架构守卫首轮为 3 pass、1 fail | 阶段 28 红测试 | 属于预期红态：测试准确列出 13 个绕过集中配置的生产文件；保留同一断言用于实现后转绿 |
| 首次更新阶段 28 记录时补丁标记少了列表连字符 | 阶段 28 记录 | 补丁被原子拒绝且没有文件改动；按精确原文重新应用 |
| 两次测试检索中的未引用 glob 被 zsh 报 `no matches found` | 阶段 28 测试盘点 | 前置读取或文件枚举已完成，但组合命令返回非零；后续只用 `rg --files` 和 `-g` 过滤，不再把可空 glob 交给 shell |
| 行为隔离测试首次 JSON 解析失败 | 阶段 28 行为测试 | 子进程退出码为 0，窗口状态日志与结果共用 stdout；给结果增加固定前缀并按行提取，不屏蔽真实 stderr 或退出码 |
| 扩大路径扫描后首轮为 12 pass、5 fail | 阶段 28 第二轮红测试 | 失败分别命中 Renderer 配置目录 RPC、18 个产品路径消费者、动态 APP_ROOT、Stair Workspace 路径提示和 Agent 配置识别；作为补齐隔离边界的预期红态保留 |
| 新配置目录 RPC 首次接到了 Electron 目录中的旧 core handler | 阶段 28 注册链复核 | 当前 `registerAllRpcHandlers` 实际使用 `server-core` handler；在最终验证前将实现移到真实注册链，并从旧入口移除重复实现 |
| 三个仓库 lint 入口引用不存在的 shell 脚本 | 阶段 28 静态检查 | `check-raw-sends.sh`、`check-task-tool-checks.sh`、`lint-i18n-strings.sh` 均在上游当前树缺失；聚焦 ESLint、类型检查、locale parity/sorted 和测试独立完成，不伪报这三项通过 |
| 首次 package 级测试命令因递归清理临时目录被策略拒绝 | 阶段 28 扩大测试 | 命令在启动前被拒绝，没有测试或删除发生；改用 `/tmp` 临时配置目录并交由系统清理后重新运行 |
| package 级测试首次运行的工作目录与启动夹具不完整 | 阶段 28 扩大测试 | server-core 的空配置缺少启动期 `config-defaults.json`；Renderer 从 app 目录又发现 `release/Stair.app` 副本；改为先调用 `ensureConfigDir()`，并直接在 `apps/electron/src/renderer` 运行源码测试 |
| Claude、Kimi、Pi 审查指出大 PDF 全页挂载、状态预算/损坏恢复和 Reader 资源边界风险 | 阶段 31 | 先补聚焦测试，再改为 5 页渲染窗口、4 MiB 动态预算、损坏状态隔离、字段上限和 section 级 EPUB 资源缓存；无需调整 Craft 原有架构 |
| 阶段 4 真实验收时开发窗口在长时间 HMR 后灰屏 | 阶段 31 | Vite 仍在监听但旧 Renderer 未重新挂载；只重启本轮启动的 Electron 开发进程，用户 Workspace 数据未清理，窗口恢复后继续验收 |
| PDF 第 98 页已落盘，但关闭重开一度显示第 1 页 | 阶段 31 | 追到 `numPages=0` 与空布局被误判为就绪，恢复标记被提前消费；先补失败回归，再增加非空页数初始化守卫，真实 Electron 重开恢复到 98/240 |
| `bun install --frozen-lockfile --ignore-scripts` 因当前精简 checkout 缺少历史 workspace 而要求改锁 | 阶段 31 | 不为环境差异重排整个 lockfile；通过依赖实际解析、类型检查、测试和生产构建验证阶段 4 依赖 |

### 阶段 30：Project File 生命周期审查修复

- [x] 让 Workspace 切换、窗口关闭和自动更新安装都在破坏状态前等待文档 flush。
- [x] 补齐冲突放弃/重载、恢复后继续自动保存，以及保存失败 veto 回归。
- [x] 修正空文件、末尾换行、NUL 文本、dotfile 和 Project File 错误码边界。
- [x] 运行相关包完整源码测试、三层类型检查、locale 与差异检查。
- **状态：** 完成

### 阶段 31：重建方案阶段 4——EPUB 与 PDF

- [x] 复用现有 `project-file` Preview/显式 Auxiliary 和 Document Registry，不改变 Craft 原有领域与 Workbench 所有权。
- [x] 实现 EPUB/PDF 安全二进制读取、Reader State RPC、原子状态存储与 fingerprint 隔离。
- [x] 实现目录、连续阅读、进度、选区、红色波浪划线、稳定 locator 和 Reader 内 reveal。
- [x] 对大 PDF 使用稳定占位布局和 5 页渲染窗口，并限制页数、二进制、状态和 EPUB 解压预算。
- [x] 执行 Code Simplifier，再由 Claude、Kimi、Pi 审查并修复有效问题。
- [x] 完成 Renderer 550/550、Reader/RPC/IPC 52/52、三层类型检查、聚焦 lint、生产构建和差异检查。
- [x] 使用 Computer Use 验收真实 EPUB、1 页 PDF、240 页 PDF，以及关闭重开后的阅读进度恢复。
- [x] 更新中文权威方案与进度记录，并按用户要求停止，不启动阶段 5。
- **状态：** 完成

### 阶段 32：阶段 0—4 功能等价审计与 EPUB 窄栏修复

- [x] 以旧产品 `6dc6c9fb`、旧 Workbench `6be3dd4b` 和当前工作树建立能力对照基线。
- [x] 为 EPUB 840 px 响应式边界先增加失败测试，再恢复覆盖式目录。
- [x] 在当前 `os` Project 的真实 Electron 窗口中确认窄 Auxiliary 目录覆盖正文，并恢复测试前状态。
- [x] 区分意外回归、计划漏项、阶段 5—9 明确延期和此前批准的语义变化。
- [x] 调用 Claude 与 Kimi 独立审查，并只采纳经当前/旧版源码复核的结论。
- [x] 形成中文演进、实现和质量三份研究文档，并纠正权威计划中过度的完成声明。
- [x] 梳理其余回归并等待用户确认恢复范围。
- **状态：** 审计与 EPUB 修复完成；后续收口见阶段 33

### 阶段 33：阶段 0—4 功能等价收口

- [x] 恢复 HMR Root、WindowManager、Draft 授权、空 Session、PDF overlay、Markdown 链接、Save Draft As、选区生命周期和 pageLabels。
- [x] 恢复 Project Files 搜索/创建/图片/扩展名，以及 Reader 导出、分组、作者和相对路径信息。
- [x] Panel 数量策略与 Craft 保持一致，不增加额外上限。
- [x] 执行 Code Simplifier，并完成 Claude、Kimi、Pi 审查和有效问题修复。
- [x] 运行聚焦测试、三层类型检查、相关 lint、Electron 构建、差异检查和真实 Electron 验收。
- [x] 更新中文权威方案和进度记录；停止在阶段 4，不启动阶段 5。
- **状态：** 完成

## 执行约束

- 每个重大架构决定前重新核对本计划与实际代码。
- 修缺陷时优先保留可复现失败，再做最小修复。
- 任何失败命令或测试都要记录后再改变路径。
- 不暂存、不提交用户既有改动，除非用户明确要求。
- `promo/` 始终不在当前处理范围内。
- 文档中的英文仅用于代码标识、命令、路径、文件名、测试名和固定产品术语。
