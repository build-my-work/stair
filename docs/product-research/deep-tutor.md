# DeepTutor 产品参考档案

> 审计日期：2026-09-02
>
> 上游仓库：[`HKUDS/DeepTutor`](https://github.com/HKUDS/DeepTutor)
>
> 固定版本：[`6e6e56aedb559ccb6e147e25024352b60da28b90`](https://github.com/HKUDS/DeepTutor/tree/6e6e56aedb559ccb6e147e25024352b60da28b90)（`v1.6.3`）
>
> 证据边界：只使用该固定版本的 README、提示词、前后端源码；下文明确区分“上游事实”和“Stair 的产品判断”。

## 结论

DeepTutor 值得借鉴的不是它庞大的功能清单，而是三条产品骨架：

1. **一个 Agent 运行时，多个目的明确的学习循环**；
2. **学习不是一次聊天，而是一条可以暂停、恢复、留下证据并按期复习的持久路径**；
3. **课程编排层默认只给一个下一步，再把学习者交给真正负责教学或练习的场景**。

但不能照搬它的产品形态。DeepTutor 把 Chat、Ask Questions、Quiz、Research、Visualize、Solve、Mastery Path、Immersive Reading、Course Study 等能力分别暴露为模式或工作区；这对一套通用开源平台合理，对追求“没有说明书也会用”的 Stair 会显著增加选择成本。[README：统一运行时与能力清单](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/README.md#L217-L225) [README：首页与专用工作区](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/README.md#L576-L592)

对 Stair 最重要的改写应是：

> 后台可以拥有很多能力，前台任何时刻只让用户面对一个最合适的学习动作。

## 一、产品事实：DeepTutor 实际做了什么

### 1. 一套运行时，多个专用循环

DeepTutor 将辅导、解题、测验、研究、可视化、课程学习、掌握路径、沉浸阅读和视频学习建立在同一套 capability runtime 与 session context 上，同时保留各场景自己的循环和管线。知识库、书籍、草稿、笔记本、题库、Persona 与 Memory 可以被支持它们的工作流复用。[README：Key Features](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/README.md#L217-L225)

Chat 中又把上下文分成两类：课程、能力、知识库、Persona、阅读或 Mastery 状态属于跨轮保留的 sticky context；文件、聊天历史、书籍片段、笔记与题库等属于一次性引用。[README：Context 分类](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/README.md#L588-L592)

**我们的判断：**值得借的是“统一状态与运行时”，不是把每一种 capability 都做成入口。Stair 的六个入口应是用户心智中的工作阶段，底层工具按上下文自动挂载。

### 2. 学习主题从目标和材料生成，但先让用户确认路线

创建 Mastery Topic 的界面是三步：`Goal → Materials → Outline`。用户先填写主题和学习目标、选择书籍/笔记本/知识库，AI 再生成路线草稿；草稿进入可编辑的 `RouteDraftEditor`，用户确认后才创建主题并开始学习。[创建向导：状态与生成](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/web/components/space/learning/CreateTopicWizard.tsx#L34-L117) [创建向导：Goal / Materials / Outline](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/web/components/space/learning/CreateTopicWizard.tsx#L168-L225)

路线生成受到明确边界约束：最多读取 16 个来源、每个来源最多 4,000 字符、总来源上下文最多 24,000 字符；模型最多生成 8 个模块、每个模块最多 7 个知识点，并把知识点分为 `memory / concept / procedure / design`。[路线生成边界](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/topic_generation.py#L24-L49) [路线实体化与限制](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/topic_generation.py#L146-L275)

**我们的判断：**“AI 提议、用户确认”是对的；但完整路线不必在学习前强迫用户阅读。Stair 可以在后台生成路线，前台先展示一个可信的下一步，并把“查看/调整路线”作为次级能力。

### 3. Mastery Path 是一套持久、可恢复的掌握门控

Mastery Path 把知识点分成四类，并采用两种门槛：

- `memory / procedure`：根据最近答题正确率形成量化证据，达到 0.9 才通过；
- `concept / design`：要求学习者用自己的话解释，由 Tutor 通过 `mastery_assess` 记录质性通过。

门槛决定下一个目标；同一知识点未通过时不会推进。[Mastery Policy：门槛与类型](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/policy.py#L32-L110) [Mastery Policy：下一目标](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/policy.py#L206-L288)

量化分数只读取最近五次结果并给予越新的作答越高权重；一次正确最多显示 0.5，两次最多 0.8，因此至少需要更多证据才可能跨过 0.9 门槛。[掌握度计算](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/mastery.py#L1-L37)

题目不是一次性聊天文本，而是持久化交互：服务端保存题目、预期答案和生命周期；用户稍后回答时再做确定性评分，预期答案不会经过模型回传。[PendingQuestion 与交互生命周期](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/models.py#L164-L225) Mastery 提示词也要求复用已持久化的题号、题面、选项与用户答案，避免恢复会话后重复出题或换答案。[Mastery 提示词：题目恢复](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/capabilities/mastery/prompts/zh/system.md#L7-L15)

**我们的判断：**这是 DeepTutor 最值得借鉴的部分。Stair 应把“我正在学什么、做到哪一步、上次卡在哪里、哪次输出还没交、什么时间该复习”作为独立于聊天记录的学习状态。

### 4. 复习不是独立卡片库，而是知识点状态的后续任务

DeepTutor 按知识类型设置不同的固定间隔：记忆型为 `0/1/3/7/14/30/60` 天，概念型为 `3/7/14/30` 天，程序型为 `3/7/14` 天，设计型为 `14/28` 天；仍未纠正的错题记录会得到最高复习优先级。[间隔复习调度器](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/scheduler.py#L13-L25) [复习推进与优先级](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/scheduler.py#L45-L98)

质性知识点首次通过后也会建立复习状态；后续评估会推进或缩短间隔，失败但从未通过的知识点不会被错误地当成“可复习的掌握”。[质性掌握与复习状态](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/service.py#L898-L990)

**我们的判断：**应借“复习附着于学过的能力和真实错误”，不应照搬固定间隔表。Stair 的复习时间应进一步考虑帮助程度、输出类型、错误稳定性、用户遗忘表现与真实项目使用。

### 5. 每个“掌握”可以回看证据

Mastery Topic 的目标详情会展示：门槛、复习时间、学习者自己的解释、每次题目与回答、正确次数以及错误诊断，而不是只显示最终状态。[目标证据界面](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/web/components/space/learning/ObjectiveDetail.tsx#L10-L109)

系统也允许学习者声明“我已经会了”并向前推进，但该声明不会冒充系统评估：`mastery_source` 明确区分 `system` 与 `learner`，原有证据保持不变。[Mastery Policy：证据来源](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/policy.py#L92-L118)

**我们的判断：**“事实、判断和证据来源不能混在一起”非常值得借。Stair 中 AI 判断、用户自评、系统测验、延迟回忆、项目迁移都应显示各自来源，不能压成一个不透明的掌握分。

### 6. Immersive Reading 把 AI 回答锚定在用户眼前的原文

阅读模式要求 Tutor 先检索位置、再读取真实原文；每处具体论断附页码并调用 `reader_goto`，让阅读器滚动并高亮依据。若材料不包含答案，必须明确说明，不能用模型记忆伪装成材料内容。[沉浸阅读提示词](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/capabilities/reading/prompts/zh/reading.yaml#L6-L34)

其中“学习引导”不是再给一段总结，而是根据选中原文提供三步行动：定位证据、建立联系、用自己的话表达，并明确禁止直接给最终答案。[阅读学习引导](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/reading/study_guidance.py#L20-L34) 阅读测验要求每个正确答案都带有来自当前上下文的证据，服务端验证证据确实存在后再移除该证据并展示题目，避免把答案泄漏给学习者。[阅读测验的证据校验](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/reading/quiz.py#L20-L34) [阅读测验的服务端验证](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/reading/quiz.py#L83-L95)

**我们的判断：**这正好解决 Input 过多的问题：资料页不再只负责阅读，而是在选中内容之后，立即推动一次小型 Process 和 Output。

### 7. Course Study 是编排器，不亲自承担所有教学

Course Study 的提示词刻意限制自己的职责：读取课程状态、默认推荐一个最有价值的下一步、说明原因，再通过 `course_handoff` 把学习者送往 Mastery、Reading、Question Bank、Notebook 或 Chat；它被禁止在编排模式里直接教学、解题或测验。[Course Study 提示词：职责边界](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/capabilities/course_study/prompts/zh/course_study.yaml#L3-L17) [Course Study：只推荐一个下一步](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/capabilities/course_study/prompts/zh/course_study.yaml#L25-L34)

它还明确规定：课程单元是否“已覆盖”由学习者决定，不由模型擅自勾选；一键可逆、结构很小的 Notebook 或 Reading Workspace 可以在得到同意后直接创建，但需要模型生成完整模块树的 Mastery Path 必须留在自己的专用流程里。[Course Study：用户所有权](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/capabilities/course_study/prompts/zh/course_study.yaml#L19-L34) [Course 工具的创建边界](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/capabilities/course_study/tools.py#L47-L88)

**我们的判断：**Stair 的首页应借用这个角色：它不成为另一个学习空间，只负责恢复上下文并给出一个下一步。用户不需要理解“现在该切哪个 AI 模式”。

### 8. 输出工具存在，但尚未成为 Mastery 的硬性终点

DeepTutor 有 Co-Writer、Notebook、Question Bank 和 Book 等输出或沉淀表面。Co-Writer 支持长文写作、选区修改、可逆编辑；Book 可以把来源编译成带测验、闪卡、交互模块、图表和用户笔记的 living book。[README：Co-Writer](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/README.md#L640-L651) [README：Book](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/README.md#L655-L672)

但 Mastery Path 当前的 `complete` 条件只是“所有知识点已通过并且没有到期复习”；它不要求用户完成一个外部作品，也不要求在新情境中完成迁移任务。[Mastery Policy：完成条件](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/policy.py#L206-L288)

**我们的判断：**DeepTutor 已经拥有 Output 工具，却没有把它们强制闭合进主学习路径。Stair 必须把“独立输出”和“新情境应用”作为能力成立的必要证据，而不是可选的旁路功能。

## 二、用 Input → Process → Output 审视 DeepTutor

| 阶段 | DeepTutor 的强项 | 仍然存在的问题 | Stair 的取舍 |
|---|---|---|---|
| Input | 多格式材料、RAG、沉浸阅读、视频字幕、可追溯引用、AI 生成 living book | 输入能力非常丰富，容易继续扩大阅读和生成内容的时间 | 资料进入后立即生成一个小学习动作，而不是继续推荐更多材料 |
| Process | 分知识类型的门槛、费曼解释、错因、间隔复习、同点不过不前进 | 新知识点默认 `probe first`；部分“理解”仍由 LLM 单次布尔判断 | 新用户坚持 Learn First；逐步撤掉支架后再判断 |
| Output | 测验回答、自己的解释、Notebook、Co-Writer、Book 用户笔记 | 输出表面与 Mastery 路径是并列能力；完成掌握不要求真实作品或迁移 | Output 不是一个工具入口，而是每个学习单元必须发生的阶段 |
| Closure | 状态可恢复、题目可恢复、复习可调度、证据可回看 | `complete` 仍主要等价于通过知识点门槛，没有项目迁移证据 | 成长状态必须区分支架下完成、独立完成、延迟后完成、跨情境应用 |

## 三、最值得借鉴的机制

### A. 学习状态独立于聊天状态

聊天是交互表面，学习路径才是事实来源。重开会话、刷新页面或更换教学表达，都不应让当前知识点、待答问题、错误记录和复习计划丢失。

### B. 同一学习内核，不同场景使用不同约束

学习、练习、阅读、项目可以共用用户画像、材料、记忆和证据，但各自应有专用协议：阅读必须引用原文；练习必须先提交再揭示；项目必须保留真实产物；成长只汇总已发生的证据。

### C. 下一步由学习状态计算，不由聊天模型随口决定

AI 可以选择如何讲、用什么例子、怎样反馈；“该学哪一点、是否可以推进、什么复习已到期”由持久状态和透明规则决定。

### D. 按知识类型选择输出，而不是所有内容都做选择题

- 记忆：闭卷召回、辨认与时间后的再现；
- 概念：自己的解释、例子、反例、关系辨析；
- 程序：在没有步骤提示时完成操作；
- 设计：说明取舍、处理约束并完成开放作品。

DeepTutor 的四类型是很好的起点；Stair 需要进一步把这些输出接到项目迁移证据。

### E. 证据来源显式化

用户自评可以存在，但不能伪装成测验通过；AI 判断可以存在，但不能伪装成事实；一次正确可以存在，但不能被称作长期掌握。所有状态都应能追溯到原始 Attempt、使用过的帮助、修正和时间。

### F. 编排器只给一个下一步

系统内部可以在学习、练习、阅读、项目、复习之间复杂决策，首页只呈现：

> 继续上次：用自己的话解释「冲突解决」，预计 4 分钟。

用户可以展开查看理由和路线，但不需要先选择 Quiz、Solve、Mastery、Reading 还是 Chat。

## 四、明确不可照搬的部分

### 1. 不照搬大量能力入口

DeepTutor 需要展示平台广度；Stair 需要减少学习者在“我要用哪个工具”上的元工作。不能在首页平铺 Chat、Quiz、Research、Solve、Visualize、Mastery Path、Reading、Watching。

### 2. 不照搬 `probe first`

DeepTutor 对未触碰知识点的正式策略是“先探查是否会了再教”。[Mastery 提示词：probe first](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/capabilities/mastery/prompts/zh/system.md#L6-L11) 这适合压缩已有知识，却不适合用户刚导入、尚未学习的新资料。

Stair 应是：

```text
明确已有基础 → 允许快速挑战或跳过
刚开始的新主题 → Learn First → 有支架练习 → 独立输出
```

### 3. 不把 90% 和百分比进度等同于掌握

DeepTutor 的主题卡把 `mastered / total` 转成 ProgressRing，并展示模块数、知识点数和会话数。[Topic Map Card](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/web/components/space/learning/TopicMapCard.tsx#L12-L58) 这很易读，但会让用户误以为“路线完成度”就是“能力可靠度”。

Stair 的成长状态应使用行为语言：

- 正在学习；
- 在支架下完成；
- 当前能独立完成；
- 延迟后仍能完成；
- 已在新情境应用。

### 4. 不把字符串匹配当作开放理解的可靠裁判

DeepTutor 当前的确定性评分中，简答题使用完全相等或 0.85 字符相似度，开放题使用 60% 关键词包含；错误初判只有“空白＝元认知、非空＝应用错误”两种。[评分与粗粒度错因](https://github.com/HKUDS/DeepTutor/blob/6e6e56aedb559ccb6e147e25024352b60da28b90/deeptutor/learning/grading.py#L13-L61)

这种方法适合窄答案题，不足以判断概念迁移或开放设计。Stair 对高价值输出应采用多证据评价：约束是否满足、推理是否一致、能否举反例、帮助程度、延迟表现和真实产物结果。

### 5. 不让 AI 生成路线替代真实学习

AI 生成的 3–8 个模块、2–7 个目标只是导航假设，不是已经建立的知识结构。用户未学过时，不应要求他先理解完整地图，更不能因为路线生成成功就增加成长进度。

### 6. 不把自动生成更多教材当成解决 Input 过多

Living Book、总结、图表和测验都可能有价值，但它们也可能把一份资料扩展成更多待读内容。生成的价值必须用“是否更快触发用户自己的处理和输出”衡量，而不是内容丰富度。

### 7. 不以 Mastery Path 的 `complete` 作为最终完成

通过当前门槛只说明学习者在这套题和解释中表现合格；没有延迟回忆和真实迁移时，不能宣称能力已经稳定。

## 五、映射到 Stair 现有六个入口

不新增 `Mastery Path`、`Immersive Reading`、`Course Study` 或 `DeepTutor` 一级入口。

| Stair 入口 | 借鉴 DeepTutor | 重写后的产品交互 |
|---|---|---|
| 首页 | Course Study 的“读取状态 → 推荐一个下一步 → handoff”；持久路径和会话恢复 | 默认主卡永远是“继续上次”，显示具体动作、预计时间和为什么现在做；次级区域才有开始新主题、导入资料等入口 |
| 学习 | Goal → Materials → editable Outline；统一上下文；单知识点聚焦 | 用户说明想学什么并选资料；AI 后台生成路线，先教当前一小步。新主题 Learn First，路线可查看/调整但不成为前置负担 |
| 练习 | 类型化门槛、持久题目、隐藏答案、错题证据、到期复习 | 依据知识类型选择回忆、解释、操作或设计；先作答再揭示反馈；刷新和跨会话仍回到同一待答动作 |
| 项目 | 复用同一上下文与材料；Co-Writer 的真实产物表面 | 先要求用户做出真实方案或作品，再按需调用旧知识；项目产物、取舍和结果成为迁移证据，而不是另开一个孤立 AI 写作器 |
| 资料 | Immersive Reading 的原文同屏、精确定位、基于选区的行动 | 选中原文后只给少量自然动作：解释这里、问我一下、用自己的话说、放进当前学习；AI 论断可以回到原文定位 |
| 成长 | 目标证据详情、复习队列、用户自评与系统评估的来源区分 | 不用单一百分比；展示原始 Attempt、帮助使用、Repair、延迟回忆和项目迁移，给出下一次最值得巩固的能力 |

跨入口的底层原则：同一个学习目标、材料、理解版本和能力证据被不同入口引用；用户切换的是工作阶段，不是创建六套互不相干的数据。

## 六、融合后的最小端到端体验

第一版只需要验证一条纵向链路：

```text
首页：继续上次
  ↓
学习：基于当前资料 Learn First，只聚焦一个概念
  ↓
有支架练习：共同完成一个例子
  ↓
交棒：隐藏讲解，让用户独立解释或完成
  ↓
反馈与 Repair：保存原始尝试、帮助和修正
  ↓
成长：记录“当前独立完成”，安排延迟唤醒
  ↓
项目：在新约束中再次应用，升级为迁移证据
```

从 DeepTutor 直接吸收四个基础能力：

1. 学习路径与聊天会话分离；
2. 待答动作与预期答案持久化；
3. 依据知识类型选择不同输出；
4. 复习从真实学习证据生成，并能恢复到一个明确的下一步。

第一版明确不吸收：

- 新增能力模式入口；
- 百分比 Mastery Path 首页；
- AI 生成整本教材；
- 固定的 90% 掌握门槛；
- 固定间隔表作为最终策略；
- 只靠一次 LLM 判断就宣布概念已掌握；
- 未经项目迁移就显示整条路线完成。

## 七、可以直接转成产品验收的问题

### 首页与连续性

- 用户离开后回来，能否一键回到具体未完成动作，而不是只回到聊天记录？
- 待答问题能否保持题面、选项、答案和上下文一致？
- 首页是否只推荐一个最重要的下一步？

### Learn First

- 新导入、从未学习的资料是否先获得足够讲解与示例？
- 系统是否只有在检测到用户确有基础或用户主动挑战时才压缩教学？
- 路线是否可修改，但不要求用户在学习前理解整张地图？

### Process 与 Output

- 每个学习单元是否一定触发一次用户自己的解释、回忆、操作或设计？
- AI 是否避免在用户输出前泄漏参考答案？
- 用户的原始 Attempt 与 Repair 是否都被保留？

### 记忆与迁移

- 复习是否来自学过的内容和真实错误，而不是自动生成的卡片堆？
- 延迟后能否再次闭卷完成？
- 项目中的实际应用能否更新能力状态，而不是只增加一条笔记？

### 简洁性

- 用户是否无需理解 Chat / Quiz / Mastery / Reading / Course 等内部模式？
- 每个页面是否有一个明显主动作，同时保留完整但次级的能力入口？
- 能否清楚区分资料事实、用户自评、AI 判断和行为证据？

## 八、最终取舍摘要

| 项目机制 | 决策 | 原因 |
|---|---|---|
| 统一 Agent runtime + 共享 context | 吸收 | 避免六个入口形成六套孤岛 |
| Goal + Materials + 可编辑路线 | 吸收并弱化前台地图 | 保留用户所有权，减少前置理解成本 |
| 持久 Mastery Path 与 pending question | 强吸收 | 直接解决“不能接着学”和跨会话断裂 |
| 四类知识与不同门槛 | 吸收类型，重写评价 | 不同知识需要不同输出，但不应只有分数/布尔值 |
| Course Study 单一下一步与 handoff | 强吸收 | 复杂能力藏在后台，首页保持简单 |
| 沉浸阅读的原文定位与选区行动 | 强吸收 | 把 Input 当场转成 Process / Output |
| 固定间隔复习 | 只作冷启动参考 | 需要根据真实遗忘与帮助程度个性化 |
| Probe First | 不吸收为默认 | 新主题必须 Learn First |
| 90% Mastery 与进度环 | 不作为成长模型 | 路线进度不能替代独立、延迟和迁移证据 |
| Living Book / 大量生成内容 | 暂不吸收 | 当前用户的主要问题是 Input 过多 |
| 多能力一级入口 | 不吸收 | 增加选择与理解成本 |

一句话总结：

> DeepTutor 告诉我们怎样把 AI 辅导变成一条可恢复、可门控、可复习的长期学习路径；Stair 需要再向前一步，把这套复杂内核藏起来，并用 Learn First、独立输出和真实迁移补齐它没有闭合的最后一公里。
