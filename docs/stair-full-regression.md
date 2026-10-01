# Stair 全量回归验收规范

## 1. 文档定位

- 适用范围：Stair 当前已交付的全部产品模块，以及后续功能、修复、重构、依赖和打包迭代。
- 基线来源：[`stair-rebuild-plan.md`](./stair-rebuild-plan.md)。
- 日常 Full Run 直接验证当前工作区源码，以及开发版 `~/.stair-dev` 和正式包 `~/.stair` 各自的当前数据与 Project，不创建数据副本。
- 全新配置首次启动和 Windows/Linux 实机验证属于发布资格补充，不阻塞日常 Full Run。

本文是未来迭代的验收入口。`stair-rebuild-plan.md` 中的历史通过记录只说明当时的代码状态，不能替代当前工作树的重新验证。

## 2. 不可放宽的执行契约

1. 每次 Run 记录 Commit SHA、分支和 `git status --short`。Run 中不修改源码；源码变化后使用新的 Run ID。
2. 新功能在实现前增加或更新 Case；Bug 修复必须新增能够复现缺陷的自动化回归，并映射到一个稳定 Case ID。
3. 任一必须 Case 为 `FAIL` 或 `BLOCKED` 时，本轮不能标记为完成。`BLOCKED` 不是 `PASS`。
4. 修复失败后先复跑失败 Case、直接关联 Case和受影响模块。同一开发周期可以累计修复；候选源码稳定后，再使用新的 Run ID，由验收人员逐 Case手动发起、判定并记录全部模块中的 Case。AUTO结果、批量脚本和模块汇总不能替代本轮逐 Case判定。
5. 上一轮、上一 Commit 或历史文档中的通过结果不得复用。截图、日志和测试计数必须来自当前 Run。
6. `AUTO` 由本轮源码门禁统一提供；`DEV`、`PKG` 必须在真实 Electron 中执行。两者互不替代。
7. 模拟 IPC、Reducer、jsdom 和单元测试不能替代 Pointer、独立 BrowserWindow、重启恢复或正式包运行时验收；人工 smoke也不能替代路径授权、竞态、原子回滚和大小预算自动化。
8. 本次从阶段 ID迁移到当前 Case ID体系的对应关系固定在第 21 节；新 ID生效后永不重排或复用。废弃 Case保留 ID，并写明替代 Case和原因。

## 3. 执行模型

### 3.1 执行类型

| 标记 | 含义 |
| --- | --- |
| `AUTO` | 由源码测试、类型检查、静态守卫或构建验证执行。 |
| `DEV` | 使用 `bun run stair:dev` 的真实 Electron 开发版执行。 |
| `PKG` | 使用本轮源码新构建的正式目录包 `Stair.app` 执行。 |
| `DERIVED` | 不重复执行动作；只核对本轮其他 Gate/Case 的结果。 |

每个 Case只有一个主要执行类型。完整 Run仍由验收人员逐 Case发起和判定：`AUTO` Case由验收人员手动启动对应源码门禁并核对证据，不在 UI中人工复现自动注入；`DEV`/`PKG` Case由验收人员操作真实 Electron；`DERIVED` Case只由验收人员核对全部依赖结果，不执行新动作。源码门禁会统一运行全部自动化，因此 `DEV` Case无需再单独填写一份 AUTO子结果。

执行类型在这里统一归类，产品模块的 Case 树不重复标记：

- `AUTO` Case：`APP-01`、`APP-08`、`PROJECT-07`、`WORKBENCH-25`、`WORKBENCH-26`、`FILES-10`、`FILES-14`—`FILES-16`、`READER-01`、`READER-02`、`EPUB-07`、`REFERENCE-04`—`REFERENCE-07`、`REFERENCE-10`、`CHAT-03`、`BROWSER-10`、`DRAWNIX-03`、`DRAWNIX-08`、`DRAWNIX-10`。
- `PKG` Case：`APP-09`—`APP-12`、`PROJECT-10`、`WORKBENCH-27`、`CHAT-05`—`CHAT-07`、`RELEASE-04`—`RELEASE-06`。
- `DERIVED` Case或规则：`PROJECT-08`、`BROWSER-14`、`RELEASE-01`—`RELEASE-03`、`INV-01`—`INV-08`。
- `DEV` Case：其余产品模块 Case。

### 3.2 场景修饰符

| 标记 | 含义 |
| --- | --- |
| `+FAULT` | 在主要执行类型上增加故障注入，不是新环境；不得为验收向生产代码加入隐藏开关。 |

`+FAULT` Case统一为：`APP-08`、`PROJECT-07`、`WORKBENCH-24`、`WORKBENCH-25`、`FILES-10`、`FILES-11`、`FILES-14`—`FILES-16`、`READER-01`、`EPUB-07`、`REFERENCE-04`—`REFERENCE-07`、`REFERENCE-10`、`CHAT-02`、`CHAT-04`、`BROWSER-10`、`DRAWNIX-03`和 `DRAWNIX-08`。

### 3.3 结果状态

| 标记 | 含义 |
| --- | --- |
| `PASS` | 当前源码与指定环境中，实际结果完全满足 Case 的 `Expect`，且证据完整。 |
| `FAIL` | 结果不符、崩溃、残留部分状态、出现错误成功提示，或证据证明发生回归。 |
| `BLOCKED` | 环境或外部依赖阻止执行；必须说明阻断原因，不能计为通过。 |
| `NOT_REQUIRED` | 仅用于条件 Gate，表示当前 Diff 不触发该 Gate；必须记录判定依据，Case 不能使用此结果。 |
| `N/A` | 仅用于当前 Host不适用的发布资格补充项。 |

同一操作可以覆盖多个 Case，但执行和报告都必须逐 Case判定，不能用模块汇总代替。平台专属自动化必须显式 skip，并在当前 Host执行可用的等价安全边界。

当前清单共 136 条：产品模块 Case 共 128 条，包括 `APP=12`、`PROJECT=10`、`WORKBENCH=27`、`FILES=16`、`READER=2`、`EPUB=7`、`PDF=5`、`REFERENCE=12`、`CHAT=7`、`BROWSER=14`、`DRAWNIX=10`、`RELEASE=6`；另有 8 条跨模块验收规则 `INV-01`—`INV-08`。`INV` 是 Invariant（不变量）的缩写，只派生判定其他 Case 的共同约束，不是产品模块，也不增加操作。增删 Case时同步更新本计数；同一前缀内编号必须连续且唯一。

Case 按主要产品所有者归类，而不是按开发顺序或执行环境归类：EPUB/PDF 共用的状态与安全边界归入 `READER`，跨内容选择动作归入 `REFERENCE`，正式包与平台资格归入 `RELEASE`。同一行为不为凑齐模块表而复制 Case。

### 3.4 模块验收依赖

聚焦回归某个模块时，至少执行下表的本模块 Case、直接共享/集成 Case，并重新判定列出的 `INV` 规则。该矩阵用于失败修复后的受影响模块回归；最终 Full Run仍必须执行全部 128 个产品 Case和8条跨模块规则。

| 受影响模块 | 本模块 Case | 必需共享/集成 Case | 重新判定 |
| --- | --- | --- | --- |
| APP | `APP-01`—`APP-12` | `RELEASE-01`—`RELEASE-03` | `INV-07`、`INV-08` |
| PROJECT | `PROJECT-01`—`PROJECT-10` | `WORKBENCH-10`、`REFERENCE-02`、`REFERENCE-07`、`BROWSER-08`、`DRAWNIX-07` | `INV-03`、`INV-06` |
| WORKBENCH | `WORKBENCH-01`—`WORKBENCH-27` | `APP-06`、`FILES-04`/`FILES-05`/`FILES-09`/`FILES-10`、`REFERENCE-03`—`REFERENCE-07`、`BROWSER-01`/`BROWSER-03`—`BROWSER-10`、`DRAWNIX-01` | `INV-01`、`INV-02`、`INV-04`、`INV-06` |
| FILES | `FILES-01`—`FILES-16` | `REFERENCE-02`—`REFERENCE-11`、`DRAWNIX-01`—`DRAWNIX-03`、`RELEASE-04` | `INV-02` |
| READER | `READER-01`/`READER-02` | `APP-07`、`EPUB-01`—`EPUB-07`、`PDF-01`—`PDF-05` | `INV-02` |
| EPUB | `EPUB-01`—`EPUB-07` | `APP-07`、`READER-01`/`READER-02`、`REFERENCE-01`、`REFERENCE-08`—`REFERENCE-11` | `INV-02` |
| PDF | `PDF-01`—`PDF-05` | `APP-07`、`READER-01`/`READER-02`、`REFERENCE-01`、`REFERENCE-08`—`REFERENCE-11`、`CHAT-07`、`RELEASE-04` | `INV-02` |
| REFERENCE | `REFERENCE-01`—`REFERENCE-12` | `PROJECT-06`、`CHAT-01`—`CHAT-05`、`CHAT-07`、`BROWSER-07`、`EPUB-04`/`EPUB-05`、`PDF-01` | `INV-03` |
| CHAT | `CHAT-01`—`CHAT-07` | `PROJECT-03`/`PROJECT-06`、`WORKBENCH-09`、`REFERENCE-01`—`REFERENCE-12` | `INV-03`、`INV-04`、`INV-07` |
| BROWSER | `BROWSER-01`—`BROWSER-14` | `APP-12`、`WORKBENCH-15`/`WORKBENCH-23`/`WORKBENCH-27`、`REFERENCE-01`/`REFERENCE-12`、`RELEASE-04` | `INV-02`、`INV-03`、`INV-04`、`INV-07` |
| DRAWNIX | `DRAWNIX-01`—`DRAWNIX-10` | `FILES-04`/`FILES-05`/`FILES-09`/`FILES-10`、`WORKBENCH-13`/`WORKBENCH-27`、`RELEASE-04` | `INV-02`、`INV-03` |
| RELEASE | `RELEASE-01`—`RELEASE-06` | `APP-09`—`APP-12`、`PROJECT-10`、`WORKBENCH-27`、`CHAT-05`—`CHAT-07` | `INV-07`、`INV-08` |

## 4. 标准环境与测试数据

### 4.1 Run 边界与 Preflight

- Run ID使用 `stair-regression-YYYYMMDD-HHMMSS`。
- 直接测试当前工作区，以及开发版和正式包各自的当前 Workspace/Project；不复制、清理或恢复测试数据。
- 开始时记录 `git rev-parse HEAD`、`git status --short`、Host/架构、Bun和 Node版本；结束时再次记录 HEAD和工作树状态。
- Run中不修改源码。若源码发生变化，结束当前 Run并创建新 Run ID。
- 确认 Stair可启动、Computer Use可用；涉及聊天的 Case再确认至少一个真实 Provider连接可用。
- 测试使用的文件、Session、Panel和故障现场可以保留。故障影响后续操作时，改用新的测试对象。
- 只停止已确认属于 Stair的进程，不使用可能误杀其他应用或 Electron进程的宽泛命令。

有效 deep link从 Stair的 Share/Copy Link入口复制，不凭空构造未知路由。

### 4.2 每轮记录

- Run ID、分支、Commit SHA、开始/结束工作树状态和 Host/架构。
- 开始/结束时间、执行人、DEV/PKG启动命令和正式包路径。
- Gate和模块结果，以及全部 Case的逐项记录。
- 若源码变化导致重跑，记录新旧 Run ID和触发重跑的 Case。

### 4.3 测试数据

分别使用开发版与正式包中的当前 Workspace、Project和数据。Case需要特殊对象时，在对应环境的当前 Project中创建，并允许保留现场。至少准备：

- 两个 Project，以及每个 Project中的普通 Session。
- 可编辑 Markdown、第二个 Preview文件、冲突文件、空文件、BOM/CRLF文件、dotfile、常见代码文件和包含 NUL的二进制。
- 包含本轮唯一标记 `REF-<RunID>` 的文本文件；需要验证模型输入或恢复时必须使用该标记，不能凭语义相近判定。
- 精确 1 MiB与 1 MiB+1文本、501-entry目录、PNG、真实 EPUB、text-layer PDF、240页 PDF和 `.drawnix`。
- 可选择文本、输入、滚动、横向溢出和 Modal的稳定网页。
- 一个已有 Craft数据命名空间，用于验证 Stair不会读取或修改它。

不维护夹具清单、Project副本或 DEV/PKG隔离配置。破坏性 Case完成后不恢复；后续 Case改用新的文件、Session、Panel或 Project。

### 4.4 执行顺序

1. 记录当前源码和环境，完成第 5.1 节源码门禁。
2. 启动开发版，按状态依赖完成全部 `DEV` Case；执行顺序可以跨模块复用现场，但必须逐 Case记录。
3. 启动本轮新构建的正式包，完成全部 `PKG` Case；开发版可同时运行，以验证两个实例互不影响。
4. 核对 Gate、Case结果、失败证据和退出日志，形成报告。

明确写为 `AUTO` 的 Case统一引用本轮 `validate:ci`；`DERIVED` Case只核对依赖结果，不重复执行动作。

### 4.5 专项执行协议

- `FILES-11`：先在 Stair打开并保持 `conflict.md` 的旧 fingerprint；再用外部编辑器修改同一文件，最后回到 Stair编辑并触发保存。
- `CHAT-02`：从包含 `REF-<RunID>` 的 Project File创建引用，在草稿正文输入不包含该标记的 `MSG-<RunID>`；用外部编辑器修改源文件使 fingerprint失效，再发送该草稿。
- `CHAT-04`：开始真实 Agent turn，在 Stop可见期间提交第二条包含唯一文本、引用和附件的消息；进入 queue后执行 Stop并核对持久草稿。冷重启和 ack幂等性由本轮 AUTO证据补足。
- `WORKBENCH-24`：退出 DEV后编辑当前 Workspace根目录的 `workbench-layout.json`；在两个有效 Panel间插入未知 `kind` 条目，并让 `focusedPanelId` 指向它，然后重启。故障现场无需恢复。
- HMR协议（`APP-06`、`BROWSER-13`）：先计算目标源码文件 SHA-256，只执行 `touch <file>` 触发 watcher；HMR/rebuild后再次计算 SHA-256，必须相同。若 watcher不响应，该 Case为 `FAIL`，不能通过改内容绕过。

### 4.6 固定验收边界

| 边界 | 当前必须值 |
| --- | --- |
| 普通文本可编辑上限 | 1 MiB；1,048,577 bytes必须只读。 |
| Project File服务端文本/Drawnix上限 | 8 MiB。 |
| EPUB/PDF二进制上限 | 32 MiB。 |
| EPUB Archive | compressed 32 MiB、uncompressed 256 MiB、单 entry 32 MiB、5,000 entries、ratio 100。 |
| Reader State | 每文档 4 MiB。 |
| Reader 标记数量 | EPUB/PDF 每文档最多 1,000 条；PDF 每条最多 512 个 rect。 |
| EPUB inline目录 | 宽度 ≥ 840 px；小于 840 px为 overlay。 |
| PDF inline目录 | 宽度 ≥ 760 px；小于 760 px为 overlay。 |
| 长 PDF | 240 页；从第 1 页直达第 98 页；目标附近只挂载 5 页。 |
| Drawnix Agent batch | 1—50 operations。 |
| Workbench比例 | 持久化 `widthRatio` 必须精确不变；像素取整允许每条边最多 1 px。 |
| Browser Window | Toolbar 与页面视口边界误差最多 1 px；选区动作不得遮挡或误触页面。 |
| Focus快捷键 | 下一 Panel：`Cmd+Shift+]`；上一 Panel：`Cmd+Shift+[`；首尾循环。 |

阈值来自生产常量或重建契约。实现改变这些值时必须先作为产品行为变化更新本文和对应自动化测试，不能在回归报告中临时放宽。

### 4.7 最低证据

- `AUTO`：保存命令、退出码和完整输出；失败时记录 test file和 test name。
- 普通 `DEV/PKG` Case记录结果即可；视觉、Pointer、动画和 Browser几何保留截图或短录屏。
- 持久化、flush、HMR和 Runtime生命周期 Case保留相关文件、hash或日志证据。
- 所有 `FAIL`、`BLOCKED` 和故障注入 Case必须记录足以复现的操作、截图或日志。
- 一份证据可以被多个 Case引用，不要求为每个 Case重复截图。

## 5. 每轮强制执行顺序

### 5.1 源码门禁

从仓库根目录执行：

```bash
bun run validate:ci
bun run lint
bun run stair:build
git diff --check
```

四项 Gate都必须通过；新文件另用 `git diff --no-index --check /dev/null <file>` 检查 whitespace。`stair:build` 只运行一次，`RELEASE-02`/`RELEASE-03`直接引用该日志。Diff触及 Provider、Connector、鉴权或外部服务适配时再运行 `bun run test:external`，否则记 `NOT_REQUIRED`。

### 5.2 开发版 E2E

1. 精确停止已有 Stair开发进程。
2. 执行 `bun run stair:dev`，确认默认使用 `~/.stair-dev`、`stair-dev://` 和 5193，并保持终端和 Main日志可读。
3. 使用开发版当前数据完成全部 `DEV` 和 `DEV+FAULT` Case；`AUTO`结果来自 5.1，不重复操作。
4. 故障数据可以保留，必要时换新的测试对象继续。

### 5.3 正式包 E2E

1. 确认没有残留的正式包进程；开发版可以保持运行。
2. 启动本轮 `stair:build` 生成的当前 Host/架构目录包，并记录实际可执行文件路径。
3. 使用正式包当前 `~/.stair` 数据完成全部 `PKG` Case，不复用开发版数据。
4. 退出后检查残留进程和 Main日志。

## 6. APP：产品身份与应用生命周期

- `APP-01`：运行 Stair profile、branding、user-data 和 deep-link 测试。
  - Expect：开发版默认使用 `~/.stair-dev`、5193 和 `stair-dev://`；正式包继续使用 `~/.stair` 和 `stair://`；产品名、图标和禁用自动更新的约束通过。
- `APP-02`：使用当前 Stair数据启动开发版，检查设置页、日志和已恢复的 Workspace/Session。
  - Expect：只从 `~/.stair-dev` 读取并恢复开发版状态；配置、日志和 Electron userData 不写入正式包的 `~/.stair`。
- `APP-03`：同时运行 Stair 开发版与正式包，并分别打开 `stair-dev://` 和 `stair://` 的有效深链；记录已有 Craft数据摘要。
  - Expect：两个 Stair 进程与窗口同时保持运行，开发版使用 `~/.stair-dev` 和 5193，正式包使用 `~/.stair`；深链进入对应实例，Craft数据摘要不变化。
- `APP-04`：创建 Workspace、Project、Session和设置后重启。
  - Expect：Stair状态完整恢复，不出现重复、丢失或跨 Workspace数据。
- `APP-05`：在开发版使用 `stair-dev://` 深链打开有效 Session/路由，再使用格式错误或非开发版 scheme。
  - Expect：开发版 scheme正确路由；无效或非开发版 scheme不污染当前状态，也不接管正式包深链。
- `APP-06`：打开两个 Panels，保留未发送草稿和 Project Files 筛选；记录源码内容摘要后，只用 `touch` 触发 Renderer HMR。
  - Expect：HMR 前后源码内容摘要一致；React Root 复用；Panels、Focus、草稿和筛选全部保持。
- `APP-07`：打开并关闭 EPUB/PDF iframe，覆盖 `ERR_ABORTED`/子框架卸载场景。
  - Expect：子框架失败不触发主窗口重载；完整主窗口 URL 保留；无生产 Renderer 错误 fallback。
- `APP-08`：模拟真实 main-frame 加载失败和重复失败。
  - Expect：最多恢复五次，成功后计数重置；开发模式耗尽后保守停止。
- `APP-09`：使用当前 Stair数据启动本轮新构建的 `Stair.app`。
  - Expect：无 `Cannot find module`、main-process JavaScript弹窗、灰屏或源码目录依赖。
- `APP-10`：检查应用名、图标、About/菜单、bundle id、`stair://`和更新行为。
  - Expect：身份为 Stair；`io.github.build-my-work.stair`；只注册 Stair scheme；自动更新被禁用且不检查、下载或安装发布。
- `APP-11`：分别在应用未运行和已运行时打开有效 `stair://` 深链，并重复启动正式包。
  - Expect：冷启动和运行中均路由到正确目标；重复启动只聚焦既有实例，不产生重复主实例或错误协议处理。
- `APP-12`：退出正式包，检查残留进程、端口和日志。
  - Expect：正式包的 Runtime与父子进程全部退出，无未处理异常或退出期写入失败；并行运行的开发版与 5193 监听不受影响。

## 7. PROJECT：Workspace、Project 与 Session

- `PROJECT-01`：在当前数据中创建全新 Workspace。
  - Expect：同步创建且仅创建一个真实默认 Project，`defaultProjectId` 非空有效。
- `PROJECT-02`：删除默认 Project。
  - Expect：明确拒绝，无部分删除或 UI/磁盘不一致。
- `PROJECT-03`：创建 Project A、B，并从 New Session、New Session in Panel、Branch、Project File/Browser New Chat 等入口创建 Session。
  - Expect：每个 Session 从创建时就拥有预期且不可变的 `projectId`。
- `PROJECT-04`：重启后检查 A、B 的所有 Session。
  - Expect：Project 归属、列表和过滤保持，不出现无 Project 或串 Project Session。
- `PROJECT-05`：删除仍包含 Session 的非默认 Project。
  - Expect：明确拒绝；不解绑、不移动、不删除其中 Session。
- `PROJECT-06`：从 A 尝试向 B Session 通信、引用、分支或选择目标。
  - Expect：UI 不提供非法目标；构造请求时服务端仍拒绝，无部分消息或草稿。
- `PROJECT-07`：分别加载仅缺失 Project 身份的旧 Workspace/Session，以及携带显式不存在或跨 Workspace `projectId` 的伪造数据。
  - Expect：缺失身份只按已冻结规则确定性回填到真实 General/default Project；显式非法身份仍拒绝或隔离，不做可选字段放宽或跨 Project 猜测。
- `PROJECT-08`：核对本轮 Project/Session storage、create-managed-session和 project-communication自动化结果。
  - Expect：直接创建的 Session归入真实默认 Project；运行时拒绝缺失 Project身份的 Session；服务端拒绝跨 Project通信。
- `PROJECT-09`：删除一个无 Session 的非默认 Project；删除前让其拥有持久布局、Browser Runtime并处于当前 Focus。
  - Expect：删除成功；Project、布局和 Runtime 一并清理，UI通过 Workbench命令落到有效 Project/Focus；重启不复活任何残留。
- `PROJECT-10`：在当前数据中创建新的 Workspace、第二 Project和 Session。
  - Expect：新 Workspace仅创建一个有效默认 Project；第二 Project的 Session从创建到重启后始终保留自身 `projectId`，两个 Project列表互不串入。

## 8. WORKBENCH：Panel、布局与交互

- `WORKBENCH-01`：在空 Workbench 创建 New Session。
  - Expect：Session 成为 Primary，不创建 Auxiliary。
- `WORKBENCH-02`：点击未打开的普通 Session。
  - Expect：替换 Primary；Panel 数不增加。
- `WORKBENCH-03`：点击已打开的 Primary/Auxiliary Session。
  - Expect：只聚焦原 Panel，Panel 身份、数量和顺序不变。
- `WORKBENCH-04`：使用 New Session in Panel。
  - Expect：新增且仅新增一个 Auxiliary；Primary不变；新 Session与来源 Session属于同一 Project。
- `WORKBENCH-05`：从 Primary、中间 Auxiliary、最后 Auxiliary 分别 Branch。
  - Expect：新 Session 按 `afterSessionId` 紧邻来源插入，其他 Panel 顺序不变。
- `WORKBENCH-06`：依次关闭未聚焦、聚焦和 Primary Panel。
  - Expect：非聚焦关闭时 Focus不变；聚焦 Auxiliary关闭后优先同索引右邻、再左邻、再 Primary；聚焦 Primary关闭后落到首个 Auxiliary，否则为空。
- `WORKBENCH-07`：将已有 Session Panel 横向滚出视口，再从列表点击它。
  - Expect：Workbench 自身横向滚动使其可见，不滚动页面根节点。
- `WORKBENCH-08`：在 Collection、Settings、Sources、Skills、Board 等 Shell 页面间切换，并收起或展开 Navigator。
  - Expect：这些入口保持 Shell surface；只改变 Shell/Navigator 展示，不创建物理 Panel，不修改 Workbench、Project、Session 或 Focus。
- `WORKBENCH-09`：后台 Session 产生消息、状态变化和任务事件。
  - Expect：内容更新，但布局、Focus 和 Navigator 不变。
- `WORKBENCH-10`：切换 Project A/B，再切回。
  - Expect：切换到对应 Workbench 上下文；Session 列表只包含当前 Project。
- `WORKBENCH-11`：创建未命名、无消息、无草稿的空 Session，然后离开所有可见 Panel。
  - Expect：空 Session 自动清理。
- `WORKBENCH-12`：对有消息、有草稿或被其他可见 Panel 使用的 Session重复上一步。
  - Expect：Session 不被误清理。
- `WORKBENCH-13`：A 设置 Primary + 文件 + Drawnix 三 Panel；B 设置不同 Primary + 文件布局和 Focus。
  - Expect：每个 Project 独立保存语义布局、Auxiliary 顺序、Focus、Preview和宽度。
- `WORKBENCH-14`：完整重启后依次进入 A、B。
  - Expect：两个 Project 分别恢复有效布局，不互相覆盖。
- `WORKBENCH-15`：比较重启前后 Project File Preview、固定文件和 Drawnix Panel。
  - Expect：各 Panel按语义身份恢复，Preview仍唯一；临时编辑器实例 ID不持久化或复用。
- `WORKBENCH-16`：记录持久化 `widthRatio` 后反复切换 Sidebar、Navigator和 Project Files。
  - Expect：`widthRatio` 前后精确相同；渲染像素差每条边不超过 1 px。
- `WORKBENCH-17`：Pointer Resize 一个 Auxiliary并提交；再次 Resize 后按 Escape。
  - Expect：只修改目标 Panel；提交持久化；取消恢复原比例；Primary 固定。
- `WORKBENCH-18`：Pointer 拖拽多个 Auxiliary 排序。
  - Expect：视觉连续、顺序正确、Focus稳定；重启保持顺序。
- `WORKBENCH-19`：仅用键盘聚焦 reorder handle并执行 DnD。
  - Expect：Auxiliary按目标索引移动、有可见 Focus；Primary没有 reorder handle且不可重排。
- `WORKBENCH-20`：使用 `Cmd+Shift+]`/`Cmd+Shift+[`，覆盖横向视口外 Panel和首尾。
  - Expect：Focus按 Primary→Auxiliary语义顺序移动、首尾循环并自动显露，无 Keyboard Trap。
- `WORKBENCH-21`：在单 Panel、多 Panel、Navigator 开/关时切换 Compact。
  - Expect：Compact 只改变展示行为，不丢 Panel、比例、Focus或语义布局。
- `WORKBENCH-22`：在正常 Motion 和系统 Reduced Motion 下切换、排序和 Resize。
  - Expect：行为一致；Reduced Motion 关闭非必要动画但不改变状态转换。
- `WORKBENCH-23`：在 100% 和 200% Zoom 下仅用键盘完成导航、排序、关闭和恢复。
  - Expect：两个 Zoom级别下所有控件均可通过键盘到达且 Focus可见；排序、关闭和恢复结果一致。
- `WORKBENCH-24`：在当前 Workspace根目录的 `workbench-layout.json` 中加入一个无效 Panel条目后重启。
  - Expect：只丢弃无效条目；有效邻居、Focus fallback和其他 Project布局保留。
- `WORKBENCH-25`：Workspace 切换时延迟旧 layout读取，并模拟瞬时读取失败。
  - Expect：旧响应不能覆盖新 Workspace；失败采用保守合并或重试，不把空读取写回磁盘。
- `WORKBENCH-26`：同一 Workspace 的两个 Renderer Window从相同 baseline分别修改不同 Project布局并先后写入。
  - Expect：两个独立 Project变更都保留；服务端按 client baseline合并，不由后写窗口回滚另一 Project。
- `WORKBENCH-27`：建立包含 Session、文件和 Drawnix 的多 Panel布局后重启。
  - Expect：布局、比例、顺序、Focus以及文件和 Drawnix语义身份恢复。

## 9. FILES：Project Files 与文本编辑

- `FILES-01`：展开普通目录和 `tree/many`，刷新和折叠子目录。
  - Expect：目录按需加载；501-entry目录明确显示 500-entry截断状态；刷新准确，无重复节点或整树失焦。
- `FILES-02`：搜索根目录和深层文件，再清空筛选。
  - Expect：结果同时包含预设的根目录和深层匹配文件且无不匹配项；清空筛选后恢复筛选前的节点与展开状态。
- `FILES-03`：在根目录或子目录创建普通文件和目录，并测试空名、`.`、`..`、重名和包含路径分隔符的名称。
  - Expect：合法创建成功并刷新；每个非法输入就地拒绝且无半创建节点。
- `FILES-04`：普通点击 `alpha.md`，再点击 `beta.md`。
  - Expect：唯一 Preview 原位复用，Panel 数不增加，Primary 不变。
- `FILES-05`：对文件执行 Open in New Panel，并与 Preview 并存。
  - Expect：新增持久 Auxiliary；两个 Panel 身份和内容独立。
- `FILES-06`：打开 PNG、常见代码或配置、dotfile、`unknown.bin`、1 MiB文本和 1 MiB+1文本。
  - Expect：图片可预览；支持类型和 1 MiB文本可编辑；二进制与 1 MiB+1文本明确只读，不误解码。
- `FILES-07`：点击 Markdown Project相对链接、`https:`链接、`javascript:`/`data:`/`file:`和 `../../` 越界链接。
  - Expect：相对链接进入 Project File命令；`https:`遵守偏好；危险 scheme和越界链接全部拒绝。
- `FILES-08`：编辑文本并等待 800 ms 自动保存，关闭重开。
  - Expect：保存一次且内容一致；无重复写、旧状态覆盖或 dirty 残留。
- `FILES-09`：输入最后一段后立即替换 Preview、关闭 Panel、切换 Project/Workspace和关闭窗口。
  - Expect：每个破坏性动作先 flush；成功时最后输入完整落盘。
- `FILES-10`：在 flush 中制造写入失败，再执行替换、关闭、Project/Workspace 切换和更新安装。
  - Expect：所有动作被 veto；主进程不先提交窗口/Project 映射或进入退出安装。
- `FILES-11`：Stair 中产生 dirty 草稿，外部修改 `conflict.md` 后触发保存。
  - Expect：显示 fingerprint 冲突，不静默覆盖任一版本。
- `FILES-12`：在冲突状态 Reload，再继续编辑和保存。
  - Expect：Reload明确丢弃内存版本并显示外部磁盘内容；随后编辑可再次保存，且不残留错误提示、timer或永久 dirty状态。
- `FILES-13`：在冲突或保存失败时执行 Save Draft As。
  - Expect：导出当前内存文本，不要求先 Reload，不被磁盘旧内容替换。
- `FILES-14`：覆盖空文件、BOM、CRLF/LF、多个末尾换行、NUL 和权限位。
  - Expect：文本精确保真；NUL 被拒绝；原权限与换行策略保持。
- `FILES-15`：请求绝对路径、`..`、symlink、special file、越界路径和跨 Workspace Project。
  - Expect：服务端最终拒绝；错误码经传输层保持，工作目录外无读取或写入。
- `FILES-16`：对同一文件并发保存并在原子替换前失败。
  - Expect：同文件串行、临时文件原子替换；无截断文件或旧写覆盖新写。

## 10. READER：EPUB/PDF 共享能力

- `READER-01`：损坏或超限 Reader 状态文件，并进行并发 progress/highlight mutation。
  - Expect：损坏状态隔离后重新开始；原子写与同文档串行；4 MiB、字段和数量预算生效。
- `READER-02`：测试超过 32 MiB 的 EPUB/PDF 和 fingerprint 变化。
  - Expect：二进制上限生效；旧 locator或高亮不会错误应用到新内容。

## 11. EPUB

EPUB 完整验收范围为本节 `EPUB-01`—`EPUB-07`、第 10 节的 `READER-01`/`READER-02`和主窗口生命周期 `APP-07`；跨内容引用动作按第 13 节执行，不在本节复制。

- `EPUB-01`：从 Project Files打开压缩 `mimetype` 的真实 EPUB。
  - Expect：EPUB作为 Auxiliary打开且 Primary不变；目录、正文、样式、图片和内部链接完整加载。
- `EPUB-02`：连续阅读、目录跳转、内部链接往返。
  - Expect：滚动、目录跳转和内部链接到达对应章节并同步当前目录高亮；返回后恢复原阅读位置，且主窗口不重载、Workbench状态不变。
- `EPUB-03`：分别在 839 px和 840 px EPUB Auxiliary打开目录。
  - Expect：839 px使用 overlay且不挤压正文或邻居；840 px切换为 inline。
- `EPUB-04`：真实 Pointer 拖选 EPUB 文本；测试 pointerdown、折叠选区、Escape、滚动、resize 和 view unload。
  - Expect：拖选期间锚点稳定；动作后工具条立即关闭且无失效监听器。
- `EPUB-05`：新增多个 EPUB 划线，使用列表 reveal、重复 reveal、删除和导出 Markdown。
  - Expect：每条划线显示红色波浪线并归入最深目录节点；连续 reveal均回到原文；删除后正文和列表同时消失；导出包含作者或相对路径、目录和逐行引用文本。
- `EPUB-06`：关闭重开并重启应用。
  - Expect：EPUB 进度、目录位置和划线按 Project、路径和 fingerprint 恢复。
- `EPUB-07`：测试 EPUB 路径穿越、加密、ZIP64、条目、字节、膨胀比和无效 container。
  - Expect：所有危险 Archive 被服务端拒绝，不解压到 Project 或应用目录。

## 12. PDF

PDF 完整验收范围为本节 `PDF-01`—`PDF-05`、第 10 节的 `READER-01`/`READER-02`和主窗口生命周期 `APP-07`；跨内容引用动作按第 13 节执行，不在本节复制。

- `PDF-01`：从 Project Files打开 text-layer PDF，拖选并新增、定位、删除多个划线，再导出 Markdown。
  - Expect：PDF作为 Auxiliary打开且 Primary不变；选区文本与原文一致；每条划线显示红色波浪线并可重复 reveal到原页原文；删除后正文和列表同时消失；导出包含文件、页码和引用文本。
- `PDF-02`：使用带 pageLabels 的 PDF 查看页头、目录和划线列表，执行目录跳转并继续滚动。
  - Expect：三处使用相同印刷页码；目录高亮和当前页随跳转、滚动同步；无标签时回退物理页码。
- `PDF-03`：分别在 759 px和 760 px PDF Auxiliary打开目录。
  - Expect：759 px使用 overlay并收起已有 inline目录；760 px切换为 inline。
- `PDF-04`：在 240 页 PDF 从第 1 页直达第 98 页并滚动。
  - Expect：只挂载目标附近 5 页，其他页保留稳定占位；不一次挂载全文，滚动位置不跳变。
- `PDF-05`：关闭重开和应用重启后检查 PDF。
  - Expect：阅读进度、目录和划线恢复，且不串到另一 Project、文件或 fingerprint。

## 13. REFERENCE：选择引用与跨内容动作

- `REFERENCE-01`：分别从文本、EPUB和PDF拖选，并对每种来源执行 Add Chat、New Chat和 Add Note；聊天选区由 `REFERENCE-12`覆盖。
  - Expect：三种来源都生成当前 `projectId`、原始 quote和可回跳 locator；Add Chat把引用加入所选 Session草稿且不改布局；New Chat创建同 Project Auxiliary并更新来源 Chat Target；Add Note把经过转义的来源和完整选区追加到所选 Markdown。
- `REFERENCE-02`：Project File 选择 Add Chat，并选择当前 Project 已有 Session。
  - Expect：目标草稿获得引用；当前 Workbench Focus、Panel 数或顺序不变；B Session 不可选。
- `REFERENCE-03`：Project File 选择 New Chat。
  - Expect：创建同 Project Session，在来源文件 Panel 后新增 Auxiliary，并原子更新文件 Chat Target。
- `REFERENCE-04`：New Chat 创建 pending 时把 Focus 从来源文件 A 切到 Panel B。
  - Expect：新 Session 仍紧邻 A；不会按完成时 Focus 插入。
- `REFERENCE-05`：pending 时让 Preview A 被文件 B 替换。
  - Expect：操作失败；B Chat Target 不变；新空 Session、Panel和引用草稿全部回滚；无成功 toast。
- `REFERENCE-06`：pending 时关闭来源 Panel。
  - Expect：操作失败并清理新 Session、Panel和草稿，不插到当前 Focus 后。
- `REFERENCE-07`：pending 时切换到 Project B。
  - Expect：拒绝当前和 parked layout 写入；A/B 布局均不残留新 Panel或 target。
- `REFERENCE-08`：连续两次点击同一个 Reference Preview。
  - Expect：两次点击都显露来源 Panel并回到同一原始选区；第二次不需要关闭、重开或重新挂载来源文件。
- `REFERENCE-09`：不选择 Chat Target，Add Note选择 `existing.md` 并写入；选中另一段文本再次点击 Add Note；再用箭头打开最近目标，搜索已有 Markdown和创建新 Markdown。重开窗口后重复，并切换 Project 检查隔离。
  - Expect：第二次 Add Note直接追加到上次成功目标；重开仍记住，其他 Project不复用；已有 Chat专属目标优先。箭头打开 Picker且预选上次目标，最近列表包含它；取消或写入失败不覆盖记忆，目标删除后重新选择。搜索和创建均使用同一 Picker；目标 Markdown追加经过转义的来源名称、位置和完整引用文本，不生成可执行 Markdown。
- `REFERENCE-10`：Add Note 期间替换路径为 symlink/reparse point、跨 Project 路径或并发追加。
  - Expect：服务端最终授权；固定目录句柄内读写，同一目标内容不丢失或越界。
- `REFERENCE-11`：打开 Add Note 后取消。
  - Expect：当前选区和动作上下文保留，可再次执行。
- `REFERENCE-12`：对聊天选区执行 Add Chat、New Chat、Add Note，并右键用户消息。
  - Expect：Add Chat把引用加入所选 Session草稿且不改布局；New Chat创建同 Project Auxiliary；Add Note把完整选区追加到所选 Markdown；右键用户消息不弹出选区菜单；目标列表不包含归档或隐藏 Session。

## 14. CHAT：草稿、发送与 Agent Turn

- `CHAT-01`：引用源只包含 `REF-<RunID>`，消息正文只包含 `MSG-<RunID>`；Add Chat后切换 Panel再返回并发送，完成后重启 Stair、重新打开 Session，再发送“只回复上一条引用中的唯一标记”。
  - Expect：Panel切换后草稿正文和引用预览不变；发送后的用户消息只显示正文与引用预览；重启后引用仍可回到原选区；模型回复严格等于 `REF-<RunID>`；输入框和用户消息不显示 `<stair_reference_data`、`locator`或其他内部 JSON。
- `CHAT-02`：按4.5节协议发送 fingerprint已失效的 Project File引用。
  - Expect：发送明确失败；草稿恢复为原 `MSG-<RunID>`和原引用预览，不静默清空、不产生用户消息或 Agent turn。
- `CHAT-03`：覆盖恢复、Branch seed、PromptBuilder和摘要预算边界。
  - Expect：可见文本与引用上下文分开预算；引用 marker或 JSON 永不被截断成半块。
- `CHAT-04`：Agent 运行中发送包含文本、引用和附件的 queued 消息，然后 Stop；自动化补充冷重启恢复、optimistic ID 到 server ID确认和重复或陈旧 ack。
  - Expect：Stop 始终可用；完整文本、引用和附件先落入持久草稿；只有匹配 ack 才从 UI或持久消息删除 queued bubble，重复或陈旧 ack 为 no-op，冷重启不丢数据或自动误发。
- `CHAT-05`：正式包实际发送一条带引用消息并要求模型复述精确上下文。
  - Expect：Provider回复包含引用中的 `REF-<RunID>`；重启后用户消息仍显示同一引用预览，点击后回到原始选区。
- `CHAT-06`：使用可用 Claude/Pi连接各完成一次真实消息，要求回复唯一随机短语。
  - Expect：正式包内实际 Agent runtime 可启动并得到精确回复；无源码目录 module fallback。
- `CHAT-07`：正式包先发送一条带文本、PDF和 Browser唯一标记引用的消息并等待 Provider回复；再在下一次 Agent运行中排队一条同结构消息，执行 Stop后重启。
  - Expect：首条用户消息和持久记录保留三条引用，Provider分别复述三个唯一标记；Stop后未确认的 queued正文与三条引用恢复到草稿，重启后仍存在且不会自动误发。

## 15. BROWSER：原生 Browser

独立 BrowserWindow 的几何、Pointer、目标绑定、隐藏恢复和关闭必须保存截图或等价视觉证据。

- `BROWSER-01`：通过顶部 Browser入口或 Built-in Link 打开 Browser。
  - Expect：只新增独立 BrowserWindow；从 Chat打开时显式绑定该 Chat，从手动入口打开时只绑定当前 Project；Workbench布局不变。
- `BROWSER-02`：在本地页点击、输入、选择和纵向滚动。
  - Expect：Pointer 坐标与视觉页面一致，无偏移、穿透或失焦。
- `BROWSER-03`：调整独立 BrowserWindow尺寸并记录 Toolbar与页面视口边界。
  - Expect：每条边误差不超过 1 px；录屏中没有旧位置残影、越界帧或 Pointer偏移。
- `BROWSER-04`：展开或收起主窗口 Navigator、Sidebar 和 Project Files，并在主窗口 Panel间切换 Focus。
  - Expect：独立 BrowserWindow的尺寸、页面和 Project/Chat归属不变；主窗口 Focus不改变 Browser宽度。
- `BROWSER-05`：从顶部 Browser入口隐藏并再次显示同一窗口。
  - Expect：恢复同一 Runtime、URL、滚动位置、目标 Chat和最新 Note目标；不会创建 phantom Workbench项。
- `BROWSER-06`：从 Browser打开统一 Note目标选择器，分别确认和取消。
  - Expect：主窗口显示与 PDF/EPUB相同的 Picker；确认或取消后焦点返回 Browser；取消保留选区且不显示错误。
- `BROWSER-07`：从 Browser 页面真实选区执行 Add Chat、New Chat和 Add Note。
  - Expect：三个动作都使用当前 Project、URL和完整选区生成同一引用；Add Chat真实写入目标 Chat草稿；New Chat创建同 Project Session并更新 Browser target；Add Note主按钮写当前目标、箭头打开统一 Picker，并从磁盘验证 Markdown追加结果。
- `BROWSER-08`：分别在 Project A/B创建多个 Browser，再切换主窗口 Project。
  - Expect：顶部入口只列出当前 Project的 Browser；每个窗口保持原 Project/Chat归属，不能被另一 Project选择或写入。
- `BROWSER-09`：使用窗口关闭、顶部隐藏/显示和终止动作，并检查 Main日志与 Runtime列表。
  - Expect：普通关闭只隐藏且可恢复；终止才销毁页面、Toolbar和 Runtime；重复动作幂等且不影响其他 Browser。
- `BROWSER-10`：在 Note Picker pending、Chat删除、Project删除、目标重命名或换 Note、主窗口关闭和 Browser隐藏/恢复间制造异步竞态。
  - Expect：不写入错误 Project/Chat；删除 Chat会清除手动目标或销毁 Chat-owned窗口；删除 Project清理其全部 Browser；恢复时刷新目标元数据，失败明确显示而不伪装成取消。
- `BROWSER-11`：新增、列出、重启检查并删除 Bookmark。
  - Expect：Bookmark以 Workspace持久化，重启前后顺序和 URL均一致，删除后列表与持久数据都不残留。
- `BROWSER-12`：分别选择 System Browser 和 Built-in Browser，然后点击聊天、Markdown或文档网页链接。
  - Expect：System 只打开系统浏览器且不创建 Runtime；Built-in 新增并聚焦独立 BrowserWindow。
- `BROWSER-13`：记录三类 preload 源码内容摘要，只用 `touch` 依次触发 toolbar、page、overlay preload 重建。
  - Expect：重建前后源码内容摘要一致；三类 preload 都被监听，当前 Browser 不进入损坏的半更新状态。
- `BROWSER-14`：核对本轮 Browser capability、tool detection、selection、geometry、broadcast和 release自动化结果。
  - Expect：Main独占 BrowserWindow与 WebContentsView生命周期；Renderer只提供全局 Chat/Note应用能力，不存在嵌入式展示、reparent、park或 presentation路径。

## 16. DRAWNIX：画布与 Agent Mind Map

- `DRAWNIX-01`：从 Project Files 创建 `.drawnix`；普通点击和 Open in New Panel。
  - Expect：文件在当前 Project；普通点击复用 Preview，显式动作才新增 Auxiliary。
- `DRAWNIX-02`：使用真实 Pointer或键盘编辑，等待 autosave并关闭重开。
  - Expect：停止编辑 800 ms后磁盘包含本次改动；关闭前的最后改动经 flush落盘；重开后的 Canvas节点、文本和位置与关闭前一致。
- `DRAWNIX-03`：制造 fingerprint 冲突、写入失败、重试和 8 MiB 边界。
  - Expect：使用 Project File Controller 语义；冲突不覆盖，重试后保存；普通文本仍保持 1 MiB。
- `DRAWNIX-04`：在同 Project Session 要求仅调用 `mindmap_read` 读取当前 Board。
  - Expect：返回当前 live Canvas 的根节点或结构，不依赖磁盘旧快照。
- `DRAWNIX-05`：调用 `mindmap_update` 修改根节点并新增子节点，再次 read。
  - Expect：Canvas 即时更新，自动保存后磁盘与 read一致。
- `DRAWNIX-06`：同一文件打开两个可见 Canvas后调用工具，再关闭一个重试。
  - Expect：先返回 `MINDMAP_AMBIGUOUS_BOARD`；关闭到单视图后无需重启恢复。
- `DRAWNIX-07`：切到 Project B，从 B Session读取只在 A 打开或 parked 的 Board。
  - Expect：返回 `MINDMAP_NOT_OPEN`；A/B 文件和布局均不被跨界修改。
- `DRAWNIX-08`：以相同 `changeSeq` 并发更新，测试超过 50 个操作和批内失败。
  - Expect：只有一个并发更新成功；超限拒绝；批内失败完整回滚并保持单一历史批次。
- `DRAWNIX-09`：同时发生用户编辑、Agent update和 Presentation状态保存。
  - Expect：用户内容、Presentation和 Agent outline序列独立，不互相覆盖。
- `DRAWNIX-10`：检查 Tool Execution依赖与路由。
  - Expect：Session不可变 `projectId` 决定能力路由；Panel ID不进入领域模型；工具不导入或修改 Workbench State。

## 17. RELEASE：构建、目录包与跨平台资格

- `RELEASE-01`：聚合第 5.1 节全部 Gate。
  - Expect：四项固定 Gate必须 `PASS`；`test:external`必须为 `PASS`或有依据的 `NOT_REQUIRED`。
- `RELEASE-02`：引用第 5.1 节本轮唯一一次 `bun run stair:build`。
  - Expect：从当前源码生成当前架构目录包；未复用旧 release、Pi、Koffi或错误架构 runtime。
- `RELEASE-03`：从 `RELEASE-02` 的同一构建日志，以及 `validate:ci` 内的 Electron asset validation子步骤提取 afterPack或资产校验结果。
  - Expect：Claude SDK、目标架构 binary、Session MCP、Pi Agent Server、Koffi、Bun、uv、ripgrep和 PNG图标全部存在且架构正确。
- `RELEASE-04`：完成文本创建、编辑、保存，text-layer PDF选区，Browser Pointer或 Scroll，以及 Drawnix编辑。
  - Expect：文本重开后保留最后输入；PDF选区与原文一致；Browser点击或滚动作用于指针所在页面且无偏移；Drawnix重开后保留编辑内容。
- `RELEASE-05`：在 Windows arm64或 x64实机用新配置执行 Project Note追加、symlink或 reparse拒绝和冷启动聊天 smoke。
  - Expect：Project Note只写入 Project内目标；symlink或 reparse越界被拒绝且外部文件不变；目标架构 runtime启动并准确回复唯一短语；其他 Host按平台白名单记 `N/A`。
- `RELEASE-06`：在 Linux arm64或 x64实机用新配置执行冷启动、聊天、文本保存和 Browser smoke。
  - Expect：目标架构 runtime冷启动无缺失模块；聊天准确回复唯一短语；文本重开后保留最后输入；Browser点击命中可见目标；退出后无 Stair残留进程；其他 Host按平台白名单记 `N/A`。

当前 Host的日常 Full Run允许 `RELEASE-05`/`RELEASE-06`按平台白名单记 `N/A`。正式外部分发前另做发布资格补充：用空配置复跑 `APP-09`/`PROJECT-10`，在目标 Windows或 Linux实机执行 `RELEASE-05`/`RELEASE-06`，并完成签名与 notarization。缺少这些证据时不能宣称跨平台 Release Ready，但不阻塞当前 Host的日常回归。

## 18. 跨模块架构不变量

这些规则只聚合上述产品模块结果，不增加一轮重复操作。

| Rule ID | 判定 | 依赖 | Expect |
| --- | --- | --- | --- |
| INV-01 | DERIVED | 聚合 `WORKBENCH-01`—`WORKBENCH-05`。 | 普通导航只聚焦已有 Panel或替换 Primary，绝不新增 Auxiliary。 |
| INV-02 | DERIVED | 聚合 `FILES-04`/`FILES-05`、`EPUB-01`、`PDF-01`、`BROWSER-01`和 `DRAWNIX-01`。 | 非 Session内容只使用 Auxiliary，Primary不被静默替换。 |
| INV-03 | DERIVED | 聚合 `PROJECT-03`/`PROJECT-06`、`BROWSER-08`和 `DRAWNIX-07`。 | Workspace → Project → Session所有权始终成立；跨 Project数据不可见、不可选、不可写。 |
| INV-04 | DERIVED | 聚合 `WORKBENCH-09`和 `BROWSER-10`。 | Primary、Auxiliary顺序、Focus、Navigator、Project和 Chat Target不改变。 |
| INV-05 | DERIVED | 聚合本规范全部 `+FAULT` Case。 | 仅当每个 `+FAULT` Case均为 `PASS` 时为 `PASS`；任一失败、阻断或缺证据均原样传播。 |
| INV-06 | DERIVED | 聚合 `WORKBENCH-06`/`WORKBENCH-11`/`WORKBENCH-12`/`WORKBENCH-14`和 `APP-12`。 | 非空 Session生命周期独立于 Panel；仅符合空 Session清理条件的 Session被删除。 |
| INV-07 | DERIVED | 聚合当前 Host适用且已执行的全部 DEV或 PKG Case及本轮退出日志；按平台白名单为 `N/A` 的 Case不参与派生。 | 所有参与聚合的 Case均为 `PASS`，且无崩溃、灰屏、无限重载、main-process JavaScript弹窗或未处理异常；任一 `FAIL`或 `BLOCKED`原样传播。 |
| INV-08 | DERIVED | 聚合 `APP-01`—`APP-05`、`APP-10`和 `APP-11`。 | Stair只使用自身的数据命名空间、端口、协议和产品资源；无效或其他产品输入不改变 Stair状态。 |

## 19. 自动化追踪入口

`bun run validate:ci` 会动态发现源码测试并排除 `release`、`dist` 和 `node_modules`。其完整输出是本轮所有 `AUTO` Case的共同证据。

- Gate失败时记录失败的 test file和 test name；聚焦命令只用于定位和复测。
- `AUTO+FAULT`、安全边界和原子性 Case必须能从 Gate输出定位到对应测试。
- `DERIVED` Case或规则引用 Gate或具体 Case结果，不执行第二套 smoke。
- 自动化文件调整时更新下方模块导航，不按开发阶段维护另一份索引。

### 19.1 AUTO Case / DERIVED Case与规则精确证据映射

`validate:ci` 必须整体通过；此外，验收人员必须在本轮输出中定位下表所列的 test file和精确 test name。下表是逐 Case最低证据，不是缩减源码门禁的测试白名单。

| Case / Rule | 本轮必须定位的证据 |
| --- | --- |
| APP-01 | `scripts/stair-profile.test.ts :: 提供固定产品身份和独立默认值`；`stair-user-data.test.ts :: Stair 使用独立配置、Electron userData、图标和深链协议`；`deep-link-routing.test.ts :: Stair 入口接受独立 stair scheme` |
| APP-08 | `window-manager-renderer-lifecycle.isolated.ts :: retries the complete main-frame URL at most five times without a production fallback`；`window-manager-renderer-lifecycle.isolated.ts :: resets recovery after a successful load and retains the latest in-page URL` |
| PROJECT-07 | `default-project.test.ts :: isolates persisted Sessions with nonexistent or cross-Workspace Project ownership`；`default-project.test.ts :: loads old Sessions under the default Project instead of hiding or replacing them` |
| PROJECT-08 | `default-project.test.ts :: assigns every direct storage constructor to the default Project`；`create-managed-session.test.ts :: rejects a runtime Session without Project ownership`；`project-communication.test.ts :: rejects a target in another Project` |
| WORKBENCH-25 | `workbench-persistence.test.ts :: does not enable writes after a failed restore read`；`workbench-persistence.test.ts :: drops a stale restore response after switching Workspace`；`workbench-persistence.test.ts :: retries a transient restore read before enabling persistence` |
| WORKBENCH-26 | `workbench-layout.test.ts :: merges independent Project changes from two windows that read the same baseline` |
| FILES-10 | `workbench-commands.test.ts :: flush 失败时拒绝替换 Preview、关闭 Panel 和切换 Project`；`window-close-project-files.isolated.ts :: flush 失败时保持窗口打开且不确认关闭`；`auto-update-install.isolated.ts :: flush 失败时中止 quitAndInstall 并恢复可重试状态`；`project-files.test.ts :: 旧文档 flush 失败时 veto Workspace 切换` |
| FILES-14 | `project-files.test.ts :: 逐字保留末尾空行，并允许把文件清空`；`project-files.test.ts :: 拒绝写入随后无法按文本读取的 NUL 内容` |
| FILES-15 | `project-files.test.ts :: 拒绝绝对路径和越界路径`；`project-files.test.ts :: 拒绝符号链接或 Windows junction 路径`；`project-files.test.ts :: 只允许 RPC 上下文所属 Workspace 中的 Project`；`error-codes.test.ts :: preserves Project File conflict codes over the wire` |
| FILES-16 | `project-files.test.ts :: 串行化同一 fingerprint 的并发保存且不残留临时文件`；`project-files.test.ts :: 原子替换失败时清理临时文件且不改变目标` |
| READER-01 | `epub-state.test.ts :: serializes concurrent progress and highlight mutations without lost updates`；`epub-state.test.ts :: rejects a mutation before it exceeds the state byte budget`；`epub-state.test.ts :: quarantines corrupt persisted progress, highlights, timestamps, and oversized state`；`pdf-state.test.ts :: serializes concurrent mutations and keeps no-ops revision-free`；`pdf-state.test.ts :: rejects a mutation before it exceeds the state byte budget`；`pdf-state.test.ts :: quarantines corrupt and oversized persisted state` |
| READER-02 | `project-files.test.ts :: 拒绝读取超过 32 MiB 上限的 Reader 二进制`；`epub-state.test.ts :: isolates state by source fingerprint`；`pdf-state.test.ts :: isolates state by source fingerprint` |
| EPUB-07 | `epub-archive-validator.test.ts :: rejects traversal, encrypted entries, and ZIP64 markers`；`epub-archive-validator.test.ts :: rejects declared entry, total, count, and compressed-size limits`；`epub-archive-validator.test.ts :: enforces actual per-entry, cumulative, and ratio limits` |
| REFERENCE-04 | `workbench-commands.test.ts :: New Chat 等待期间焦点切到其他 Panel，仍紧邻来源文件 Panel 原子提交` |
| REFERENCE-05 | `workbench-commands.test.ts :: New Chat 等待期间 Preview 被替换时拒绝提交且不修改新文件 target` |
| REFERENCE-06 | `workbench-commands.test.ts :: New Chat 等待期间来源 Panel 被关闭时拒绝提交且不残留 Session Panel` |
| REFERENCE-07 | `workbench-commands.test.ts :: New Chat 等待期间切换 Project 时拒绝写入当前或 parked layout` |
| REFERENCE-10 | `project-notes.test.ts :: 只接受 Project 内现有 Markdown/文本普通文件并拒绝软链接或 junction`；`project-notes.test.ts :: 串行并发追加且不丢失任何引用`；`project-notes.test.ts :: 父目录在最终打开前被替换为软链接或 junction 时不会跟随`；`project-notes.test.ts :: RPC 以当前 Workspace 和 Project 为授权边界，并校验 Chat 引用来源` |
| CHAT-03 | `prompt-builder-context-split.test.ts :: buildContextParts equals [...volatile, ...stable] (Claude path stays byte-identical)`；`conversation-summary.test.ts :: never truncates a reference data block at message or transcript limits`；`recovery-reference-context.test.ts :: keeps reference data intact when PromptBuilder truncates recovery content` |
| BROWSER-10 | `browser-pane-manager.test.ts :: destroys only native runtimes owned by the deleted Project`；`browser-pane-manager.test.ts :: clears a manual Browser target when a remote Chat is deleted`；`browser-pane-manager.test.ts :: refreshes the target Chat and Note when a Browser window is shown again`；`browser-window-scope.test.ts :: cleans the deleted Project on every Browser-capable remote Workspace client` |
| BROWSER-14 | `browser-tool-detection.test.ts :: does not activate for browser_tool help/open/release/teardown commands`；`browser-selection.test.ts :: normalizes bounded selection text and creates a Project-scoped reference`；`browser-broadcast.test.ts :: rejects an action against a Browser in another Project`；`browser-application-capability.test.ts :: delegates Add Note to the shared renderer flow even without a current target`；`sessions-browser-release.test.ts :: clears visuals and unbinds session ownership` |
| DRAWNIX-03 | `drawnix-document-controller.test.ts :: vetoes flush after a save failure and never claims the board was saved`；`drawnix-document-controller.test.ts :: retries a transient save failure without discarding the live board`；`project-files.test.ts :: 允许保存达到 8 MiB 上限的 Drawnix 文档并拒绝超限内容` |
| DRAWNIX-08 | `drawnix-document-controller.test.ts :: allows only one of two concurrent updates with the same outline sequence`；`drawnix-document-controller.test.ts :: rolls back a failed Agent batch instead of leaving an untracked partial mutation`；`drawnix-document-controller.test.ts :: rejects a batch with more than 50 operations before changing the board` |
| DRAWNIX-10 | `drawnix-project-scope.test.ts :: stamps every capability request with the invoking Session Project`；`drawnix-project-scope.test.ts :: keeps Agent tool execution independent from Renderer Workbench state`；`drawnix-board-registry.test.ts :: routes reads and updates only to the exact Project and path` |
| RELEASE-01 | 本轮 `validate:ci`、`lint`、`stair:build`和 whitespace Gate结果。 |
| RELEASE-02 | `scripts/stair-profile.test.ts :: 提供开发、构建和打包入口以及独立资源`，以及同一 Run的 `bun run stair:build`完整日志。 |
| RELEASE-03 | `scripts/stair-profile.test.ts :: 暂存并验证 packaged runtime 依赖`，以及 `RELEASE-02`构建日志和 `validate:ci`资产校验子步骤。 |
| INV-01 | 逐项引用 `WORKBENCH-01`—`WORKBENCH-05`结果。 |
| INV-02 | 逐项引用 `FILES-04`/`FILES-05`、`EPUB-01`、`PDF-01`、`BROWSER-01`和 `DRAWNIX-01`结果。 |
| INV-03 | 逐项引用 `PROJECT-03`/`PROJECT-06`、`BROWSER-08`和 `DRAWNIX-07`结果。 |
| INV-04 | 逐项引用 `WORKBENCH-09`和 `BROWSER-10`结果。 |
| INV-05 | 逐项引用全部 `+FAULT` Case结果。 |
| INV-06 | 逐项引用 `WORKBENCH-06`/`WORKBENCH-11`/`WORKBENCH-12`/`WORKBENCH-14`和 `APP-12`结果。 |
| INV-07 | 逐项引用当前 Host适用且已执行的全部 DEV或 PKG Case及退出日志。 |
| INV-08 | 逐项引用 `APP-01`—`APP-05`、`APP-10`和 `APP-11`结果。 |

### 19.2 模块导航

| 模块 | 代表性自动化入口 |
| --- | --- |
| APP | `scripts/stair-profile.test.ts`、`packages/shared/src/stair-branding.test.ts`、`apps/electron/src/main/__tests__/stair-user-data.test.ts`、`apps/electron/src/renderer/__tests__/renderer-root.test.ts`、`window-manager-renderer-lifecycle.isolated.ts` |
| PROJECT | `default-project.test.ts`、`projects/__tests__/storage.test.ts`、`projects.test.ts`、`create-managed-session.test.ts`、`project-communication.test.ts` |
| WORKBENCH | `workbench-commands.test.ts`、`session-auto-cleanup.test.ts`、`workbench-persistence.test.ts`、`panel-sizing.test.ts`、`workbench-layout.test.ts` |
| FILES | `project-files.test.ts`、`project-text-document-controller.test.ts`、`project-files-tree-capabilities.test.ts`、`project-file-markdown-links.test.ts`、`window-close-project-files.isolated.ts` |
| READER | `reader-state.test.ts`、`project-file-reader-capabilities.test.ts` |
| EPUB | `epub-archive-validator.test.ts`、`epub-state.test.ts`、`epub-highlights.test.ts` |
| PDF | `pdf-state.test.ts`、`project-file-pdf-state.test.ts`、`project-file-pdf-layout.test.ts` |
| REFERENCE | `reference-draft.test.ts`、`message-references.test.ts`、`project-notes.test.ts`、`selection-reference.test.ts` |
| CHAT | `midstream-queue.test.ts`、`handle-interrupted.test.ts`、`pending-plan-execution.test.ts`、`session-draft-coordinator.test.ts` |
| BROWSER | `browser-pane-manager.test.ts`、`browser-broadcast.test.ts`、`browser-application-capability.test.ts`、`browser-selection-application.test.ts`、`browser-selection.test.ts`、`browser-cdp.test.ts`、`browser-window-scope.test.ts`、`sessions-browser-release.test.ts` |
| DRAWNIX | `drawnix-document-controller.test.ts`、`drawnix-board-registry.test.ts`、`project-file-drawnix.test.ts`、`drawnix-project-scope.test.ts` |
| RELEASE | `scripts/stair-profile.test.ts`、`apps/electron/scripts/afterPack.stair.cjs`、`apps/electron/scripts/validate-assets.ts`、`scripts/stair-build.ts` |

## 20. 回归报告模板

报告必须先按下列产品模块顺序记录 128 个模块 Case，再记录 8 条跨模块验收规则。每项都由验收人员填写本轮结果和证据；不得只填写模块汇总。执行动作可以按依赖顺序复用，但报告不能省略任何 Case或规则。

```markdown
# Stair Full Regression Report

- Run ID:
- Branch / Commit:
- Worktree status (start / end):
- Platform / Arch:
- DEV command:
- PKG executable:
- Started / Finished:
- Executor:

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| validate:ci | | |
| lint | | |
| stair:build | | |
| whitespace | | |
| test:external | PASS / NOT_REQUIRED / BLOCKED / FAIL | |

## Case results

### 产品模块 Case

| Case ID | Result | Evidence | Finding / Notes |
| --- | --- | --- | --- |
| APP-01 | | | |
| APP-02 | | | |
| APP-03 | | | |
| APP-04 | | | |
| APP-05 | | | |
| APP-06 | | | |
| APP-07 | | | |
| APP-08 | | | |
| APP-09 | | | |
| APP-10 | | | |
| APP-11 | | | |
| APP-12 | | | |
| PROJECT-01 | | | |
| PROJECT-02 | | | |
| PROJECT-03 | | | |
| PROJECT-04 | | | |
| PROJECT-05 | | | |
| PROJECT-06 | | | |
| PROJECT-07 | | | |
| PROJECT-08 | | | |
| PROJECT-09 | | | |
| PROJECT-10 | | | |
| WORKBENCH-01 | | | |
| WORKBENCH-02 | | | |
| WORKBENCH-03 | | | |
| WORKBENCH-04 | | | |
| WORKBENCH-05 | | | |
| WORKBENCH-06 | | | |
| WORKBENCH-07 | | | |
| WORKBENCH-08 | | | |
| WORKBENCH-09 | | | |
| WORKBENCH-10 | | | |
| WORKBENCH-11 | | | |
| WORKBENCH-12 | | | |
| WORKBENCH-13 | | | |
| WORKBENCH-14 | | | |
| WORKBENCH-15 | | | |
| WORKBENCH-16 | | | |
| WORKBENCH-17 | | | |
| WORKBENCH-18 | | | |
| WORKBENCH-19 | | | |
| WORKBENCH-20 | | | |
| WORKBENCH-21 | | | |
| WORKBENCH-22 | | | |
| WORKBENCH-23 | | | |
| WORKBENCH-24 | | | |
| WORKBENCH-25 | | | |
| WORKBENCH-26 | | | |
| WORKBENCH-27 | | | |
| FILES-01 | | | |
| FILES-02 | | | |
| FILES-03 | | | |
| FILES-04 | | | |
| FILES-05 | | | |
| FILES-06 | | | |
| FILES-07 | | | |
| FILES-08 | | | |
| FILES-09 | | | |
| FILES-10 | | | |
| FILES-11 | | | |
| FILES-12 | | | |
| FILES-13 | | | |
| FILES-14 | | | |
| FILES-15 | | | |
| FILES-16 | | | |
| READER-01 | | | |
| READER-02 | | | |
| EPUB-01 | | | |
| EPUB-02 | | | |
| EPUB-03 | | | |
| EPUB-04 | | | |
| EPUB-05 | | | |
| EPUB-06 | | | |
| EPUB-07 | | | |
| PDF-01 | | | |
| PDF-02 | | | |
| PDF-03 | | | |
| PDF-04 | | | |
| PDF-05 | | | |
| REFERENCE-01 | | | |
| REFERENCE-02 | | | |
| REFERENCE-03 | | | |
| REFERENCE-04 | | | |
| REFERENCE-05 | | | |
| REFERENCE-06 | | | |
| REFERENCE-07 | | | |
| REFERENCE-08 | | | |
| REFERENCE-09 | | | |
| REFERENCE-10 | | | |
| REFERENCE-11 | | | |
| REFERENCE-12 | | | |
| CHAT-01 | | | |
| CHAT-02 | | | |
| CHAT-03 | | | |
| CHAT-04 | | | |
| CHAT-05 | | | |
| CHAT-06 | | | |
| CHAT-07 | | | |
| BROWSER-01 | | | |
| BROWSER-02 | | | |
| BROWSER-03 | | | |
| BROWSER-04 | | | |
| BROWSER-05 | | | |
| BROWSER-06 | | | |
| BROWSER-07 | | | |
| BROWSER-08 | | | |
| BROWSER-09 | | | |
| BROWSER-10 | | | |
| BROWSER-11 | | | |
| BROWSER-12 | | | |
| BROWSER-13 | | | |
| BROWSER-14 | | | |
| DRAWNIX-01 | | | |
| DRAWNIX-02 | | | |
| DRAWNIX-03 | | | |
| DRAWNIX-04 | | | |
| DRAWNIX-05 | | | |
| DRAWNIX-06 | | | |
| DRAWNIX-07 | | | |
| DRAWNIX-08 | | | |
| DRAWNIX-09 | | | |
| DRAWNIX-10 | | | |
| RELEASE-01 | | | |
| RELEASE-02 | | | |
| RELEASE-03 | | | |
| RELEASE-04 | | | |
| RELEASE-05 | | | |
| RELEASE-06 | | | |

### 跨模块验收规则

| Rule ID | Result | Evidence | Finding / Notes |
| --- | --- | --- | --- |
| INV-01 | | | |
| INV-02 | | | |
| INV-03 | | | |
| INV-04 | | | |
| INV-05 | | | |
| INV-06 | | | |
| INV-07 | | | |
| INV-08 | | | |

## Release qualification

| Check | Result | Evidence |
| --- | --- | --- |
| Empty-profile APP-09 / PROJECT-10 | NOT_RUN / PASS / FAIL | |
| Windows RELEASE-05 | N/A / PASS / FAIL / BLOCKED | |
| Linux RELEASE-06 | N/A / PASS / FAIL / BLOCKED | |
| Signing / notarization | NOT_RUN / PASS / FAIL | |

## Final decision

- Current Host Full Run: PASS / NOT READY
- Cross-platform Release Ready: YES / NO
```

最终 `PASS` 只绑定这一个 Run的源码状态。后续代码变化需要新的 Run。

## 21. 旧 Case ID 迁移索引

本节只用于查找改名前的审查记录，不是执行目录，也不得在新报告或新 Case中继续使用旧 ID。当前产品模块 Case编号以及 `INV` 规则编号均不得重排或复用。

| 旧 ID | 新 ID |
| --- | --- |
| G-01—G-08 | INV-01—INV-08 |
| P0-01—P0-08 | APP-01—APP-08 |
| P1-01—P1-09 | PROJECT-01—PROJECT-09 |
| P2-01—P2-12 | WORKBENCH-01—WORKBENCH-12 |
| P3-01—P3-16 | FILES-01—FILES-16 |
| P4-01—P4-06 | EPUB-01—EPUB-06 |
| P4-07—P4-11 | PDF-01—PDF-05 |
| P4-12 | READER-01 |
| P4-13 | EPUB-07 |
| P4-14 | READER-02 |
| P5-01 | REFERENCE-01 |
| P5-02 | CHAT-01 |
| P5-03—P5-12 | REFERENCE-02—REFERENCE-11 |
| P5-13 | CHAT-02 |
| P5-14 | REFERENCE-12 |
| P5-15—P5-17 | CHAT-03—CHAT-05 |
| P6-01—P6-14 | BROWSER-01—BROWSER-14 |
| P7-01—P7-10 | DRAWNIX-01—DRAWNIX-10 |
| P8-01—P8-14 | WORKBENCH-13—WORKBENCH-26 |
| P9-01—P9-03 | RELEASE-01—RELEASE-03 |
| P9-04 | APP-09 |
| P9-05 | APP-10 |
| P9-06 | PROJECT-10 |
| P9-07 | CHAT-06 |
| P9-08 | RELEASE-04 |
| P9-09 | WORKBENCH-27 |
| P9-10 | CHAT-07 |
| P9-11 | APP-11 |
| P9-12 | APP-12 |
| P9-13—P9-14 | RELEASE-05—RELEASE-06 |
