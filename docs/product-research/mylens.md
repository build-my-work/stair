# MyLens 产品参考档案

> 审计日期：2026-09-02
> 参考对象：[MyLens](https://mylens.ai/)
> 审计范围：官网公开页面、官方学生/教师场景页、官方功能页、官方指南、定价页、隐私政策与 Trust Center
> 审计限制：未登录产品，未进行付费生成与长期学习实测；质量、准确率、引用忠实度、延迟复习和登录后的编辑体验均未被实证。

## 一句话结论

MyLens 值得 Stair 借鉴的不是“AI 自动把一切画得更好看”，而是把**同一份有来源的知识，变成可点击、可深挖、可切换表达、可追溯证据的交互界面**。

但 MyLens 的公开主链路仍然是“导入材料 → AI 结构化/可视化 → 点击探索 → 展示分享”；它优化了信息的“看懂与呈现”，却不等于完成了“闭卷提取 → 独立输出 → 反馈修正 → 延迟保留 → 迁移应用”的学习闭环。Stair 应把它当作**学习渲染层**，而不是学习引擎本身。

---

## 1. 当前产品事实

### 1.1 当前同时呈现“AI 展示代理”与“视觉思考平台”定位

- MyLens 当前首页将自己定位为 **AI presentation agent**：它生成视觉幻灯片、增加 AI 旁白，并保留观众的在线交互。[官网首页](https://mylens.ai/)
- MyLens 在官方比较指南中又将自己描述为 **native AI visual thinking platform**：从用户的资料和数据生成可点击、可编辑的可视化结构。[官方 NotebookLM 比较指南](https://mylens.ai/guides/notebooklm-vs-mylens-comprehensive)
- 因此，它并非一个纯教育产品；学习只是其中一个场景，核心能力是“将复杂内容转为可交互的视觉呈现”。[学生场景页](https://mylens.ai/mylens-for-education) [AI Agents 场景页](https://mylens.ai/agents)

### 1.2 公开的产品主链路

根据首页和学生场景页，公开主链路可归纳为：

1. **导入来源**：文档、幻灯片、链接、视频、图像、数据，或直接描述一个主题。[官网“How it works”](https://mylens.ai/)
2. **选择 Agent**：学习场景公开列出 Infographia、Classroom Pack、Quiz 和 Cheatsheet。[学生场景页](https://mylens.ai/mylens-for-education)
3. **选择或生成视觉表达**：时间线、思维导图、流程图、树、对比矩阵、表格和多种图表等。[官方 Visuals 目录](https://mylens.ai/visuals)
4. **点击节点继续探索**：可解释、扩展、查看引用、深入追问，部分功能页还展示将节点转为 infographic 或 flashcards。[时间线功能页](https://mylens.ai/ai-timeline) [Chrome 扩展页](https://mylens.ai/mylens-chrome-extension)
5. **编辑与个性化**：公开文案称内容、视觉类型、主题和布局可调整，也可请 AI 细化某一部分。[官网 FAQ](https://mylens.ai/) [官方 NotebookLM 比较指南](https://mylens.ai/guides/notebooklm-vs-mylens-comprehensive)
6. **旁白、演示与分享**：支持 AI 旁白、在线链接、嵌入和静态导出；学生页还宣称可导出 PNG、PDF 或 PowerPoint。[官网首页与 FAQ](https://mylens.ai/) [学生场景页](https://mylens.ai/mylens-for-education)

### 1.3 面向学习的公开能力

- **视觉学习材料**：将笔记、PDF、教材和视频转成信息图、思维导图、时间线、流程图和速查表。[学生场景页](https://mylens.ai/mylens-for-education)
- **节点级探索**：视觉元素不只是图片，点击节点后可解释、深挖、扩展和查看来源。[学生场景页](https://mylens.ai/mylens-for-education) [时间线功能页](https://mylens.ai/ai-timeline)
- **Quiz Agent**：官方页面列出选择题、判断题、简答题、概念题、词汇题、理解题、复习题和考试型练习题，来源可为 PDF、链接、笔记、视频等。[官方 Quiz 功能页](https://mylens.ai/ai-quiz-maker)
- **Cheatsheet Agent**：将来源压缩成高密度、可扫描的单页学习资料，且可再次切换不同视觉形态。[官方 Cheatsheet 功能页](https://mylens.ai/ai-cheatsheet-creator)
- **导读旁白**：官方称一键可把图变成带 AI 旁白的引导式 walkthrough，用户同时仍可探索可点击内容。[学生场景页](https://mylens.ai/mylens-for-education)
- **引用回溯**：首页公开 FAQ 称来源与幻灯片保持关联，引用和跳回原来源仍可用。[官网 FAQ](https://mylens.ai/)
- **多语言**：学生页公开宣称支持 60+ 种语言，可以本地语言提示、导入材料和要求输出。[学生场景页](https://mylens.ai/mylens-for-education)

### 1.4 来源、账户与数据

- MyLens 公开页面称来源和用户内容不用于训练 AI 模型，且上传内容默认对工作区私有。[官方 Trust Center](https://mylens.ai/trust)
- Trust Center 公开列出 AWS 用于托管与存储，Google Gemini、OpenAI 与 Anthropic 用于 AI 内容生成。[官方 Trust Center](https://mylens.ai/trust)
- 隐私政策说明，用户创建的 prompts、stories、visualizations 以及用作来源的文档和链接都会被收集和处理。[官方隐私政策](https://mylens.ai/privacy-policy)

> **审计边界**：以上是 MyLens 自述，不是独立安全审计结论；Trust Center 在 2026-09-02 显示 SOC 2 仍为“In progress”。

### 1.5 定价快照与文案歧义

- 2026-09-02 的公开定价页显示 Free 方案每月 15 AI Credits、1K Source Limit、每个 Storyboard 1 个来源，并列有 AI Narration；Pro 才列出 Multi Sources per Storyboard 与 Manual Edit。[官方定价页](https://mylens.ai/pricing)
- 但学生场景页又宣称“Every visual is fully editable”。[学生场景页](https://mylens.ai/mylens-for-education)

**结论**：公开文案无法确认免费方案中“fully editable”与付费页“Manual Edit”的具体边界；登录后功能和套餐门槛必须再做实测，不在本文中推断。定价也属高变动信息，不应当作长期产品判断。

---

## 2. 从 Input → Process → Output 审视 MyLens

| 环节 | MyLens 的公开机制 | 产品判断 |
| --- | --- | --- |
| Input | 可导入多种来源，AI 抽取重点与结构 | 显著降低进入门槛，但也容易进一步扩大“资料已处理 = 我已学会”的错觉 |
| Process | 可切换视觉表达，点击节点解释、扩展、追问与查看引用 | 比线性摘要更有利于看见结构与关系，但“点开”仍是识别式活动，未自动变成学习者的提取、解释与判断 |
| Output | Quiz、可编辑图、演示、导出与分享 | 能生成可交付物，但公开设计中主体多是 AI 产出；还看不到对学习者独立输出质量的证据化评估 |
| Feedback | Quiz 用来发现缺口的宣传表述 | 公开页面未展示逐步诊断、针对性补救、尝试历史、延迟保留与迁移证据，不能据此认定已有学习闭环 |

### 核心判断

MyLens 展示了一个很好的**可理解性界面**，却未在公开证据中展示一个完整的**可证明学习界面**。

这个区分对 Stair 非常关键：

- “看见了概念间的连线”，不等于“能离开图重建连线”。
- “点击 Explain”，不等于“能用自己的话解释”。
- “AI 产出 Quiz”，不等于“系统基于尝试证据适应性地修复学习缺口”。
- “已经分享一幅美观的图”，不等于“已能在新场景中独立应用”。

---

## 3. 最值得借鉴的机制

### 3.1 把交互放在“知识对象”上，而不是全部塞进聊天框

MyLens 的 Explain、Expand、Cite、Infographic、Flashcards 等动作是从当前节点发起的。[时间线功能页](https://mylens.ai/ai-timeline)

Stair 应转化为更符合学习的节点动作：

- **先说说你怎么理解**，然后才可点“听 AI 解释”。
- **查看依据**，直接跳回源文片段。
- **举个反例**，用边界条件加深概念。
- **变成一道题**，可对当前节点即时提取。
- **放进我的项目**，将概念转成现实任务的决策或检查点。

这会比“随时问 AI”更直觉，也能减少用户不知道怎样提问的理解成本。

### 3.2 用内容结构选择表达，而不是只生成“更漂亮的摘要”

MyLens 公开目录将序列、层级、流程、对比、网络、地理和统计等不同关系映射到不同视觉形式。[官方 Visuals 目录](https://mylens.ai/visuals)

Stair 不应先让学习者从几十种图里选一种，而应根据知识关系自动给出第一建议：

| 知识关系 | 默认表达 |
| --- | --- |
| 先后演化 | 时间线 |
| 原因、结果、条件分支 | 因果/流程图 |
| 整体、局部、概念层级 | 树或嵌套图 |
| 相似点与差异 | 对比矩阵 |
| 角色、阶段、交接 | 泳道图 |
| 组件间相互影响 | 关系网络 |

用户仍可切换，但“换一种表达”应服务于认知任务，不是变成主题与样式消费。

### 3.3 同一个知识对象，在不同学习阶段变换形态

MyLens 能将同一来源转为不同图，也能再转为 Quiz 或 Cheatsheet。[学生场景页](https://mylens.ai/mylens-for-education) [Quiz 功能页](https://mylens.ai/ai-quiz-maker)

Stair 应进一步把这件事变成连续学习：

```text
源资料中的知识模型
  → AI 引导图（初次理解）
  → 留白图（有支架回忆）
  → 空白画布（独立重建）
  → 用户口述/作答（独立输出）
  → 认知差异（反馈修正）
  → 新情境任务（迁移应用）
```

此时视觉图不再只是“展示成品”，而成为从 AI 支架逐步交棒给学习者的界面。

### 3.4 视觉节点必须与来源及学习证据同时关联

MyLens 的节点引用和 jump back to source 值得保留。[官网 FAQ](https://mylens.ai/)

Stair 应让一个节点同时回答三个问题：

1. **它从哪里来？** —— 来源片段与引用。
2. **我现在怎么理解？** —— 学习者的理解版本、例子和修正。
3. **我真的会了吗？** —— 有支架尝试、独立尝试、延迟提取和项目应用证据。

这能避免把“来源事实”、“我的理解”和“我已经掌握”混为一张 AI 生成的图。

### 3.5 用可点击的层级渐进呈现复杂度

MyLens 将概览层和节点深挖放在同一个视觉对象中。[官方 NotebookLM 比较指南](https://mylens.ai/guides/notebooklm-vs-mylens-comprehensive)

这对 Stair 的意义是：

- 初学者先看到一屏的主干，不被长文淹没。
- 只在遇到理解障碍时打开支线。
- 深挖后仍保留自己处于全局的位置。
- AI 根据学习者的尝试结果改变推荐的层次，而不是一次性显示所有解释。

---

## 4. 不应照搬的部分

### 4.1 不照搬“资料 → AI 视觉成品 → 分享”作为学习主链路

这条链路非常适合沟通和呈现，却会让学习者把 AI 的结构化工作当成自己的认知加工。

Stair 必须在“看懂”之后继续要求：

- 隐藏图后重建主干。
- 不看解释，用自己的话说一遍。
- 针对错误连线进行局部修正。
- 在新问题和真实项目中使用它。

### 4.2 不把“视觉类型和主题数量”当作学习价值

MyLens 的可视化目录很广，学习场景页也强调 unlimited themes。[官方 Visuals 目录](https://mylens.ai/visuals) [学生场景页](https://mylens.ai/mylens-for-education)

对 Stair 而言：

- 首要选择是“现在要理解、回忆还是应用？”，不是“要时间线还是手绘主题？”
- 视觉类型应由知识关系默认推荐，需要时才让用户切换。
- 主题仅服务可读性和情绪，不进入核心学习指标。

### 4.3 不把 Cheatsheet 当作“记得牢”

Cheatsheet 能压缩信息，非常适合考前导航和快速查找。[官方 Cheatsheet 功能页](https://mylens.ai/ai-cheatsheet-creator)

但它仍属于强支架的 Input。Stair 中的用法应是：

- 学习前：作为路线图，不作为已掌握证据。
- 独立输出时：隐藏。
- 反馈后：只重新显示错误附近的部分。
- 复习时：先召回，再作为对照答案。

### 4.4 不把 AI Narration 变成另一条被动收听通道

旁白的价值是帮初学者建立主线，不是把阅读转成不停顿的播客。

Stair 中的导读应默认带有停顿点：

```text
讲一小段
  → 让用户预测下一步
  → 让用户指出图中的关系
  → 让用户用自己的话复述
  → 再继续展开
```

### 4.5 不把“生成了 Quiz”当作练习闭环

MyLens 的官方 Quiz 页证明它能从材料生成多种题型。[官方 Quiz 功能页](https://mylens.ai/ai-quiz-maker)

但公开页面未证明以下能力：

- 根据学习目标与先修关系选题。
- 根据每次尝试的错误模式生成针对性反馈。
- 由有支架题逐步过渡到无支架任务。
- 延迟再测和跨情境迁移。
- 用尝试证据更新掌握状态。

所以 Stair 可借鉴“就地变题”，但练习引擎仍必须自己完成上述闭环。

---

## 5. 映射到 Stair 的六个入口

| Stair 入口 | 借鉴 MyLens 的方式 | 明确不做什么 |
| --- | --- | --- |
| **首页** | “继续上次”可直接返回上次的概念节点、当前问题和未完成尝试 | 不做视觉模板市场，不把“新建一张图”当作首要任务 |
| **学习** | 从学习目标和来源生成一屏主干；点节点可解释、查依据、举例或切换表达；随学习进程逐步淡出 AI 支架 | 不在用户刚导入时就要求画图；不让自动可视化取代 Learn First |
| **练习** | 对当前节点“就地变题”；隐去关键节点或连线，让学习者重建；系统比较 AI 参考模型与用户当前模型 | 不只生成一批选择题；不在作答前显示 Cheatsheet |
| **项目** | 把概念图转为真实任务中的决策树、流程、架构或检查表；项目产出反向更新理解与证据 | 不把“导出一张演示图”冒充真实项目输出 |
| **资料** | 一份资料可以多视图浏览，每个节点保留来源片段；视觉是资料的表示层，不是重复复制一份 AI 笔记 | 不用“已生成摘要/图”标记已学习；不在资料页堆放无限主题 |
| **成长** | 展示参考图、首次重建、修正版、延迟重建与项目应用之间的变化 | 不用“生成图数、打开节点数、分享数”表示掌握程度 |

### 全局 AI 的位置

MyLens 最好的启发是：AI 不一定通过一个巨大聊天窗口出现。它可以是当前学习对象上的一组就地动作。

Stair 中的全局“问 AI”仍保留，但高频学习行为应通过上下文动作完成：

```text
解释这里  ·  查看依据  ·  先考考我  ·  给个反例  ·  放进项目
```

---

## 6. 建议融入 Stair 的产品方案

### 6.1 不新增“可视化”一级入口

MyLens 能力应成为横跨“学习、练习、项目、资料、成长”的渲染与交互层，不应再增加一个让用户理解的“AI 画图工具”。

对用户来说，他不是要“创建 Mind Map”，而是要：

- 先看懂一个主题的主干。
- 找到自己不懂的那个关系。
- 重新讲出或画出它。
- 用它解决一个问题。

图形只是系统为完成当前任务选择的语言。

### 6.2 标志交互：“会交棒的理解图”

```text
1. AI 根据当前目标和来源，只画出一屏主干
2. 用户点节点，先回答一个小问题，再展开 AI 解释与依据
3. 经过一小段学习后，AI 的关键词和连线逐步淡出
4. 用户拖回节点、补上关系，或用语音重建主干
5. AI 不给总分，而是标出：漏掉什么、连错什么、哪个例子不成立
6. 只重教错误所在的局部，再次交棒
7. 延迟复习时只显示空白骨架，在项目中则变成可应用的决策图
```

这个交互吸收了 MyLens 的“可视化 + 点击深挖 + 同源变形”，但将最关键的 Process 和 Output 还给了学习者。

### 6.3 与“我的理解”记忆层的关系

MyLens 式图形是“当前视图”，不应成为另一份独立真相。

一次学习结束后：

- 原始文档仍属于**来源记忆**。
- AI 参考图仍是学习支架。
- 用户重建的概念、关系、例子和修正才能进入**我的理解**。
- 独立尝试、延迟重建和项目应用进入**能力证据**。

这样，可视化层与 Zettelkasten 式长期记忆不会变成两套相互重复的产品。

---

## 7. 建议优先验证的最小产品切片

不先做整套可视化平台，只用一个真实主题验证一条纵向闭环：

```text
导入一份资料
  → AI 给出一屏关系图
  → 点一个节点看解释与来源
  → 学完后图逐步留白
  → 用户重建
  → AI 显示认知差异
  → 局部修复
  → 留下“我的理解”
  → 延迟重建
```

验证时不看“图好不好看”，先看：

1. 用户能否不看图讲出主干。
2. 用户是否能发现并修正一个错误关系。
3. 用户第二天能否重建。
4. 用户能否在新任务中使用它。

---

## 8. 当前无法确认的问题

下列能力在本次审计中没有得到登录后实测或官方详细文档证据，不应当作已确认事实：

- 长 PDF、视频、表格和多来源合并时的抽取质量。
- 视觉节点的引用是否精确对应原文，以及错误引用的修正机制。
- AI 自动选择视觉类型的准则与可控程度。
- Flashcards 的完整交互，是否有记忆排程或延迟提取。
- Quiz 是否记录学习者答案、保留尝试历史、生成针对性反馈或自适应下一题。
- 是否有概念级掌握状态、间隔复习、迁移任务和长期成长证据。
- AI Narration 是否可定位到引用、接受学习者中途回答，或根据回答调整讲解。
- 学生页的“fully editable”与定价页“Manual Edit”之间的真实套餐边界。
- 共享学习图中的权限、协作、版本和个人学习证据如何分离。

### 如需第二轮实测，建议只测一条纵向任务

不用穷举所有视觉类型。选一份可人工校验的中等长度学习资料，完整走一遍：

```text
导入来源 → 生成主图 → 点节点解释/引用 → 转成 Quiz
→ 提交答案 → 查看反馈 → 隔天再访
```

用这条任务验证“生成品质、引用忠实度、练习反馈和连续性”，才能判断哪些能力可以进入 Stair 原型。

---

## 9. 最终取舍

### 建议吸收

- 多源内容到结构化视图的快速转换。
- 一屏主干 + 节点级渐进深挖。
- 在知识对象上直接提供 Explain、Cite、Expand 一类上下文动作。
- 同一知识模型在时间线、关系图、对比表、练习和导读之间变形。
- 每个结论都保留跳回原始来源的能力。
- AI 在节点上就地出现，而不是只存在于聊天框。

### 建议拒绝

- 把 AI 生成的视觉摘要当作“已学会”。
- 把一键展开、旁白和 Cheatsheet 当作主要学习活动。
- 把视觉模板、主题和导出格式放到学习主导航。
- 把 Quiz 当作一种内容格式，而不记录尝试、错因、修正和延迟保留。
- 用视觉产出数量、打开次数或分享数代替能力证据。

### 对 Stair 的一句话转化

> MyLens 让 AI 把知识画给用户看；Stair 应让 AI 先帮用户看懂，再逐步擦掉支架，直到用户能自己重建、解释和应用。

---

## 官方来源

- [MyLens 官网首页](https://mylens.ai/)
- [MyLens for Education](https://mylens.ai/mylens-for-education)
- [MyLens for Teachers](https://mylens.ai/mylens-for-teachers)
- [MyLens Visuals](https://mylens.ai/visuals)
- [MyLens AI Quiz Maker](https://mylens.ai/ai-quiz-maker)
- [MyLens AI Cheatsheet Creator](https://mylens.ai/ai-cheatsheet-creator)
- [MyLens AI Timeline](https://mylens.ai/ai-timeline)
- [MyLens AI Mind Map](https://mylens.ai/ai-mindmap)
- [MyLens Chrome Extension](https://mylens.ai/mylens-chrome-extension)
- [MyLens for AI Agents / MCP](https://mylens.ai/agents)
- [MyLens 官方 NotebookLM 比较指南](https://mylens.ai/guides/notebooklm-vs-mylens-comprehensive)
- [MyLens Pricing](https://mylens.ai/pricing)
- [MyLens Trust Center](https://mylens.ai/trust)
- [MyLens Privacy Policy](https://mylens.ai/privacy-policy)
