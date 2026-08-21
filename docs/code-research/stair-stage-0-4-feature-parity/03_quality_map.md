# Stair 阶段 0—4 质量与修复地图

> 文档性质：这是 2026-08-21 修复前制定的质量与执行地图。批次 A—C 后续已经完成，Panel 数量策略经用户确认与 Craft 保持一致；最终结果以 `docs/stair-rebuild-plan.md` 和 `docs/code-review/2026-08-21_13-52-33/review.md` 为准。

## 质量判断

当前代码的主要问题不是“新架构不可用”，而是**验证目标偏了**：大量测试验证了新实现的内部正确性，却没有把旧版用户行为逐项锁住。因此同一阶段可以同时出现“550 个 Renderer 测试通过”和“窄 Panel 目录挤压正文”。

## 已有覆盖与缺口

| 领域 | 已有强覆盖 | 关键缺口 |
| --- | --- | --- |
| Workspace/Project/Session | 新建、必需 projectId、跨 Project 拒绝、删除约束 | 这些是新语义测试，不证明与旧 Stair 等价；空 Session 离开清理未覆盖 |
| Workbench | Primary/Auxiliary 命令、Preview 复用、焦点 reveal、flush veto | HMR Provider 保持、8 Panel 上限、跨重启、比例、排序、Compact 保持状态未覆盖 |
| Project Files 服务端 | 路径穿越、symlink 拒绝、稳定读、比较保存、权限/换行保真 | 搜索、创建、图片读取、完整扩展名矩阵和 Draft Workspace 授权缺失 |
| 文本页面 | 编辑、dirty、自动保存、冲突 Reload | Markdown 链接、Save Draft As、相对路径展示缺失 |
| EPUB | ZIP 防护、continuous rendition、locator、状态、划线 | 先前没有窄栏布局测试；选区工具条全生命周期、高亮分组/导出缺失 |
| PDF | 虚拟页布局、进度、locator、状态、划线 | 窄栏布局、pageLabels、导出缺失 |
| Electron Window | 上游基础创建/恢复 | 旧 main-frame/ERR_ABORTED/HMR 回归测试未移植 |

## 本轮 TDD 证据

EPUB 修复遵循先失败、再最小实现：

1. 在 `project-file-epub.test.ts` 增加 839/840/1200 px 布局边界测试。
2. 首次运行因 `getEpubNavigationLayout` 不存在而失败。
3. 增加纯布局函数和 Reader 内 `ResizeObserver` 接线。
4. 同一测试文件重跑为 21 项通过、0 项失败。

测试冻结了旧版的 840 px 边界。随后在当前 `os` Project 的真实 Electron 开发窗口中打开实际 EPUB：窄 Auxiliary 内目录以遮罩层覆盖，Project Files 仍固定在右侧，正文与 Panel 宽度没有因目录加入 Grid 而缩小；测试后恢复为目录关闭状态。该场景通过不代表 WindowManager/HMR 两项独立回归已经解决。

## 建议的最小修复批次

### 批次 A：先恢复运行时稳定性

成功条件：

- HMR 重新执行 Renderer entry 时复用同一个 React Root，当前 Jotai/Workbench 不被整棵重置。
- 子框架失败和 Chromium `ERR_ABORTED (-3)` 不触发 BrowserWindow 恢复。
- 真实主框架失败只重试最多 5 次，并保留完整 pathname/query/hash。
- 开发模式耗尽重试后不加载不存在的生产文件。

建议直接移植行为与测试，不移植旧 Browser/PanelStack 依赖。这个批次不改变新架构。

### 批次 B：恢复阶段 0—4 内的确定行为

成功条件：

- Draft GET/SET/DELETE/GET_ALL 按当前 RPC Workspace 授权。
- 空、无草稿、未处理中的 Session 在离开全部可见 Panel 后自动删除；有草稿/名字/消息/处理中的 Session 保留。
- PDF 小于 760 px 时目录覆盖正文。
- Markdown 文件路径调用当前 Project File open command；网页链接遵循当前产品链接策略。
- 保存冲突/失败时可将内存草稿另存，不强迫用户丢弃。
- EPUB 选区工具条在 pointerdown、折叠、Escape、滚动、unload、resize 后关闭。
- PDF 使用文档 page labels。

这些都能在现有模块边界内恢复，不需要调整 Craft 原有架构。

### 批次 C：需要用户确认的旧能力清单

- Project Files 搜索。
- 创建普通文件和目录。
- 图片预览与旧扩展名集合。
- EPUB/PDF 高亮导出 Markdown。
- EPUB 高亮按目录分组、作者与相对路径辅助信息。
- 8 Panel 上限。

这些能力不应悄悄消失，但恢复顺序和视觉细节存在产品取舍。用户确认保留项后，再逐项补失败测试和最小实现。

### 批次 D：继续保持延期

阶段 5—9 不在本轮启动：References/Add Note、Browser、Drawnix、布局持久化/比例/排序/Compact 完善、正式发布。

## 回归矩阵

| 修复项 | 最小自动化 | 真实验收 |
| --- | --- | --- |
| HMR Root | mock `createRoot`，重复入口执行仍只创建一次 Root | 打开多个 Panel，修改 Renderer 源码，Panel 集合和焦点不变 |
| `did-fail-load` | 恢复旧三组 WindowManager lifecycle tests | 打开 EPUB、切换/关闭目录，不出现窗口重载或消失 |
| Draft 授权 | 两个 Workspace/Session 的 GET/SET/DELETE/GET_ALL | 当前 Workspace 只看到自己的 Draft |
| 空 Session | 空、有草稿、有消息、processing 四种状态 | 新建空 Session 后离开会消失，其他三种保留 |
| PDF overlay | 759/760 px 边界测试 | 窄 Auxiliary 中打开目录，正文宽度不变 |
| Markdown 链接 | file/url/blocked 三类点击 | 相对文件打开 Preview，网页按偏好打开 |
| Save Draft As | 保存冲突/失败时仍导出内存文本 | 强制外部修改后可另存并继续选择 |
| EPUB 选区生命周期 | iframe document/window 事件清理测试 | 选中文本后滚动、Esc、点击正文，工具条立即消失 |
| pageLabels | 罗马数字/自定义标签 fixture | 页头、目录和高亮列表一致显示 |

## 完成判定

只有同时满足以下条件，才能重新把阶段 0—4 标为“功能等价完成”：

1. 批次 A、B 全部转绿并完成真实 Electron 验收。
2. 批次 C 每一项都有“恢复”或“用户明确放弃”的记录。
3. 阶段 5—9 继续明确标为未开始，不再与“全部产品能力已保留”同时出现。
4. 计划文档、测试结果和真实 UI 证据三者一致。
