# EPUB Project File Viewer V2 实现稿

## 0. 文档状态

- 状态：已完成实现与验证。
- 范围：Project Files、Project File Panel、EPUB 阅读、阅读状态、划线、Markdown 导出和 Add Chat。
- 产品前提：这是新产品，不实现旧 URL、旧 `workingFile` 命名、旧状态或旧引用格式的兼容读取。
- 实施方式：按本文七个阶段依次交付；每阶段保持应用可运行并独立验证。
- 是否提交：由当时工作树状态和用户授权决定，不作为阶段完成条件。

当前工作区已有未提交的 Project、Right Sidebar 和文件 Panel 改动。每阶段开始前先检查 `git status` 和相关 diff，只修改本阶段需要的代码，不覆盖无关用户改动，不整分支 cherry-pick `codex/socratopia-learning`。

“24 pass”只作为改动前基线，不能作为任何阶段的完成证据。每阶段必须增加并运行对应测试。

---

## 1. 产品决策

### 1.1 统一命名为 Project File

新实现统一使用：

- `ProjectFilePage`
- `ProjectFileKind`
- `ProjectFileBinaryResponse`
- `PanelContentRoute.kind = 'projectFile'`
- `openOrReuseProjectFilePanelAtom`
- `project-file-route.ts`

不得新增或保留新的 `WorkingFile*`、`workingFile` 命名。当前同职责文件在阶段 1 直接重命名或删除。

### 1.2 EPUB 是 Project File Viewer

```text
Project File Panel
└── ProjectFilePage
    ├── EpubReader
    ├── PDF Viewer
    ├── Image Viewer
    ├── Markdown Viewer
    ├── Code/Text Viewer
    └── Unknown File State
```

EPUB 不是独立 Panel 类型，也不是应用级 Navigation 页面。不得添加 `panelType: 'epub'`。

### 1.3 阶段 3 就能阅读

基础 EPUB 阅读在阶段 3 完成，不等待：

- Panel URL 恢复；
- 阅读位置和划线持久化；
- Markdown 导出；
- Add Chat。

阶段 1 到阶段 3 暂停 PanelStack URL 持久化。Project File/EPUB 在当前运行周期可正常使用；阶段 4 再引入唯一的 `PanelLayoutV1`。

### 1.4 Browser 完全排除

不得引入：

- Browser 页面、Browser View、Browser Pane；
- `WebSelectionReference`；
- Browser 选区或引用路由；
- Browser 历史、状态和工具。

### 1.5 AnnotationV1 不承担 EPUB 引用

`AnnotationV1.target` 指向 Session/Message。EPUB 引用的资源身份是：

```text
projectId + relativePath + sourceFingerprint + EPUB CFI
```

阶段 7 新增 `MessageReference`/`ProjectFileReferenceV1`。不得把 EPUB 引用放进 `AnnotationV1.meta`。

---

## 2. 总体架构

```text
AppShell
├── PanelStack
│   └── PanelSlot
│       └── PanelContentRouter
│           ├── MainContentPanel
│           └── ProjectFilePage
│               ├── EpubReader
│               └── Existing File Viewers
└── Fixed Right Sidebar
    └── Project Files Tree

Server
├── Project-scoped file resolver
├── Project File read RPC
├── EPUB archive validation
├── EPUB state store
└── Session/Message reference validation
```

职责：

- `PanelSlot`：尺寸、比例、焦点、Header 和关闭入口。
- `PanelContentRouter`：只根据 `PanelContentRoute` 选择页面。
- `MainContentPanel`：普通 `ViewRoute`。
- `ProjectFilePage`：文件加载、错误状态、Header 和 Viewer 分发。
- `EpubReader`：EPUB 渲染、TOC、定位、选区和视觉划线。
- Server：Project 授权、路径安全、读取、内容指纹、状态写入和引用校验。
- Fixed Right Sidebar：目录树、搜索和打开文件；不进入 PanelStack 比例计算。

`PanelSlot` 不得判断文件后缀、文件页面或 EPUB。

---

## 3. 全局约束

### 3.1 Project File 身份

```ts
interface ProjectFileIdentity {
  projectId: string
  relativePath: string
}
```

要求：

- `relativePath` 是 `/` 分隔的 canonical POSIX 相对路径。
- 禁止绝对路径、空路径、`.`、`..`、NUL 和空 segment。
- Renderer 不向 Project File RPC 传绝对路径。
- Server 根据 RPC context 的 workspace 校验 Project 归属。
- route、state、reference 统一使用 `relativePath`，不得混用 `path`、`sourcePath`。
- Right Sidebar 可以继续只读展示 Project working directory 的完整根路径；根路径是 Project metadata，不是文件身份或读取参数。

### 3.2 内容指纹

```ts
type SourceFingerprint = `sha256:${string}`
```

必须对返回给 Renderer 的实际 Buffer 计算 SHA-256。路径、size、mtime 只能用于缓存，不能作为持久化指纹。
该基础类型在阶段 2 放入 `packages/core`，供 protocol、state 和 message
reference 共用；`packages/core` 不反向依赖 `packages/shared`。

### 3.3 EPUB 内容是不可信数据

书名、TOC、XHTML、quote、context 和 CFI 都是不可信内容：

- 不作为可信 system instruction；
- 不执行 EPUB 脚本；
- 不允许 EPUB 发起外部网络请求；
- 不将未经转义的内容注入应用 HTML；
- 进入模型前受长度限制并标记为引用数据。

### 3.4 Panel 与 Session 生命周期

- Session 是持久数据，Panel 是可关闭视图。
- 关闭 Panel 不删除 Session。
- Project File owner 是物理 Panel 实例关系，不是 route 关系。
- owner 关闭后 Project File Panel 可以保留为 orphan，并清除 `ownerPanelId`。
- Add Chat 目标始终是普通 `sessionId`，不新增 Side Chat 实体。

---

## 4. 阶段 1：PanelContentRouter + ProjectFilePage

### 4.1 目标

拆开 Panel 布局和内容路由，保留现有 PDF、Image、Markdown、Code/Text 预览。

### 4.2 内存路由

```ts
type PanelContentRoute =
  | {
      kind: 'navigation'
      viewRoute: ViewRoute
    }
  | {
      kind: 'projectFile'
      projectId: string
      relativePath: string
      contextRoute: ViewRoute
    }

interface PanelStackEntry {
  id: string
  route: PanelContentRoute
  ownerPanelId?: string
  proportion: number
}
```

`contextRoute` 只用于 Project 上下文和 Compact 回退，不能用来判断物理 owner。

### 4.3 PanelContentRouter

```tsx
function PanelContentRouter({ entry }: { entry: PanelStackEntry }) {
  switch (entry.route.kind) {
    case 'navigation':
      return <MainContentPanel route={entry.route.viewRoute} />
    case 'projectFile':
      return <ProjectFilePage route={entry.route} panelId={entry.id} />
  }
}
```

`PanelSlot` 只渲染 Router，不解析 query 或文件类型。

### 4.4 ProjectFilePage

```ts
type ProjectFileKind =
  | 'epub'
  | 'pdf'
  | 'image'
  | 'markdown'
  | 'code'
  | 'json'
  | 'text'
  | 'unknown'
```

`ProjectFileKind` 是 Renderer 内的 Project File Viewer 分类，不能扩展通用 `FilePreviewType`，也不能让 `LinkInterceptor` 接管 EPUB。

页面职责：

- 接受 `projectId + relativePath`。
- 显示 loading/error/retry/Header。
- 分发到现有 Viewer 或 `EpubReader`。
- 文件身份变化时完整卸载旧 Viewer。

阶段 1 只原样调用当前读取实现；不新增 adapter、双读分支或旧格式判断。阶段 2 在原调用点直接替换为 Project-scoped RPC。

### 4.5 创建、复用和关闭

```ts
interface OpenOrReuseProjectFilePanelInput {
  ownerPanelId?: string
  projectId: string
  relativePath: string
  contextRoute: ViewRoute
}
```

行为：

- owner 必须是 navigation Panel。
- 同一物理 owner 只保留一个 Project File Panel。
- 连续打开文件时原位更新 route，保留 Panel ID、位置和比例。
- 不同物理 owner 相互隔离，即使 route 相同。
- focused Panel 已是 Project File 时直接复用自身，不创建文件 Panel 的文件 Panel。
- 关闭 owner 后文件 Panel 保留为 orphan，并清除 owner。
- Desktop close 只关闭文件 Panel。
- Compact 打开文件后关闭 Right Sidebar Drawer。
- Compact Back：
  - owner 存在：关闭文件 Panel 并明确聚焦 owner；
  - owner 不存在：将当前 Panel 替换为 `navigation(contextRoute)`。

### 4.6 URL 过渡

阶段 1 同时停止旧 PanelStack layout URL 的读写：

- 不读取旧 `?file=` 或旧 `route/panels`；
- 不写临时新格式；
- 阶段 1 到阶段 3 刷新进入安全默认 navigation；
- 普通 navigation 的运行期创建、切换和聚焦继续工作。

### 4.7 测试与完成条件

新增并运行：

- Router navigation/projectFile 分发。
- `PanelSlot` 不再判断文件页面。
- Project File kind 和 Viewer 分发。
- Right Sidebar 目录树、搜索和懒加载回归。
- PDF/Image/Markdown/Code/Text 回归。
- LinkInterceptor 不处理 EPUB。
- 同 owner 复用、duplicate route owner 隔离、orphan。
- Desktop close、Compact Back 和 Drawer close。
- 文件切换导致旧 Viewer unmount。
- 旧 layout query 不读取、不产生临时 layout URL。

完成条件：

- 新代码统一为 `ProjectFile*`。
- Right Sidebar 可打开现有文件。
- Electron typecheck、相关测试和 touched-file lint 通过。

---

## 5. 阶段 2：Project File 服务端相对路径读取

### 5.1 目标

Renderer 不再拼绝对路径；所有读取由 Project-scoped Server API 完成。

### 5.2 RPC

```ts
RPC_CHANNELS.projectFiles.READ_TEXT
RPC_CHANNELS.projectFiles.READ_BINARY
```

```ts
interface ProjectFileRequest {
  projectId: string
  relativePath: string
}

interface ProjectFileMetadata {
  projectId: string
  relativePath: string
  name: string
  mimeType: string
  byteLength: number
  lastModifiedMs: number
}

interface ProjectFileBinaryResponse {
  metadata: ProjectFileMetadata
  bytes: Uint8Array
  sourceFingerprint: SourceFingerprint
}

interface ProjectFileTextResponse {
  text: string
}
```

不返回长期 `resourceUrl`。需要 Blob URL 时由 Renderer 临时创建并 revoke。

### 5.3 同字节读取

`readProjectFileBinary`：

1. 从 RPC context 取得 workspace。
2. 在该 workspace 中按 `projectId` 加载 Project。
3. 规范化 `relativePath`。
4. `realpath` working directory 和目标，做 segment-aware containment。
5. 打开解析后的目标文件并 `fstat`，要求 regular file。
6. 检查大小限制。
7. 从该文件句柄读取一次，得到唯一 Buffer。
8. 再次 `fstat`；读取期间 dev/ino/size/mtime 变化则失败。
9. 对该 Buffer 计算 SHA-256。
10. 用同一 Buffer 构造 bytes、byteLength 和 fingerprint 响应。
11. `finally` 关闭句柄。

不得 hash 后重新按路径读取内容。

`readProjectFileText` 复用相同读取原语，再对同一 Buffer 做 UTF-8 解码。

### 5.4 首版限制

```ts
MAX_PROJECT_FILE_PATH_BYTES = 2048
MAX_PROJECT_FILE_TEXT_BYTES = 8 * 1024 * 1024
MAX_PROJECT_FILE_BINARY_BYTES = 32 * 1024 * 1024
```

选择 32 MiB 是为了沿用当前单次 `Uint8Array` RPC：WebSocket codec 会将 bytes base64 化，32 MiB 约变成 43 MiB，仍显著低于当前 100 MiB 默认 payload 上限。

超过限制时展示 `PROJECT_FILE_TOO_LARGE`，不在首版建设分块/流式传输。只有真实 EPUB/PDF 样本证明 32 MiB 不够后，才单独设计流式能力。

路径要求：

- 拒绝绝对路径、`..`、NUL、directory 和非 regular file。
- 允许 root 内 symlink，拒绝越界 symlink。
- Server 日志和 Renderer 错误不泄露不必要的绝对文件路径。
- Right Sidebar 仍可展示 Project working directory 根路径。

### 5.5 主要改动位置

- `packages/shared/src/protocol/channels.ts`
- `packages/shared/src/protocol/dto.ts`
- `packages/shared/src/protocol/routing.ts`
- 新增 `packages/server-core/src/handlers/rpc/project-files.ts`
- 复用或抽取现有 Project root resolver/path validator
- `apps/electron/src/transport/channel-map.ts`
- `apps/electron/src/shared/types.ts`
- `ProjectFilePage.tsx`

### 5.6 测试与完成条件

新增并运行：

- workspace/Project 归属。
- canonical path、绝对路径、`..`。
- root 内/外 symlink。
- directory/非 regular file。
- 32 MiB/8 MiB 边界。
- 读取期间文件变化。
- `sha256(response.bytes) === sourceFingerprint`。
- `metadata.byteLength === response.bytes.byteLength`。
- 接近 32 MiB 的 IPC/WebSocket round-trip。
- Renderer 不再调用 absolute-path read API。
- 现有 Viewer 使用新 API 回归。

完成条件：

- route/state 只保存 relative path。
- Project 根路径仍可在 Sidebar 只读展示。
- binary bytes、fingerprint 和 metadata 来自同一次稳定读取；text API 只返回解码后的 text。

---

## 6. 阶段 3：EPUB 基础阅读

### 6.1 目标

交付可见、可用的 EPUB：

- continuous/scrolled；
- TOC；
- 当前章节；
- 明暗主题；
- 资源限制；
- 完整销毁。

本阶段不等待状态持久化、导出和 Add Chat。

### 6.2 epub.js

依赖放入实际 Renderer consumer `apps/electron/package.json`：

```json
{
  "epubjs": "github:futurepress/epub.js#eee359d0790002115a1156a9833c54f4bcd44c1d"
}
```

交付时记录 lockfile 最终 SHA，不依赖浮动 branch/tag。

从 `codex/socratopia-learning` 只复用：

- book/rendition 初始化和销毁；
- continuous/scrolled 配置；
- TOC、href 和 CFI 纯函数；
- selection 定位；
- 主题、ResizeObserver 和事件清理；
- 对应纯函数测试。

不迁移 RightWorkspace、sessionId 文件读取、Side Chat、Browser、Textbook/import、localStorage 阅读状态和旧 highlights。

### 6.3 Reader 输入和配置

```ts
interface EpubReaderProps {
  identity: ProjectFileIdentity
  metadata: ProjectFileMetadata
  bytes: Uint8Array
  sourceFingerprint: SourceFingerprint
  initialLocator?: {
    type: 'epub-cfi'
    cfiRange: string
  }
}
```

Viewer key：

```text
projectId + "\0" + relativePath + "\0" + sourceFingerprint
```

渲染：

```ts
{
  manager: 'continuous',
  flow: 'scrolled',
  spread: 'none',
  allowScriptedContent: false,
}
```

要求：

- 自然上下滚动并跨章节加载。
- 不以 Previous/Next 为主要交互。
- TOC 点击跳转 href/CFI。
- location 同步当前章节。
- 跟随应用明暗主题。
- reflowable 和 pre-paginated 均有测试。

### 6.4 TOC

```ts
interface EpubTocNode {
  key: string
  title: string
  href?: string
  orderPath: number[]
  children: EpubTocNode[]
}
```

- `orderPath` 是原 TOC 的兄弟索引路径。
- `key = "toc:" + orderPath.join(".")`。
- key 在同一 fingerprint 内稳定，不依赖 EPUB 可空或重复 id。
- 保留父子结构和原顺序。
- 当前章节优先匹配规范化 document href + fragment，失败时回退到同 document 最深节点。

### 6.5 安全与资源限制

```ts
MAX_EPUB_COMPRESSED_BYTES = 32 * 1024 * 1024
MAX_EPUB_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
MAX_EPUB_ENTRY_BYTES = 32 * 1024 * 1024
MAX_EPUB_ENTRIES = 5000
MAX_EPUB_COMPRESSION_RATIO = 100
```

Server 在返回 EPUB bytes 前检查：

- ZIP/EPUB 基本结构和 `mimetype`；
- path traversal；
- encrypted entries；
- ZIP64；
- central directory 声明的 entry/总量/ratio 上限；
- 对将要返回的同一份 bytes 做受限流式解压扫描，不把解压结果整体留在内存；
- 按实际 entry 输出、实际累计输出和实际 ratio 计数，任一超过上限立即中止。

使用现有成熟 ZIP 库的流式读取能力，不自研解压器。声明值只能用于提前拒绝，
不能替代实际输出计数。

`packages/server-core/package.json` 直接声明 `yauzl`，lockfile 固定当前
`2.10.0`；类型包放入该包的 devDependencies。不得因为它已被其他依赖间接
带入 lockfile 就省略直接依赖。

Reader 安全：

- `allowScriptedContent: false`。
- 保留 epub.js 所需 `sandbox="allow-same-origin"`，不增加 scripts/forms/popups/top-navigation。
- 在 `book.spine.hooks.serialize`、iframe write 前注入 CSP：

```text
default-src 'none';
script-src 'none';
connect-src 'none';
object-src 'none';
frame-src 'none';
form-action 'none';
base-uri 'none';
img-src blob: data:;
media-src blob: data:;
font-src blob: data:;
style-src 'unsafe-inline' blob:;
```

- 同一 pre-write 步骤移除 `script`、`meta refresh` 和 `base`。
- contents click handler 阻止外链、form 和顶层导航。
- 不在首版自建完整 URL/CSS sanitizer 或 archive resolver；以真实恶意样本的网络监听测试为准。若仍观察到 HTTP/file 请求，再针对真实泄漏入口补拦截。

### 6.6 销毁

卸载、文件切换、刷新和重试清理：

- rendition/book/contents 事件；
- ResizeObserver；
- document/window listeners；
- timers；
- CSS Highlight；
- Blob URL；
- rendition 和 book。

销毁幂等；异步初始化在卸载后完成时不得写 state。

### 6.7 测试与完成条件

新增并运行：

- pinned SHA/lockfile。
- continuous/scrolled/spread/no-script。
- reflowable/pre-paginated。
- TOC 结构、key、顺序和 current chapter。
- corrupt ZIP、encrypted、ZIP64、traversal、声明与实际大小/ratio。
- 伪造 central directory 声明值仍被实际解压计数阻断。
- CSP 在 iframe write 前注入。
- 恶意样本不产生 HTTP/file 请求。
- 明暗主题。
- 重复 mount/unmount 和文件切换无 listener/observer/Blob 泄漏。
- Reader 失败和重试。
- LinkInterceptor 不处理 EPUB。

完成条件：

- 从 Right Sidebar 打开 EPUB 后可以连续跨章节阅读。
- TOC 跳转和当前章节正常。
- Electron 启动、typecheck、相关测试和 lint 通过。

---

## 7. 阶段 4：版本化 Panel Layout Codec

### 7.1 目标

可靠恢复物理 Panel、Project File owner、比例和 focused panel。

升级的核心理由是 owner 实例关系。相同 route 的两个 Panel 不能通过 route 或“向左寻找”区分；逗号文件名不是本次升级的核心理由。

### 7.2 Schema

```ts
interface SerializedPanelLayoutV1 {
  version: 1
  entries: Array<{
    key: string
    route: PanelContentRoute
    proportion: number
    ownerKey?: string
  }>
  focusedKey: string
}
```

- Serializer 按当前顺序生成 snapshot-local key，例如 `p0`、`p1`。
- runtime entry 不保存额外 `layoutKey`。
- `ownerKey` 只用于 projectFile entry，并指向 navigation entry。
- orphan 不写 `ownerKey`。

### 7.3 URL

```text
?layout=<base64url(UTF-8 JSON SerializedPanelLayoutV1)>
```

- 只实现 V1。
- 不读取旧 `?file=`、旧 `route/panels`。
- 最大 encoded layout 64 KiB。
- 最大 8 个 Panel。
- route 复用已有 validator。
- 校验 key 唯一、ownerKey 存在、focusedKey 存在、比例是正有限数。
- 非法 layout 整体失败并进入安全默认 navigation，不做部分恢复。

### 7.4 恢复

1. decode + validate。
2. 为每个 key 创建 runtime Panel ID。
3. 创建全部 entry。
4. 用 `key -> runtimeId` 映射 owner。
5. 归一化比例。
6. 用 focusedKey 恢复焦点。
7. 一次性提交 PanelStack，避免中间状态回写 URL。

不得从 route 或相对位置推断 owner。

### 7.5 生命周期

- create/reuse/resize/focus/close/owner clear 后写回。
- 写回 debounce，窗口关闭前 flush。
- owner 关闭后先转 orphan 再序列化。
- 文件切换保留 runtime Panel ID、比例和 owner。

### 7.6 测试与完成条件

新增并运行：

- V1 round-trip。
- duplicate navigation route 的 owner 隔离。
- focused panel、比例、orphan。
- owner 关闭。
- Project File 切换。
- 非法 version/key/owner/focus/route/proportion。
- Unicode、空格、逗号和冒号路径。
- 8 Panel/64 KiB 边界。
- Electron 刷新前后实际恢复。

完成条件：

- 刷新前后顺序、比例、owner 和焦点一致。
- 只读写 `PanelLayoutV1`。
- 不存在 route-position owner 推断。

---

## 8. 阶段 5：服务端增量状态 Mutation

### 8.1 目标

实现阅读位置和红色波浪线持久化，同时保证：

- progress/highlight 不互相覆盖；
- 同文档 mutation 服务端串行；
- revision 单调增加；
- fingerprint 变化后不加载旧状态。

### 8.2 存储

```text
{workspaceRoot}/projects/{projectSlug}/epub-state/v1/{documentKey}.json
```

```text
documentKey = sha256(relativePath + "\0" + sourceFingerprint)
```

每个文档只保存一个 JSON。首版不实现 journal、append log 或 compaction。

### 8.3 Schema

```ts
interface EpubDocumentStateV1 {
  version: 1
  projectId: string
  relativePath: string
  sourceFingerprint: SourceFingerprint
  revision: number
  progress?: {
    cfi: string
    chapterKey?: string
    percentage?: number // 0..1
    updatedAt: number
  }
  highlights: EpubHighlightV1[]
  updatedAt: number
}

interface EpubTocPathEntryV1 {
  key: string
  title: string
  orderPath: number[]
  href?: string
}

interface EpubHighlightV1 {
  id: string
  cfiRange: string
  quote: string
  contextBefore?: string
  contextAfter?: string
  chapterKey?: string
  chapterTitle?: string
  tocPath: EpubTocPathEntryV1[]
  spineIndex?: number
  style: {
    type: 'wavy'
    color: 'red'
  }
  createdAt: number
  updatedAt: number
}
```

`EpubTocPathEntryV1` 在本阶段放入 `packages/core`；state DTO 引用该类型，
不在 Server、Renderer 和阶段 7 各复制一份。

### 8.4 RPC

```ts
getEpubDocumentState({
  projectId,
  relativePath,
  sourceFingerprint,
}): Promise<EpubDocumentStateV1 | null>
```

```ts
type EpubStateMutation =
  | {
      type: 'set-progress'
      progress: {
        cfi: string
        chapterKey?: string
        percentage?: number
      }
    }
  | {
      type: 'upsert-highlight'
      highlight: Omit<EpubHighlightV1, 'createdAt' | 'updatedAt'>
    }
  | {
      type: 'delete-highlight'
      highlightId: string
    }

applyEpubStateMutation({
  projectId,
  relativePath,
  sourceFingerprint,
  mutation: EpubStateMutation,
}): Promise<{
  revision: number
  applied: boolean
  canonicalHighlight?: EpubHighlightV1
}>
```

Renderer 不得发送完整 state。

`canonicalHighlight` 只在成功的 `upsert-highlight` 中返回，用于接收 Server
生成的时间字段；其他 mutation 只需要 `revision + applied`。首版不做
compare-and-swap，也不因 Renderer 持有旧 revision 而拒绝 mutation。

### 8.5 服务端写入

锁 key：

```text
workspaceId + projectId + relativePath + sourceFingerprint
```

在 per-document mutex 内：

1. 校验 Project/path、fingerprint 格式和 workspace 权限。
2. 读取最新 JSON；不存在则创建 revision 0 空状态。
3. 校验 schema。
4. 应用一个 mutation。
5. no-op 返回 `applied: false`，不增加 revision。
6. Server 生成 createdAt/updatedAt。
7. revision + 1。
8. 校验 highlights 数量和序列化总大小。
9. 写同目录临时文件，flush/close 后 atomic rename。
10. 返回 revision、applied，并在 upsert 时返回 canonicalHighlight。

State RPC 不在每次 progress/highlight mutation 时重新读取和 hash EPUB。
`sourceFingerprint` 表示 Reader 已加载的那份 bytes，并直接参与 documentKey。
重新打开文件必须先走阶段 2 读取；文件变化会得到新 fingerprint，从而读取新的
state 分区。只有阶段 7 把引用发送进 Message/模型时，才重新校验磁盘当前
fingerprint。

固定限制：

```ts
MAX_EPUB_CFI_LENGTH = 4096
MAX_EPUB_QUOTE_CHARS = 4000
MAX_EPUB_CONTEXT_CHARS = 1000
MAX_EPUB_TOC_PATH_DEPTH = 32
MAX_EPUB_HIGHLIGHTS_PER_DOCUMENT = 1000
MAX_EPUB_STATE_BYTES = 4 * 1024 * 1024
```

只有真实性能数据证明单 JSON 成为瓶颈后，才考虑 journal/数据库。

### 8.6 阅读位置

- `relocated` 后更新内存位置。
- 1000ms debounce `set-progress`。
- 文件切换、Panel close 和 Reader unmount 前 flush。
- 只恢复 fingerprint 相同的 state。
- CFI 恢复失败回到书籍开头。
- Renderer 记录响应中的最大 revision；观察到非连续 revision 时重新 GET 全量状态。

### 8.7 红色波浪线

选择文字后最终显示：

```text
红色波浪线 | Add Chat | 取消
```

本阶段启用红色波浪线，阶段 7 启用 Add Chat。

创建：

- 捕获 CFI Range、quote、同一 spine 内 bounded context、chapter、tocPath 和 spineIndex。
- 立即显示 optimistic CSS Highlight。
- 调用 `upsert-highlight`。
- 失败时移除 optimistic highlight。

恢复和删除：

- section ready 后恢复。
- 点击定位 CFI。
- 删除先更新 UI，再调用 mutation；失败时回滚。

### 8.8 测试与完成条件

新增并运行：

- state 不存在/null。
- revision/no-op。
- progress/highlight mutation 不重新读取或 hash EPUB。
- progress/highlight 交错不覆盖。
- 并发 upsert/delete 串行。
- atomic rename 失败保留旧完整文件。
- 不同 fingerprint 的 state/mutation 完全隔离。
- 文件替换后不加载旧状态。
- state/highlight/字段限制。
- progress debounce 和 close/unmount/file switch flush。
- highlight 创建、失败回滚、恢复、跳转、删除。

完成条件：

- 重启后恢复阅读位置和划线。
- Renderer 只发送 mutation。
- 交错请求不丢数据。

---

## 9. 阶段 6：TOC 划线列表、CFI 排序和 Markdown 导出

### 9.1 Reader 内部 UI

```text
目录 | 划线
```

属于 EpubReader 内部，不使用应用级 Right Sidebar。

划线树：

- 当前 fingerprint 的 TOC 是权威顺序。
- 用 highlight `tocPath[].key` 定位节点。
- 父节点只显示一次。
- 只显示包含 highlight 的节点和祖先。
- 无法匹配的进入“未识别章节”。
- 窄 Panel 使用 Reader 内部 Drawer。
- 点击跳 CFI，删除走阶段 5 mutation。

### 9.2 CFI 排序

同章节：

1. `spineIndex` 升序，缺失排最后。
2. 使用 epub.js `EpubCFI.compare`。
3. comparator 失败时用 Server `createdAt`。
4. 最后用 id 保证稳定。

禁止按 CFI 字符串字典序排序。

### 9.3 Markdown

```ts
buildEpubHighlightsMarkdown({
  bookTitle,
  fileName,
  toc,
  highlights,
}): string
```

规则：

- H1 使用书名，缺失时用文件名。
- TOC 根节点从 H2 开始，最多 H6；更深层用粗体标题。
- 保持原 TOC 顺序和父子层级。
- 同一父章节只输出一次。
- highlight 按 CFI 阅读顺序。
- 每行 quote 输出为 blockquote。
- 无法匹配的最后输出“未识别章节”。
- LF 且结尾一个换行。
- 标题转义 Markdown 控制字符。
- 无 highlight 时不创建空文件。

### 9.4 保存

- Electron 使用主进程 Save Dialog。
- 用户取消不写文件。
- Renderer 只提供 suggested filename 和 Markdown content，不提供任意输出绝对路径。
- Web/remote 使用 Blob download。
- 默认 `{safeBookTitle}-highlights.md`。

不为此建立通用文件导出框架；只抽取一个小的文本保存 adapter。

### 9.5 测试与完成条件

新增并运行：

- 多层 TOC、相同标题、空 id/href。
- spine + CFI comparator。
- 无 TOC、未识别章节。
- H6 以上、Unicode、标题转义、多行 quote。
- 空 highlights。
- Save 确认/取消。
- 划线列表跳转和删除。

完成条件：

- UI 与导出顺序一致。
- Markdown 保留 TOC 层级。
- Save 取消不产生文件。

---

## 10. 阶段 7：Add Chat 结构化引用端到端

### 10.1 目标

```text
EPUB selection
→ ProjectFileReferenceV1
→ SessionDraft.references
→ Composer reference UI
→ Message.references
→ StoredMessage.references
→ Session JSONL
→ Model input
→ Message reference UI
→ Reopen EPUB at CFI
```

不得向 draft text 拼接 Markdown 来替代这条链路。

### 10.2 Core 类型

```ts
interface ProjectFileReferenceV1 {
  version: 1
  kind: 'project-file'
  projectId: string
  relativePath: string
  sourceFingerprint: SourceFingerprint
  fileName: string
  quote: string
  contextBefore?: string
  contextAfter?: string
  chapterKey?: string
  chapterTitle?: string
  tocPath: EpubTocPathEntryV1[]
  locator: {
    type: 'epub-cfi'
    cfiRange: string
  }
}

type MessageReference = ProjectFileReferenceV1
```

- 本版本不定义 `WebSelectionReference`。
- `SourceFingerprint` 已在阶段 2、`EpubTocPathEntryV1` 已在阶段 5 放入
  `packages/core`；本阶段只新增 MessageReference。
- `packages/shared` 可以导入 Core；Core 不反向导入 Shared。

扩展：

```ts
interface Message {
  references?: MessageReference[]
}

interface StoredMessage {
  references?: MessageReference[]
}

interface SendMessageOptions {
  references?: MessageReference[]
}

interface SessionDraft {
  text: string
  attachments?: DraftAttachmentRef[]
  references?: MessageReference[]
}
```

引用不额外保存数据库 ID。Renderer 用以下确定性 key 做追加、移除和去重：

```ts
const referenceKey = JSON.stringify([
  reference.kind,
  reference.projectId,
  reference.relativePath,
  reference.sourceFingerprint,
  reference.locator.type,
  reference.locator.cfiRange,
])
```

### 10.3 复用现有 Draft

继续使用现有 `drafts.json`、Renderer `sessionDraftsRef` 和 debounce 持久化，不迁移到 per-session draft 文件，也不新增 mutation journal。

必须修改现有 Draft helpers：

- text 更新保留 attachments/references。
- attachments 更新保留 text/references。
- Add Chat 通过同一个 central draft updater 追加 reference。
- `isEmptyDraft` 同时检查三者。
- `getAllDrafts`/GET/SET 按当前 workspace 的 Session 做授权和过滤。
- reference card 独立显示，不修改 `draft.text`。

central draft updater 增加三个局部操作，不建立新的持久化状态机：

```ts
beginSend(sessionId): { token: string; snapshot: SessionDraft }
finishSend(token): Promise<void>
abortSend(token): void
```

- `beginSend` 同步完成 snapshot + lock，必须在任何附件异步处理之前调用。
- lock 期间所有 Draft mutation 返回明确的 `DRAFT_LOCKED`，不排队静默执行。
- `finishSend` 只接受当前 token；清空内存 Draft 并立即持久化。
- `abortSend` 保留原 Draft。
- 三条路径都在 `finally` 释放 token。

同一个 Session Draft 的多客户端实时协作不是本版本目标。

### 10.4 Add Chat 目标

- owner 是同 Project Session Panel：追加到该 Session Draft。
- owner 不存在、不是 Session 或 Project 不一致：显示 Session 选择器。
- 选择器只列同 Project、非 archived、可导航 Session。
- 不静默选择最近 Session。
- Add Chat 只更新 Draft，不自动发送。
- 没有 Session 时显示空状态；创建 Session 必须由用户明确操作。

Reference card 显示文件名、TOC 路径、quote 摘要、移除和 stale/error 状态。

### 10.5 发送

当前 `sessions.sendMessage` RPC 已在 user message 写入并 flush 后返回快速 ACK。复用该边界：

1. FreeFormInput 调用 `beginSend`，在任何附件异步处理前原子取得不可变 snapshot 和 lock token。
2. optimistic Message 和 `SendMessageOptions` 都携带 references。
3. 等待 ACK 时 token 锁定该 Session 的 central draft updater，而不只是输入框；text、attachment、Add Chat 和 remove reference 都不能在此期间修改该 Draft。
4. Server 校验引用。
5. user message 连同 references 写入 Session JSONL并 flush。
6. ACK 成功后调用 `finishSend(token)`。
7. ACK 前或附件处理失败时调用 `abortSend(token)`；optimistic Message 标记失败并可 Retry。
8. ACK 后模型失败不恢复 Draft，使用现有 Message retry。

`finishSend` 持久化失败时，Message 已经成功落盘，不能改判发送失败或触发消息
Retry。内存 Draft 保持已清空，`finally` 解锁 updater，并显示“消息已发送，但
Draft 清理失败”的 warning；旧 Draft 可能留在磁盘，后续正常 Draft 保存会覆盖它。

沿用现有 optimistic Message ID 和 Server Message ID 语义，不在 EPUB 阶段新增
exactly-once、跨重连发送事务或第二套消息 ID。ACK 丢失后的行为与普通消息保持一致。

Session JSONL flush 与 `drafts.json` 清空不是跨文件事务。进程恰好在两者之间崩溃时，
重开后可能看到“消息已经发送，但 Draft 仍保留”；首版明确接受这个不丢内容的残留，
由用户确认后丢弃 Draft，不为它建设 pending-send/consume 对账系统。

queued、redirect、Stop、Retry 和 OAuth refresh 路径必须把 references 作为 Message 的一部分完整透传。

这保留完整结构化引用，又不引入第二套 Draft 事务状态机。ACK 前短暂锁定
central draft updater 是首版明确的简单性取舍。

### 10.6 Server 校验和限制

发送消息时强校验：

- Session 属于当前 workspace。
- Session 与 Project File 属于同一 Project。
- relativePath 合法且文件仍在 Project root。
- 当前 fingerprint 与 reference 相同。
- locator 是 `epub-cfi`。
- 字段满足阶段 5 限制。

Add Chat 使用当前 Reader 已加载的 `sourceFingerprint` 构造 reference，只做结构、
大小和 Session/Project 关系校验，不新增 Validate RPC，也不在每次 Draft SET 时
重新读取或 hash EPUB。

普通 Draft 保存只校验结构、大小、workspace/Session 归属，允许保留已经 stale
的 reference；否则文件变化会阻断无关的文字 Draft 保存。发送时若 fingerprint
已变化，保留 Draft 并把对应 card 标为 stale，由用户移除或重新选择。

```ts
MAX_REFERENCES_PER_MESSAGE = 32
MAX_PROJECT_FILE_REFERENCE_BYTES = 16 * 1024
MAX_MESSAGE_REFERENCES_BYTES = 128 * 1024
```

按规范化 JSON UTF-8 bytes 计算。Renderer 校验不能替代 Server 校验。

### 10.7 模型输入

模型每次收到：

- projectId/relativePath/sourceFingerprint；
- quote/context；
- chapter/tocPath；
- CFI。

Server 共用 helper 将 references 转成 bounded、不可信的 user-turn 数据：

```text
<project_file_reference_data trust="untrusted">
{bounded JSON}
</project_file_reference_data>
```

- 不放进可信 system instruction。
- 不注入整章或整本书。
- JSON 序列化后转义 `<`、`>`、`&` 和行分隔符，防止闭合包装标签。
- 所有 Agent provider 使用同一个 helper。
- 普通发送、mid-stream redirect/steer、queued replay、Retry 和 OAuth retry
  都先通过该 helper 构造模型输入；不能让只接受 string 的 redirect 路径丢掉 references。
- Session JSONL 仍分别保存原始 message text 和结构化 references，不保存拼接后的模型字符串。

### 10.8 点击引用重开 EPUB

引用跳转使用一次性运行时 intent，不进入 Layout：

```ts
interface ProjectFileOpenIntent {
  expectedFingerprint: SourceFingerprint
  locator: {
    type: 'epub-cfi'
    cfiRange: string
  }
}
```

- `openOrReuseProjectFilePanelAtom` 接受可选 intent。
- intent 存在独立的 panelId -> intent runtime map。
- fingerprint 相同：Reader ready 后定位并消费。
- fingerprint 不同：打开当前文件，显示 stale banner，不跳旧 CFI。
- 文件缺失：保留消息引用并显示不可用。

### 10.9 AnnotationV1 边界

不得：

- 修改 `AnnotationV1.target` 指向 Project File；
- 把 reference 塞进 `AnnotationV1.meta`；
- 用 Annotation selector 代替 CFI；
- 让 highlight 依赖 Annotation 存储。

三者不同：

- highlight：Project 文档阅读状态；
- MessageReference：用户消息引用的 Project File 上下文；
- Annotation：Session/Message 内容标注。

### 10.10 测试与完成条件

新增并运行：

- reference validator/大小/数量。
- Draft text/attachment 更新保留 references。
- Add/remove/dedupe 和 empty draft。
- Draft workspace 授权和过滤。
- owner Session/选择器/不静默最近 Session。
- Composer reference card 不修改 text。
- reference-only Draft 可发送。
- optimistic Message、SendMessageOptions、JSONL round-trip。
- ACK 前失败 Draft 不清空；ACK 后清空。
- ACK 等待期间 text/attachment/Add Chat/remove reference 都不能绕过 central updater。
- `beginSend` 在附件异步处理前取得 token。
- `finishSend` 持久化失败仍保持 Message 成功、释放 token 并显示 cleanup warning。
- queued/redirect/Stop/Retry/OAuth 保留 references。
- 模型输入完整、bounded、untrusted 且转义。
- 点击引用重开、定位、stale 和文件缺失。
- `AnnotationV1` 未被复用。
- 不存在 Browser reference 路径。

完成条件：

- Add Chat 只增加 structured reference。
- Draft、Message、JSONL、模型和 reopen 全链路保留引用。
- 失败/队列/重试不丢引用。

---

## 11. 每阶段统一验证

每阶段至少执行：

1. 本阶段新增定向 Bun tests。
2. 受影响包 typecheck。
3. touched-file/package-local lint。
4. `git diff --check`。
5. Electron 启动验证。
6. 相关 Chat、Source、Settings、Skills、Automation 和 Project navigation 回归。

常用命令：

```bash
bun test <本阶段测试文件...>
bun run typecheck:electron
cd packages/shared && bun run tsc --noEmit
cd packages/server-core && bun run tsc --noEmit
cd apps/electron && bun run lint
git diff --check
```

涉及 Main/Preload/transport 时按范围构建：

```bash
bun run electron:build:main
bun run electron:build:preload
bun run electron:build:renderer
```

不得用改动前“24 pass”替代阶段测试。

### 11.1 Computer 自动化

阶段 3、4、5、6、7 分别验收对应可见行为；最终流程：

1. 打开 Project 和 Fixed Right Sidebar Files。
2. 确认 working directory 根路径可见。
3. 打开 EPUB 并跨章节滚动。
4. 使用 TOC。
5. 刷新并验证 owner/focus。
6. 验证阅读位置。
7. 创建、重启恢复、跳转和删除划线。
8. 查看树形划线列表。
9. 导出 Markdown并验证取消保存。
10. Add Chat 到 owner Session。
11. 无 owner 时使用 Session 选择器。
12. 发送并点击引用重开 EPUB。
13. 替换 EPUB 后验证 stale。
14. 切换 EPUB/PDF/Image/Markdown，检查资源释放和回归。

自动化不得删除 Project 或 working directory 文件。

---

## 12. 实施顺序

```text
阶段 1  PanelContentRouter + ProjectFilePage
  ↓
阶段 2  Project-scoped 同字节读取
  ↓
阶段 3  可见 EPUB 基础阅读
  ↓
阶段 4  Panel Layout owner/focus 恢复
  ↓
阶段 5  Progress/Highlight mutation
  ↓
阶段 6  TOC 列表与 Markdown 导出
  ↓
阶段 7  Add Chat 完整结构化引用
```

每阶段独立验证；是否 commit/push 由当时工作树状态和用户明确授权决定。

---

## 13. 非目标

- Browser/Web selection。
- Side Chat 特殊实体。
- Project Textbook/import。
- 修改 EPUB 源文件。
- 状态写入 working directory。
- JSON highlight export。
- EPUB 全文搜索或编辑。
- 大于 32 MiB 的首版 Project File binary streaming。
- EPUB state journal/数据库。
- 多客户端同时编辑同一 Session Draft。
- 旧 URL、旧状态、旧 reference 的兼容或迁移。
- 用 AnnotationV1 表达 Project File Reference。
- 关闭 Panel 时删除 Session。

---

## 14. 最终交付报告

必须列出：

- 最终 epub.js SHA 和 lockfile 结果。
- 七阶段实际修改范围。
- 每阶段新增测试及结果。
- typecheck/lint/build 结果。
- Electron/Computer 自动化路径和可见结果。
- Project File/EPUB 最终资源限制。
- state mutation/revision 并发测试。
- Add Chat 从 Draft 到模型输入和 reopen 的链路证据。
- 未运行或环境阻塞检查。
- 工作树、commit 和 push 状态，不把未提交误报为已提交。
