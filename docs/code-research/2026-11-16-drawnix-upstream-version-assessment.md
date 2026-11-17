# Drawnix 旧基线与上游新版的独立评估

核验日期：2026-11-16，Asia/Singapore。本文为只读源码与发布状态研究；没有升级 Stair 或修改 Drawnix 产品代码。上游状态均重新查询，不能将 npm 包、GitHub Release、develop 源码和本地 fork 当作同一版本。

## 判断

最初选择 `v0.4.0-2` 有明确的工程理由：当时可直接安装的官方组件包停留在这一代，先复用发布包能避免同时承担上游源码的打包和适配工作。**这个理由足以解释首次接入，不能自动证明长期停留在 2025 年基线最优。**

现在 Stair 已经维护自己的 `@ttsworld/drawnix` 包和备注扩展，“不想维护源码包”这个原始收益已经减弱。但“直接替换成上游最新版”同样不可行：上游没有我们的备注和 Agent 编辑接口，合并实测存在实质冲突。较合理的方向是保留现有包边界，在隔离分支上更新其上游基线并验证；不能仅凭日期旧、版本号大或 React 主版本不同作决定。

## 1. 当前到底有哪些版本

| 对象 | 本次核实的状态 | 含义 |
| --- | --- | --- |
| 官方 npm `@drawnix/drawnix` | `latest=0.4.0-0`，`next=0.4.0-2`；最后修改 2025-12-05 | 没有一个可直接改版本号安装的官方 2026 新版组件包 |
| 官方 npm react-board / react-text | 同样停在 `0.4.0-0` / `0.4.0-2` | 更新 Drawnix 源码还要处理配套 React 包 |
| 官方 GitHub Release | `v0.4.0`，2026-04-19 发布 | GitHub 已发布新版应用，不能据此说 npm 组件也更新了 |
| 官方 `develop` | `b138ff867943ddff6c4c79560e10ab6ee3b5600e`，2026-09-07 | 比上述 Release 更新的开发源码 |
| 旧基线 `v0.4.0-2` | 解引用后 `1d614bb60fc99132e0cd55a608a14fe786f4ee9b`，2025-12-05 | Stair fork 的起点；不要把 annotated tag 对象 SHA 当成源码提交 SHA |
| Stair 实际依赖 | `@ttsworld/drawnix@0.4.0-notes.7` 的固定 GitHub Release 归档 | 旧基线上的维护版本，已经不是原封不动的官方旧包 |
| 相邻 Drawnix 工作区 | `feat/anki-card-widget`，当前 `19f070c` | 另有未接入 Stair 的 Anki 扩展，不能算作 Stair 当前已有功能 |
| 底层 Plait | Stair 精确固定 `0.92.3`；官方 npm 最新 `0.94.1`，2026-09-23 | Drawnix 和 Plait 是两个升级维度，不能只换其中一个而不验证配套 |

来源：[npm Drawnix 元数据](https://registry.npmjs.org/@drawnix%2fdrawnix)、[npm react-board 元数据](https://registry.npmjs.org/@plait-board%2freact-board)、[npm react-text 元数据](https://registry.npmjs.org/@plait-board%2freact-text)、[官方 Release](https://github.com/plait-board/drawnix/releases/tag/v0.4.0)、[develop 固定提交](https://github.com/plait-board/drawnix/commit/b138ff867943ddff6c4c79560e10ab6ee3b5600e)、[npm Plait core 元数据](https://registry.npmjs.org/@plait%2fcore)、[Stair package.json](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/package.json:50)。以上 npm 状态通过本次 `npm view` 查询，不依赖以前 session 的结论。

上游名为 `publish` 的 GitHub 工作流发布的是容器镜像，并不执行 npm 发布；另有 `scripts/publish.js` 才负责手工发布三个组件库。这能解释为什么应用源码/Release 前进而 npm 停滞，但没有证据确认维护者停止 npm 发布的主观原因。[容器工作流](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/.github/workflows/publish.yml#L19)、[npm 发布脚本](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/scripts/publish.js#L5)。

## 2. 哪些继续用旧版的理由成立

### 发布包和已验证行为仍有价值

Stair 当前消费的是一个固定归档，并通过 `onEditorReady` 获取 `serialize/readMindmap/updateMindmap`。宿主掌握落盘、防覆盖、保存失败、关闭前 flush 与 Agent 并发序号。这个边界本身有价值，应保留，而不是为了升级版本号重新把 Plait 操作散到宿主。[实际组件调用](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/components/project-files/ProjectFileDrawnixCanvas.tsx:124)、[保存和 Agent 更新](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/components/project-files/drawnix-document-controller.ts:98)。

### React 19 不是已证实的硬性障碍

最新源码根项目声明 React 19.2，但库构建把 `react/react-dom/react-dom/client/react/jsx-runtime` 作为 external。通常的嵌入参数仍保留 `value`、`viewport`、`theme`、各类 `onChange` 和 `afterInit`。本次源码检查没有发现必须依靠 React 19 专用 API 才能实现这些基本交互的证据。[依赖声明](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/package.json#L17)、[external 配置](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/vite.config.ts#L44)、[组件接口](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/src/drawnix.tsx#L50)。

这不等于已经证明最新版在 React 18 下全部正常：仍要验证 Slate 编辑、中文输入、焦点、独立 createRoot、撤销重做以及卸载。7 月历史的 React 18 构建成功，也不能代替对 9 月最新提交的运行验收。

### 工具链差异是真实成本，但不强迫 Stair 一起升级

最新源码用 Nx 22、Vite 8、TypeScript 6，旧 fork 有自己的构建入口。更新 fork 可能需要同步构建配置；但这些是包的构建依赖，发布后消费方并不必然要把整个 Stair 同步升级到 Vite 8 或 React 19。[上游工具链](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/package.json#L43)。

## 3. 新版确实能带来什么

以 `1d614bb..b138ff8` 实际 git 对比为准，共 48 个提交、179 个变动文件。大量差异来自锁文件和格式化，不能将这些数字直接解释为功能规模或迁移工期。[固定比较范围](https://github.com/plait-board/drawnix/compare/1d614bb60fc99132e0cd55a608a14fe786f4ee9b...b138ff867943ddff6c4c79560e10ab6ee3b5600e)。

| 旧基线之后的真实变化 | 对 Stair 的意义 |
| --- | --- |
| 主题随 JSON 序列化、外部替换文档时应用主题 | 对原生文件往返有价值；但 Stair fork 已自行处理主题，不能把上游收益全部算成当前缺失 |
| 双击创建文字后的焦点时序修复 | 可改善画布文字编辑；需确认我们的 fork 是否已覆盖同一触发路径 |
| 自定义文字字号及对应渲染样式 | 直接的画布编辑能力增量，而非单纯工具链更新 |
| SVG/PNG 复制、透明背景偏好、更多选项、语言及工具状态持久化接口 | 有实际用户价值；宿主是否启用和保存这些偏好仍需设计 |
| 平移、多选框与 freehand 选择刷新、工具指针同步 | 对混合脑图/绘图画布和交互一致性有价值 |
| Vitest 与共享测试 Board fixture | 让 fork 更接近上游测试方式，有助后续维护，不是直接的用户功能 |

对应源码：[主题保存与加载](https://github.com/plait-board/drawnix/commit/4be66dc)、[外部文档替换应用主题](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/react-board/src/wrapper.tsx#L198)、[文字焦点修复](https://github.com/plait-board/drawnix/commit/a046d15)、[字号支持](https://github.com/plait-board/drawnix/commit/55d8fb1bbf8f60f26cbf149a8d0db566056c266b)、[复制 SVG/PNG](https://github.com/plait-board/drawnix/commit/e6993b0)、[偏好接口](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/src/drawnix.tsx#L54)、[选择刷新](https://github.com/plait-board/drawnix/commit/d010277)、[测试 fixture](https://github.com/plait-board/drawnix/commit/b138ff867943ddff6c4c79560e10ab6ee3b5600e)。

必须校正一个容易夸大的点：GitHub `v0.4.0` Release 汇总的是从 `v0.3.0` 开始的变化，包含 2025 年旧基线之前已经有的修复。例如 Release 列出的脑图图片缩放修复不能直接算成 `v0.4.0-2` 之后新增收益。更不能因为看到“脑图文字无法完整显示”旧 changelog 就推断它修复了这次 Stair 的 CSS 继承/换行问题。

### Plait 升级的真实收益和边界

`0.92.3` 后，官方 core changelog 明确记录了：平移时刷新多选框、导出保留文字颜色、支持把剪贴板 SVG 作为图片粘贴、SVG 背景色、避免当前工具吞掉 Space 平移手势。mind changelog 的显式增量较少，主要有命中测试传入 `hitPoint`、只读时隐藏添加图标。`0.94.0` 还增加了供插件测试使用的框架无关 Board 事件观察器。[core changelog](https://github.com/worktile/plait/blob/e0d76b0942c5c1e2f62af6ca8098ea7e86bdc841/packages/core/CHANGELOG.md#L3)、[mind changelog](https://github.com/worktile/plait/blob/e0d76b0942c5c1e2f62af6ca8098ea7e86bdc841/packages/mind/CHANGELOG.md#L3)。

因此可以说新版包含值得验证的交互、导出和维护改进；不能说仅升 Plait 就会自动修复所有脑图布局、备注时序或文档安全问题。部分 changelog 条目为空，不能把空条目当成没有变更，也不能凭空填充收益。

升级也包含接口变化：上游曾为 `@plait/core@0.93.1` 改动补修 freehand 的 `getOneHitElement` 调用，新增 `point` 参数。这是实在的破坏性变化证据，说明旧 Drawnix 代码搭配新 Plait 需要检查，而不是仅改锁文件。[兼容修复提交](https://github.com/plait-board/drawnix/commit/e28ba80864397fa9934b2b18d4f16a6af939cf38)。

## 4. “新版包边界已经完善”不成立

上游在 2026-02-10 为 **Drawnix 包**增加了公开 `./index.css` export，确实解决了其中一项解析问题。[提交](https://github.com/plait-board/drawnix/commit/59f8356)、[当前 manifest](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/package.json#L7)。

但最新版 `react-board` 和 `react-text` 的 manifest 仍只导出 JS/类型入口，没有公开 CSS 子路径。Drawnix manifest 的 dependencies 也仍没有列全其 external 配置中的 Plait、react-board、Slate 等依赖；其样式入口没有把 react-board/react-text 的全部基础 CSS 一起引入。更新到 develop 不能据此假定消费方再也不需要处理配套样式与依赖。[react-board manifest](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/react-board/package.json#L7)、[react-text manifest](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/react-text/package.json#L7)、[Drawnix dependencies 与 external](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/vite.config.ts#L46)、[Drawnix 样式入口](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/src/styles/index.scss#L1)。

另外根项目依赖 Plait `^0.94.0`，而 react-board/react-text 子包仍声明 `^0.93.1`；在 0.x 的 caret 语义下，这两个范围不会自动对齐到同一个 minor。发布自己的包时应明确测试并固定配套依赖，不把上游 workspace 成功构建等同于一个干净消费项目成功安装。[根依赖](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/package.json#L21)、[子包依赖](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/react-board/package.json#L14)。

更直接的迁移问题是三个组件库的打包耦合：上游新的 react-board/react-text 源码声明版本 `0.4.0`，但 npm 对应新包没有发布；Drawnix 库又 external 了 `@plait-board/react-board`。如果只更新 fork 中的 Drawnix 源码和 Plait，然后仍让消费方装 `@plait-board/react-board@0.4.0-2` / react-text 旧包，新的 Wrapper 主题回载、文字聚焦或字号渲染改动并不会自动进入 Stair。迁移必须让自己的发布物中 Drawnix、Board、Text 的实际代码与 Plait 配套，具体是随包构建并内置内部 workspace 组件还是采用其他已有打包方式，要在实现时用干净消费项目验证，不能凭空再增加一组公开包。这个问题比笼统的“React 19 不兼容”更实在；也不要求升级整个 Stair 的构建链。[Drawnix external](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/vite.config.ts#L51)、[上游 Board 包](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/react-board/package.json#L3)、[上游 Text 包](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/react-text/package.json#L3)、[Stair 仍安装的配套包](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/package.json:51)。

## 5. 为什么现在不能直接换包

上游最新版保留普通受控画布接口，但没有 fork 的 `onEditorReady`、`./editor` 入口、`updateMindmap` 原子批次和节点备注 UI。Stair 的实际调用依赖这些接口。直接把 `@ttsworld/drawnix` 改成上游包会失去现有行为，至少需要移植扩展或重做适配。[上游 Props](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/src/drawnix.tsx#L50)、[上游 exports](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/package.json#L7)、[Stair 调用](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/components/project-files/ProjectFileDrawnixCanvas.tsx:11)。

主代理本轮提供的隔离 `git merge-tree` 实测：

- 已发布 `notes.7` 提交 `046fe6f586c3ba20f8beb17481a21063e8d11e0f` 与最新上游合并，15 个冲突文件；双方共同修改 23 个文件。
- 当前 Anki 分支 `19f070cd64a5924a70855aab6ab84a2c4bd5e472` 与最新上游合并，17 个冲突文件；双方共同修改 25 个文件。
- 冲突包括 `drawnix.tsx`、context hooks、JSON 数据、样式、工具栏及依赖文件，不只是文档或锁文件。
- 此操作不修改已有工作树；冲突数量不能直接换算为天数，也不能证明某一个合并方案正确。

实测日志：[merge-summary.json](/var/folders/pw/87rv66m91h9g710rc68z0c740000gn/T/stair-drawnix-assessment-20261116-d54sqz3m/merge-summary.json)、[notes.7 日志](/var/folders/pw/87rv66m91h9g710rc68z0c740000gn/T/stair-drawnix-assessment-20261116-d54sqz3m/notes7-merge-tree.log)、[Anki 日志](/var/folders/pw/87rv66m91h9g710rc68z0c740000gn/T/stair-drawnix-assessment-20261116-d54sqz3m/anki-merge-tree.log)。

新上游还把内部 `appState.pointer` 改成 `appState.toolState.pointer`，并默认隐藏画布原生滚动条。备注或 Anki 插件若读取旧 context、计算浮层或依赖工具状态，要核对；这类变化不能仅靠宿主 TypeScript 通过判断运行时一致。[新状态结构](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/src/hooks/use-drawnix.tsx)、[默认选项](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/packages/drawnix/src/drawnix.tsx#L105)。

## 6. 该如何决定

| 选择 | 判断 |
| --- | --- |
| 永久维持旧基线，只修遇到的问题 | 短期发布风险较低，但会继续累积上游差距；不宜只以“已有 npm 包”作为长期理由 |
| 直接换成官方最新源码/包，放弃 fork | 与目前已发布的备注、Agent 行为不等价，不建议 |
| 保持独立包接口，在 fork 中更新上游基线 | 最符合现有架构；值得做隔离迁移验证，再决定是否发布接入 |
| 只提升 Plait 版本 | 变动看似小，但已经有接口变更实证，仍需同样检查图形插件、布局和编辑历史 |
| 只回移个别上游补丁 | 明确的单点故障可以采用；若要长期得到字号、工具状态、偏好、导出等多项新能力，持续回移会形成另一套维护负担 |

对“现在就应更新整个上游基线”的独立保留意见：本次没有找到当前脑图核心功能因为 `0.92.3` 而不可用的证据，也没有证明新基线能解决现有备注、Anki 或文字越界问题。上游实际新增收益以字号、导出、工具交互、偏好和测试设施为主。若近期只交付备注/Anki，完整迁移不一定比保持已验证版本、只回移明确修复更划算；应由具体要用的新能力或已复现缺陷触发，而不是“2025 看起来老”。反过来，如果团队已经决定持续扩展绘图交互，继续叠加自定义功能后再追上游会增加共同修改面，宜尽早在独立变更中解决基线问题。这里是基于源码和冲突范围的判断，没有可据以给出精确 ROI 或工期的运行数据。

升级验收应落在已有行为上：原生文件含备注/主题/视口往返、关闭重开、中文输入与焦点、复制剪切粘贴、连续输入及 Agent 操作的撤销隔离、Agent 目标节点发生移动/删除时的迟到输入、原子批次失败回滚、保存失败/冲突保护、当前及旧脑图根节点的文字布局。Anki 分支如同时迁移，再单独覆盖卡片 ID、媒体和跨文档复制；不能将尚未发布的扩展测试当作 Stair 已有验收。

## 验证边界

本研究执行了官方 refs、Release API、npm 元数据重新查询，读取并比较固定提交源码，核对了当前 Stair 调用，并复核主代理给出的 merge-tree 结果。没有完成解决冲突后的新 fork 构建、React 18 实际编辑测试、Electron/WebUI 生产构建、完整原生桌面 E2E，因此不宣称“升级已经可用”或给出未经验证的准确工期。是否存在安全漏洞、性能回退或性能收益也没有在本轮实测，不能凭旧日期推断。
