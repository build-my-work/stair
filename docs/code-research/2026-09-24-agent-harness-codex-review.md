# Codex CLI 独立审阅归档：Maka、Cindy、ZCode 与 Stair

日期：2026-09-24

用途：保留独立模型意见；最终采纳、纠偏及调用方补充实验见 [综合评估第 17 节](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-09-24-agent-harness-evaluation.md)。本文不自动成为项目规则。

- CLI：`codex-cli 0.155.0-alpha.16`。
- 沿用本机配置：`gpt-6-astra`，reasoning effort `max`；未覆盖 model 或 provider。JSON 输出未给出服务端实际模型 ID，因此不进一步推断后端路由。
- 执行：独立只读会话，ephemeral；本次进程禁用 hooks、MCP、plugins、apps、memory 和子代理；不更改全局配置。
- 输入：三个固定 SHA 源码目录、thinking-agent 当前 HEAD + WIP，以及阅读起点；未提供先前模型结论。记录中有 37 次只读命令；未调用测试、安装、构建或应用。
- 结果：退出码 `0`，`turn.completed`，耗时 `652.188` 秒。该结果仅表示独立审阅完成。
- 归档处理：以下正文保持原意见，仅将第三方临时快照链接转换为相同 SHA 的 GitHub 链接。调用方随后运行的 Cindy 聚焦用例和本地守卫夹具实验，不归为这次 Codex CLI 的运行证据。

---

**我的结论：Stair 最值得借鉴的是 Maka 的验证分层、Cindy 的规则入口与执行证据、ZCode 的状态所有权分析；不宜整套移植任何一家的治理体系。** 当前项目已经有源码回归、构建检查和严格的人工验收合同，优先问题是让入口、实现、检查范围和验收声明相互一致。

本次核验了四个 HEAD，均与给定 SHA 一致；thinking-agent 同时按当前未提交 WIP 分析。以下“已接线”仅表示源码中存在调用关系。未运行测试、构建或应用，未联网、修改文件、读取已有模型报告，也没有实际运行通过证据。

**Maka：最有价值的是把昂贵验证的使用理由做成可审查合同。**

它要求逐条行为断言选择最低有效测试层：状态、事件顺序、存储和恢复优先放在单元或集成测试；布局、焦点等浏览器行为使用 Chromium；只有具体 Electron 边界才进入真实应用测试。迁移还要求证明替代测试能检出原缺陷，并保留独立的原生保护。这比“多写 E2E”更有工程价值。[e2e/AGENTS.md:22](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/e2e/AGENTS.md#L22)

这里有完整证据链：

- **规则**：上述分层与 Electron 准入理由。
- **检查**：预算检查器核对文件、测试数量、非空 Electron 理由以及已删除条目；不能识别的测试声明形式直接报错。[check-e2e-budget.mjs:82](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/scripts/check-e2e-budget.mjs#L82)
- **测试**：反例明确覆盖数量漂移、空理由、新文件未登记和已删除文件仍登记。[check-e2e-budget.test.mjs:74](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/scripts/check-e2e-budget.test.mjs#L74)
- **执行入口**：desktop 的 `check:e2e-budget` 先运行检查器测试，再执行检查；根命令转发，CI 无条件调用，特意不放进条件执行的 Electron job。[ci.yml:118](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/.github/workflows/ci.yml#L118)

但源码也揭示了它的限度：填写任意非空理由即可满足机器检查；数量相同，不代表断言有效或测试层级正确。预算是清单一致性约束，不是覆盖率证明，更不是测试数量上限。

另一项值得借鉴的是 renderer 的“存量债务只能减少”机制。它解析依赖和能力访问，区分 shell、composition、application、feature、platform；CI 使用基准提交重新计算债务，检查器变化时还调用旧检查器交叉比较。文档同时承认：目标 owner 字段不证明迁移完成，比较规则自身仍需 review。[renderer/README.md:81](https://github.com/apache/maka/blob/ba706ca645c623ec39993b48353fabdc58d6e14f/apps/desktop/src/renderer/README.md#L81)

这是成熟迁移工程，不是轻量模板：检查器与测试合计约 7,387 行。Stair 可以借鉴“冻结一个已知危险入口、只允许债务减少”，目前没有充分理由复制整套分析器。

Maka 的文档分工也清楚：`ARCHITECTURE.md` 讲运行时所有权，`DESIGN.md` 主要讲视觉系统，`docs/README.md` 区分当前合同、历史材料与短期记录。代码审阅 skill 有 Copilot 指令入口；架构文档 skill 强调实现状态和证据，但 skill 文件存在本身不证明任何 CLI 已自动加载它。

**Cindy：最值得借鉴的是单一规则入口，以及对“执行成功”的具体定义。**

根 `AGENTS.md` 按任务触发条件导航到工程、产品和视觉规则，`CLAUDE.md` 实际只有 `@AGENTS.md`，避免两份正文长期漂移。代价也明显：入口已经承载大量专题索引，小项目照搬目录和审批条款，会增加检索与维护负担。

相关测试机制有完整接线。开发规则要求提交前执行 `test:unit:related`，公共包改动扩大到依赖方全包，调度器、配置或 Git 基准不可靠时回退全量。[development-workflow.md:78](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/docs/dev-rules/development-workflow.md#L78)

实现确实合并相对主分支的已提交、暂存、未暂存和未跟踪变化，并沿 `workspace:` 依赖计算传播；不是简单的“只运行改过的测试文件”。[test-related.mjs:181](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/test-related.mjs#L181) 选择器测试由根 `test:runner` 收录，CI 调用该自测入口；workspace 单测分片仍执行完整 unit tier，没有把相关测试替代为 CI 全量单测。[ci.yml:55](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/.github/workflows/ci.yml#L55)

不过，**删除文件是一个具体的选择缺口**：当叶子 workspace 只删除源码、没有其他传播路径时，文件不存在便不会进入 related 参数，计划可以返回 `skip`；对应测试明确要求如此。[test-related.test.mjs:237](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/__tests__/test-related.test.mjs#L237) 这证明选择器会跳过，尚不能证明发生了产品回归——类型检查可能另行发现问题。类似地，Markdown/资源被排除、依赖图只认特定声明、related 模式允许 `--passWithNoTests`，都使它适合作为反馈加速器，而不能证明“所有受影响行为已覆盖”。

开发 verdict 比单纯检查进程存活更有价值：它要求 checkout 根目录、commit、ready 和 commitVerified 同时匹配，并返回 PID、模式等信息；相关成功与失败分支有测试，restart/whoami 入口实际消费它。[desktop-dev-verdict.mjs:166](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/desktop-dev-verdict.mjs#L166) 但 commit 相同仍不能证明脏工作树内容已加载，ready 也不证明全部产品行为正常。Stair 借鉴时应保留自己的 WIP 与 Run 身份要求。

视觉治理的边界尤其值得学习：规则、数值、迁移台账和真实截图分别承担不同职责。与此同时，PR 设计依据检查只是路径启发式和正文格式校验；正文含 `DESIGN.md`，或“不涉及”附足够长度理由，即可通过，不验证章节存在、引用正确或视觉效果。[check-pr-design-basis.mjs:71](https://github.com/makecindy/cindy/blob/1f63ff9c1a6fe8230f085555ab420c408efd96e1/scripts/check-pr-design-basis.mjs#L71)

`REVIEW.md` 还明确区分机器检查和人工判断。自动 review 的本地 workflow 调用了固定版本的外仓复用 workflow；受本次只读范围限制，我没有读取外部实现，因此不能进一步证明 `REVIEW.md` 实际进入了模型提示词。

**ZCode：设计问题问得好，但机器约束明显比文字承诺窄。**

其 architecture-governance 和 feature-boundary-planner 最值得学的是：先定位状态唯一所有者、命令接纳路径、持久化与投影关系，再分析异步顺序、幂等和过期结果。尤其后者明确说，静态可达性不等于产品关系，图索引也不等于测试覆盖。这很适合 Stair 的 Workbench、Browser Runtime、Project 与 Session 边界。

实际约束范围却很小：策略开启 `managedOnly: true`，只有 storage 标为受管模块；UI、desktop、CLI、session 等仍是 legacy。[architecture-policy.yaml:26](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/architecture-policy.yaml#L26) 因此“全仓禁止 UI 直接依赖实现”不能由当前检查器普遍证明，未受管调用方也不会因为跨进 storage 就自动受到全部检查。

解析器虽然使用 TypeScript AST，依赖解析却只处理相对路径；包名、workspace alias，以及未采集的动态加载不构成完整依赖图。[policy.mjs:152](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/policy.mjs#L152)

更重要的是 `--changed`：它取 `git diff HEAD` 加未跟踪文件，而非分支相对主干的提交差异；随后只保留变化文件、逆向依赖及全局违规。[index.mjs:317](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/scripts/architecture/index.mjs#L317) **静态推断**是：提交完成、工作树干净后，名为 `verify:pre-push` 的入口可能不再检查刚提交改动的大多数文件级违规。仓库 troubleshooting 也承认这个范围，故不是隐蔽实现细节，而是入口用途容易被误读。

这里没有找到完整的“规则→检查→测试→CI”链：规则、实现和 package 手动命令存在，但该快照没有 `.github/workflows`，在抽查的脚本和包测试中未找到架构检查器自测，也没有找到实际自动 hook。golden-module 是示例，不能算测试。skill 要求的四件套中，检查器只强制 `module.ts` 和 `contract.ts`；storage 实例没有发现另外两件。`architecture:context` 输出的主要是路径和依赖契约列表，也不自动包含完整 spec、测试和实现上下文。

**对小型复杂 Electron 项目，文件分工应围绕决策和发现成本，而非目录数量。**

| 载体 | 应承担的职责 |
|---|---|
| 根 AGENTS | 所有任务通用的少量规则、命令入口、按风险触发的阅读导航 |
| 局部规则 | 模块特有的不变量、真实实现位置与验证入口；不重复全局工作流 |
| 产品 spec | 用户可见行为、失败结果、验收场景；Stair 优先复用现有 Case ID |
| 技术 design／ADR | 状态所有者、协议、时序、取舍；只记录值得长期保留的决定 |
| 视觉 design | 语义 token、组件和交互规范；精确数值指向代码或生成源 |
| 长久 docs | 当前架构、开发操作、排障与维护知识，明确状态和权威关系 |
| 短期任务记录 | 本轮计划、尝试、日志、未决项和 Run 证据，不冒充当前合同 |
| skills | 可重复执行的方法与导航，不复制产品语义，不承担唯一规则存储 |

这里需要区分三种“权威”：用户决定与已确认 spec 描述**应该怎样**，源码描述**实现怎样**，运行证据说明**这一轮观察到什么**。三者冲突时，应判断是缺陷、过期文档还是需求改变；不能因为代码目前如此，就自动修改 spec 为现状背书。ZCode 的 `CONTEXT.md` 实际仅是插件商店词汇表，也说明文件名不能替代职责说明。

多 CLI 应共享正文，适配入口保持薄。Cindy 的单行转引值得借鉴，但不能未经验证便假定 Codex、Claude、Pi 对转引、嵌套规则和 skill 目录采用完全相同的发现机制。这里应验证各自实际加载了哪些文件，而不是维护三份近似规则。

**Stair 当前已经具备足够扎实的基础，主要缺口在连接与声明。**

`validate:ci` 已串联类型检查、两个守卫、i18n、源码测试、文档工具测试、Electron 构建及资产校验，Validate workflow 确实调用它。[package.json:44](/Users/zhihu/code/m_code/ai/thinking-agent/package.json:44) 源码运行器动态发现 apps/packages/scripts 中的测试，按 workspace 分进程，isolated 文件逐个执行，external 单独运行；发现规则已有测试。[run-source-tests.ts:5](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/run-source-tests.ts:5)

这仍不是 Full Run：完整 ESLint、Stair 目录包、whitespace，以及真实 DEV/PKG 的逐 Case 判定是另外的要求。现行规范明确 AUTO 与真实 Electron 不能互相替代，历史通过不能复用，源码变化须新建 Run。[stair-full-regression.md:12](/Users/zhihu/code/m_code/ai/thinking-agent/docs/stair-full-regression.md:12)

我还抽查了 Workbench 恢复链：恢复失败不启用写入、旧 Workspace 响应被丢弃、多窗口按 baseline 合并，都能找到实现和有行为断言的测试，并与现有精确 test name 映射对应。这些现成资产比新建模块合同框架更值得维护。

本次发现的实际偏差有三类：

- 根 `AGENTS.md`、根 `CLAUDE.md`、`docs/README.md` 当前不存在，已有开发文档缺少统一的 agent 入口；`CONTRIBUTING.md` 仍以 Craft 开发和类型检查为主。
- `.husky` 中仅发现生成的转发脚本，没有实际 `.husky/pre-commit`；生成脚本在目标文件不存在时直接退出。shared 的 CLAUDE 文档却写着 i18n 已接入 pre-commit。`prepare: husky` 不能证明项目检查已挂上。
- WIP 已将开发环境默认值改成 `.stair-dev` 和 `stair-dev` scheme，并有对应测试。[stair-profile.ts:28](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/stair-profile.ts:28) 新开发文档仍称应用数据“全部在 `.stair`”、深链统一为 `stair://`，属于当前源码与文档的明确偏差。[data-and-security.mdx:21](/Users/zhihu/code/m_code/ai/thinking-agent/apps/docs/src/content/docs/dev/data-and-security.mdx:21)

**最值得先做的三个动作：**

1. **收敛阅读入口并修正 WIP 对应说明。** 用一份短 AGENTS 指向现有 dev 文档和回归规范，Claude 入口仅转引；明确包级 CLAUDE 的职责。修正 DEV/PKG 命名空间、贡献流程和 hook 声明，不重写现有正文或另建第二份回归清单。验收是引用可定位、命令真实存在、冲突有明确归属。
2. **先加固已有守卫，再增加新规则。** raw-send 守卫只匹配固定文本、整文件豁免三个位置，而且 `|| true` 会把扫描错误吞掉；目录缺失也可能最后打印 OK。[check-raw-sends.sh:13](/Users/zhihu/code/m_code/ai/thinking-agent/scripts/check-raw-sends.sh:13) tool-name 守卫也有类似边界。应补违规、合法使用和检查失败的反例测试，区分“没匹配”与“没检查成功”，暂不扩建通用 AST 平台。
3. **用一条现有高风险 Case 做证据闭环样板。** 优先选 Workbench 恢复或跨 Project 写入，核对规则、实现、精确测试名、源码运行器和 CI 的关系；通过针对性变异确认测试会因行为错误而失败。沿用当前 Run 记录与真实 DEV/PKG 判定，只有重复出现身份误判时才补启动身份回执。

**现在不要做的三个动作：**

1. 不整套移植 Maka 的债务分析器、ZCode 的全模块四件套或统一行数上限；没有反复发生的边界问题，不先建立治理平台。
2. 不用 changed-only tests、静态架构绿灯或自动 review 替代当前完整门禁和逐 Case Full Run。尤其不要把“零测试”“未执行”“已被基线接受”归为通过。
3. 不借治理之名更换 Bun、框架或运行时接入，也不复制 Cindy 的 profile／沙箱／迁移政策。保留现有 WIP、开发版与正式包各自的数据，以及用户已经确定的回归数据规则。

**对上述建议，我最需要保留的疑问是收益排序。** 根入口缺失是事实，但尚未测量它是否经常导致 agent 漏读；守卫有静态盲区，也尚未证明这些盲区造成过生产事故。如果宿主已经稳定注入现有规则，新增入口的收益会降低；如果主要成本实际来自数十分钟的测试等待，就应先测量调度与进程隔离，再讨论局部加速。如果历史回归集中在别名或跨模块依赖，窄范围 AST 约束才可能超过文本守卫的收益。相反，频繁调整目录却没有行为事故，会削弱引入架构策略的理由。

若只能做一次两小时试点，我选 **raw-send 守卫的失败语义与反例测试**。它已有规则、脚本、package 和 CI 入口，变更面小，效果可直接测量。先用临时 fixture 证明非法发送会失败、合法 typed dispatch 会通过，再证明扫描目录缺失或扫描器异常目前可能误报成功；随后最小修复退出码处理。测试可借临时工作目录调用现有脚本，无需新依赖或新配置。

有效标准是：同一组反例修复前能揭露误报，修复后稳定拒绝；合法样例继续通过；新测试确实被现有源码运行器纳入；输出明确区分规则违规和检查失败。试点完成只能说明这条守卫更可信，不能据此宣布整个 Stair 或本轮 Full Run 已通过。
