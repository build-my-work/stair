# Maka、Cindy、ZCode：Agent harness 深度评估与迁移建议

日期：2026-09-24

状态：调研与建议；尚未应用到项目规则或业务代码

落地参照：通用方法 + 当前 thinking-agent / Stair 工作区

## 1. 结论先行

**建议以 Cindy 的单一指令入口和规则路由为骨架，借鉴 Maka 的可执行约束与证据分层，再吸收 ZCode 的模块阅读入口和行为边界规划。保留你现有的 Bun、Claude/Pi 接入和验证体系，逐步补齐缺口。**

这三个仓库最有价值的共同点，是让 agent 更容易找到正确的上下文、在正确的代码位置修改、得到可信反馈。文档数量、AGENTS 行数、多模型数量都不能直接代表效果。

你的项目已具备源码测试运行器、静态守卫、构建校验、136 条回归 Case/不变量，以及正在建设的开发文档站。当前优先级应是：

1. 先修复已复现的守卫误报成功问题，并对齐当前文档、命令与 WIP，再建立统一入口。
2. 将关键规则连接到真实代码、测试和检查命令。
3. 保持源码、浏览器、真实 Electron、正式包验证的证据边界。
4. 用少量真实开发任务验证新 harness 是否减少返工，再决定增加技能或自动化。

本次是开发环境与工程机制评估，不是三个产品的整体质量、安全性或性能排名。

补充独立 Codex CLI 审阅后，建议把“两小时首个试点”收窄为既有 raw-send 守卫的失败处理和反例测试。调用方已在临时夹具中复现两个守卫把扫描失败判成成功；这比新增治理框架更有可直接验证的收益。过程、分歧裁决和证据见第 17 节。

## 2. 取证范围与可信度

### 2.1 固定源码快照

| 项目 | 完整 Commit SHA | 提交时间 |
| --- | --- | --- |
| Maka | `ba706ca645c623ec39993b48353fabdc58d6e14f` | 2026-09-24 12:42:56 +08:00 |
| Cindy | `1f63ff9c1a6fe8230f085555ab420c408efd96e1` | 2026-09-24 11:21:40 +08:00 |
| ZCode | `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f` | 2026-09-23 21:24:09 +08:00 |
| thinking-agent | `0fd491b5c067f10a4c4753001cdac1f8fd4518cd` + 本地 WIP | 分支 `codex/stair-rebuild-v2` |

第三方仓库在临时目录浅克隆，文中 GitHub 链接均固定到上述 SHA。未安装三个项目的依赖，未启动它们的产品，没有核验远端当前 branch protection 或近期完整 CI 运行结果。

当前 thinking-agent 有既有未提交修改：CI、package.json、bun.lock、回归规范、Stair profile/dev 脚本，以及未跟踪的 `.zcode/`、`apps/docs/`。下文按工作区事实评价，不把它们都算成已提交能力。本次仓库内新增的只有本报告与独立 Codex 审阅归档，既有业务代码与规则未改。

### 2.2 如何使用并行模型

第一轮的主调查与三个仓库分支调查本身均由 Codex 完成；Claude Code（GLM）与 Kimi 是额外的证据包交叉分析，Gemini 未完成有效审阅。随后应用户要求，另起一次本机 Codex CLI 独立上下文，直接检查三个固定源码快照与 thinking-agent 当前工作区，不提供先前报告或模型结论，再由主调查者回查分歧。**这不是所有模型各自完整审计全部仓库，也不是模型能力基准测试。**

| 调查分支 | 实际调用情况 | 证据边界 |
| --- | --- | --- |
| Maka / Claude Code | CLI 2.1.278；成功；响应确认 `glm-5.3[1m]`，配置 endpoint 为 BigModel Anthropic-compatible API | 保留既有模型；21 个公开文件摘录；工具/MCP/skills/hooks 禁用 |
| Cindy / Kimi | CLI 2.0.2；成功；配置 `kimi-code/k3`，provider `managed:kimi-code` | 未覆盖模型；响应没有提供实际后端模型，不能进一步确认路由版本；首次参数冲突后一次针对性重试 |
| ZCode / Gemini | CLI 0.61.0；未得到有效响应，不计独立审阅 | 保留原配置，未指定模型；第一次被 CLI 配置/信任检查拒绝，一次重试约 8 分钟无结果后终止；实际模型未确认 |
| 三仓 + Stair / 独立 Codex CLI | CLI 0.155.0-alpha.16；退出 0，turn.completed；652.188 秒；沿用配置 gpt-6-astra / max，未覆盖 provider/model | 37 次只读命令；收到阅读起点，但未读取前次结论；未运行测试/应用；JSON 未提供服务端实际模型 ID，不额外推断路由 |

模型意见没有自动升级为结论。例如，GLM 将 Maka 的 CI job 名称说错，并根据有限摘录作相对成熟度判断；Kimi 建议小项目整体搬入 related-test 调度器，却没充分考虑删除路径漏选。报告只采纳有源码支持的部分。

[独立 Codex 审阅归档](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-09-24-agent-harness-codex-review.md) 保留其意见与调用记录。该调用获得独立上下文，但仍共享预选的阅读范围，不应把它理解为统计意义上的独立样本；最终综合依据是源码和复现实验。

### 2.3 已运行与未运行

Maka 调研分支在 Node v26.4.0 下执行了两组无依赖轻量测试：

- `node --test apps/desktop/scripts/check-e2e-budget.test.mjs`：5/5 通过。
- `node --test apps/desktop/src/main/__tests__/ink-ladder-contract.test.ts`：6/6 通过。
- `node apps/desktop/scripts/check-e2e-budget.mjs`：清单一致，34 tests / 20 files。

补充复核时，主调查者又在同一 Node 版本执行 Cindy 的既有聚焦用例：`node --test --test-name-pattern='drops deleted files from related args' scripts/__tests__/test-related.test.mjs`，1/1 通过。该用例断言删除叶子应用文件时计划为 `skip`、`runs=[]`；通过说明该选择器行为得到复现，不代表删除后的产品行为正确。

调用方还用两个未修改的 Stair shell 守卫分别执行了 4 种临时文本夹具：无匹配、违规匹配、扫描目录缺失、扫描器退出 2，共 8 次调用。正常两类分别退出 0/1；后两类对两个守卫都输出 OK 并退出 0，确认失败处理缺口。原始脚本没有改动，没有扫描或修改实际产品数据；结果详见第 17 节。

以上轻量测试只支持对应守卫、静态契约与调度器行为，不证明应用构建、UI 或全部测试通过。Cindy、ZCode 和 thinking-agent 的业务测试本轮未执行；独立 Codex CLI 也未运行测试。其他覆盖判断来自脚本、测试与 CI 的静态接线核查。

## 3. Harness 应该分成什么

这里把 harness 视为“让模型稳定完成工程任务的周边环境”，分为六个环节：

| 环节 | 回答的问题 | 常见载体 |
| --- | --- | --- |
| 环境 | 在哪里运行，用什么版本、命令与数据目录？ | lockfile、package scripts、启动入口、profile |
| 上下文 | 这次改动应读什么，哪些材料可信？ | AGENTS、模块说明、文档索引 |
| 行为与设计 | 用户要什么，状态由谁拥有，失败时怎样？ | feature spec、架构契约、DESIGN、ADR |
| 执行流程 | 如何调查、实现、审查、交付？ | skills、任务记录、review 指令 |
| 确定性验证 | 哪些错误能由程序阻止？ | typecheck、lint、contract tests、构建和 CI |
| 反馈 | 怎样证明做对了，并防止同类错误复发？ | UI 证据、Run 记录、缺陷回归、规则维护 |

```mermaid
flowchart LR
  A[需求与验收条件] --> B[AGENTS 路由到相关契约]
  B --> C[检查当前源码与测试]
  C --> D[最小实现]
  D --> E[确定性检查]
  E --> F[真实场景验证]
  F --> G[独立审查与交付证据]
  G --> H[缺陷回归或修正规则]
  H --> B
```

产品自身的 model/tool loop、权限、事件日志、会话恢复、多 agent 调度属于另一层 **runtime harness**。开发 harness 可以指导工程工作；产品 runtime 中真正的权限或副作用控制仍要由运行时实现。拥有出色的 runtime 不等于开发 agent 会自动遵守 AGENTS。

## 4. 三个项目的整体比较

| 维度 | Maka | Cindy | ZCode |
| --- | --- | --- | --- |
| 开发指令入口 | 无根 AGENTS/CLAUDE；局部 AGENTS、Copilot review skill、贡献规范 | 根 AGENTS 正本，CLAUDE 薄导入，按改动类型路由 | 根 AGENTS + CLI 子树 AGENTS + 仓库 skills |
| 文档组织 | 稳定契约、局部 README、blog、Issue/PR、archive 分工清楚 | 工程、产品、视觉三类规则及权威索引 | spec-first、领域词汇、设计规范、模块契约；公开文档存在缺项 |
| 最强样本 | 规则→检查→反例测试→CI；真实行为证据分层 | 单一权威、业务风险路由、反馈变回归 | 单一状态所有者、依赖方向、按模块生成阅读入口 |
| 设计治理 | Token / theme / primitive / 生成文件职责明确 | 规则、数值、迁移台账、真实视觉四种事实分开 | 面向 agent 的语义 token 与交互规范 |
| 可执行约束边界 | 较完整，但 checker 自身复杂，语义仍需 review | 多种检查已接 CI；一些“硬规则”仍只是约定 | 架构 checker 当前主要作用于 storage，不能外推到全仓 |
| 主要迁移风险 | 大型遗留架构迁移工具过重 | 规则体量大，复杂调度器与文档同步成本高 | 可见测试/CI 材料有限，检查范围与命令名容易被高估 |
| 对你的主要价值 | 验证与证据结构 | 项目指令和文档治理结构 | 变更影响分析与模块阅读方式 |

### 构建环境也有可借鉴之处

Maka 固定 npm 11.19.0、要求 Node >=22.19；Cindy 固定 pnpm 10.33.2 并提供 Node 22.22.3 的 .nvmrc；ZCode 的 mise 固定 Node 24.14.0 与 pnpm 10.33.2。这些是它们当前工具链的选择，不构成你从 Bun 迁移的理由。

真正应迁移的是“版本可定位、依赖可按 lockfile 安装、开发与正式数据目录清晰、命令输出能辨别实际就绪”。你已有 CI 固定 Bun 1.3.10 与 frozen lockfile，应继续以现有工具链为基础。[Maka package](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/package.json)；[Cindy package](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/package.json)；[ZCode mise](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/mise.toml)；[本地 CI](/Users/zhihu/code/m_code/ai/thinking-agent/.github/workflows/validate.yml:22)。

## 5. Maka：最值得学的是验证闭环

### 5.1 文档是导航和契约，执行记录另放

Maka 的文档地图分配了明确职责：根/包 README 负责入口和所有权，docs 保存当前跨模块契约，blog 解释机制，Issue/PR 存实施计划，archive 保存过时材料。它还要求优先修改已有权威文档，避免另建平行正本。[文档地图](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/docs/README.md#L20-L30)；[维护规则](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/docs/README.md#L105-L113)。

架构写作 skill 从“读者的问题”出发，要求真实代码锚点、失败路径与权衡，并区分 Current / Planned / Exploratory / Deprecated / Historical。这比固定填满一份长模板更能抑制 AI 把计划写成已实现能力。[写作流程](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/skills/maka-architecture-docs/SKILL.md#L38-L59)。

需要保留一个判断：代码和测试能说明**现在怎么做**，产品契约说明**应该怎么做**。两者冲突时要判断是实现缺陷还是文档过期；不能为了匹配现有实现而悄悄改掉用户需求。

### 5.2 三条已追到实现的链路

| 规则 | 程序如何执行 | 还不能证明什么 |
| --- | --- | --- |
| Electron E2E 只放需要真实 native / 跨进程边界的断言 | spec 清单扫描、数量预算、边界理由登记；checker 有反例测试；CI 调用 | 理由是否真实、测试是否放在正确层 |
| AppShell 遗留职责只减不增；新能力有明确 owner | 解析依赖、hook、bridge 与环境副作用；比较 base 真实树；严格基线模式 | 所有产品依赖是否合理，checker 规则本身是否被错误修改 |
| 设计 token 有单一来源与有限层级 | ink / colorspace / theme alias 契约测试，主题生成漂移检查 | 页面最终视觉、交互可用性和所有颜色对比度 |

第一条尤其适合 Stair：先找能暴露缺陷的最低测试层，而实际原生窗口、preload/main、生命周期问题仍保留真实 Electron 验证。预算检查的文档主动声明“清单通过不等于分层正确”。[E2E AGENTS](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/e2e/AGENTS.md#L22-L72) → [checker](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/scripts/check-e2e-budget.mjs#L29-L103) → [反例](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/scripts/check-e2e-budget.test.mjs#L37-L93) → [CI](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/.github/workflows/ci.yml#L118-L122)。

第二条强在检查器也接受检验。基线取自真实 Git tree，必要时用旧 checker 同时度量新旧树，减少“改规则顺便把债务洗掉”的机会。但约 3717 行 checker 加 3670 行测试，对个人项目维护成本很高；其中比较逻辑仍需独立 review。[所有权及防退化合同](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/src/renderer/README.md#L32-L124)；[实现](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/scripts/check-renderer-architecture.mjs#L3465-L3565)；[CI 参数](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/.github/workflows/ci.yml#L258-L270)。

第三条把设计语言连接到生产来源，明确生成 CSS 不能作为手改权威。契约测试会扫描退役 token、错误 colorspace 和主题表达式，而不是只要求 agent “做得一致”。[DESIGN 来源](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/DESIGN.md#L78-L118)；[实际断言](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/src/main/__tests__/ink-ladder-contract.test.ts#L118-L181)。

### 5.3 AI review 负责发现反例

review skill 要求先核对实际问题，追踪 ownership 和状态流，挑战无依据的抽象、配置、fallback，并判断测试是否能捕获原缺陷。它也明确，零 finding 不等于批准合并，AI review 不替代独立人类责任。[review 契约](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/.github/skills/code-review/SKILL.md#L24-L99)。

对你值得迁移的部分是审阅问题本身：新状态由谁拥有？已有入口为什么不够？原 bug 再出现时哪个测试会失败？不能把“模型说没问题”当最终验收。

### 5.4 不宜照搬的部分

没有根级 AGENTS 并非项目缺乏治理，但对跨 CLI 使用者，发现规则的入口不统一。其完整架构棘轮、发布合规检查、双语维护、Peer Mesh 和 Eval 都有具体背景。你的优先动作是连接已有规则和验证，之后再挑确实反复退化的两三条边界做检查。

## 6. Cindy：最适合借鉴指令与规则组织

### 6.1 一份正本，按改动路由

Cindy 根 AGENTS 是正本，CLAUDE 只导入；工程、产品、设计规则分工，目录专属规则留在相应目录。根文件使用明确触发条件：改 Renderer / IPC 先读进程边界，改持久数据先读存储规则，改 UI 先读设计规范，改 Pi 集成先读 Pi harness 约束。[入口结构](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/AGENTS.md#L1-L28)；[条件路由样本](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/AGENTS.md#L33-L77)。

这里的重点是 **“任务→相关规则”**。让每个任务都读全部规则，会把路由设计的收益抵消。该快照工程/产品/设计规则目录分别有 36/20/11 篇；根 AGENTS 已达 198 行，DESIGN 达 1847 行。只复制目录结构容易，长期保持它们准确才是成本。

### 6.2 四种设计事实分开

Cindy 区分视觉规则、token 数值、surface 迁移状态、真实运行视觉证据。自动生成区不替代人工决策区，生成器不能擅自把迁移状态改成完成；用户已有 token ID 和主题也是兼容契约。[治理职责](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/docs/design-rules/design-governance.md#L50-L83)；[兼容边界](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/docs/design-rules/design-governance.md#L124-L132)。

这对 AI coding 很实用：模型知道应该改源 token、组件还是产品组合，也知道“静态检查通过”和“在真实窗口验过”是不同状态。你无需先引入 DTCG / Terrazzo；单一 Electron 前端可以先用已有 CSS/token 来源落实同样的职责。

### 6.3 从事故到回归，优先于加长 AGENTS

工作流明确要求：行为变更更新对应权威规则；入口漏读就补触发条件；可自动验证就补回归；一次环境事故不默认升级成长期规则。[反馈规则](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/docs/dev-rules/development-workflow.md#L124-L130)。

一个具体样本是按钮暗色 hover 与 rest 同色：测试遍历主题和 variant 检查状态差异，还特意恢复旧错误绑定，验证它确实失败。这里的数值阈值只是代理指标，但“测试能抓回原错误”这一步值得学习。[事故索引](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/docs/design-rules/cindy-design-system.md#L63-L65)；[回归与反例](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/apps/desktop/src/renderer/themes/__tests__/buttonStateContrast.test.ts#L90-L128)。

新增裸色检查也形成了规则、增量扫描、窄豁免、误报反例和 CI 链路；成熟的范围阻断，其余先报告，不为了统一形式清洗全仓旧债。[规则范围](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/docs/design-rules/design-governance.md#L226-L254)；[审计实现](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/hardcoded-color-audit.mjs#L123-L178)；[窄豁免反例](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/__tests__/hardcoded-color-audit.test.mjs#L75-L125)；[CI 接线](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/.github/workflows/ci.yml#L67-L90)。

### 6.4 已确认的局限

**PR 声明检查只证明声明存在。** pr-template-rules 检查模板文件标题，不读取实际 PR 正文；pr-design-basis 按 UI 路径与正则检查设计依据，允许有理由的“不涉及”。它不验证规范引用正确、截图存在、视觉已经验收。REVIEW 自己也承认这一范围。[实现](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/check-pr-design-basis.mjs#L18-L108)；[review 范围](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/REVIEW.md#L29-L51)。

**相关测试调度有删除路径缺口。** 只删除叶子 app 的文件时，已删除路径从 related 参数中去掉，计划可能直接 skip；测试明确锁定这一行为，本次已运行该聚焦用例并复现。CI 全量 unit 仍有补偿作用，但“相关测试成功”不能称为完整影响分析。你当前已有源码全量运行器，先保留；将来若引入增量调度，删除、重命名、动态依赖、配置和未知范围应回退整包或全量。[删除用例](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/__tests__/test-related.test.mjs#L237-L245)；[调度实现](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/test-related.mjs#L290-L328)；[全量 unit CI](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/.github/workflows/ci.yml#L163-L195)。

**有真实文档漂移。** README 仍说 remote dev 复用已有登录和会话，而专项规则、脚本及测试已将默认设为独立 dev profile。它说明“链接存在、命令存在”的文档测试不能保证语义同步。[README](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/README.md#L99-L113)；[脚本默认](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/desktop-dev-verdict.mjs#L94-L117)；[锁定默认的测试](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/__tests__/restart-desktop-remote.test.mjs#L252-L281)。

**措辞可能相互拉扯。** 设计治理一处要求可见 PR 提供双主题截图，后文又指向 best-effort 目检规则。迁移时应明确分开“必须实现”“本任务必须验证”“暂未验证”，避免 agent 自选最严或最松的一句话。[证据合同](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/docs/design-rules/design-governance.md#L147-L189)。

此外，本地提交前跑测试主要是约定；可选 DCO hook 并不执行测试。CI 已接线不等于远端设置了不可绕过的 required check。[hook](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/.githooks/prepare-commit-msg#L1-L30)。

## 7. ZCode：有价值的模块契约思路，需要审视实际覆盖

### 7.1 当前公开仓已经包含源码

本次快照包含 Electron/Web、共享服务和 apps/zcode-cli，不能按旧印象把它当作只有下载入口的闭源仓库。根 AGENTS 要求行为变更先明确 spec、唯一状态所有者、接口与验证；CONTEXT 只负责插件商店术语，DESIGN 则定义 UI 系统。[根约束](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/AGENTS.md#L1-L66)；[领域词汇](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/CONTEXT.md)；[设计规范](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/DESIGN.md)。

### 7.2 最值得学的是“有限的阅读入口”

architecture:context 按 module id 输出 owner、requires、module.ts、contract.*、公开入口和直接依赖的 contract 路径。它**只是阅读入口，不是已读过源码或验证过语义的摘要**，也没有自动提供测试入口。[实现](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/index.mjs#L325-L358)。

feature-boundary-planner 的方法更值得直接采用：

1. 从用户行为找到入口。
2. 分别追踪各 UI 表面，不能因共用组件就假定共用副作用。
3. 找出权威状态所有者、校验、提交命令、持久化、恢复。
4. 先扩展一个有语义的依赖层，再按未解决问题继续。
5. 把场景分为已确定、未定义、可剪枝和疑似 bug；每次剪枝写出不变量依据。

它明确要求图索引只是种子、路径要在当前 checkout 核实、计划测试不等于已执行覆盖。[流程](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/.agents/skills/feature-boundary-planner/SKILL.md#L18-L48)。这适合 Stair 的 Workbench / Browser / Session 跨层行为，也适合你后续的新项目。

### 7.3 规则很强，checker 的范围较窄

以下是源码确认的边界，不代表团队内部完全没有其他措施：

- policy 只有 storage 标为 managed:true，global.managedOnly:true；其它主要模块未纳入该架构检查范围。[policy](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/architecture-policy.yaml#L3-L65)；[执行过滤](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/index.mjs#L130-L133)。
- import resolver 只处理相对路径；包名和 alias 形成的边不进入这个 resolver 的依赖图。[实现](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/policy.mjs#L152-L160)。
- baseline 匹配的违规不导致失败；当前 baseline 为空，不能据机制推断已有大量豁免。[判定](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/index.mjs#L281-L307)；[退出码](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/architecture-check.mjs#L22-L39)。
- skill 要求 module.ts、contract.ts、contract.example.ts、CONTRACT.md；checker 只强制前两项。文字规程与可执行合同不是同一范围。[skill](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/.agents/skills/architecture-governance/SKILL.md#L38-L49)；[checker](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/index.mjs#L105-L127)。

还有一处对复制工作流影响很大：verify:pre-push 使用 architecture:check --changed，但 changed 集来自 `git diff HEAD` 加未跟踪文件，没有比较待推送分支和 upstream。**工作树干净时，已提交变更里的普通文件违规可能不在筛选范围；global 违规仍保留。** 这是按代码推导的检查范围缺口，本轮未运行复现实验。[变更集](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/index.mjs#L317-L322)；[筛选](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/index.mjs#L282-L306)；[入口命令](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/package.json)。

迁移时应该显式定义三种范围：编辑中相对 HEAD；提交前覆盖 staged；PR/pre-push 覆盖 merge-base 到候选 HEAD，并按需要包含 WIP。命令名字不会自动保证范围正确。

### 7.4 公开验证材料的限制

该快照未提供 .github workflow；按常见 test/spec 后缀及测试目录扫描只发现 4 个测试文件。根 AGENTS 本身也告知不要假定存在统一单测/E2E 命令。因此能够学习其设计思想和部分实现，不能据此确认全产品回归成熟度。公开分发缺少材料，也不能直接推断内部没有测试。[验证说明](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/AGENTS.md#L10-L27)。

spec-first 的公开交付也有缺项：feature-boundary-planner 引用的 `docs/skills/feature-boundary-graph.md` 不在当前 tracked tree 中，根 docs 目录也不存在。这是可复现阅读链的断点，不能把技能文字当作完整规格已交付的证明。[缺失引用所在位置](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/.agents/skills/feature-boundary-planner/SKILL.md#L34-L42)。

根 lint/typecheck 和 CLI 子包检查仍存在；“公开 CI 不可见”并不等于“没有质量检查”。对你来说，它更适合作为局部设计方法参考，不宜直接替代已有 validate:ci。

## 8. Runtime harness：可迁移原则与迁移边界

### Maka：把历史、执行与投影分开

RuntimeEvent 作为历史，模型上下文与 UI 是投影；存储中有 prepare/outcome transaction，恢复逻辑把已 dispatch、无 response 的副作用判为 indeterminate，不能按“从未执行”盲重试。源码还包含 SIGKILL 后重开存储的 crash 测试。[架构](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/ARCHITECTURE.md#L24-L63)；[prepare](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/packages/storage/src/sqlite-runtime-store.ts#L3213-L3252)；[未知结果](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/packages/runtime/src/recovery-resolver.ts#L251-L294)；[崩溃测试](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/packages/runtime/src/__tests__/runtime-resume-crash.test.ts#L45-L90)。

对开发 AI 产品，可迁移为：任务身份、已接受命令、授权、副作用结果和恢复状态由确定性代码管理。是否需要完整 event sourcing，取决于真实恢复与审计要求，不能因为“agent 项目”就默认引入。

### Cindy：区分产品技能与开发流程

产品内的 learn / skill-creator 是交付给用户 agent 的能力，并不能证明开发团队自动把每次审查变成仓库规则。公开代码能证明它们有相应指令，不能证明组织实践或结果质量。[learn](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/apps/desktop/resources/system-skills/learn/SKILL.md#L1-L21)。

### ZCode：控制执行条件，不能只依赖提示词

workspace hook 的授权与 workspace identity、声明摘要绑定；配置 enabled 与 effectiveRunnable 分开，dispatch 前重验，授权判断异常时拒绝执行。这是确定性代码保护，但本轮只追查这一条链，不能外推为所有工具都已得到同样保护。[调用前重验](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/apps/zcode-cli/packages/core/src/hooks/runner.ts#L61-L112)；[授权与摘要](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/apps/zcode-cli/packages/core/src/hooks/workspace-hook-runtime-admission.ts#L116-L187)。

CreateWorkflow 还检查当前上下文是否成功加载所需 skill，缺失返回 428；但未注入探针与 saved workflow 有豁免。“已加载技能”也不等于模型正确理解了技能。可迁移的是在工具边界明确执行前置条件与例外，不能把 AGENTS 文字当成硬性保证。[技能门实现](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/apps/zcode-cli/packages/core/src/tool/handlers/workflow-skill-gate.ts#L1-L47)；[工具入口](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/apps/zcode-cli/packages/core/src/tool/handlers/create-workflow.ts#L302-L355)。

### 单独评估模型行为

Maka Eval 把 Experiment / Cell / Attempt / Result 分开，冻结实验规格，区分新样本、基础设施重试和 runtime continuation，不任意选最好的重试结果。[Eval 语义](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/packages/eval/README.md#L39-L89)。

对 thinking-agent 更直接的应用，是为 Claude/Pi 的关键能力保存少量固定场景：取消/续跑、工具结果、引用输入、失败恢复、usage/model 报告。模型结果测试与确定性的协议测试分别记录；不能让一次“模型回答正常”替代数据归属和恢复机制的验证。本次不建议更换你的 agent engine。

## 9. thinking-agent 当前具备什么、缺什么

以下均在本轮工作区读取确认：

| 当前事实 | 含义 | 建议 |
| --- | --- | --- |
| 磁盘根目录没有 AGENTS.md / CLAUDE.md；本轮对话提供了 AGENTS 指令 | 当前会话有规则，但换 CLI / 新 checkout 未必能获得同样项目背景 | 建立短根级正本，保留现有会话规则含义 |
| packages/core 与 shared 有 CLAUDE.md | 已有模块知识，跨工具发现方式不一致 | 根索引显式路由，后续按需统一局部入口 |
| shared/CLAUDE.md 有 203 行、约 2.26 万字符 | 混有模块合同、事故知识、i18n 与 provider 细节 | 拆到相关正文/模块说明，只保留触发指针；不丢掉有效约束 |
| 已有 validate:ci，含 typecheck、guards、i18n、源码测试、Python smoke、Electron build/assets | 已有较强工程基础 | 保留，不再建同义 verify 框架 |
| 默认源码运行器区分 regular / isolated / external，并排除构建产物 | 已处理测试发现与进程隔离问题 | 继续维护其自身测试，不急着换 related 调度 |
| 两个现有文本守卫在扫描目录缺失或扫描器错误时仍输出 OK、退出 0；已用临时夹具复现 | 检查流程出错可能被当成“没有违规” | 先修失败语义、补正反例与扫描失败用例，再考虑扩大规则范围 |
| .husky 只有生成的 _，没有项目 pre-commit；shared/CLAUDE 却声明 i18n 三检查已接 pre-commit | 安装 Husky 不等于配置了本地检查，当前存在文档与本地接线差异 | 修正声明或明确补接；已有 CI 路径独立保留 |
| 当前 WIP 中开发 profile 默认 .stair-dev / stair-dev://；开发与安全文档仍写 .stair / stair:// | 把文档标为权威，不会自动消除它与实现的偏差 | 核对并保留 WIP 意图，对齐 DEV/PKG 默认值与可覆盖项 |
| overview 要求运行 typecheck；根脚本同名命令只覆盖 shared | 新 agent 容易把局部检查当成 Electron / 全仓覆盖 | 写明工作目录、精确命令和覆盖面 |
| CONTRIBUTING 仍描述 Craft 上游 clone 与 electron:dev | 容易与 Stair 专属入口混淆 | 将本项目贡献入口指向当前开发规则 |
| apps/docs 已有权威开发规则、读取时机、源码与测试映射，但未跟踪 | 这部分已经接近推荐形态，尚不是新 checkout 可获得的规则 | 先校正已知漂移，再接到根索引；入口与目标文档必须在同一候选中 |
| 根 task_plan/findings/progress 与 rebuild-plan 均较长；docs 无根 README | 容易混淆历史实施与当前约束 | 索引注明角色与权威关系，之后再决定归档 |
| full-regression 区分 AUTO / DEV / PKG / DERIVED，绑定 Run/候选 | 对真实 UI 证据的要求已经明确 | 完整保留，不用静态测试替代 |

来源：[模块说明](/Users/zhihu/code/m_code/ai/thinking-agent/packages/shared/CLAUDE.md:1)、[package scripts](/Users/zhihu/code/m_code/ai/thinking-agent/package.json:23)、[源码发现](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/run-source-tests.ts:4)、[发现器测试](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/run-source-tests.test.ts:21)、[旧贡献入口](/Users/zhihu/code/m_code/ai/thinking-agent/CONTRIBUTING.md:13)、[开发不变量文档](/Users/zhihu/code/m_code/ai/thinking-agent/apps/docs/src/content/docs/dev/overview.mdx:9)、[回归规范](/Users/zhihu/code/m_code/ai/thinking-agent/docs/stair-full-regression.md:12)。

你的规则已经有可执行样本：raw webContents.send 检查和 Task/Agent 名称守卫通过 lint:guards 进入 validate:ci，再进入 CI。它们是有明确范围的模式检查，不是完整 IPC 或工具安全证明。[IPC 守卫](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/check-raw-sends.sh:13)、[工具名守卫](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/check-task-tool-checks.sh:18)、[CI 入口](/Users/zhihu/code/m_code/ai/thinking-agent/.github/workflows/validate.yml:44)。

补充审阅发现，两者将扫描命令的错误输出丢弃，并用 `|| true` 统一吞掉退出码。主调查者随后在临时 fixture 中确认：缺少目标目录、或临时 rg stub 明确退出 2 时，两者均输出 OK 并退出 0。这不说明当前正常 CI 已漏掉某次产品违规，但足以证明检查失败没有可靠地向上传播。建议区分“发现违规”“成功扫描且无匹配”“扫描失败”，并让第三种状态非零退出。

本地 hook 差异对应的原声明见 [shared 的 Validation 章节](/Users/zhihu/code/m_code/ai/thinking-agent/packages/shared/CLAUDE.md:120)。该发现只说明当前 checkout 的接线与说明不一致，不否认 CI 中已有 i18n 检查。

开发 profile 的漂移是补充 Codex 独立审阅新发现、主调查者回查确认的事实：`stair-dev.ts` 调用 `createStairDevelopmentEnvironment`；当前 WIP 将默认配置目录设为 `~/.stair-dev`、scheme 设为 `stair-dev`，普通 profile 则为 `~/.stair` / `stair`。`CRAFT_CONFIG_DIR` 仍允许显式覆盖，因此这里描述的是默认值。开发文档仍将 `stair://` 写成开发深链，安全文档仍称数据全部位于 `~/.stair`。本次只核对源码与文本，没有启动应用验证实际运行目录，也不改变现行数据使用策略。[开发入口](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/stair-dev.ts:3)；[profile 实现](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/stair-profile.ts:15)；[开发说明](/Users/zhihu/code/m_code/ai/thinking-agent/apps/docs/src/content/docs/dev/development-setup.mdx:38)；[安全说明](/Users/zhihu/code/m_code/ai/thinking-agent/apps/docs/src/content/docs/dev/data-and-security.mdx:21)。

命令覆盖面也需要明确：`overview.mdx` 的验证要求只写 `typecheck`，而根目录 `bun run typecheck` 实际转发到 `typecheck:shared`。这是容易误选命令的文档歧义，不代表 `validate:ci` 漏掉 Electron 类型检查；后者调用的是 `typecheck:all`。[验证说明](/Users/zhihu/code/m_code/ai/thinking-agent/apps/docs/src/content/docs/dev/overview.mdx:44)；[真实脚本](/Users/zhihu/code/m_code/ai/thinking-agent/package.json:27)。

Workbench 也已经有行为测试，例如普通选择不增加 Auxiliary、已有 Session 不重复建面板、跨 Project 的陈旧提交被拒绝、flush 失败阻止破坏性切换。优先把规则指向这些已有保护，而不是再复制一层测试壳。[行为测试](/Users/zhihu/code/m_code/ai/thinking-agent/apps/electron/src/renderer/workbench/__tests__/workbench-commands.test.ts:158)。

特别注意：现行 Full Run 已规定直接使用当前 DEV/PKG 数据，不自动复制、清理或恢复。本报告不会把 Cindy 的临时 profile 规范替换成你的验收政策。开发 profile 隔离与完整回归的数据使用约定是两件事。[本地 Run 规则](/Users/zhihu/code/m_code/ai/thinking-agent/docs/stair-full-regression.md:86)。

## 10. 建议的最小文档与规则结构

### 10.1 第一阶段校正事实、补齐连接

```text
AGENTS.md                       新增：目标、关键边界、读取路由、完成标准
CLAUDE.md                       如需兼容：仅导入 AGENTS
docs/README.md                  新增：当前正本、历史材料、验证入口的索引

apps/docs/src/content/docs/dev/  复用已有开发规则正文
docs/stair-full-regression.md    保持为回归验收正本
packages/*/现有模块说明            保留；按需要统一入口和拆分长文
docs/code-research/              研究材料；不自动成为强制规范

仅在实际有需求时增加：
docs/specs/<feature>.md          行为改变涉及多层时的短规格
docs/decisions/<decision>.md     真正需要保留取舍理由的 ADR
项目 skills                      已反复使用、步骤稳定的工作程序
```

已有 MDX 开发正文可直接供 agent 读取；纯规则的代码定位和验收信息不必再复制成 Markdown。网页负责呈现，源码文件继续作为同一份正文。只有发现 MDX 外壳影响具体工具读取时，才考虑同源生成，不能手工维护两份。

建立入口前应先校正第 9 节的已知漂移；否则路由只会让过时信息更容易被找到。`apps/docs` 当前未跟踪，正式落地必须让入口与被引用文档一起进入同一份候选，并在该候选的独立 checkout 核验路径。不能仅因当前机器能读到，就认定其他会话或开发者已获得这套规则。

### 10.2 各种文件的职责

| 载体 | 应保存 | 不应逐渐变成 |
| --- | --- | --- |
| AGENTS | 项目范围、总入口、全任务有效的不变量、读取条件、完成标准 | 全部架构细节、每次错误历史、所有命令清单 |
| 模块规则 | 当前模块 owner、公开入口、禁止跨越的依赖、局部验证 | 根规则的复制 |
| Product spec | 用户行为、状态转换、失败语义、验收场景 | 完成后的流水账 |
| DESIGN | 视觉与交互原则、语义 token、组件和状态 | 全部工程架构，或另一份手写 token 数值库 |
| Architecture / contract | 状态所有者、数据流、接口、依赖方向、恢复与权限边界 | 只有框图没有源码/失败路径的概述 |
| ADR | 已采纳选择、替代方案、理由、代价与回退 | 每个小改动强制填的表格 |
| Skill | 某类任务可重复的步骤、输入、输出和完成条件 | 所有任务都加载的巨大参考库 |
| Run / Evidence | SHA、环境、实际命令、结果、artifact、未验证项 | 当前规范的替代品 |
| CI / hooks | 适合机械执行的约束和快速反馈 | 对用户行为正确性或授权的替代判断 |

索引每行先保留“内容 / 状态 / 适用改动 / 正本路径 / 检查入口”即可。有多个真实维护者再增加 owner。文档状态建议 current、proposed、historical、reference；自动生成的内容再标 generated。状态不等同于已验证。

### 10.3 根 AGENTS 草案

以下是建议模板，引用的 docs/README 尚需先建立；未写入真实 AGENTS。

```markdown
# Stair 项目工作入口

## 开始前
- 明确这次任务的成功条件、重要假设和范围；检查分支与工作区状态。
- 保护无关改动，使用现有依赖、命名与模块边界。
- 当前规则入口见 docs/README.md；历史计划不代表当前候选已通过验收。

## 按改动读取
- 启动、profile、打包：读 apps/docs/src/content/docs/dev/development-setup.mdx
  和 dev/packaging-updates.mdx，并核对相关 package scripts。
- Workbench、Project、Session：读 dev/overview.mdx 与
  dev/workbench-commands.mdx，沿来源链接检查实现和测试。
- Browser、原生窗口：读 dev/browser-runtime.mdx。
- 文件、持久化、跨 Project 权限：读 dev/data-and-security.mdx 与 dev/persistence.mdx。
- shared 的 provider、MCP 或 i18n：读 packages/shared/CLAUDE.md 中相关章节。
- 发起或判定回归：读 docs/stair-full-regression.md。

上文 dev/ 均指 apps/docs/src/content/docs/dev/。

## 实现边界
- Workspace / Project / Session 的归属由既有领域与服务端校验维护。
- Workbench 布局通过既有命令层修改；UI 不创建第二份权威状态。
- 接入模型与工具优先复用既有 Claude / Pi 和会话工具契约。
- 行为修改先明确验收场景；修 bug 先取得复现或有效失败测试。
- 保持最小改动；没有复用需求不新增 helper、配置或抽象层。

## 验证与交付
- 迭代时执行能验证本次变化的聚焦检查；交付按既有回归规范选择 Gate。
- validate:ci 不等于完整 lint、真实 Electron 或正式包验收。
- 声明运行命令、候选状态、结果、证据与未验证项。
- 新源码需要新候选证据；历史通过不自动沿用。
- 检查器失败应定位原因，不能靠更新 baseline 或削弱断言制造通过。
```

这份入口不用强塞全部业务知识。它承担的是路由和完成标准，细节留在已有权威来源。

### 10.4 Rule 应写成可操作的约束

以“布局只有一个写入口”为例：

```text
规则：Workbench 布局通过既有 workbench-commands 修改。
触发：新增面板、导航、焦点、跨 Project 恢复及相关异步操作。
依据：overview.mdx + workbench-commands.mdx。
代码入口：workbench-commands.ts；状态形状：workbench-state.ts。
行为验证：普通选择不增 Auxiliary；陈旧 Project 提交拒绝；
          flush 失败时不替换/关闭/切换。
尚未证明：仅凭这些测试，不能保证所有未来 UI 路径都未直接写 atom。
扩展门禁条件：如果旁路写入实际反复发生，再增加有反例的静态检查。
```

这里的“尚未证明”很重要。规则、行为测试和全仓静态约束是不同证明范围。不要因为有一条测试，就把整条架构规则标成“全部自动保证”。

## 11. Design、spec 与文档怎样配合 AI coding

### 11.1 三类设计不要混成一份大文档

- **产品行为**：例如 Add Note 在没有 Chat target 时使用什么目标、取消是否保留选区、跨 Project 如何拒绝。
- **技术结构**：目标偏好由谁拥有、请求怎样携带 Project、失败如何回滚、哪个服务端入口做最终校验。
- **视觉与交互**：目标选择器复用哪个组件、empty/loading/error/disabled 状态、窄窗与主题怎样表现。

一项改动只更新真正受影响的部分。拼写修正和纯等价重构不需要一套 PRD + spec + ADR + 计划。已有行为写清楚时，一条复现、一个失败测试和聚焦 diff 就可能足够。

### 11.2 跨层行为改动的最小规格

```markdown
# <用户行为>

状态：proposed / accepted / implemented / verified（分别判断）
目标与非目标：
当前行为及证据：
期望行为及用户价值：
状态所有者与唯一提交入口：
输入、输出、校验与失败结果：
异步顺序、陈旧结果、幂等与恢复（不涉及时删除）：
兼容或数据影响：
验收场景：
- 前置状态 / 动作 / 可观察断言 / 验证层 / 证据要求
实现入口与已有测试：
尚未决定的问题：
回退方式：
```

实施计划可以放在同一份短规格底部；只有长期、多人工作需要单独任务文件。完成后把稳定合同归入对应模块，执行日志归历史或 PR，避免多个“最新方案”长期并存。

### 11.3 视觉改动的验收应绑定运行状态

建议每次可见改动记录：候选 SHA/WIP、真实运行入口、平台、窗口尺寸、主题、操作步骤、截图或录屏、预期/实测差异。源码 token 和 UI 截图分别回答不同问题。

精确数值尽量从已有 token 或组件源读取。必要的设计数值表可以生成；“生成完成”只说明来源一致，不说明页面最终表现合格。截图与录像放在适当 artifact 存储，仓库主要保留可复核的文本索引；长期视觉基线是否入库另按现有测试工具选择，不一刀切。

## 12. 可实际执行的 AI coding 工作方法

### 12.1 单任务流程

| 步骤 | 必需产物 | 完成判断 |
| --- | --- | --- |
| 定界 | 一句话行为目标、影响范围、关键未知 | 能写出成功/失败的可观察区别 |
| 定位 | 相关规则、入口、owner、接口与已有测试 | 每个关键结论能回到当前源码 |
| 先建立反馈 | bug 复现/失败测试；功能验收场景 | 能解释原错误为何被捕获 |
| 最小实现 | 聚焦 diff | 没有第二份状态、重复路径或无依据扩展 |
| 验证 | 对应层级检查及实际结果 | 检查执行过，失败/阻断单独记录 |
| 审查 | 从用户行为和调用方寻找反例 | finding 有路径、触发条件、后果与证据 |
| 交付 | 变化、验证、限制和回退 | 用户可核对结论，不靠“已完成”一句话 |
| 沉淀 | 回归 / 原规则修订 / 路由补充三选一或组合 | 解决重复问题，没有无关常驻规则 |

### 12.2 并行模型用在独立问题上

推荐一个主实现者负责整合。跨边界或尚有实质不确定性时，再把有限任务交给不同模型：

- 一个追产品行为和遗漏场景。
- 一个追状态归属、接口、并发和恢复。
- 一个从最终 diff 与测试证据找回归。
- 独立 UI 任务交给实际运行验证；语言模型互相认可不能替代操作证据。

每路收到相同的任务边界、固定 SHA/diff、相关契约与明确问题。初次独立分析尽量不附“主作者已得出的结论”，减少锚定。默认只读；需要并行写代码时先分配互不重叠的文件/模块，确有隔离需求再建 worktree。

统一输出可以很短：

```text
结论：已确认 / 有根据的疑点 / 无法验证
出处：path:line、相关契约
触发：具体前置状态与输入
后果：哪个用户行为会失败
验证：已运行证据，或最小复现办法
建议：最小修复，不顺带改架构
```

汇总按证据裁决，不按模型票数。共识可能来自共同遗漏；失败调用、空响应、仅重复作者观点不能记为完成独立审阅。记录 CLI、配置 provider/model、可观察实际模型、输入范围与退出状态，避免把 Claude CLI 误称为 Claude 模型。

### 12.3 反馈沉淀的顺序

1. 能用回归固定的，先固定可观察行为。
2. 原规范过时的，更新原正本。
3. 规范正确却没被找到的，补路由触发条件。
4. 稳定、反复出现且需要步骤的工作，提炼为 skill。
5. 单次环境故障保留本次排障记录。
6. 当旧约束失效时清理或标 superseded，不持续叠加相互矛盾的规则。

skill 首先是稳定的操作程序。你已安装通用 research / code-review 等技能，可以复用；无需把每一个通用动作再复制成项目 skill。

## 13. 多 CLI 的共用入口：不要只按文件名猜加载行为

建议共用 AGENTS 正文，再按工具真实能力建立薄入口，并在新会话检查加载结果。

- Claude Code 当前官方文档已支持原生 AGENTS，但存在版本、设置和同目录 CLAUDE 文件的选择规则。Cindy 的 `CLAUDE.md → @AGENTS.md` 仍是兼容方案；不应宣称 Claude 永远只能读 CLAUDE，也不要将所有专题通过 @ 全量导入。[官方加载说明](https://code.claude.com/docs/en/memory#agentsmd)。
- Gemini 默认 GEMINI.md；可配置 context.fileName，或用 import 引入共用正文。选一种方式，检查 `/memory show` 的实际内容，避免同时导入和发现产生重复上下文。[Gemini 官方文档](https://geminicli.com/docs/cli/gemini-md/)。
- Kimi 自定义 agent 使用 KIMI_AGENTS_MD 时会获得项目根到 cwd 的合并内容；自定义 system prompt 若不消费该变量，就不能凭“文件存在”认定已经生效。[Kimi 官方文档](https://moonshotai.github.io/kimi-cli/en/customization/agents)。
- ZCode 默认适配器组合用户级 AGENTS 与从 cwd 向上找到的最近一份 workspace 指令，默认并非合并沿途所有 AGENTS。跨工具复用模块级规则时必须考虑这一差异。[加载实现](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/apps/zcode-cli/packages/adapters/src/context/index.ts#L204-L242)。

`@AGENTS.md` 是支持该语法的客户端的导入方式；普通 Markdown 链接通常只是阅读指针。专题规则按触发条件阅读和启动时全量 import 的成本不同。

接线验收用一个小的只读任务：让每个实际使用的 CLI 列出当前项目规则入口、适用模块规则、验证命令，并核对其上下文/加载诊断。自述只能作辅助；不要用一句“我已读”代替工具的实际加载证据。

## 14. 落地顺序与完成条件

下面是建议阶段，不是已经执行的改造：

| 阶段 | 具体改动 | 完成条件 |
| --- | --- | --- |
| A：修已证实的反馈缺口 | 修现有守卫的扫描失败语义；对齐 DEV/PKG profile、精确 typecheck 命令、pre-commit 声明与 CONTRIBUTING；保留现行 Full Run 数据约定 | 守卫正反例和扫描错误都给出正确结果；命令和默认值与候选一致，未运行项明确 |
| B：连通已有材料 | 根 AGENTS、docs/README；需要时加 CLI 薄入口；标注历史材料；确认共享模块长文的保留/拆分 | 入口与引用目标同属候选，一个新会话能找到正确启动入口、相关规则、测试与当前验收正本 |
| C：小范围试点 | 选一次 Workbench/Browser 真实改动，实践 owner→契约→测试→真实 UI→证据 | 找到原 bug 的验证能红后绿；未验证项明确，现有能力不减少 |
| D：增加必要守卫 | 只针对试点反复出现的问题；正例+违规反例+误报反例；CI 接线 | 守卫确实阻止目标错误，误报与耗时可接受，失败不会自动洗 baseline |
| E：再考虑更多自动化 | 模块阅读生成、相关测试、固定场景 eval、更多模型协作 | 有已观测瓶颈和收益证据，而不只是“别人仓库有” |

前两个阶段不需要新增规则引擎、依赖图数据库、独立 orchestration 平台或更换包管理器。你的现有文档站、脚本与测试足够承载第一轮。

对新项目，可从短 AGENTS、一份运行说明、一份行为规格和一条可端到端执行的验证开始。模块边界和技能随真实重复需求生长，避免先搭出一座空的治理框架。

## 15. 怎样验证 harness 是否真的有用

先选 3 个有明确答案的代表任务：一个业务 bug、一个跨层行为变化、一个 UI 状态修复。使用独立 checkout 和固定基线，对比原有入口与新入口；模型、预算、依赖、任务描述及验证环境保持一致。得到初步结果后，再扩大到历史任务集合；不要从三个例子推断普遍效果。

建议记录：

| 指标 | 为什么值得看 |
| --- | --- |
| 行为验收是否通过 | 最终目标 |
| 同类缺陷/规则遗漏是否再次出现 | 是否减少重复错误 |
| 首次得到有效验证结果的时间 | 反馈链是否缩短 |
| 人工纠正次数与范围外改动 | 协作负担与约束质量 |
| 无关文档阅读量、耗时、费用 | 上下文与流程成本 |
| 守卫误报、漏报、检查耗时 | 自动化是否可靠且值得保留 |
| 报告能否绑定准确候选与证据 | 是否减少“看似完成” |

一项基础设施故障是 blocked/invalid sample，不应悄悄重试直到选到最好结果；模型实际完成但行为错误则是失败。多次采样保留全部记录。成功率、耗时和成本分开看，别把它们揉成缺少依据的综合分数。

**优先验证的判断是：增加短入口和权威索引，能否让下一次真实改动少漏规则、少读历史、少返工。** 只有这个成立，才有理由继续扩大 harness。

## 16. 阅读路线

如果只看最有迁移价值的源码，按下面顺序：

1. [Cindy AGENTS](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/AGENTS.md) 与 [文档索引](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/docs/README.md)：怎样做单正本和条件路由。
2. [Maka 文档地图](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/docs/README.md)、[E2E 分层规则](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/e2e/AGENTS.md)：怎样区分当前规则、历史材料与验证层。
3. [Cindy 反馈规则](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/docs/dev-rules/development-workflow.md#L124-L130)：怎样避免每次错误都加一条全局指令。
4. [ZCode feature-boundary-planner](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/.agents/skills/feature-boundary-planner/SKILL.md)：怎样按行为追 owner、提交入口与恢复。
5. [Maka 架构边界](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/src/renderer/README.md#L32-L124) 与 [ZCode checker 的范围](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/index.mjs#L281-L322)：同时学习设计目标和检查局限。
6. 回到 [Stair 当前开发规则](/Users/zhihu/code/m_code/ai/thinking-agent/apps/docs/src/content/docs/dev/overview.mdx:9) 与 [回归正本](/Users/zhihu/code/m_code/ai/thinking-agent/docs/stair-full-regression.md:1)，确定第一轮需要补的连接。

本报告的迁移模板为针对当前项目的建议，不自动替换现行规范。实施时应保留用户已确认的行为、验收约定和本地改动。

## 17. 补充独立 Codex 分析后的综合意见

### 17.1 Codex 是否实际参与，以及独立调用增加了什么

第一轮源码主调查和三个分支就是 Codex 的分析；GLM、Kimi 是额外交叉审阅。这次另起的 Codex CLI 使用独立上下文，保留本机 `gpt-6-astra / max` 配置，直接读取同一批源码，成功完成。其 [完整审阅归档](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-09-24-agent-harness-codex-review.md) 与本报告分开，便于区分模型原意见和最终采纳结果。

这次没有推翻三项目的借鉴方向，却实质改变了首个试点的选择：

- **保留的判断**：Cindy 的单一规则入口、Maka 的验证层次与检查器反例、ZCode 的状态所有权和语义影响分析值得迁移；三者的完整治理设施都不适合直接搬入。
- **新增发现**：Stair 开发 profile 的 WIP 与新文档不一致；两个已有守卫会吞掉扫描错误。
- **本次进一步证实**：主调查者运行 Cindy 删除路径聚焦用例，并在临时夹具中复现 Stair 守卫的错误通过。Codex CLI 自己没有运行这些实验，不能混写其证据来源。
- **收益仍待测量**：短 AGENTS 是否减少漏读、多少文档应该常驻上下文，目前没有对照实验。检查失败仍返回成功则已经可以直接观察，因此先修这一小处更容易验证收益。

### 17.2 各模型意见怎样裁决

| 观点或分歧 | 回查结果 | 综合决策 |
| --- | --- | --- |
| GLM 强调 Maka 的规则→检查→自测→CI | E2E 预算与架构守卫均能追到对应实现；轻量守卫测试实际运行过 | 学习证据链与最低有效测试层；大型债务分析器按实际需求再考虑 |
| Kimi 建议整体借鉴 Cindy related-test 调度器 | 删除叶子源码会跳过；已运行原有测试确认其行为；Stair 已有全量源码运行器 | 现阶段保留全量入口；增量选择将来只作加速层，未知、删除等情况有明确回退 |
| Kimi 将部分视觉证据、并发治理视为个人项目无需采用 | Stair 自身已有真实 DEV/PKG 证据要求；单人也可能同时使用多 agent、worktree | 保留当前视觉和运行证据；是否加并发锁取决于实际竞争，不能由团队人数推断 |
| Codex 指出 ZCode 的约束范围小于其规则文字 | policy 仅 storage 受管；changed 范围以 HEAD 为基准；公开快照缺少完整检查器自测/CI 链 | 借鉴 owner 与模块阅读方法，不把该命令作为全仓治理保证 |
| 独立 Codex 优先建议加固已有守卫 | 两个本地脚本均在扫描失败场景退出 0；临时夹具已复现 | 将它列为第一项小型工程试点，并给现有门禁补失败语义 |
| 第一轮建议先用根入口连接文档 | 独立审阅找到 profile 文档漂移，主调查者又确认 typecheck 范围歧义及未跟踪文档问题 | 先校正已知事实，再建立入口；入口和目标文件在同一候选中验收 |

Gemini 没有有效审阅结果，不参与上述判断。重复意见仅能提高某条线索值得回查的优先级，不能代替源码、反例或实际运行证据。

### 17.3 两个守卫的最小复现实验

调用方使用仓库中未修改的 `check-raw-sends.sh` 与 `check-task-tool-checks.sh`，将工作目录设为临时夹具目录；没有改业务源码，也没有对实际用户数据运行测试。每个脚本各执行四种输入：

| 场景 | raw-send 守卫 | tool-name 守卫 | 判定 |
| --- | --- | --- | --- |
| 扫描目录存在，文本不命中模式 | exit 0，OK | exit 0，OK | 正常控制组 |
| 扫描目录存在，文本包含违规模式 | exit 1，ERROR | exit 1，ERROR | 正常控制组 |
| 扫描目录缺失 | exit 0，OK | exit 0，OK | 未完成扫描却报告成功 |
| 目录与违规文本均存在；临时 rg stub 返回 2 | exit 0，OK | exit 0，OK | 扫描器失败却报告成功 |

实现原因可直接定位到丢弃 stderr 和 `|| true`： [raw-send 扫描](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/check-raw-sends.sh:13)、[tool-name 扫描](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/check-task-tool-checks.sh:20)。这次运行验证的是 rg 路径；grep fallback 具有类似的静态错误处理，但没有另行运行该分支。当前正常根目录中的 CI 不一定触发上述故障，本实验不等于发现了既往 CI 漏检事故。

用空目录可复现第一种失败处理问题，脚本输出与退出码应同时观察：

```python
import subprocess
import tempfile

with tempfile.TemporaryDirectory() as fixture_dir:
    result = subprocess.run(
        ["/bin/bash", "/Users/zhihu/code/m_code/ai/thinking-agent/scripts/check-raw-sends.sh"],
        cwd=fixture_dir, capture_output=True, text=True,
    )
    print(result.returncode, result.stdout)
    # 当前结果：0，OK: No raw webContents.send() outside approved wrappers.
```

完整调用日志保存在本次临时研究目录的 `codex-independent-review/local-guard-reproduction.json`。这里展示的是发现，不是已经实施的修复。

### 17.4 第一项两小时试点与后续次序

**首个工程试点选 raw-send 守卫，范围只含原脚本与其回归测试。** 无需新规则框架、依赖或全仓 AST：

1. 固定本节的无匹配、违规匹配、缺目录、扫描器错误四类输入，让现有行为先暴露失败。
2. 核对扫描目标，保留扫描器退出状态。对 rg 的 0、1、2 分别解释为“匹配到内容”“成功但无匹配”“扫描失败”；规则违规和扫描失败都应令门禁非零退出，并提供可定位的原因。grep 分支按同一语义核验。
3. 确认合法样例继续通过；测试文件被现有源码测试运行器发现，并通过已有 `test:source → validate:ci → CI` 链执行。
4. 仅宣称这条守卫得到加固；不把它升级为完整 IPC 正确性或 Full Run 通过。tool-name 守卫按同样的已证实缺口处理，不顺带扩大匹配范围或新建公共抽象。

其后完成文档和路由工作：对齐默认 DEV/PKG profile、pre-commit 声明、精确 typecheck 命令与贡献入口；用短 AGENTS 和 docs 索引连接已有正文；核验未跟踪文档是否包含在同一候选中。CLI 入口只作适配，不复制业务规则。

再选一项真实 Workbench 或 Browser 变更，沿“用户行为 → owner/提交入口 → 既有测试 → 对应层级实际验证 → Run 证据”执行。只有确认是阅读遗漏、边界反复被破坏或验证耗时成为瓶颈，才分别增加路由、窄范围守卫或增量测试调度。

多模型协作保持有明确任务边界：一个主实现者负责整合，需要时再用独立上下文审阅需求遗漏、状态/并发或最终 diff。每次调用记录实际范围与结果；并非每项修改都必须同时调用 Codex、GLM、Kimi 和 Gemini。
