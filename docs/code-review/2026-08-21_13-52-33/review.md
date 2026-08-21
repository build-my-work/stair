# 代码审查报告

> **日期**: 2026-08-21 13:52:33 CST
> **变更文件**: 88 个文件（不含 `promo/`）
> **审查来源**: Claude、Kimi、Pi

---

## 摘要

本轮审查覆盖阶段 0—4 功能等价收口的全部未提交改动。三方审查共确认 7 类高置信问题，均已按现有 Craft/Stair 边界做最小修复并补回归测试；未重新引入旧 PanelStack、兼容层或新的状态所有者，也未进入阶段 5。

---

## 问题列表

> 按优先级排序；下列问题均已修复。

### 1. [高] Reader 状态读取可能与原子写入竞争

**位置**: `packages/server-core/src/project-files/epub-state.ts:383-391`、`packages/server-core/src/project-files/pdf-state.ts:403-411` | **分数**: 95/100

**问题描述**: `get()` 原先绕过 Store 的同路径锁。读取损坏状态并执行隔离时，可能与正在进行的 `apply()` 竞争，从而把刚写好的状态误判或移动。

**修复**: EPUB/PDF 的读取和写入现在共用已有的 `withLock()`，并增加“写入未完成时读取必须等待”的并发回归测试。

### 2. [高] 空 Session 删除只检查当前 Renderer 的草稿缓存

**位置**: `apps/electron/src/renderer/App.tsx:1272-1298` | **分数**: 94/100

**问题描述**: 另一个 Renderer 已持久化草稿、而当前 Renderer 本地缓存为空时，原逻辑仍可能把 Session 当作空 Session 删除。

**修复**: 删除前通过当前 RPC Workspace 调用 `getDraft()` 复核服务端草稿，再使用当前 Session 元数据和 Workbench 可见状态重新判断。读取失败时采取保守策略，不删除 Session。

### 3. [高] Session 删除后防抖草稿写入可能产生未处理拒绝

**位置**: `apps/electron/src/renderer/App.tsx:1260-1266`、`apps/electron/src/renderer/App.tsx:1613-1618` | **分数**: 92/100

**问题描述**: 新增 Workspace 授权后，已排队的 `setDraft()` 若在 Session 删除后执行会被服务端拒绝，而原调用没有处理 Promise 拒绝。

**修复**: 删除成功后清除该 Session 的待执行定时器和内存草稿，同时为防抖持久化补充失败处理，避免竞态形成未处理拒绝。

### 4. [中] EPUB 窄栏导航跳转后没有自动收起

**位置**: `apps/electron/src/renderer/components/project-files/ProjectFileEpubReader.tsx:575-605` | **分数**: 91/100

**问题描述**: 在 overlay 模式从目录或高亮跳转后，导航仍覆盖正文，与旧 Stair 行为不一致。

**修复**: 目录跳转和高亮跳转完成后仅在 `compactNavigation` 下关闭导航；宽栏 inline 行为保持不变。

### 5. [中] 纯锚点或纯查询 Markdown 链接会被解析成目录

**位置**: `apps/electron/src/renderer/pages/project-file-markdown-links.ts:32-35` | **分数**: 90/100

**问题描述**: `#section` 和 `?mode=print` 去掉锚点/查询后路径为空，原实现会把当前文件的父目录作为 Project File 打开。

**修复**: 缺少实际相对文件路径时归入现有 `blocked` 分支，不新增链接类型或页内锚点能力。

### 6. [中] 点号开头的文件名被误判为二进制 Reader

**位置**: `packages/shared/src/project-files/file-classification.ts:20-29` | **分数**: 88/100

**问题描述**: `.pdf`、`.png`、`.epub` 被当作扩展名文件，但服务端按 Node `extname()` 视为无扩展名，导致前后端分类不一致。

**修复**: 文件名首字符的点不再视为扩展名分隔符；同时显式保留旧 Stair 支持的 `.env`、`.gitignore`、`.gitattributes`、`.editorconfig`、`.npmrc` 和 `.nvmrc` 文本文件。

### 7. [中] Project Files 旧本地化文案被英文覆盖

**位置**: `packages/shared/src/i18n/locales/de.json:476-486` 等 5 个非英文 locale | **分数**: 87/100

**问题描述**: 恢复搜索和创建能力时，8 个已有德语、西班牙语、匈牙利语、日语和波兰语文案被英文值覆盖。

**修复**: 恢复旧版本地化文案，并增加非英文 locale 不得退回英文值的回归测试。

## 真实验收补充

### [高] HMR 复用 React Root 后仍重复渲染 Provider 树

**位置**: `apps/electron/src/renderer/main.tsx`、`apps/electron/src/renderer/renderer-root.ts`

**问题描述**: 三方静态审查后，真实 Electron 首轮 HMR 发现入口模块虽然复用了 React Root，但每次重执行仍会调用 `root.render()`；同时入口内的 React 组件最初未导出，Vite React Refresh 会把模块判为不兼容边界。结果是 Panels 尚在，但 Jotai Provider/Workbench 下的草稿和 Project Files 筛选会被重置。

**修复**: 导出入口内的两个 React 组件，使其成为稳定的 React Refresh 边界；根据 `import.meta.hot.data` 只在首次执行时挂载 Provider 树，后续更新交给 React Refresh。回归测试覆盖 Root 复用、边界导出和首次渲染约束。真实 Electron 再次触发 HMR 后，两个 Panels、当前焦点、内存草稿和文件筛选均保持不变，Vite 只报告正常 `hmr update`，没有 `hmr invalidate`。

**增量复核**: Claude 与 Pi 未发现新问题。Kimi 指出原先的源码字符串断言不能防止 `shouldRender` 计算顺序被误改；已采纳，让 `resolveRendererRoot()` 在写入 hot data 前同时返回 `reactRoot` 与 `shouldRender`，并以行为测试断言首次执行为 `true`、HMR 复用为 `false`。关于 HMR 重跑幂等 i18n/Sentry 初始化的低置信建议未采纳：真实验收没有重复上报或状态异常证据，扩大一次性初始化边界超出本轮必要改动。

---

## 未采纳项

- “空 Session 自动清理改变 Craft 默认行为”：未采纳。`upstream/main` 已有空 Session 自动清理，本轮只恢复多 Panel 下的正确判定。
- “flagged/archived 空 Session 一律保留”：未采纳。用户确认的保留条件和旧实现均不包含这两个状态，添加该规则会改变产品行为。
- “Project Files 搜索增加遍历上限和截断协议”：未采纳。旧 Stair 使用相同搜索边界，这不是本轮架构重写造成的回归；新增协议属于范围扩张。
- “Save Draft As 始终显示”：未采纳。旧 Stair 和本轮需求都限定为保存失败或冲突后出现。
- “Renderer entry 必须再显式调用 `import.meta.hot.accept()`”：未采纳。当前 Vite React 插件会为包含 React Refresh 注册的入口自动注入接受逻辑，重复添加没有必要；真实 Electron HMR 已确认正常接受更新且没有失效回退。

---

## 当前验证

- 相关测试：28 个文件、180 项通过，共 458 个断言。
- 完整源码测试：Shared 3023 项通过、12 项跳过；server-core 279 项通过；Renderer 583 项通过，均为 0 项失败。
- WindowManager 独立生命周期测试：3 项通过。
- 既有 Project 文档控制器与注册表测试：6 项通过。
- 三层类型检查：全部通过。
- 相关 Electron/Shared lint：0 error；Electron 现有大文件仍有 23 条 warning。
- i18n parity 与排序检查：通过。
- `git diff --check`：通过。
- `lint:i18n:coverage` 与 `lint:i18n:strings`：仓库脚本引用的文件不存在，属于基线工具缺口。
- Electron main、preload、Renderer、resources 与 assets 完整构建：通过；仅保留既有 tsconfig 和大 chunk 警告。
- 真实 Electron：HMR 状态保留、空 Session 清理、Markdown 相对链接、EPUB/PDF 打开关闭及 PDF 窄栏 overlay 均通过；临时验收数据已清理。

---

*由 Codex 汇总 Claude、Kimi、Pi 审查结果*
