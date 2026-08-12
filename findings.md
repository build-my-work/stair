# 调研结论与架构决策

## 需求边界

- 从干净的 `upstream/main` 重建 Stair，只保留产品能力，不保留旧用户数据、旧布局或迁移兼容层。
- 普通导航默认不创建 Panel；只有用户明确执行 Add Chat、Add Panel 或打开专属资源时才允许新增 Auxiliary。
- Sidebar 与 Navigator 固定在壳层，Workbench 只在内容区域横向滚动。
- Primary 可以为空；Auxiliary 有明确顺序、生命周期和容量限制。
- Session 永久归属创建它的 Project，所有列表、选择、任务和投递都必须服从 Project 过滤。
- 点击已经存在的 Session 或资源时，既要改变逻辑焦点，也要把对应 Panel 自动滚入可视区域。
- Navigator 可以独立收起和恢复，不改变 URL、当前选择、Primary、Auxiliary 或焦点模式偏好。
- `promo/` 不属于本次范围。

## 仓库与基线事实

- 重建基线为 `upstream/main` 的 `50ffa143ab76`；创建重建分支时本地 HEAD 与上游 SHA 一致。
- 旧检查点 `6be3dd4b` 建立在 `6dc6c9fb` 之上，包含大量相互耦合的 Workbench、原生 Browser 和布局改动，不适合继续叠加。
- Stair 开发版应通过 `scripts/stair-dev.ts` 启动；仅设置 `CRAFT_APP_NAME=Stair` 会继续读取 Craft 数据。
- Stair 自有配置目录为 `~/.stair`。外部 Project 工作目录属于用户文件，不是可清理的应用状态。
- `CRAFT_CONFIG_DIR` 只改变配置目录，不能自动重定向已写入 Workspace 记录中的目录；隔离验收需要显式预置新的 Workspace 根目录。
- 阶段 1—2 验收时，`apps/electron/src/main` 没有相对上游的改动，因此该目录的既有 `BrowserPaneManager` 失败不能归因于阶段 1—2；阶段 0 随后增加了品牌和路径接线。

## 核心不变量

| 领域 | 已确认的不变量 |
|---|---|
| Workspace | 始终存在 `defaultProjectId`，首次启动可落到合法默认 Project |
| Project | 选择 Project 只改变 Project 上下文，不隐式创建 Auxiliary |
| Session | 必须携带不可变 `projectId`，旧 Project 的 Session 不能污染当前 Project |
| Workbench | 单一状态所有者维护可为空的 Primary、有序 Auxiliary 和当前焦点 |
| 普通选择 | 优先聚焦已经存在的 Panel；否则按资源规则替换 Primary 或复用 Preview |
| 显式新增 | Add Chat、Add Panel 等显式命令才可新增 Auxiliary |
| 后台投递 | 可以更新 Session 内容，但不能改变当前布局或焦点 |
| Project File | 所有文件格式共用一个 Preview Auxiliary；再次选择只替换 Preview 内容 |
| Browser | 使用持久 Auxiliary，保留自己的运行时、URL 和历史，不与文件 Preview 混用 |
| 布局 | Sidebar、Navigator 固定；`ContentViewport` 是唯一横向滚动容器 |
| Panel 显露 | 一次性 reveal 信号只存在于运行时，由 `WorkbenchContainer` 执行水平滚动 |
| 原生表面 | Electron View 必须服从稳定 DOM 几何、固定壳层边界和真实遮挡 |
| 壳层偏好 | Sidebar、Navigator 和焦点模式分别持有偏好，不能互相覆盖 |

## 状态与命令边界

- Navigation 负责“用户想去哪里”，Workbench 命令负责“目标在当前布局中如何呈现”。两者通过明确参数协作，不共享可随意写入的 Panel 细节。
- Workbench 的直接状态写入集中在一个所有者中；组件只发出 `select`、`open`、`focus`、`close` 等语义命令。
- `activeTabId`、Browser 运行时标签与 Workbench Panel 是不同层次的概念，不能因为 UI 都叫标签就合并。
- Panel 不承担消息总线职责。后台 Agent 通过 Session/消息通道投递，布局只响应用户显式动作。
- 持久化状态只保存用户偏好和必要布局；reveal revision、动画门控、当前异步动作上下文保持运行时状态。

## 关键技术决策

| 决策 | 依据 |
|---|---|
| 不引入历史迁移和兼容门面 | 用户明确不要旧数据；兼容层会重新引入被清理的双模型 |
| 默认 Project 与默认 Workspace 在领域层成立 | UI 兜底不足以保护服务端、测试和后台入口 |
| 创建 Session 后使用返回值完成本次选择 | render 时捕获的 `sessionMetaMap` 不可能包含刚创建对象 |
| Project File 采用单 Preview 模型 | 文件预览是瞬时任务，复用能避免无上限横向增长 |
| Browser 不采用 Preview 模型 | Browser 持有独立进程侧状态，替换语义会丢 URL、历史和生命周期 |
| Panel 尺寸基准与可见裁剪宽度分离 | 壳层切换只应改变可见区域，不应重新计算所有 Panel 宽度 |
| reveal 使用 revision 而不是布尔值 | 连续点击同一个目标也必须产生新的可观察请求 |
| reveal 由容器调用 `scrollTo` | `scrollIntoView` 会滚动所有祖先，曾导致页面根节点偏移和灰色视口 |
| 原生 Browser 在壳层运动期间门控 | Electron View 不参与 DOM 动画，若持续显示会短暂穿透或滞后 |
| Navigator 可见性由 AppShell 管理 | 它属于壳层偏好；放进 Workbench 会把产品导航和内容布局耦合 |

## 阶段性调研结论

### 阶段 8：独立审查修复

- 审查证明干净重建初版仍有四个边界缺口：启动早期事件可能丢失、陈旧 task 可能回退、旧 Session 可污染当前 Project、Project 过滤的所有权不够集中。
- 处理方式不是增加兼容层，而是先写聚焦失败测试，再把校验收回到权威 Project/Session 数据源。
- 修复后重新执行相关包测试、Renderer 测试、类型检查和 UI 验收。

### 阶段 9：Project File 选择语义

- 首个实现把文件选择解释为替换 Primary，这与用户真实产品语义冲突。
- 用户最终确认：Project File 永远是 Auxiliary；不同文件格式共用一个可复用 Preview；Browser 仍是持久 Auxiliary。
- 选择新的文件会更新 Preview 内容并聚焦它；再次选择同一文件不会创建副本。
- Preview 生命周期由 Workbench 命令管理，文件组件不直接修改 Panel 数组。

### 阶段 10：Panel 宽度稳定

- 根因不是单纯动画方向，而是同一个视口宽度同时承担了“当前可见宽度”和“Panel 尺寸计算基准”。
- Sidebar 或 Navigator 收起时，可见裁剪区域变大；若同时重算 Panel 宽度，所有内容会缩放并出现反向显露。
- 修复后壳层切换只改变裁剪窗口，Panel 自身宽度保持稳定。

### 阶段 11：选择动作回归

- Add Chat 创建 Session 后，异步函数继续使用 render 时捕获的 `sessionMetaMap`，因此新 Session 会被误判为无效引用。
- 创建接口的返回 Session 才是当前动作的权威对象；全局映射只适合后续渲染和跨动作查询。
- Browser 无显式 Session 时应传 `undefined`，不能把 `null` 泄露进可选命令字段。
- 八 Panel 容量预检应直接返回容量错误，阅读器通知必须保留原始回调错误。

### 阶段 12：已有 Project File Panel 的视觉聚焦

- 逻辑焦点变化并不等于用户能看见目标；横向 Workbench 中目标可能完全在视口外。
- 新增运行时 reveal 请求后，重复点击同一文件也会产生新 revision。
- reveal 不进入持久化布局，避免重启时重放无意义滚动。

### 阶段 13：Browser 原生表面滚动同步

- Browser 内容由 Electron View 绘制，React Panel 只提供外壳和几何；两条渲染链的提交时机不同。
- 连续滚动时如果 View 位置更新落后于 DOM，会看到短暂错位；但把所有滚动都视为遮挡又会造成闪烁。
- 正确边界是：连续 resize/scroll 继续更新几何，只有真实遮挡或壳层尚未稳定时才暂停显示。

### 阶段 14：静态裁剪与关闭生命周期

- 用户澄清后，问题被重新定义为关闭相邻 Project File Panel 时 Browser 的静态边界错误，而不是普通滚动问题。
- 关闭动作改变 Panel 排列和可见裁剪范围，需要在布局提交后重新计算 Browser 几何。
- 修复不能销毁 Browser 运行时，也不能把它误替换成文件 Preview。

### 阶段 15：固定 Sidebar 边界

- 原生 View 的可见矩形此前只考虑内容视口，没有扣除固定左 Sidebar。
- 结果是 Browser View 可能覆盖固定导航壳层。
- 将 Sidebar 作为不可穿透边界后，展开、收起和窗口 resize 都能得到一致裁剪。

### 阶段 16：原生表面系统审计

- 仅测试 reducer 或模拟几何不足以证明真实像素正确。
- 必须同时覆盖 `React → DOM geometry → IPC → Electron View`，并观察真实窗口中的连续运动。
- 审计把问题分成三类：状态模型错误、几何提交时序错误、环境导致的验收不可用；三者不能混报。

### 阶段 17：Claude 与 Kimi 架构挑战

- 两个外部审查重点挑战状态所有权、异步命令中的陈旧闭包、Project 隔离、Panel 与原生 View 生命周期。
- 有效意见都回到定义、调用者、输出状态和测试证据逐项核实；没有因“审查建议”而新增抽象。
- 最终结论是继续保持单一 Workbench 命令层，并把原生表面的稳定性作为独立边界处理。

### 阶段 18：壳层运动门控

- DOM 壳层动画期间，Electron View 不会自动跟随 CSS 变换；持续显示会出现穿透和拖影。
- 实现以壳层稳定信号控制原生表面：运动开始时暂停，稳定后按最新 DOM 几何恢复。
- 重载测试进一步发现每个 lease 都注册 host `closed` 监听器，累计到 12 个后触发 `MaxListenersExceededWarning`。
- 删除每个 lease 的单独监听器后，host 停放继续由既有 WindowManager 生命周期负责。

### 阶段 19：最终 Computer Use 复验

- 锁屏前完成了大部分 UI 矩阵；书签菜单、孤立 Panel 关闭等指针专属动作受到 AX 无几何框、窗口识别和锁屏限制。
- 每次可访问性树更新后旧元素索引都可能失效，不能重复使用。
- 未完成项保留为真实验收缺口，不用结构测试冒充完整像素验收。

### 阶段 20：原生 Browser 滚动闪烁

- 整段滚动手势都暂停原生表面可以避免错位，但用户会看到 Browser 大面积闪烁。
- 这说明“运动中一律隐藏”过于粗糙；门控应只覆盖尚未提交的壳层运动或真实遮挡。
- 该历史问题在干净重建后已被收窄，但最终像素级复验仍未正式关闭。

### 阶段 21：检查点分支审计

- 旧检查点混合了 Project/Session 迁移、PanelStack、Side Chat、原生 Browser 和大量布局补丁。
- 继续修补会保留双重状态模型和难以验证的隐式副作用。
- 更安全的路径是以领域不变量为规格，从 `upstream/main` 逐层重建最小可运行产品。

### 阶段 22：干净重建的阶段 1—2

- Phase 1 先让 Workspace 和 Session 类型变得不可表达非法状态：Workspace 必须有 `defaultProjectId`，Session 必须有 `projectId`。
- 所有创建、序列化、测试夹具和服务端读取都被同步更新；没有用可选字段换取兼容。
- 阶段 2 引入最小 Workbench：可为空的 Primary、有序 Auxiliary、显式聚焦/打开/关闭命令和 Project 过滤。
- Renderer 的普通导航不再隐式创建 Panel；Add Chat 与后台消息投递分离。
- 独立审查暴露的四类回归先转成失败测试，再做收窄修复。
- 启动验收曾发现关闭处理器改错到重新认证分支；核对四个调用点后，仅就绪状态使用可感知 Navigation 的处理器。
- 完整 Renderer 源码测试在以 `apps/electron/src/renderer` 为工作目录时通过 493 项；从上层路径运行会误发现 `release` 副本。

### 阶段 23：Session Panel 自动显露

- 点击非 Primary Session 时，原先只改变焦点标识，横向视口不移动，因此用户感觉点击无效。
- 第一版 `scrollIntoView` 在真实 Electron 中没有移动目标容器，反而滚动页面根节点并暴露灰色视口。
- 最终实现计算目标 Panel 相对 `WorkbenchContainer` 的最近水平差值，只调用容器自己的 `scrollTo`。
- 运行时 `workbenchPanelRevealRevisionAtom` 支持同一 Session 的重复显露，不污染持久化状态。

### 阶段 24：全部未提交改动简化

- 按 `code-simplifier` 只审查当前未提交差异，明确忽略 `promo/`。
- 简化集中在重复条件、可直接表达的状态推导和本次引入的局部冗余；没有顺手整理上游代码。
- 广义 Renderer lint 的 4 个错误和 43 个警告均位于本次差异片段之外；实际简化文件为 0 个 lint 错误。
- 聚焦测试、完整 Renderer 测试、类型检查和 `git diff --check` 均保持通过。

### 阶段 25：Navigator 独立收起

- Craft 已有 Sidebar 收起能力，但 Navigator 没有独立偏好；最小架构归属是 AppShell，而不是 Workbench 或 Navigation。
- 新增持久化 `navigatorVisible`，TopBar 使用现有图标、按钮和 locale 体系提供桌面切换入口；紧凑模式不显示该入口。
- 收起只将 Navigator 宽度归零并隐藏对应 sash，不改变 Project、Session、URL、Primary 或 Auxiliary。
- 真实 Renderer 几何结果为宽度 `300 → 0 → 300` 像素，sash 数量 `2 → 1 → 2`，其他状态保持不变。
- 首次点击处于焦点模式时只退出焦点模式，不篡改 Navigator 偏好；随后点击才执行 Navigator 收起。
- 聚焦 TopBar 回归 2/2 通过；完整 Renderer 497/497 通过，共 886 个断言；Electron typecheck、JSON 校验和差异检查通过。
- 后台 Computer Use 期间 Renderer 的 `document.visibilityState` 为 `hidden`，Splash 动画被冻结；最终几何通过同一真实 Renderer 的 DevTools 和按钮事件验证，开发版保持运行供前台手测。

## 已知限制与未关闭项

- 阶段 19 的少量指针专属 Computer Use 场景仍受 macOS 辅助功能和窗口状态限制。
- 阶段 20 的 native Browser 滚动闪烁仍保留为历史进行中项，需要稳定前台窗口做最终像素复验。
- `typecheck:all` 会被上游 `session-tools-core` 缺少 `tsconfig.base.json` 阻断；相关包已独立验证。
- Electron main 的 8 个 `BrowserPaneManager` 测试失败与 Phase 1—2 无代码差异，按基线问题单列。
- `build:validate` 引用上游缺失的 `apps/electron/scripts/validate-assets.ts`；其余 Renderer、main、preload 和 copy 构建已分别验证。
- 完整 lint 中仍有上游遗留错误和警告；本次新增或简化代码没有新增 lint 错误。

## 参考位置

| 内容 | 路径或标识 |
|---|---|
| 重建基线 | `upstream/main@50ffa143ab76` |
| Stair 开发入口 | `scripts/stair-dev.ts` |
| 共享 Session bundle | `packages/shared/src/sessions/bundle.ts` |
| 集中式 locale | `packages/shared/src/i18n/locales` |
| Renderer 源码 | `apps/electron/src/renderer` |
| Electron 共享路由/类型 | `apps/electron/src/shared` |
| 当前三份工作文档 | `task_plan.md`、`findings.md`、`progress.md` |

## 阶段 27：阶段 0 启动事实

- 权威重建进度文件是 `docs/stair-rebuild-plan.md`；根目录三份文件只作为本次内部执行记录。
- 当前 HEAD 与 `upstream/main` 都是 `50ffa143ab76`，干净基线已经确认。
- `apps/electron/src/main/index.ts` 已支持通过 `CRAFT_APP_NAME` 设置运行时应用名。
- `packages/shared/src/config/paths.ts` 已支持通过 `CRAFT_CONFIG_DIR` 切换应用数据目录。
- `scripts/electron-dev.ts` 已有多实例端口和配置目录机制，但没有固定的 Stair 入口。
- 实现前仓库不存在 `scripts/stair-dev.ts`，`package.json` 也没有 Stair 专属开发或构建命令。
- 阶段 0 的最小方向是组合并验证现有机制，同时增加 Stair 专属品牌/入口；不新增第二套配置框架。
- `scripts/electron-dev.ts` 在调用 `detectInstance()` 前会加载 `.env`，且 `detectInstance()` 遇到已有 `CRAFT_VITE_PORT` 会直接保留调用方配置；Stair 入口可以安全复用该脚本。
- 主进程已经通过 `app.setName(process.env.CRAFT_APP_NAME || 'Craft Agents')` 支持运行时应用名，但 Renderer HTML、应用菜单和打包配置仍写死 Craft 品牌。
- 旧品牌提交 `0b2b36dc` 提供了 Stair 图标、打包配置、入口脚本和品牌测试，可作为资产与验收规格来源；不能整提交 cherry-pick。
- 当前 `electron-builder.yml` 固定使用 Craft 的 `appId`、`productName`、图标、更新地址和 artifact 名称；Stair 必须拥有独立打包配置，避免污染 Craft 发布渠道。
- 阶段 0 与阶段 9 的边界：本阶段提供可工作的 Stair 品牌、开发/构建入口和本地可打包配置；正式发布说明、签名、更新策略和完整安装验收仍属于阶段 9。
- `scripts/electron-dev.ts` 的真实顺序是先 `detectInstance()`、后 `loadEnvFile()`；此前记录的相反顺序已纠正。Stair wrapper 提供的环境变量仍可能被 `.env` 覆盖，必须让显式进程环境优先于 `.env`。
- Renderer 构建会原样继承环境，但当前 Vite 没有产品名注入；可以使用 `VITE_APP_NAME` 为 Stair 入口设置页面品牌，同时保留默认 Craft 标题。
- `WindowManager` 已用 `app.getName()` 管理窗口标题，因此主进程尽早设置 app name 后不需要另建窗口标题状态。
- 当前窗口和 Dock 图标只查找 Craft 资源；需要支持显式 `CRAFT_APP_ICON` 覆盖，打包版仍由独立 builder config 选择 Stair 图标。
- `setupI18n()` 是每个进程一次初始化的 singleton。若品牌化 locale，必须由入口在首次初始化时显式传入产品名，不能在共享模块中无条件替换 Craft 文案。
- 系统提示中的 Craft 产品自称与共著者需要按当前产品 profile 条件转换；`Craft Agents Backend`、`Craft Agents Docs` 等上游服务名必须保持不变。
- `WindowManager.refreshWindowTitles()` 已以 `app.getName()` 为权威，并阻止 HTML `<title>` 覆盖窗口标题；阶段 0 只需保证 app name 在创建窗口前正确设置。
- 阶段 0 应将 Electron `userData` 放到 `CRAFT_CONFIG_DIR` 的独立子目录，确保开发版 Craft 与 Stair 的 Chromium 缓存、窗口状态和单实例锁也隔离，而不仅是共享配置文件隔离。
- 当前 main 注册协议时读取 `CRAFT_DEEPLINK_SCHEME`，但 `deep-link.ts` 仍硬编码 `craftagents:`；若 Stair 使用独立 scheme，必须同步修正解析边界并补测试。
- `packages/shared/CLAUDE.md` 要求所有用户可见文案走 i18n，且品牌名保持英文。Stair 品牌转换应作用于 locale 值，不新增散落的硬编码 UI 文案。
- `apps/electron/resources/AGENTS.md` 说明资源目录会整体复制到 `dist/resources`；Stair 图标子目录属于打包资源，不应改写 Craft 根图标源文件。
- 旧 Stair 资源以一个 SVG 为源，通过 `sharp` 生成 PNG/TIFF、通过 macOS `iconutil` 生成 ICNS、通过 `ffmpeg` 生成 ICO；本次可恢复已验证的源和产物，不修改 Craft 根资源。
- Stair 的 macOS `afterPack` 只移除 `CFBundleIconName`，避免继承 Craft 的 `Assets.car`，让独立 ICNS 生效。
- 自动更新模块当前总会访问 Craft 更新通道；Stair profile 和打包入口必须设置 `CRAFT_DISABLE_AUTO_UPDATE=1`，同时让 `checkForUpdates()` 在该条件下直接返回当前状态。
- Renderer 页面品牌可以由 `VITE_APP_NAME` 驱动；打包时 shell 环境会清理 `VITE_*`，但品牌值已经在 Vite 构建期内联，不影响运行时。
- 现有深链测试只覆盖 `craftagents://` 路由。应让 `parseDeepLink` 接受显式 scheme 参数（默认仍为 `craftagents`），主进程传入当前 product scheme，并增加 `stair://` 回归。
- 现有 i18n bootstrap 通过子进程验证配置目录，适合复用为 Stair profile 的“模块加载前环境已设置”验收模式。
- 系统提示测试默认必须继续断言 Craft 共著者；新增 Stair 用例应临时设置环境并在 `finally`/测试钩子中恢复，证明双入口互不污染。
- 阶段 0 红测试至少覆盖三层：共享品牌纯函数、主进程 product profile 与 userData 路径、Stair 脚本环境/端口；深链和系统提示使用现有测试文件追加回归。
- 首轮红测试结果为 20 项通过、5 项失败、3 个加载错误；原有 Craft 深链和提示测试保持通过，新 Stair 断言准确命中尚未实现的边界。
- 阶段 0 实现后同一测试集达到 32 项通过、0 项失败、90 个断言；共享包和 Electron TypeScript 检查也均通过。
- 仓库根目录不能直接承载 ESLint 9 聚焦检查；必须在 `apps/electron` 和 `packages/shared` 内使用各自既有 lint 配置。
- i18n parity 与 sorted 检查可运行且通过，但 `lint:i18n:coverage` 指向不存在的脚本，属于当前上游工具链缺口。
- 阶段 0 涉及的 Electron 与 shared 文件聚焦 lint 均为 0 个错误；Electron 全量 lint 的 9 个错误位于本阶段范围外，不能算作阶段 0 回归，也不能在本阶段顺手修复。
- 默认 Craft 生产构建与 Stair `--dir` 打包均成功；Stair builder 明确加载父配置，说明自配置中的 `files` 没有把 Craft 的完整应用文件集错误覆盖掉，仍需检查成品包内容与运行行为。
- 首个 Stair 成品的 `CFBundleDisplayName`、`CFBundleIdentifier`、入口、Renderer 品牌和 ICNS 哈希均正确，但 `Info.plist` 没有 URL type；仅在主进程调用 `setAsDefaultProtocolClient` 不足以证明 macOS 包能接收 `stair://`，应由 builder 配置声明协议。
- electron-builder 官方配置确认顶层 `protocols` 接受 `{ name, schemes }`；在 macOS 上还必须注册 `open-url` 处理，而现有主进程已经具备该处理路径。

## 阶段 28：用户状态路径隔离事实

- 默认 Craft 必须保持现有路径；因此只能让 `CRAFT_CONFIG_DIR` 显式存在时改变路径，或复用默认值仍为 `~/.craft-agent` 的共享 `CONFIG_DIR`。
- 当前 Stair 的 Chromium `userData` 已经是 `~/.stair/electron`，配置、Workspace 和 Session 日志也已经从 `~/.stair` 加载。
- 修复前真实运行日志显示窗口状态来自 Craft 路径，专用 messaging 日志也报告为 `~/.craft-agent/logs`；根因是少数运行时路径绕过了现有 `CONFIG_DIR`，不是 Workbench 业务缺陷。
- 第一轮源码审计确认 18 个运行时命中，其中 `permissions-config.ts` 已动态尊重 `CRAFT_CONFIG_DIR`，无需修改；其余命中需按实际读写行为继续核对。
- 已确认必须隔离的共享状态包括：加密凭据、拦截器配置/日志/错误、默认 Workspace、内置 docs/release-notes 同步目录、provider domain 缓存和 Browser 前置文档路径。
- 凭据路径仍指向 `~/.craft-agent/credentials.enc`，意味着当前 Stair 会读取 Craft 凭据；按“不保留用户数据”要求，这不是兼容能力，必须改为 Stair 自己的 `CONFIG_DIR`。
- `interceptor-common.ts` 运行在 SDK 子进程中；应直接依赖进程启动前已有的 `CRAFT_CONFIG_DIR`，不能增加运行时可变配置或第二套命名空间。
- Electron/Server 第二轮审计确认必须隔离：特权执行审计日志、注销时删除的 config、Workspace slug 检查、窗口状态、主日志、messaging/auto-update 专用日志和 Workspace messaging 目录。
- `apps/electron/src/main/index.ts` 已导入 `getDefaultWorkspacesDir()`，messaging 目录可以直接复用，无需新建路径 helper。
- Electron 主日志需要特殊处理：默认 Craft 必须继续使用 electron-log 的现有系统目录；仅当显式存在 `CRAFT_CONFIG_DIR` 时，将 `resolvePathFn` 指向该目录下的 `logs/main.log`。专用日志默认本来就在 `~/.craft-agent/logs`，可直接基于 `CONFIG_DIR`。
- `@craft-agent/shared/config/paths` 已被 server-core 的 `headless-start.ts` 使用，说明当前构建链已有这一依赖方向；本次不引入反向依赖。
- 现有测试惯例是在子进程启动前设置 `CRAFT_CONFIG_DIR`，因为大多数路径常量在模块加载时冻结；阶段 0 新测试应沿用这一模式，避免依赖测试执行顺序。
- 测试将分两层：行为测试证明关键导出路径和实际写盘落到临时配置目录；源码架构测试禁止生产代码绕过集中路径重新硬编码 `~/.craft-agent`，但保留已故意动态读取环境的 permissions 实现和唯一默认值定义。
- `getDocsDir()`、interceptor 的 `CONFIG_FILE/LOG_DIR`、`getDefaultWorkspacesDir()` 和 Electron 专用日志路径都可直接行为断言；credentials 等私有路径由实际写盘或架构扫描覆盖，不为测试扩大公共 API。
- `config/index.ts` 通过 `storage.ts` 间接导出集中式 `CONFIG_DIR`；server-core 可从 `@craft-agent/shared/config` 引入，避免依赖未列入 package exports 的内部子路径。
- `SecureStorageBackend.set()` 会创建 `credentials.enc`，但红测试不能让旧实现写入真实 Craft 凭据目录；因此凭据位置在修复前只用无副作用源码架构测试复现，修复后再用临时目录行为测试验证。
- electron-log 类型明确支持 `transports.file.resolvePathFn`，可在显式 `CRAFT_CONFIG_DIR` 时重定向主日志而不改默认 Craft 路径。
- 数据目录架构守卫首轮结果为 3 项通过、1 项失败；失败准确列出 13 个生产文件，覆盖凭据、拦截器、Workspace、文档同步、provider 缓存、审计、注销、窗口状态和日志路径。
- 更宽的字面量扫描发现第一轮只覆盖了 `join(homedir(), '.craft-agent')`，尚未覆盖 Renderer 模板字符串、Agent 正则和提示文本；其中新建 Workspace、工具图标、配置校验与写入提示会影响 Stair 实际能力，必须纳入阶段 0。
- Renderer 不能自行从 HOME 和产品名重建配置目录；最小且符合现有架构的做法是新增 LOCAL_ONLY `system:configDir` RPC，由主进程返回既有 `CONFIG_DIR`。
- `getPathHint()` 已经收到当前 `plansFolderPath`，可以从它推导当前 Workspace 根目录，无需再认识 `.craft-agent` 或 `.stair` 产品名。
- Agent 的 `PathProcessor` 与 `ConfigValidator` 应以 `CONFIG_DIR` 的规范化绝对前缀构建已知配置规则，不能硬编码任一产品目录名。
- 全仓剩余 `.craft-agent` 运行时字面量已经分类：Craft 安装脚本、Docker 服务端卷、开发多实例默认和 `permissions-config` 动态回退属于保留边界；其余均为示例或注释，不再参与 Stair 实际读写。
- shared 全量测试发现 `unified-network-interceptor.schema.test.ts` 仍直接读写 Craft 的真实 config；产品实现已正确，但测试夹具必须改用 `CONFIG_DIR`，否则 Stair 隔离测试验证的是错误文件并可能碰用户数据。
- 阶段 0 的“独立深链”不能只检查 `Info.plist` 和主进程 parser：Renderer 生成链接、`url-safety` 分类、`server-core` 内部导航和新窗口初始链接必须使用同一个产品 scheme，否则 Stair 会把自己的链接交给外部协议处理，或继续唤起 Craft。
- 产品间协议应保持单向归属：Craft 默认只把 `craftagents` 当内部链接，Stair 只把 `stair` 当内部链接；另一个产品的协议保持普通外部 URL，才能由操作系统唤起正确应用。
- 最终实现将 13 类主进程/服务端路径及 Renderer 可见配置路径统一接入既有 `CONFIG_DIR`，没有引入第二套配置框架，也没有改变 Project、Session 或 Workbench 规则。
- Stair 单独运行前后，Craft 数据目录 289 个文件的汇总摘要完全一致；结合静态硬编码守卫和运行日志，可确认 Stair 自有状态落入 `~/.stair`，默认 Craft 路径保持不变。
- 阶段 0 的本地成品使用 ad-hoc 签名且未公证；正式签名、公证、更新与发布仍属于阶段 9，不能因本次本地打包通过而提前标记完成。
