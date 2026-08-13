# 产品 Stair 的干净重建方案与实施进度

## 文档状态

- 状态：阶段 0—3 已实现并完成验证；阶段 4 尚未开始
- 基线：`upstream/main@50ffa143`（`v0.11.4`）
- 分支：`codex/stair-rebuild-v2`
- 更新日期：2026-08-13
- 范围：保留 Stair 产品能力，不迁移 Craft 或旧 Stair 用户数据
- 代码状态：阶段 0—3 已形成经审查修复的可交付基线

## 当前实施进度

| 阶段 | 状态 | 当前结果 |
| --- | --- | --- |
| 阶段 0：建立干净基线 | 完成 | Stair 已具备专属品牌、开发/构建入口、`~/.stair` 数据命名空间、5193 端口和 `stair://` 深链；默认 Craft 行为保持不变。 |
| 阶段 1：Project 与 Session 不变量 | 完成 | 默认 Project、不可变 `Session.projectId`、Project 删除约束和同 Project 通信边界已经落地。 |
| 阶段 2：仅包含 Session 的 Workbench | 完成 | 新 Workbench 状态与命令层已经接管 Session Primary/Auxiliary；普通导航不再隐式新增 Panel。 |
| 阶段 3：Project Files 与文本文档 | 完成 | Project 文件树、安全路径 API、复用 Preview、显式 Auxiliary，以及文本编辑的 dirty、自动保存、冲突恢复、flush 和破坏性动作 veto 已落地并完成真实 Electron 验收与审查修复。 |
| 阶段 4—9 | 未开始 | EPUB/PDF、Add Note、原生 Browser、Drawnix、布局持久化和正式发布打包尚未进入实施。 |

### 阶段 1 已完成内容

- Workspace 必须拥有真实的 `defaultProjectId`，创建 Workspace 时同步创建默认 Project。
- Session 必须从创建时携带非空 `projectId`，Project 归属不可变。
- 默认 Project 和仍包含 Session 的 Project 不可删除；删除 Project 不再解绑 Session。
- Session、Task 和 Agent 派生入口继承或显式校验 Project 归属。
- 跨 Project Session 通信被拒绝，旧或非法 Session 不会污染当前 Project。
- 旧测试夹具已按新不变量更新，没有通过可选字段或兼容迁移放宽边界。

### 阶段 2 已完成内容

- 删除旧 `PanelStack` 可写状态和 URL 驱动的布局恢复路径，新增单一 Workbench 状态与显式命令层。
- Workbench 使用可为空的 Primary、有序 Auxiliary 和独立焦点；普通 Session 选择只聚焦已有 Panel 或替换 Primary。
- New Session 进入 Primary；New Session in Panel 和 Branch 才能显式新增 Auxiliary。
- Project 切换会切换对应 Workbench 上下文，Session 列表和任务过滤遵守 `projectId`。
- Add Chat 使用创建接口返回的 Session 完成当前动作，不再依赖创建前的陈旧 Session 映射。
- 后台 Session 事件只更新内容，不改变 Primary、Auxiliary、Navigator 或焦点。
- 点击已经存在但位于视口外的 Session Panel 时，由 `WorkbenchContainer` 自有横向滚动将其显露；不再使用会滚动页面根节点的 `scrollIntoView`。
- Navigator 已增加独立收起能力，由 AppShell 持有 `navigatorVisible` 偏好；收起不会修改 Workbench、Project、Session、URL 或焦点模式偏好。

### 阶段 3 已完成内容

- 新增 Project 相对路径协议与独立 RPC，只接受当前 Workspace 中 Project 显式配置的 `workingDirectory`，不回退到 Workspace、Session 或应用数据目录。
- 文件树按目录懒加载；服务端拒绝绝对路径、路径穿越、符号链接、特殊文件、越界路径和跨 Workspace Project 请求。
- 普通文件点击只创建或替换唯一 Preview Auxiliary；显式“Open in New Panel”创建持久 Auxiliary，两者都不会占用或替换 Primary。
- Markdown、文本、JSON、常见代码与配置文件支持预览和源码编辑；可编辑文件限制为 1 MiB，不支持的二进制类型只显示不可编辑状态。
- 文档控制器统一管理 dirty、800 ms 自动保存、保存合并、重试、冲突和 flush；替换 Preview、关闭 Panel、切换 Project 与退出应用前都会等待 flush，失败则 veto 当前破坏性动作。
- 保存使用 SHA-256 比较保存、同文件串行队列和临时文件原子替换，并保留 UTF-8 BOM、CRLF/LF、末尾换行和原文件权限。
- Workspace 切换在服务端提交窗口映射前等待当前 Renderer flush；窗口关闭先取消主进程超时兜底再 flush；自动更新只在 flush 成功后进入退出清理和安装。
- 冲突状态支持显式放弃本地草稿并重新加载；内容恢复到已保存版本后可继续编辑和自动保存，不会残留错误或定时器状态。
- 文本保存允许空文件并精确保留请求内容的末尾换行数量，只按原文件风格转换 CRLF/LF；NUL 文本会被拒绝，常见 dotfile 可按文本类型编辑。
- Project File 错误码已进入共享协议白名单，服务端错误经传输层后仍保留可判定的具体错误类型。

### 当前验证结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 阶段 0 路径聚焦回归 | 通过 | 81/81 项通过，共 1423 个断言；覆盖集中配置目录、写盘位置和生产代码硬编码守卫。 |
| 阶段 0 深链聚焦回归 | 通过 | 58/58 项通过，共 123 个断言；Craft 使用 `craftagents://`，Stair 使用 `stair://`。 |
| 阶段 3 聚焦回归 | 通过 | 审查后 52/52 项通过，共 188 个断言、11 个文件；覆盖协议路由、注册、IPC、路径安全、比较保存、Workbench 文件命令、Workspace flush/veto、窗口关闭顺序、自动更新中止、冲突恢复、文本保真、dotfile 和错误码透传。 |
| 阶段 3 审查后完整源码回归 | 通过 | shared 2211 项通过、1 项跳过；server-core 239 项通过；Renderer 508 项通过，均为 0 项失败。 |
| shared 完整测试 | 通过 | 3012 项通过、12 项跳过、0 项失败，共 5830 个断言。 |
| server-core 完整测试 | 通过 | 源码测试 234 项通过、0 项失败，共 481 个断言。 |
| Renderer 完整测试 | 通过 | 源码测试 506 项通过、0 项失败，共 918 个断言。 |
| Navigator 聚焦测试 | 通过 | 2/2 项通过，覆盖桌面入口和紧凑模式排除。 |
| 三层类型检查 | 通过 | shared、server-core 和 Electron 分别通过。 |
| locale JSON 与差异格式检查 | 通过 | 7 份 locale 可解析且 key 数量一致、排序检查通过，`git diff --check` 通过。 |
| 聚焦 lint | 通过 | shared 与 Electron 阶段 3 变更文件均为 0 个错误；Electron 的 10 条警告位于 `AppShell.tsx` 既有代码。server-core 没有 ESLint 9 配置，以类型检查和源码测试作为该层检查。 |
| 真实 Renderer 交互 | 通过 | Navigator 宽度 `300 → 0 → 300`，sash 数量 `2 → 1 → 2`，URL、选择和 Panels 不变。 |
| Session Panel 显露 | 通过 | 点击非 Primary Session 后，目标 Panel 会在横向 Workbench 中进入可视区域。 |
| Craft/Stair 运行态隔离 | 通过 | Craft 停止期间仅运行 Stair，`~/.craft-agent` 的 289 个文件前后摘要一致；双实例可同时监听 5173/5193。 |
| Computer Use 桌面验收 | 通过 | 分别确认 Craft Agents 与 Stair 窗口；Stair 设置页显示 `~/.stair/tool-icons/tool-icons.json`。 |
| 阶段 3 真实 Electron 验收 | 通过 | 在当前 `os` Project 中完成文件树刷新、Preview 原位复用、右键显式新 Panel、Preview 与显式 Panel 并存、文本自动保存，以及修改后立即关闭 Panel 的同步 flush；临时文件和 Panel 已清理。 |
| 默认 Craft 与 Stair 构建 | 通过 | `bun run electron:build` 与 `bun run stair:build` 均成功。Stair 包名、bundle id、入口、图标和 `stair://` 注册符合配置；本地包为 ad-hoc 签名，未做公证。 |
| Electron main 完整测试 | 基线失败 | 343 项通过，8 个既有 `BrowserPaneManager` 失败；失败文件未被阶段 3 修改，新增主进程行为由聚焦测试覆盖。 |
| `typecheck:all` | 基线阻断 | 上游 `session-tools-core` 缺少 `tsconfig.base.json`。 |
| `build:validate` | 基线阻断 | 上游缺少 `apps/electron/scripts/validate-assets.ts`；其余 Electron 构建步骤已独立验证。 |

### 当前限制

- 阶段 0—3 作为当前基线整体交付；阶段 4—9 尚未开始，不能把本次交付理解为全部产品能力已经完成。
- 按用户最新要求，桌面验收使用当前已经选择的 `os` Project，不再以临时隔离 Workspace 作为阻塞条件；这不改变产品最终需要独立 Stair 数据命名空间的目标。
- EPUB/PDF、引用与 Add Note、原生 Browser、Drawnix、布局持久化和正式发布仍属于阶段 4—9；旧 Stair 分支只能作为规格、测试和缺陷复现来源。
- Computer Use 在应用处于后台时遇到 `document.visibilityState=hidden`，Navigator 几何通过同一真实 Renderer 的按钮事件与开发者工具核对；仍保留前台手工验收入口。
- 本地 `Stair.app` 目录包在当前机器上仍会出现“进程已启动但没有窗口”，且停在业务主进程日志加载之前；阶段 3 已在 `bun run stair:dev` 的真实 Electron 窗口验收通过，该打包运行问题保留到阶段 9 单独处理。

### 阶段 0 实施记录

- 2026-08-12：冻结品牌、userData、脚本环境、打包资源、独立深链和系统提示品牌测试。
- 唯一 Stair 开发启动命令为 `bun run stair:dev`；默认 Craft 继续使用 `bun run electron:dev`。
- 实现前红测试结果：20 项通过、5 项失败、3 个缺失模块错误；失败均对应阶段 0 尚未存在的能力。
- 实现后聚焦测试结果：32 项通过、0 项失败，共 90 个断言；共享包与 Electron TypeScript 检查均通过。
- 用户状态路径统一复用现有 `CONFIG_DIR`：Stair 的凭据、Workspace、窗口状态、日志、消息网关和 Renderer 路径均落到 `~/.stair`；默认 Craft 仍使用原路径。
- Renderer、server-core、窗口安全分类和新窗口入口已统一使用当前产品深链；Stair 不再生成或内部处理 `craftagents://`。
- 运行态验收确认 Craft 与 Stair 可并行启动，Stair 单独运行不会改写 Craft 数据目录。

## 1. 决策

Stair 将基于最新 Craft 上游重新实现，不再继续修补或重放现有 Stair 提交。

重建保留已经验证的产品能力和行为规格，但不保留：

- 现有 Stair 实现结构；
- 现有用户数据的迁移与兼容逻辑；
- 旧布局、路由、Project、阅读器和书签存储格式；
- 当前 Stair 分支的兼容层；
- 之前 29 个 Stair 提交的提交形态。

旧分支继续作为实现参考和测试用例来源，但不作为新分支的代码基础。

## 2. 为什么要重建

当前 Stair 历史中存在多次跨层大提交：

- Project Files 和 EPUB 在一次提交中同时修改了 Project/Session 导航、PanelStack、服务端 RPC、持久化、阅读器、引用和聊天。
- Browser 接入同时耦合了 React 布局、DOM 几何、IPC、Electron `View` 生命周期、选区捕获和聊天引用。
- Add Note 横跨 Browser、EPUB、PDF、文本、Project Files、Session 持久化和服务端写入。
- 最后的 Workbench 检查点一次修改了 171 个文件，同时改变 Project/Session 规则、渲染器导航、Panel 状态、Browser 生命周期、持久化和测试。

现有 bug 不是若干孤立的局部缺陷，而是多个状态所有者发生重叠：

- Navigator 路由；
- 当前焦点 Panel；
- Session 选择；
- Project 作用域；
- 浏览器历史与 URL；
- 持久化 Panel 布局；
- 原生 Browser Surface 生命周期。

继续增加 guard 只会保留这些冲突的所有权规则。在新上游上重放同一批提交，也会复制相同的耦合。

## 3. 目标与非目标

### 目标

1. 保留所有已经验证的 Stair 产品能力。
2. 明确 Project、Session、Workbench、Project File 和 Browser 的所有权。
3. 保留 Craft 的默认导航语义：
   - 普通导航优先聚焦已经可见的目标，否则替换 Primary；
   - 普通 New Session 替换 Primary；
   - 只有显式 New Panel 操作才能创建 Auxiliary Panel。
4. 每个实施阶段结束时，产品都可以端到端运行。
5. 每个阶段都有可观察、可重复的验收标准。
6. 原生 Browser 行为与渲染器状态分开验证。
7. 使用全新的 Stair 数据命名空间和唯一的当前存储版本。

### 非目标

- 迁移现有 Craft 或 Stair 用户数据。
- 读取旧 Stair 布局或阅读状态格式。
- 保留旧内部模块 API。
- 通过 cherry-pick 保留旧提交历史。
- 在单 Project Workbench 稳定前增加 Workbench Tab。
- 增加当前产品能力不需要的推测性扩展点。

## 4. 需要保留的产品能力

### 项目与会话（Project 与 Session）

- 每个 Workspace 都有一个真实的默认 Project。
- 每个 Session 从创建开始就且只属于一个 Project。
- Session 的 Project 归属不可变。
- 默认 Project 和非空 Project 不可删除。
- 除非未来有明确产品需求，否则拒绝跨 Project 通信。
- 可以从 Project UI 查看和导航 Project 下的 Session。

### 工作台（Workbench）

- 普通选择 Session 时，如果目标已经可见则聚焦它，否则替换 Primary。
- 普通 New Session 创建 Session，并在 Primary 中展示。
- New Session in Panel 创建 Auxiliary Panel。
- 默认 Branch 操作创建子 Session，将其放在来源 Panel 后的 Auxiliary 中并聚焦。
- 关闭或 park Panel 绝不删除 Session。
- 不同 Project 的布局彼此隔离。
- 支持 Panel 独立宽度调整和显式拖拽排序。
- 布局只使用新的 Workbench 存储格式。

### 项目文件与阅读器

- 懒加载 Project 文件树。
- 安全的 Project Scope 路径访问。
- 文本预览、编辑、自动保存、dirty 状态和关闭前 flush。
- EPUB 连续阅读、目录、进度、划线、选区和引用。
- PDF 连续阅读、进度、划线、选区和引用。
- Drawnix 画板、文档生命周期以及 Agent 读写工具。
- 一个可复用的 Project File Preview。
- 显式 Open in New Panel 创建持久 Auxiliary，不复用 Preview。

### 引用与 Add Note

- 文本、EPUB、PDF、Browser 和聊天内容都能生成结构化引用。
- 引用包含足够稳定的来源身份，可预览并重新定位到原始位置。
- 草稿、持久消息、模型输入和消息渲染共用一套引用协议。
- Add Note 只使用一个目标选择器和一个 Project Files Browser。
- Add Note 服务端写入必须校验 Project Scope 和路径。
- Add Chat/New Chat 的目标显式指定，并限制在当前 Project 内。

### 浏览器（Browser）

- Browser 在 Workbench Auxiliary Panel 中展示。
- Browser 选区可以生成结构化引用。
- Browser Panel 身份与原生 Browser Runtime 身份分离，但存在显式关联。
- Workspace 书签使用新格式持久化。
- 用户可以选择网页链接在 Stair 内部打开或交给系统浏览器。
- 开发启动流程构建并监听所有必需的 Browser preload。

### 品牌与打包

- Stair 应用名称、图标、打包入口、开发入口和构建入口。
- Stair 使用独立的应用数据命名空间。
- Stair 开发端口不与同时运行的 Craft 实例冲突。

## 5. 目标架构

### 5.1 领域所有权

```text
Workspace
└── Project
    ├── Session
    ├── Project File
    ├── Reader State
    └── Project-scoped Reference 与 Note
```

- Workspace 仍是运行时和安全边界。
- Project 是稳定的产品 Scope。
- Session 与 Project File 身份属于领域数据。
- Panel 身份属于展示状态，不能成为领域标识。

### 5.2 Workbench 状态

Window 拥有一个当前激活的 Project Scope。每个 Project 拥有一份可以 park/restore 的布局。

```ts
interface WindowWorkbench {
  workspaceId: string
  activeProjectId: string
  layoutsByProject: Record<string, ProjectWorkbench>
}

interface ProjectWorkbench {
  primary: WorkbenchPanel | null
  auxiliary: WorkbenchPanel[]
  focusedPanelId: string | null
  previewPanelId: string | null
}
```

规则：

- Primary 是可替换的 Session 展示位。
- 只有显式命令或显式 presentation intent 才能创建 Auxiliary。
- 即使 `primary` 内容为 `null`，Primary 仍是固定语义槽位。因此 Panel 增长只以 `auxiliary.length` 衡量，不以非空渲染实体总数衡量。
- 普通选择固定遵循：优先聚焦已可见实体；目标不可见时才替换 Primary。
- Project File Preview 是可复用 Auxiliary，绝不提升为 Primary。
- Focus 只表示视觉焦点。改变 Focus 不得修改 Navigator 路由、Project Scope、Primary 内容或聊天目标。
- Collection 列表、Settings、Sources、Skills 和 Board 仍是 Shell/Navigation Surface，不变成任意物理 Panel。

### 5.3 命令边界

UI 组件不能直接修改 Workbench atom。所有状态转换由唯一命令层负责：

```text
selectSessionFromNavigator
createSessionInPrimary
createSessionInNewPanel
branchSessionInNewPanel
openProjectFilePreview
openProjectFileInPanel
presentBrowser
focusPanel
closePanel
switchProject
resizePanel
reorderAuxiliaryPanel
```

每条命令必须明确：

- 影响哪个 Project；
- `auxiliary.length` 的准确变化量；
- Focus 结果；
- Navigator 结果；
- 替换或关闭前需要执行的生命周期工作；
- 失败结果。

通用 `navigate()` 内部不得隐藏布局修改。

Project 前置条件：

- `selectSessionFromNavigator(S)` 先解析 `S.projectId`。如果它与 `activeProjectId` 不同，该命令必须在一个串行事务中 park 当前布局、激活目标 Project，再执行“聚焦已可见目标，否则替换 Primary”的规则。
- `createSessionInPrimary(P)`、`createSessionInNewPanel(P)`、`branchSessionInNewPanel`、Project File 命令、Browser presentation、Focus、Close、Resize 和 Reorder 都只能操作当前 Project。调用方必须先显式切换 Project；命令拒绝跨 Project 或 parked layout 目标。
- `createSessionInNewPanel` 执行时如果没有焦点 Panel，则新 Auxiliary 插入到索引 `0`，也就是语义 Primary 槽位之后。

初始命令契约如下。`Aux Δ` 表示 `auxiliary.length` 的变化量；Primary 不计入 Auxiliary。

| 命令 | 布局结果 | Focus 结果 | Navigator/聊天目标结果 | 失败结果 |
| --- | --- | --- | --- | --- |
| `selectSessionFromNavigator(S)` | 如果 `S` 已可见则布局不变，否则替换或创建 Primary。`Aux Δ=0`。 | 聚焦已可见的 `S` Panel，否则聚焦 Primary。 | Navigator 选择 `S`；其他 Panel 拥有的聊天目标不变。 | 状态不变。 |
| `createSessionInPrimary(P)` | 在 `P` 中创建 `S`，再替换或创建 Primary。`Aux Δ=0`。 | 聚焦 Primary。 | Navigator 选择 `S`；当前聊天为 `S`。 | 不保留部分创建的 Session 或展示状态。 |
| `createSessionInNewPanel(P)` | 在当前 `P` 创建 `S`；插入到焦点 Panel 后，焦点为空时插入 Auxiliary 索引 `0`。`Aux Δ=+1`。 | 聚焦新 Auxiliary。 | Navigator 显式选择 `S`；当前聊天为 `S`。 | 在创建 Session 前拒绝跨 Project 或容量超限请求。 |
| `branchSessionInNewPanel(source)` | 在来源 Project 创建子 Session，并在 `source` 后插入 Auxiliary。`Aux Δ=+1`。 | 聚焦子 Session Panel。 | Navigator 显式选择子 Session；来源不变。 | 失败后不残留子 Session 或 Panel。 |
| `openProjectFilePreview(F)` | 成功 flush 后复用当前 Project 的 Preview；不存在时创建一个 Preview Auxiliary。复用时 `Aux Δ=0`，首次创建时 `+1`。 | 聚焦 Preview。 | Session Navigator 和所有聊天目标不变。 | Flush 或容量失败时保持旧布局和内容。 |
| `openProjectFileInPanel(F)` | 创建或聚焦显式文件 Auxiliary，绝不占用 Preview。 | 聚焦显式文件 Panel。 | Session Navigator 和聊天目标不变。 | 状态不变，并展示用户可见错误。 |
| `presentBrowser(B)` | 聚焦已经存在的 `B` Panel，或者只在显式 presentation intent 下创建 Auxiliary。 | 只有显式 presentation intent 才改变焦点。 | Navigator 和聊天目标不变。 | 销毁刚创建的孤儿 Runtime，布局保持不变。 |
| `focusPanel(id)` | 布局不变。 | 聚焦 `id`。 | Navigator、Project、Primary 和聊天目标不变。 | 状态不变。 |
| `closePanel(id)` | 文档先 flush，可 veto；关闭 Browser 时销毁 Runtime；随后移除 Panel。关闭 Primary 后将其设为 `null`。 | 优先右侧 Panel，其次左侧 Panel，再次 Primary，最后为 `null`。 | Navigator 不自动选择 Focus fallback；Session 数据保留。 | Veto 或生命周期失败时保持 Panel 打开。 |
| `switchProject(P)` | 将当前内存布局 park，激活 `P` 已 park 的布局或空布局。 | 恢复已保存 Focus，没有则为 `null`。 | Navigator 切换到 `P`；Panel 局部聊天目标随 parked Panel 保留。 | 留在当前 Project。 |
| `resizePanel` / `reorderAuxiliaryPanel` | 只修改比例或 Auxiliary 顺序。 | 保持 Focus。 | Navigator 和聊天目标不变。 | 状态不变。 |

### 5.4 Navigation 分离

- Navigator 只拥有当前 Collection/Filter 和显式用户导航意图。
- Workbench 只拥有可见实体和展示布局。
- 浏览器历史记录语义导航，不保存序列化的渲染器树。
- 后台 Agent 或 Browser 事件可以更新内容和 Badge，但不能修改 active Project、Primary、Navigator、`auxiliary.length` 或 Focus。

### 5.5 文档与引用边界

- 阅读器和 Browser 选区生成统一的 `Reference` 值。
- Chat 草稿、消息、Add Note、预览、模型输入和 reveal 操作消费同一个 `Reference`。
- EPUB、PDF、Browser 和文本组件不各自实现目标 Session 或 Note 写入协议。
- Document Controller 负责 dirty 状态、自动保存、flush 和关闭 veto。

### 5.6 原生 Browser 边界

- Renderer Workbench 负责 presentation intent 和 DOM Host 几何。
- Electron Main 负责原生 Browser Runtime 的创建、销毁、Focus 和 Bounds。
- 关闭 Browser Panel 时销毁对应 Runtime。
- 切换 Project 时 park Browser Panel，detach/hide 原生 Surface，并在当前进程内保留该 Project 的 Runtime。
- 应用退出时销毁所有运行时。阶段 6 中，应用重新启动后只保留语义 Browser 描述符，只有显式重新打开/呈现才创建运行时；Panel/运行时自动恢复要等阶段 8 的 Workbench 布局持久化。原生运行时对象永不持久化。
- 连续 Scroll 和 Resize 持续更新 Bounds。
- Hide/Show 只用于结构变化或真实遮挡，不用于普通几何变化。

### 5.7 持久化

重建仍然持久化新产品数据，但不包含旧格式 Reader 或 Migration。

- 使用新的 Stair 应用数据命名空间。
- 每个存储区域只保留一个当前 Schema Version。
- 领域数据与 Workbench 展示状态分开持久化。
- 持久化语义 Project 布局，不持久化 React State 或原生 Runtime 对象。
- Browser Runtime State 必须可重建。
- 不主动迁移或删除旧 Craft/Stair 数据；Stair 只读取当前配置指向的 `~/.stair` 命名空间，不读取 Craft 命名空间。
- 阶段 1 持久化 Project/Session 领域数据，阶段 4 持久化阅读器数据，阶段 6 持久化书签和语义 Browser 描述符。Workbench 跨重启布局持久化延后到阶段 8；阶段 2—7 只在当前进程内暂存不同 Project 的 Workbench 布局。因此阶段 6 绝不在应用重启后自动恢复 Browser Panel。

## 6. 实施策略

### 阶段 0：建立干净基线（完成）

范围：

- 确认 `upstream/main@50ffa143` 且 Diff 为空。
- 增加最小 Stair 品牌、开发/构建入口、独立数据命名空间和不冲突的开发端口。
- 功能开发开始前，保持未修改的 Craft 应用可以正常运行。

验证：

- Stair 开发启动与本地成品结构检查。
- Craft 与 Stair 可以同时运行。
- Stair 不读取 Craft 数据，也不迁移、删除 Craft 或旧 Stair 数据。

### 阶段 1：Project 与 Session 不变量（完成）

范围：

- 创建 Workspace 时同时创建默认 Project。
- 所有 Session 创建入口必须提供不可变的 `Session.projectId`。
- 强制执行 Project 删除规则和同 Project 通信规则。
- 删除 Project 重新绑定和旧 fallback 语义。

验证：

- 覆盖创建、删除、重启和通信的领域与存储测试。
- 覆盖每个 Session 创建入口的 RPC 测试。
- 在默认 Project 内，新创建的数据继续具备当前上游 Session 行为。

### 阶段 2：仅包含 Session 的 Workbench（完成）

范围：

- 引入新 Workbench State 和 Command Layer。
- 只支持 Session Primary 和 Session Auxiliary。
- 在一个阶段内切换 Renderer，并删除旧 PanelStack Mutation 路径。
- Collection 和 Settings 保持在物理 Panel 模型之外。

验证：

- 选择已可见 Session：聚焦目标，`auxiliary.length` 不变。
- 选择不可见 Session：替换 Primary，`auxiliary.length` 不变。
- 普通 New Session：替换或创建 Primary，`Aux Δ=0`。
- New Session in Panel：`Aux Δ=+1`，聚焦新 Panel，Navigator 指向新 Session。
- 默认 Branch：`Aux Δ=+1`，子 Session 位于来源之后并被聚焦，来源不变。
- 关闭 Primary/Auxiliary 时遵循命令表中的确定性 Focus fallback。
- 除 Reducer 测试外，还必须有真实 Renderer 交互测试。

### 阶段 3：Project Files 与文本文档（完成）

范围：

- Project 文件树和安全路径 API。
- 一个可复用的 Project File Preview。
- 显式 Project File Auxiliary。
- 文本阅读、编辑、dirty tracking、自动保存、flush 和关闭 veto。

验证：

- 替换 Preview 不修改 Primary 或显式 Auxiliary。
- 替换、关闭或退出应用前先 flush dirty 文件。
- 拒绝无效路径和越出 Project 的路径。
- 在真实 Electron 的当前 `os` Project 中验证懒加载文件树、Preview 复用、显式 Auxiliary、自动保存与关闭前 flush。

### 阶段 4：EPUB 与 PDF（未开始）

范围：

- 基于统一文档/引用边界构建 EPUB 和 PDF 阅读器。
- 增加进度、划线、选区、引用预览和 reveal。
- 覆盖真实 EPUB 校验场景，包括压缩的 `mimetype` 条目。

验证：

- 阅读器状态使用新 Schema，并在 Stair 重启后恢复。
- 引用预览和 reveal 使用稳定来源身份。
- 替换 Preview 时先 flush 状态，且不增加 Panel 数量。
- EPUB 连续阅读、目录、进度、划线、选区和 reveal 分别具有基于 Fixture 的验收用例。
- PDF 连续阅读、进度、划线、选区和 reveal 分别具有基于 Fixture 的验收用例。

### 阶段 5：引用与 Add Note（未开始）

范围：

- 将文本、EPUB、PDF 和聊天引用接入草稿、消息、模型输入和渲染。
- 实现一个 Add Note 目标选择器和一个 Project Files Browser。
- 增加显式同 Project Add Chat/New Chat 目标。

验证：

- 文本、EPUB、PDF 和聊天生成同一协议结构；Browser 在阶段 6 加入该矩阵。
- 新创建的目标 Session 立即可用，不依赖异步事件 hydration。
- Busy/Background 目标 Session 不修改 Workbench 展示。
- 服务端 Project 与路径校验是最终权威。

### 阶段 6：原生 Browser（未开始）

范围：

- DOM-only Workbench 稳定后再增加 Browser Auxiliary。
- 实现 Renderer Host、Geometry IPC、原生 Runtime 生命周期、选区、引用、书签和链接偏好。
- 开发模式构建并监听 Browser preload。

验证：

- 端到端验证 React 提交 → DOM 几何 → IPC → Electron View。
- 验证连续 Resize、Sidebar/Navigator 动画、横向 Overflow、Scroll、真实 Occlusion 和 Pointer Interaction。
- 关闭和切换 Project 后不存在孤儿 Browser Surface。
- 关闭 Panel 时销毁运行时；切换 Project 时在当前进程内暂存/分离，并在切回后恢复。应用重启后，显式重新打开/呈现根据描述符创建新运行时；阶段 8 再增加布局驱动的自动恢复。
- 书签新增/删除/列表以及内部/系统浏览器打开偏好都有全新数据验收用例。
- 单元测试或模拟 Electron 测试不能单独满足本阶段完成条件。

### 阶段 7：Drawnix 与 Agent 工具（未开始）

范围：

- Drawnix Project Document 和 Document Controller。
- 通过 Project-scoped Capability Boundary 暴露 Agent Mind Map 读写工具。

验证：

- Drawnix 自动保存和关闭行为与文本文档一致。
- Agent 工具不能访问所属 Project 外的文件。
- Tool Execution 不导入或修改 Renderer Workbench State。

### 阶段 8：布局持久化与交互完善（未开始）

范围：

- 新 Workbench 布局持久化。
- Panel 独立比例。
- Auxiliary 拖拽排序。
- Compact 行为与动画。
- 最终 Accessibility 和 Keyboard 行为。

验证：

- 重启后独立恢复每个 Project 布局。
- Shell Pane 开关不修改持久化 Panel 比例。
- 拖拽和调整原生 Browser Panel 时保持视觉连续。
- 无效持久化条目局部失败，不替换整个布局。

### 阶段 9：打包与完整验收（未开始）

范围：

- 最终 Stair 打包、图标、发布说明和全新安装行为。
- 执行在之前各阶段开始时逐步冻结并累计的完整能力验收矩阵。

验证：

- 聚焦测试、类型检查、lint、构建和相关完整测试集。
- 使用全新数据完成所有保留能力的桌面验收。
- 完成原生 Browser 视觉和 Pointer 验收。
- 最终 Diff 中不存在旧兼容层或无关重构。

## 7. 旧 Stair 工作复用策略

历史参考点：

| 参考 | SHA | 用途 |
| --- | --- | --- |
| `codex/rebuild-thinking-agent` | `6dc6c9fb` | 最后一个检查点前的 Stair 实现；用于查找独立能力测试和小型纯函数。 |
| `codex/stair-workbench-checkpoint` | `6be3dd4b` | Project 作用域 Workbench 的未完成实现；只复用领域不变量和缺陷复现，不复用实现。 |
| `codex/socratopia-learning` | `024703db` | 更旧的 Prototype；只有前两个参考点无法解释能力时才查看。 |

能力与历史映射：

| 能力 | 需要查看的历史提交 | 复用方式 |
| --- | --- | --- |
| 品牌与打包 | `0b2b36dc` | 选择资产，并基于当前上游重新接入。 |
| Project Files 与 EPUB | `bfef09e2`、`97fb9794`、`6ad26ca4`、`6dc6c9fb` | 需求、Fixture、Parser/Validator 候选。 |
| Browser Panel 与 Geometry | `87dd15b2`、`da52434a`、`7cfb308f` | 生命周期场景与 Preload/Build 需求。 |
| Browser Link 与 Bookmark | `7f00517b`、`b872f330` | 产品行为与纯 Bookmark 函数候选。 |
| Add Note 与目标选择 | `270f6198`、`f726f672`、`60312488`、`d10842e5` | 只复用协议与竞态条件测试。 |
| Drawnix | `2061a1dc`、`fc3ec13f` | 文档/工具行为与独立 Controller 候选。 |
| 文本编辑 | `6e7f4eda` | Dirty/Flush/Autosave 规格与 File Classification。 |
| PDF 阅读器 | `6c9be262` | Fixture、Reader State、Reference 与 Reveal 用例。 |
| Project-scoped Workbench | `6be3dd4b` | 只复用领域测试与失败清单。 |

### 作为规格复用

- Workbench 检查点中的 Project/Session 不变量测试。
- EPUB/PDF Fixture 和 Reference/Reveal 用例。
- Browser 生命周期与 Geometry 边界场景。
- Add Note 目标解析用例。
- 现有验收记录和缺陷复现。

### 审查当前上游 API 后选择性移植

- Stair 品牌与打包资产。
- EPUB Archive 校验算法。
- File Classification 纯函数。
- Workspace Bookmark 纯函数。
- 不依赖 Renderer 或持久化的 Reader Parser。

### 不 cherry-pick

- Project Files/EPUB 大提交。
- Browser-to-PanelStack 接入大提交。
- 跨来源 Add Note 大提交。
- 完整 Workbench 检查点。
- 旧 Layout Codec、Migration 和 Navigation Compatibility Path。

历史中的小提交也在所属阶段内重新实现，不盲目执行 `cherry-pick`，例如开发端口、Browser preload 覆盖、HMR 根节点复用和压缩 EPUB `mimetype` 支持。

## 8. 验证基线

验收矩阵不能延后到阶段 9。每个阶段开始前，必须在本文档或相邻的已提交测试计划中冻结该阶段的验收行、测试夹具、准确测试文件和人工步骤。冻结路径可以指向本阶段将以测试先行方式创建的测试；本阶段第一个提交必须先加入失败测试，再实现产品代码。

自动化基线命令：

```bash
bun test <phase-specific-test-files>
bun run typecheck:all
bun run lint:electron
bun run electron:build
git diff --check
```

如果某阶段修改其他 Package，还必须执行该 Package 的 Lint/Test。最终交付前执行：

```bash
bun test
bun run typecheck:all
bun run lint
bun run electron:build
git diff --check
```

阶段 0 必须建立并记录唯一的 Stair 开发启动命令。在此之前，上游 Craft 验收使用 `bun run electron:dev`。测试记录必须包含命令、日期、测试夹具和通过/失败数量；无关的既有失败与本次范围内失败分开记录。

阶段 0 开工门槛与最终验收记录：

- 需要创建/执行的自动化测试路径：
  - `packages/shared/src/stair-branding.test.ts`
  - `apps/electron/src/main/__tests__/stair-user-data.test.ts`
  - `bun run electron:build` 调用的现有 Electron Asset/Build 校验
- 原冻结矩阵要求使用空 Stair 数据命名空间。用户随后明确要求直接使用当前选中的 `os` Project 做 Workspace 验收，因此没有清空、迁移或删除现有 `~/.stair` 数据。
- 最终人工步骤与结果：
  1. 分别启动 Craft 和 Stair，Computer Use 确认两个产品窗口及各自可见 Project 状态。
  2. Craft 与 Stair 同时运行时，Renderer 分别监听 5173 和 5193，Electron userData 分别位于 Craft 系统目录与 `~/.stair/electron`。
  3. 停止 Craft，仅运行 Stair；对 `~/.craft-agent` 的 289 个文件计算运行前后摘要，均为 `b349821476f3463c65932da57ecef3018be79b9f347ab6bef124bbfcc68d3cd8`。
  4. Stair 日志、配置监听和设置页均指向 `~/.stair`；重新启动后仍加载当前 Stair 数据命名空间。

阶段 1 开工门槛已冻结：

- 需要创建/执行的自动化测试路径：
  - `packages/shared/src/workspaces/__tests__/default-project.test.ts`
  - `packages/shared/src/projects/__tests__/storage.test.ts`
  - `packages/server-core/src/handlers/rpc/projects.test.ts`
  - `packages/server-core/src/sessions/create-managed-session.test.ts`
  - `packages/server-core/src/sessions/project-communication.test.ts`
- 人工步骤：
  1. 创建全新 Workspace，确认只存在一个默认 Project。
  2. 在默认 Project 和第二个 Project 中各创建一个 Session；重启 Stair，确认归属不变。
  3. 尝试重新绑定 Session、删除默认/非空 Project、跨 Project 通信；确认全部被拒绝且没有部分状态。
  4. 通过每个用户可见入口创建 Session，确认创建时就具有预期 Project。

最小可重复验收矩阵：

| 阶段 | 固定测试夹具 | 必须观察到的结果 |
| --- | --- | --- |
| 0 | 空 Stair 数据命名空间和一个已有 Craft 数据命名空间 | Stair 全新启动；Craft 数据未受影响；两个开发实例运行时端口和数据互不冲突。 |
| 1 | 两个 Project，每个 Project 两个 Session，同时包含默认与非默认 Project | 归属不可变；重启后仍拒绝无效跨 Project 通信和删除。 |
| 2 | 一个 Primary Session 和两个显式 Auxiliary Session | 每条命令符合状态转换表，包括可见/不可见选择、Branch 位置、Close fallback 和 Project Switch。 |
| 3 | 可编辑 Markdown、只读文件、非法路径和强制保存失败 | Preview 复用稳定；Autosave/Flush 正确；保存失败 veto 替换/关闭；路径无法逃逸 Project。 |
| 4 | 压缩 `mimetype` EPUB、包含划线/目录的 EPUB、Text-layer PDF | 重启后连续阅读、进度、划线、选区、Reference Preview 和 Reveal 正常。 |
| 5 | 来自文本、EPUB、PDF、聊天的引用，以及已有/新建 Note Target | 使用同一协议和 Picker；目标创建没有 Hydration Race；拒绝非法 Project/Path。 |
| 6 | 确定性的本地 HTML 选区页、Scroll 页、Occlusion Dialog、两个 Project 的 Browser Panel | 原生 Surface Bounds 与 Pointer Input 正确；Close 销毁；Project Switch park/restore；Bookmark 与 Link Preference 持久化。 |
| 7 | Drawnix Board，以及允许和越出 Project 的 Agent Tool 请求 | Edit/Autosave/Flush 正确；Agent Tool 遵守 Project Scope 且不依赖 Renderer。 |
| 8 | 两个包含 Resize/Reorder Auxiliary 的持久化 Project 布局、一个非法条目；100%/200% Zoom 下的 Keyboard-only Navigation | 重启恢复有效语义状态；比例稳定；非法条目局部失败；Compact/Animation 不改变行为；所有控件和 Panel 都可通过确定顺序访问，有可见 Focus 且不存在 Keyboard Trap。 |
| 9 | 全新安装的 Stair 包 | 所有保留能力在空数据下通过；Package Identity、Asset、Update Policy 和 Data Namespace 均为 Stair 专属。 |

原生 Browser 验收必须在 macOS 的真实 Electron 应用中执行，并为调整大小、滚动、遮挡、Project 切换、关闭和指针交互记录截图或等价视觉证据。Reducer、jsdom 和模拟 IPC 测试不能满足这些验收行。

## 9. 提交与交付规则

- 每个阶段拆分为最小的端到端可运行提交。
- 一个提交不能同时包含领域迁移、Renderer 重写、原生 Browser 生命周期和交互完善。
- 定义预期行为的测试与实现同时或更早提交。
- 未执行本阶段验收检查前，不能宣称阶段完成。
- 聚焦测试只能报告为聚焦测试，不能当作完整产品验收。
- 旧检查点分支保持不变，继续作为参考。
- 用户未明确要求前不 Push。

## 10. 完成标准

只有同时满足以下条件，重建才算完成：

1. 第 4 节所有保留能力都通过全新数据验收。
2. 普通导航绝不创建 Auxiliary Panel。
3. Project Focus、Panel Focus、Navigator State 和 Chat Target 分别独立表示。
4. Session 生命周期独立于 Panel 生命周期。
5. Project File 和 Browser Focus 不能静默替换 Primary。
6. 后台 Agent 和 Browser 事件不改变布局。
7. 原生 Browser 通过真实 Electron 视觉与 Pointer 检查。
8. 只读写新的 Stair Storage Schema。
9. 最终实现不存在旧 Stair 兼容层。
10. 仓库通过 `bun test`、`bun run typecheck:all`、`bun run lint`、`bun run electron:build` 和 `git diff --check`。

## 11. 立即下一步

阶段 0—3 已完成并验证。当前停止产品能力扩展，不开始阶段 4；后续是否进入 EPUB 与 PDF 由用户另行确认。
