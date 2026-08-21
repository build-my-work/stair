# Stair 阶段 0—4 功能等价审计

> 文档性质：这是 2026-08-21 修复前的审计快照，用于保留差异发现和决策依据。文中“当前”“尚未修复”均指审计当时；最终收口状态以 `docs/stair-rebuild-plan.md` 和 `docs/code-review/2026-08-21_13-52-33/review.md` 为准。

## 结论

当前重建**不是纯粹的内部架构重写**。它同时包含三类变化：

1. 用户已经确认过的产品语义调整，例如全新 Stair 数据命名空间、默认 Project、Session 强制归属 Project。
2. 计划明确推迟到阶段 5—9 的旧能力，例如引用、Add Note、Browser、Drawnix 和布局持久化。
3. 没有得到授权、也没有在计划中明确延期的行为缺口。EPUB 窄 Panel 目录挤压正文属于这一类，本轮已经恢复；Renderer 稳定性、PDF 窄栏、Markdown 链接等仍未修复。

因此，原进度文档中“阶段 0—4 已形成可交付基线”“功能完整性未受损”之类表述不准确。更准确的状态是：**阶段 0—4 的新架构主链已经实现，但与旧 Stair 的功能等价性尚未收口。**

## 对比基线

- 旧产品：`codex/rebuild-thinking-agent@6dc6c9fb`
- 旧 Workbench 参考：`codex/stair-workbench-checkpoint@6be3dd4b`
- 干净上游：`upstream/main@50ffa143`
- 当前：`codex/stair-rebuild-v2@a6f66bd5` 加当前未提交阶段 4 改动

只比较全新 Workspace、全新 Project 和全新 Session；旧 Craft/Stair 用户数据迁移不在范围内。

## 为什么会改到功能

### 1. 选择干净上游时遗漏了旧分支上的独立缺陷修复

当前分支从 `50ffa143` 重新开始。这个上游仍使用每次模块执行都调用 `ReactDOM.createRoot` 的 Renderer 入口，也仍使用没有区分主框架、子框架和 `ERR_ABORTED` 的 `did-fail-load` 恢复逻辑。

旧 Stair 后来分别通过 `5b76e5f4` 和 `da52434a` 修过这两类问题，但这些提交不在 `upstream/main` 中。重建时只盘点了大功能，没有把这两个“小提交”真正落入验收清单。

权威计划的“旧 Stair 工作复用策略”甚至明确把“HMR 根节点复用”列为应在所属阶段重新实现的小提交，但当前 `main.tsx` 并未实现，说明这里是计划执行遗漏，不是产品主动取舍。

### 2. 阶段划分被错误地当成了功能删减许可

把引用、Browser、Drawnix、布局持久化明确放到后续阶段本身没有问题；问题是 Project Files 搜索、创建文件/目录、图片预览、Markdown 链接、保存失败时导出草稿等能力没有被任何后续阶段承接，却仍被阶段 3 的“完成”结论覆盖。

### 3. 测试主要证明新实现成立，没有证明旧行为仍在

阶段 3—4 测试重点覆盖了路径安全、原子保存、状态预算、PDF 虚拟化和 Reader locator。这些测试能证明新边界可靠，但没有覆盖：

- Vite HMR 后 Jotai/Workbench 状态是否保留；
- EPUB 子框架的失败事件是否会触发主窗口重载；
- 窄 Panel 打开目录时正文宽度是否保持；
- Markdown 文件链接和网页链接是否仍可点击；
- 旧 Project Files 的搜索、创建、图片与错误恢复入口是否还存在。

测试集全绿与功能等价不是同一件事。本次问题的直接根因是缺少“旧能力 → 新测试”的完整映射。

## 已修复的确认回归

| 能力 | 旧版行为 | 修复前当前行为 | 本轮结果 | 架构影响 |
| --- | --- | --- | --- | --- |
| EPUB 窄 Panel 目录 | Reader 宽度小于 840 px 时，目录覆盖正文并带遮罩，不改变正文布局 | 目录固定加入 `240px + 正文` Grid，挤压正文 | 已恢复 840 px 阈值、覆盖目录、遮罩关闭和进入窄模式时自动收起；增加边界测试 | 无。只改 Reader 内部布局，不恢复旧 `PanelStack` 或 sizing 模块 |

当前实现见 `ProjectFileEpubReader.tsx` 的 `ResizeObserver` 与 compact 分支，以及 `project-file-epub.ts` 的 `getEpubNavigationLayout`。旧版证据位于 `6dc6c9fb` 同名 Reader 的 `EPUB_INLINE_NAV_MIN_WIDTH_PX`、compact Grid 和 overlay nav。

## 尚未修复的意外回归与计划漏项

### P0：会造成窗口或当前工作状态丢失

| 差异 | 用户影响 | 旧版证据 | 当前证据 | 判断 |
| --- | --- | --- | --- | --- |
| HMR 不复用 React Root | 修改 Renderer 源码后，Provider/Jotai/Workbench 可能整棵重挂，已打开 Panels 消失；这解释了开发时灰屏或状态突然重置 | `6dc6c9fb:apps/electron/src/renderer/main.tsx` 将 `reactRoot` 存入 `import.meta.hot.data`；来源提交 `5b76e5f4` | `apps/electron/src/renderer/main.tsx:130` 每次直接 `ReactDOM.createRoot(...).render(...)` | 确认回归 |
| `did-fail-load` 把 EPUB 子框架失败当成主窗口失败 | EPUB iframe teardown/`ERR_ABORTED` 可能触发整个窗口重载；多次后开发模式会尝试不存在的生产 `renderer/index.html`，表现为窗口消失或只剩 Dock 图标 | 旧 `window-manager.ts` 只处理真实 main frame，忽略 `-3`，保留完整 URL，最多恢复 5 次；旧 `window-manager-renderer-lifecycle.isolated.ts` 有三组回归测试 | `apps/electron/src/main/window-manager.ts:381-394` 不读取 `isMainFrame`，不忽略 `-3`，重试时丢失 path/query/hash，第 6 次转向 `loadFile` | 确认回归 |

这两项正好对应此前真实开发验收中“Renderer 不见了”“窗口只在 Dock 中”的现象。本轮 Computer Use 再次观察到 HMR 后 Panels 被清空，以及打开 EPUB 后窗口不可用；它们不是 EPUB 样式问题。

### P1：会改变日常业务行为或安全边界

| 差异 | 用户影响 | 旧版证据 | 当前证据 | 判断 |
| --- | --- | --- | --- | --- |
| Draft RPC 缺少 Workspace 授权 | 只要知道 Session id，就可能跨当前 Workspace 读写或删除草稿；`GET_ALL` 也未过滤 | 旧 `draft-access.ts` 的 `assertDraftSessionAccess`、`filterDraftsForWorkspace`，以及 `settings.ts:213-248` 的接线 | `packages/server-core/src/handlers/rpc/settings.ts:209-225` 忽略 `_ctx`，直接操作全局草稿 | 确认安全回归 |
| 离开空 Session 后不再自动清理 | 新建但未命名、未发消息、无草稿的 Session 会永久留在列表中 | 旧 `NavigationContext.tsx:496-524` 根据所有可见 Panel 的 Session 集合统一清理 | 当前 `NavigationContext.tsx` 只有显式删除和创建失败回滚，没有离开可见集合后的清理 effect | 确认行为回归 |
| PDF 窄 Panel 目录仍挤压正文 | 和本次 EPUB 问题相同；在窄 Auxiliary 中正文继续被 240 px 目录压缩 | 旧 PDF Reader 使用 760 px 阈值、overlay、遮罩并在跳转后收起 | 当前 `ProjectFilePdfReader.tsx:525-595` 固定两列 Grid，没有 compact 状态 | 确认回归，尚未修复 |
| Markdown 链接变成无操作 | 文件内相对路径和网页链接看起来可点击，但点击不会打开任何内容 | 旧 `ProjectFilePage.tsx:780-784` 传入 `onFileClick`、`onUrlClick` | 当前 `ProjectFilePage.tsx:277-280` 只传正文；共享 `Markdown.tsx:206-225` 总会 `preventDefault`，没有回调时直接结束 | 确认回归 |

### P2：旧能力被漏掉，但不会立即破坏已有数据

| 差异 | 旧版能力 | 当前状态 | 分类 |
| --- | --- | --- | --- |
| 保存失败/冲突时“Save Draft As” | 可把未保存内容另存为本地文件，再决定是否重载磁盘版本 | 当前只提供 Retry 或确认后丢弃草稿并 Reload | 计划漏项 |
| Project Files 搜索 | 180 ms 防抖、Project 范围搜索、按扩展名过滤 | 当前树只有懒加载、刷新、打开 | 计划漏项 |
| 创建文件和目录 | 根目录/子目录右键创建、行内命名、失败就地提示 | 当前协议和 UI 都没有 `CREATE_FILE`、`CREATE_DIRECTORY` | 计划漏项；Drawnix 创建单独属于阶段 7 |
| 图片预览 | png/jpg/gif/webp/svg/bmp/ico/avif 可在 Project File Panel 中预览 | 当前分类没有 `image`，打开后显示“不支持预览” | 计划漏项 |
| 文本/代码扩展名覆盖 | 支持 cjs、less、htm、bash、fish、graphql、r、perl、astro、prisma、`.env.*`、`.nvmrc` 等 | 当前 `file-classification.ts` 集合明显更窄 | 计划漏项 |
| EPUB 选区工具条生命周期 | pointerdown、选区折叠、Escape、iframe/mount 滚动、view unload 和 resize 都会关闭工具条 | 当前只在跳转、创建/删除高亮和显式关闭时清理，滚动后可能留下失效工具条 | 确认交互回归 |
| PDF 自定义页码标签 | 调用 `pdf.getPageLabels()`，目录、页头和高亮列表显示印刷页码 | 当前只显示 1、2、3 形式的物理页码 | 计划漏项 |
| EPUB/PDF 高亮导出 | 可导出结构化 Markdown | 当前 Reader 没有 Export 入口 | 计划漏项 |
| EPUB 高亮按目录分组 | 高亮按 TOC 层级组织 | 当前是平铺列表 | 可见降级 |
| EPUB 作者、文件相对路径等辅助信息 | Reader 显示作者；PanelHeader 显示完整相对路径 | 当前省略作者，Header 用 Preview badge 替换路径 | 可见 UI 漂移 |
| 最多 8 个 Panel 的保护 | 旧 `MAX_PANEL_LAYOUT_ENTRIES = 8` 阻止无上限增长 | 当前 Workbench command 未设置容量上限 | 计划漏项，需要确认是否仍保留 8 的产品限制 |

## 计划明确延期的能力

这些能力在旧产品中存在，但当前计划明确放到阶段 5 以后。它们是当前产品能力缺口，但不是阶段 4 内某一行代码写错。

| 阶段 | 延期能力 | 当前影响 |
| --- | --- | --- |
| 5 | 文本/EPUB/PDF/聊天引用写入 Draft/Message、Reference Preview、Add Note、Add Chat/New Chat 目标 | Reader 只能在自身内部创建红色波浪划线，不能把选择内容送进聊天或 Note |
| 6 | 原生 Browser、选区引用、书签、内部/系统浏览器偏好 | 旧 Browser 产品面尚未恢复 |
| 7 | Drawnix 文档、自动保存和 Agent Tool | 旧脑图能力尚未恢复 |
| 8 | Workbench 跨重启布局、Panel 独立比例、拖拽排序、Compact 双挂载动画、最终键盘与无障碍行为 | 当前 Panel 等宽、不持久化；Compact 只挂载当前一侧，内部滚动状态可能丢失 |
| 9 | Stair 正式打包、发布与完整能力验收 | 当前开发态不等于最终发布态 |

“延期”仍然意味着当前版本功能少于旧 Stair。此前文档虽然写了阶段 5—9 未开始，但又同时写“保留所有产品能力”“可交付基线”，两个结论互相冲突。

## 用户已经确认过的语义变化

这些也不是纯重构，但在先前阶段已经明确讨论和批准。本轮不擅自撤销。

| 变化 | 旧版 | 当前 | 影响 |
| --- | --- | --- | --- |
| 用户数据 | 读取旧 Craft/Stair 数据和旧布局 | 只使用新的 `~/.stair` 命名空间，不迁移旧数据 | 用户已明确要求“不保留用户数据，只保留产品能力” |
| Workspace 默认 Project | `WorkspaceConfig` 没有必需的 `defaultProjectId` | 新 Workspace 同步创建 General Project | 新建行为改变，但只作用于新数据 |
| Session 归属 | `projectId?: string`，可未绑定或后续重新绑定 | `projectId: string` 且不可变 | 领域语义改变；当前新 Session 更确定 |
| Project 删除 | 删除后把 Session 解绑 | 默认 Project 与非空 Project 不可删 | 避免孤儿 Session，但改变旧删除行为 |
| 跨 Project Session 通信 | 没有统一强制边界 | 服务端拒绝跨 Project | 安全和领域边界收窄 |
| 符号链接 | 旧 Project File 服务允许 root 内 symlink、拒绝逃逸 | 当前一律拒绝 symlink | 更保守的安全收窄；若项目依赖 symlink，需要单独产品决定 |
| 关闭 Primary | 旧 PanelStack 删除当前位置，后一个 Panel 自然前移 | 当前 Primary 可以为空，Auxiliary 保持身份不晋升 | 符合新 Workbench 计划，但用户可见行为不同 |

## 当前仍保持或改进的能力

- 普通 Session 导航不会隐式新增 Auxiliary；已有 Panel 会被聚焦并滚入可视区。
- Project Files 已重新放回独立右侧 Sidebar，普通打开复用唯一 Preview，显式操作才增加 Auxiliary。
- Navigator 收起是用户新增需求，不会改 Workbench、Project、Session 或 URL。
- 文本自动保存、比较保存、flush/veto、BOM/换行/权限保真比旧实现边界更集中。
- EPUB/PDF 的二进制、ZIP、状态 Schema、fingerprint、原子写入和预算限制更明确。
- PDF 只渲染目标附近 5 页，属于不改变阅读语义的性能改进。

## 外部审查结论如何使用

- Kimi 独立发现并支持：`did-fail-load`、空 Session 清理、PDF 窄栏、Draft 授权、Project Files 搜索/创建/图片、Markdown 链接、Save Draft As、Reader 选区生命周期、pageLabels、导出和分组等差异。
- Claude 第一轮只看到 Reader 布局，并错误判断“功能完整性未受损”；该结论已被源码反证，不采纳。
- 随后以 safe-mode 明确指定 `claude-sonnet-4-6` 重跑。它独立确认了 HMR Root、`did-fail-load`、PDF 响应式与 pageLabels 回归；但误判空 Session 清理和 Draft Workspace 授权仍然存在。后两项与当前源码直接冲突，已驳回。
- 两个外部审查都不能替代本地证据；只有能同时指向旧版和当前实现的结论才进入上面的矩阵。

## 当前建议

先不要进入阶段 5。按影响排序，先恢复运行时稳定性和阶段 0—4 内的旧行为，再决定哪些计划漏项必须在阶段 4 收口：

1. HMR Root 复用和 `did-fail-load` 主框架过滤。
2. Draft Workspace 授权和空 Session 清理。
3. PDF overlay、Markdown 链接、Save Draft As、EPUB 选区生命周期、PDF pageLabels。
4. 由用户确认 Project Files 搜索/创建/图片/扩展名、高亮导出/分组、8 Panel 上限是否全部按旧版恢复。

以上修复都可以在现有新架构内完成；如果恢复某项必须重新引入旧 `PanelStack`、兼容迁移或多状态所有者，则触发停机线，先向用户确认。
