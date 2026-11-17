# Stair 学习系统：学习科学与脑科学复核与设计

> 建档日期：2026-11-03<br>
> 作用：用学习科学与认知神经科学证据，逐条复核[参考索引](./reference-index.md)中的产品原则与"明确不抄什么"，并据此提出学习系统设计。<br>
> 当前状态：产品研究与设计建议，未进入实现。<br>
> 证据边界：文献依据来自对已发表研究的整理，本轮未重新抓取原文；效应量为近似值，定量设参或对外引用前应核对原文。2024 年后关于生成式 AI 与学习的研究变化很快，统一标为"新兴"。

## 结论

现有原则的大方向与学习科学中证据最强的结论一致：AI 生成物不等于学会、要求独立输出、保留原始 Attempt、掌握要经过时间和迁移。这些不需要推翻。

但"明确不抄什么"里有几条是凭产品直觉写的，与证据冲突或过度概括：

1. **"不先挑战，Learn First"把两件事混在了一起。** 用于分流的诊断测验确实不该前置；但讲解前做一次不计分的预测或预提问，本身就是学习事件——即使答错，也会提升随后对这部分内容的学习（预提问效应）。对概念性内容，"先尝试、后讲解"（productive failure）在迁移上也有元分析支持。建议改为 **"先猜一下，再学"**。
2. **"全家桶"把检索型产物和消费型产物放在了一起。** 总结、播客、现成导图是可消费的输入，默认不生成是对的；但问题和闪卡是检索练习的载体，而检索练习是证据最强的学习手段之一。应拆开：前者默认不生成，后者按学习进度生成，但只以"待作答"形式出现。
3. **几条禁令过于绝对**："AI 画的图不进我的理解"、"不显示任何数字"、"尝试前不给答案"、"不新增维护工作"。证据支持的不是二元禁止，而是：按作者权记录来源、用校准替代模糊分数、用分级提示替代完全不给、去掉文书型维护但保留生成型整理。

此外，现有原则缺少几条证据较强、且直接影响设计的机制：

- **跨夜巩固**：第一次延迟回忆应跨过至少一次睡眠；
- **达标重学**：每次复习回忆到正确即停，跨多天重复；
- **反馈前先问把握度**：高把握度的错误最容易被纠正；
- **教中学**：让用户讲给扮演新手的 AI 听，这同时回答了想法 002 的"低压力输出"；
- **元认知错觉**：合意困难让人觉得学得更差，这是产品流失的主要风险，必须在设计中正面处理。

## 一、证据如何进入设计

| 等级 | 含义 | 设计中的用法 |
|---|---|---|
| A | 多项元分析，且有课堂或真实情境复制 | 直接作为默认机制 |
| B | 实验室结论稳健，但成人自学、长周期或真实产品中的证据有限 | 作为默认，并在产品内验证 |
| C | 单项研究、预印本，或主要来自动物实验和神经影像 | 只启发假设，不单独支持决策 |
| ✕ | 已被否定的神经迷思 | 明确不用 |

三条使用规则：

1. **行为证据优先于脑机制。** 脑科学解释"为什么有效"；决定"产品怎么做"的是行为层面的学习结果。从突触或脑区直接推出教学设计，被称为"一座太远的桥"（Bruer, 1997）。
2. **先看边界条件。** 几乎每个有效机制都有失效或反转的条件，例如专长逆转、交错只对易混类别有效。原则必须写清适用范围。
3. **学习者的偏好常常与学习效果相反。** 用户觉得"顺"的方式（重读、集中练习、看总结）往往效果更差。用户满意度不能作为学习功能的验收标准，只能作为流失风险的监测指标。

## 二、证据地图

### 2.1 记忆的写入与提取

| 机制 | 主要结论 | 等级 | 对 Stair 的含义 |
|---|---|---|---|
| 检索练习 | 主动回忆比重读更能提高长期保持；元分析效应约 g≈0.5–0.6（Roediger & Karpicke, 2006; Rowland, 2014; Adesope et al., 2017） | A | 独立输出和复习都必须"先回忆后看" |
| 间隔 | 分散练习优于集中练习；想保持越久，最优间隔越长（Cepeda et al., 2006, 2008） | A | 复习由排程驱动，不由"学完一章"驱动 |
| 首次间隔 | 扩展间隔与等间隔的长期差异小，关键是第一次回忆不要太早（Karpicke & Roediger, 2007） | B | 第一次复习不放在同一会话末尾 |
| 达标重学 | 每次会话回忆到正确一次即停，跨多个会话重复，长期保持显著且省时（Rawson & Dunlosky, 2011; Rawson et al., 2013） | A− | 复习的单位是"达标"，不是"做完 N 题" |
| 生成效应 | 自己生成的信息比读到的记得更牢，d≈0.4（Slamecka & Graf, 1978; Bertsch et al., 2007） | A | 理解、卡片答案、关系说明都应由用户写 |
| 预提问 / 预测试 | 学习前尝试回答，即使答错，也会提升随后对该内容的学习；收益集中在被问到的内容（Richland et al., 2009; Kornell et al., 2009; Pan & Carpenter, 2023） | B+ | 讲解前给一次不计分的预测，问题对准核心概念 |
| 检索诱发遗忘 | 只练一部分，短期内可能抑制相关但没练的内容；有延迟时常消失甚至变为促进（Anderson et al., 1994; Chan et al., 2006） | B | 复习覆盖核心概念全集，不只练易错的几个 |

### 2.2 理解与图式构建

| 机制 | 主要结论 | 等级 | 对 Stair 的含义 |
|---|---|---|---|
| 主动程度（ICAP） | 互动 > 建构 > 主动 > 被动（Chi & Wylie, 2014） | B+ | "看 AI 解释"是被动，"划线"是主动，"用自己的话解释"才是建构 |
| 自我解释 | 让学习者解释"为什么"，g≈0.55（Chi et al., 1989; Bisra et al., 2018） | A− | 每段讲解后跟一个"为什么"提示 |
| 样例与渐退 | 新手先学样例，再逐步撤去步骤，优于直接解题（Renkl & Atkinson, 2003） | A | "交棒"有直接证据支持 |
| 专长逆转 | 对新手有用的支架，对有基础的人反而有害（Kalyuga et al., 2003） | A | 撤支架看表现，不按固定剧本 |
| Productive failure | 先尝试、后讲解，在概念理解与迁移上优于先讲后练，约 d≈0.36；对程序性知识无优势，且依赖讲解是否利用学生的尝试（Kapur, 2008; Sinha & Kapur, 2021） | B | 适合概念性内容；不适合新手学习高元素交互的程序性内容（Kirschner et al., 2006） |
| 闭卷概念图 | 对照资料画概念图不如检索练习；闭卷画图本身就是检索，效果相当（Karpicke & Blunt, 2011; Blunt & Karpicke, 2014） | B | Drawnix 用于学习时应闭卷重建，不对照资料描画 |
| 学习者画图 | 自己画能提升记忆与理解，前提是有引导（Wammes et al., 2016; Fiorella & Zhang, 2018） | B | 画图是独立输出的一种形式 |
| 对比案例 | 比较两个案例比分别学习更能抽象出结构，促进迁移（Gentner et al., 2003; Alfieri et al., 2013） | B+ | 迁移练习成对给出，问"它们共同的结构是什么" |
| 交错 | 交错练习易混类别优于分块练习，g≈0.42；对说明文、不相似类别效果不稳定（Rohrer et al., 2015; Brunmair & Richter, 2019） | B+ | 只在复习中交错易混概念，不在首次学习时交错 |
| 工作记忆与分段 | 工作记忆约 4 个组块（Cowan, 2001）；分段呈现、相关信息空间邻近有利于学习（Mayer, 2009） | A | 讲解要短、分段；参考与问题放在一起 |

### 2.3 反馈与错误

| 机制 | 主要结论 | 等级 | 对 Stair 的含义 |
|---|---|---|---|
| 反馈层级 | 约三分之一的反馈干预反而降低表现；指向"人"的反馈（表扬、评价自我）效果最差，任务与过程层面最有效（Kluger & DeNisi, 1996; Hattie & Timperley, 2007; Wisniewski et al., 2020, d≈0.48） | A | 反馈说"这一步缺了什么"，不说"你真棒""你不行" |
| 反馈必要性 | 答错后不给正确信息，检索练习的收益大幅下降（Pashler et al., 2005） | A | 每次检索后必须有反馈 |
| 反馈时机 | 记忆型检索中延迟反馈有利于保持；新手学程序性技能时即时反馈更好（Butler & Roediger, 2008; Shute, 2008） | B | 时机按知识类型决定 |
| 高把握度纠错 | 自信满满答错的内容，反馈后最容易被纠正（Butterfield & Metcalfe, 2001） | B | 反馈前先问把握度，高把握度错误优先复测 |
| 帮助困境 | 帮助太少导致无效挣扎，太多导致不学习，需要按状态调节（Koedinger & Aleven, 2007） | B | 用分级提示，并记录用到哪一级 |
| 错误样例 | 找出并修正样例中的错误能促进学习，对已有基础者更明显（Große & Renkl, 2007; Adams et al., 2014） | B | 批判 AI 产物可以作为练习，但放在 L3 之后 |

### 2.4 元认知

| 机制 | 主要结论 | 等级 | 对 Stair 的含义 |
|---|---|---|---|
| 流畅性错觉 | 材料就在眼前时，人会高估以后能否回忆（Koriat & Bjork, 2005） | A | 读完总结后的"懂了"不可信 |
| 策略偏好错误 | 多数学生以重读为主要策略；做过对比实验的人仍觉得集中练习更好（Karpicke et al., 2009; Kornell & Bjork, 2008） | A | 不能让用户自选学习方式而不提示代价 |
| 错觉难以纠正 | 只讲道理、甚至亲身体验一次，仍有很多人坚持错误信念（Yan et al., 2016） | B | 需要反复用用户自己的数据说明 |
| 延迟判断更准 | 学完隔一段时间再判断"能不能记住"，比学完立刻判断准确得多（Nelson & Dunlosky, 1991） | A | 自评放在延迟之后，而不是学完立刻 |
| 策略效用评级 | 高：自测、间隔；中：精细追问、自我解释、交错；低：重读、划线、总结（Dunlosky et al., 2013） | A | 产品默认动作来自高效用一侧 |

### 2.5 动机与情绪

| 机制 | 主要结论 | 等级 | 对 Stair 的含义 |
|---|---|---|---|
| 自我决定理论 | 自主、胜任、关联三种需要支持内在动机（Ryan & Deci, 2000） | A | 推荐一步但允许改选；让人看见自己变强；有人（或 AI）在意你的解释 |
| 外在奖励 | 可预期、与任务挂钩的有形奖励会削弱内在动机；信息性的正面反馈会增强（Deci et al., 1999） | A | 不用积分、排行换学习行为，用证据反馈 |
| 游戏化 | 效应小到中等且高度异质，严格研究中部分效应不稳定（Sailer & Homner, 2020） | B | 不作为核心机制 |
| 效用价值 | 让学习者写下内容与自己生活的关系，提升低预期者的兴趣和成绩（Hulleman & Harackiewicz, 2009） | B | 新主题开始时问一次"你学这个要用在哪" |
| 实施意图 | "在 X 时间/地点我会做 Y"显著提高目标达成，d≈0.65（Gollwitzer & Sheeran, 2006） | A− | 让用户设定复习的时间点，而不是只发提醒 |
| 好奇心 | 好奇心与不确定性呈倒 U 形；高好奇时记忆更好，伴随中脑多巴胺区和海马激活（Kang et al., 2009; Gruber et al., 2014） | B | 预测问题要"有点把握但不确定" |
| 压力与提取 | 急性压力损害提取（de Quervain et al., 2000）；用检索练习学过的内容在压力下不受影响（Smith et al., 2016） | B | 低风险练习本身就是抗压训练 |
| 低风险测验 | 不计分的课堂检索练习降低学生自报的考试焦虑（Agarwal et al., 2014） | B− | 练习不计分、私密 |
| 教中学 | 学完后讲给他人比只预期要教更利于延迟保持（Fiorella & Mayer, 2013; Kobayashi, 2019）；学生为"可教代理"学习时更努力（Chase et al., 2009） | B | 让用户教扮演新手的 AI |

### 2.6 脑机制：用于解释，不单独决策

| 机制 | 主要结论 | 等级 | 对 Stair 的含义 |
|---|---|---|---|
| 互补学习系统与睡眠 | 海马快速编码，新皮层缓慢整合，睡眠中的重放支持巩固（McClelland et al., 1995; Diekelmann & Born, 2010）。两次学习之间隔一夜，能减少重学所需练习并提升半年后的保持（Mazza et al., 2016） | 机制 B / 行为 B | 首次延迟回忆跨过至少一次睡眠；"延迟独立"以跨夜为条件 |
| 图式加速巩固 | 已有图式时，新信息可以极快整合（大鼠：Tse et al., 2007）；与图式一致的信息更依赖内侧前额叶，新异信息更依赖内侧颞叶（van Kesteren et al., 2012） | C+ | 讲解前激活旧理解，"过去的你"有机制依据 |
| 预测误差 | 多巴胺神经元编码"结果与预期之差"，驱动学习（Schultz et al., 1997） | B（机制） | 先有预测，才有误差；支持"先猜一下" |
| 再巩固 | 被提取的记忆短暂进入可修改状态（Nader et al., 2000，动物）；人类证据不一致 | C | 只作为"检索后立即反馈"的补充解释 |
| 任务切换 | 切换任务有稳定的时间与准确率代价（Monsell, 2003） | A | 独立输出时单焦点，不多面板并行 |

### 2.7 生成式 AI 与学习（新兴）

| 研究 | 结论 | 等级 |
|---|---|---|
| Bastani et al. (2025, PNAS)，约千名高中生数学 RCT | 无护栏的 GPT 让练习成绩提高约 48%，但撤掉 AI 后考试成绩比对照组低约 17%；有护栏的 AI 导师（给提示、不给答案）练习提升更多，且没有显著的考试损害 | B |
| Kestin et al. (2025, Scientific Reports)，大学物理 | 按教学法设计的 AI 导师（分步、不直接给答案）在更短时间内取得的学习增益约为课堂主动学习的两倍 | B−（单课程、短期） |
| Fan et al. (2025, BJET)，写作任务 | ChatGPT 组作文分数提升更多，但知识获得与迁移无差异，元认知过程减少（"元认知惰性"） | C+ |
| Kosmyna et al. (2025，预印本)，EEG | 用 LLM 写作的组脑连接最弱，对自己文章的引述最差 | C（54 人，媒体过度解读） |
| Risko & Gilbert (2016)，认知卸载综述 | 把记忆交给外部工具会提高当下表现，但减少对被卸载内容的记忆 | B |

**共同结论：AI 本身不决定学习结果，交互设计决定。** 无护栏的"答案型 AI"会提高当场表现、降低独立表现，这正是 Stair 要避免的模式；按教学法约束的 AI 导师有正面证据。这直接支持 4.6 节"按阶段约束 AI 角色"。

### 2.8 明确不使用的神经迷思

- **学习风格匹配**：按"视觉型/听觉型"匹配呈现方式没有学习收益（Pashler et al., 2008）。视图选择按**内容结构**（时间线、因果、层级），不按"用户类型"。
- **脑训练的远迁移**：练某种小游戏不会泛化到一般认知能力（Simons et al., 2016）。
- **左脑型/右脑型**、**只用了 10% 的大脑**、**把多巴胺当成"上瘾式参与"指标**：都不作为设计依据。

## 三、逐条复核"明确不抄什么"

### 总览

| # | 原条目 | 判断 | 一句话理由 |
|---|---|---|---|
| 1 | 不把后台能力平铺成首页工具箱 | 保留，修正理由 | 依据不是"选项太多"，而是学习者不会自选有效策略 |
| 2 | 不以 Diagnosis / Probe First 作为默认 | **修订** | 诊断测验不该前置，但预测/预提问本身就是学习事件 |
| 3 | 不要求未学用户先完整画图、解释、证明 | 保留，补下限 | "完整"不前置，但"一句话预测"应该前置 |
| 4 | 不默认生成全家桶 | **拆分** | 消费型产物不生成；检索型产物按进度生成且只能作答 |
| 5 | 伙伴、世界观、游戏化不作为前置步骤 | 保留，补充 | 动机是一级变量，但不用外在奖励 |
| 6 | AI 关系图不写入"我的理解" | **修订** | 按作者权记录，而不是二元禁止 |
| 7 | 时长、对话数、生成物数不叫成长 | 保留，补充 | 可叫"投入"；早期需要快速可见的真实进展 |
| 8 | 不用一次 LLM 判断宣布掌握 | 保留并加强 | 掌握是会衰减的状态，不是事件 |
| 9 | 尝试前不泄漏答案；修正不覆盖 Attempt | 前半**修订**，后半保留 | 完全不给会无效挣扎，改为分级提示 |
| 10 | 不新增第二大脑维护 | **拆分** | 去掉文书型维护，保留生成型整理 |

### 1. 不平铺工具箱：保留，但理由要换

"选项太多导致瘫痪"的元分析平均效应接近零（Scheibehenne et al., 2010），不能作为依据。真正的依据是：**学习者系统性地偏好低效策略**——重读、集中练习、看总结（Karpicke et al., 2009; Kornell & Bjork, 2008）。工具箱把策略选择交给了最不擅长选择的人。

同时要守住自主性（Ryan & Deci, 2000）：只推荐一步，但说明为什么，并允许改选。改选到低效动作时提示代价，不阻止。

> 修订：一个时刻只推荐一个主动作并给出理由；其他动作可见可选，选择低效动作时说明代价，不隐藏、不阻止。

### 2. Diagnosis / Probe First：最需要修订的一条

原文把三件不同的事当成了一件：

| | 诊断测验 | 预测 / 预提问 | 先尝试、后讲解 |
|---|---|---|---|
| 目的 | 判断会不会，用于分流 | 让大脑形成预期，为讲解做准备 | 让学习者先暴露自己的直觉模型 |
| 是否计分 | 是 | 否 | 否 |
| 答错意味着 | 不会 | 正常，而且有用 | 正常，讲解会用到 |
| 用时 | 数分钟 | 30–60 秒 | 5–15 分钟 |
| 证据 | 无学习收益证据，有焦虑成本 | B+：即使答错也提升随后学习 | B：概念与迁移有优势，程序性无优势 |

DeepTutor 的 Probe First 是第一种，拒绝它是对的。但把第二种也一并拒绝，就丢掉了一个低成本、证据较强的机制。它还有三个附带收益：

- **预测误差**：先有预期，讲解才会产生"原来不是这样"的信号（Schultz et al., 1997）；
- **好奇心**：适度不确定的问题会提高随后的记忆（Kang et al., 2009; Gruber et al., 2014）；
- **免费的诊断信息**：用户的猜测就是他当前的直觉模型，讲解可以直接针对它，不需要另做诊断。

边界条件：

- 问题要能凭直觉或生活经验作答。完全无从下手的问题只会制造挫败；
- 收益集中在被问到的内容，所以问题要对准核心概念；
- 讲解必须紧跟，并引用用户的猜测；
- 对新手学习高元素交互的程序性内容（例如第一次学写某种算法），不用"先尝试"，改为样例先行（Kirschner et al., 2006; Kalyuga et al., 2003）。

> 修订：新主题默认"先猜一下，再学"——讲解前给 1–2 个不计分、可跳过、30–60 秒的预测问题，讲解引用用户的猜测。不做分流式诊断。概念性内容可选用"先尝试、后讲解"；程序性新手内容用样例先行。

### 3. 不要求未学用户先完整输出：保留，补下限

"完整画图、完整解释、证明"对新手确实是过载（专长逆转）。但"什么都不要求"也不对。下限是一句话：一个预测、已知的一两点，或想学它的原因（效用价值）。

> 修订：不要求未学用户完整画图、解释或证明；但每个新主题都从一句话的用户输出开始。

### 4. 全家桶：拆成两类

| 类型 | 例子 | 学习科学判断 | 默认策略 |
|---|---|---|---|
| 消费型 | 总结、播客、现成导图、讲义 | 接近重读，效用低，且制造流畅性错觉（Dunlosky et al., 2013; Koriat & Bjork, 2005） | 默认不生成；用户主动要时生成，标为"参考" |
| 检索型 | 问题、闪卡、变式题、迁移题 | 检索练习是效用最高的策略之一 | 按学习进度生成；只以待作答形式出现，作答后揭示答案 |

另外，卡片的"答案面"应优先来自用户自己的 Attempt 和 Repair，而不是 AI 写的标准答案（生成效应）。

> 修订：默认不生成消费型产物；检索型产物随学习进度按需生成，只能先作答再看答案，答案优先来自用户自己的表达。

### 5. 伙伴、世界观、游戏化：保留"不前置"，补上动机设计

"不前置"是对的，但原文容易被读成"动机不重要"。证据支持的是：

- **不用外在奖励控制行为**：积分、排行、可预期的奖励会削弱内在动机（Deci et al., 1999）；游戏化效应不稳定（Sailer & Homner, 2020）；
- **设计内在动机**：胜任（看见自己变强的证据）、自主（可以选择）、关联（有人在意你的解释）；
- **"伙伴"有一个证据充分的用途——当学生，而不是当老师**。学习者为可教代理学习时更努力（Chase et al., 2009），讲解给别人听促进延迟保持（Fiorella & Mayer, 2013）。

> 修订：伙伴、世界观和游戏化不作为前置步骤，不用积分、排行等外在奖励。AI 可以扮演"需要你讲给它听的新手"，作为独立输出的一种形式。

### 6. AI 关系图不进"我的理解"：改为按作者权记录

二元禁止有两个问题：

1. 批判、修改 AI 产物本身就是有效的生成活动（错误样例研究）；
2. 现实中用户会在 AI 草稿上改。全部禁止会逼用户从空白开始，或者绕开系统。

真正要防的是"未经用户加工的 AI 产物冒充用户的理解"。

> 修订："我的理解"的每个版本都记录作者权：用户原创、用户修改 AI 草稿（附修改比例）、AI 原文。只有前两种进入"我的理解"；能力证据只来自闭卷独立输出。L3 之后可以把"找出 AI 草稿中的错误"作为练习形式。

### 7. 时长等不叫成长：保留，补两点

1. **领先指标不等于虚荣指标**：按时完成的间隔复习、达标重学的会话数能预测长期保持，可以展示为"投入"，但不叫"成长"。
2. **冷启动**：真正的延迟证据最早次日才有。第一天要有真实、可见的进展，例如"刚才第一次没看资料就讲清楚了 X"（L3 证据）。进展的可见性会影响坚持（目标梯度效应，Kivetz et al., 2006）。

> 修订：学习时长、对话数、生成物数、笔记数、图谱密度不叫成长；按时复习等投入可以作为"投入"展示。每次学习结束时至少展示一条当场的真实证据。

### 8. 不用一次 LLM 判断宣布掌握：保留并加强

加强的方向：

- **掌握不是事件，而是会衰减的状态。** 不出现"已掌握"，只说"现在大约能独立做到什么"，并且会因遗忘下降；
- **证据要多次、跨时间、跨情境**（等级推导见 4.5 节）；
- **LLM 评审只按量规逐条判断**，保留依据文本，允许用户申诉。LLM 评审有已知的位置偏差和冗长偏差（Zheng et al., 2023）。

> 修订：不出现"已掌握"。能力状态由多次、跨时间、跨情境的闭卷 Attempt 推导，会因遗忘衰减。LLM 只按量规逐条评审并保留依据，用户可以申诉。

### 9. 不泄漏答案、不覆盖 Attempt：前半修订，后半保留

**后半完全保留**：原始 Attempt 是测量基线，是"过去的你"对比的素材，也是高把握度纠错的触发条件。

**前半修订**：完全不给答案，会让用户在毫无进展的地方空耗，打击胜任感（帮助困境，Koedinger & Aleven, 2007）。证据支持的是分级提示：

| 等级 | 内容 | 记录为 |
|---|---|---|
| 0 | 不提供帮助 | 可作为独立证据 |
| 1 | 元认知提示："你卡在哪一步？回想一下 X" | 轻度帮助 |
| 2 | 线索：方向、关键词 | 中度帮助 |
| 3 | 第一步或部分样例 | 重度帮助 |
| 4 | 完整答案 | 本次不算独立；同类题须另做一次 |

> 修订：用户尝试前不展示答案，但提供分级提示，每一级帮助都记录在 Attempt 上。修正以新版本追加，原始 Attempt 永不覆盖。

### 10. 不新增第二大脑维护：拆分

"维护"其实有两种：

- **文书型**：打标签、归档、调整链接类型、清理重复。应全部由 AI 承担。
- **生成型**：用自己的话改写、说明两个概念为什么相关、修订旧理解。这不是负担，这就是学习本身（生成效应、自我解释、精细追问）。

原文的措辞容易让后者也被"自动化"掉。

> 修订：AI 承担所有文书型维护；用自己的话改写、说明关联、修订旧理解仍由用户完成，但每次只要求一句话。

### 其他原则的复核

| 原则 | 判断 | 修订 |
|---|---|---|
| Learn First 主路径 | 修订 | 预测 → 学习 → 有支架练习 → 渐退 → 闭卷独立 → 把握度与反馈 → 跨夜回忆 → 交错 → 迁移 |
| 帮助逐步撤掉 | 保留 | 撤支架看表现，不按剧本（专长逆转） |
| 一个时刻一个主动作 | 保留 | 补上"给出理由、允许改选" |
| 五级掌握 | 保留，补两点 | "延迟"以跨过一次睡眠为条件；等级可以衰减 |
| 北极星指标 | 保留，防刷分 | 只用**未练过的题目形式**做延迟探针计算，否则会奖励"刷熟题" |
| 不展示单一掌握百分比 | 修订 | 不展示"掌握度"，但可以展示用户的**校准差**（预测能做到 vs 实际做到） |

## 四、系统设计

### 4.1 修订后的十条设计原则

1. **先猜一下，再学。** 新内容前做一次不计分的预测。（预提问、预测误差、好奇心）
2. **讲短一点，每段后让用户说。** 讲解分段，每段后一个"为什么"。（工作记忆、分段、自我解释）
3. **支架按表现撤，不按剧本撤。**（样例渐退、专长逆转）
4. **独立输出必须闭卷。** 这一步暂时收起资料面板。（检索练习、闭卷概念图）
5. **先问把握度，再给反馈。**（高把握度纠错、元认知校准）
6. **第一次复习至少隔一夜。**（睡眠巩固、首次间隔）
7. **复习先回忆后看，达标即停，跨天重复。**（达标重学）
8. **易混的放在一起练，相似的案例成对比较。**（交错、对比案例）
9. **让用户教，而不只是被考。**（教中学、低风险）
10. **让用户看见自己的错觉。** 展示预测与实际的差距，而不是分数。（元认知校准）

### 4.2 一次学习的微循环（约 20 分钟）

```text
0. 唤醒（2–3 分钟）
   到期内容闭卷回忆 → 把握度 → 反馈
1. 预测（≤1 分钟）
   新内容 1–2 个直觉问题；不计分，可跳过
2. 讲解（每段 3–5 分钟）
   引用用户的猜测；样例；来源锚点可一键回到原文
3. 生成（每段后约 1 分钟）
   "为什么" / "如果……会怎样" / "用一句话说"
4. 有支架练习
   分级提示；按表现撤支架
5. 交棒：闭卷独立输出
   讲给 AI 新手听 / 闭卷画结构 / 做题 / 做一个小设计
6. 把握度 → 反馈 → Repair
   原 Attempt 不变，Repair 追加
7. 留下这次理解
   用一句话写下来；预测"两天后还能独立做到吗"
```

### 4.3 跨天的宏循环

```text
学习当天   L2–L3 证据
   │  （跨过至少一次睡眠）
次日以后   第一次延迟闭卷回忆 → 达标重学
   │  （记忆模型排程，间隔逐步拉长）
之后多天   复习中交错易混概念；记录预测与实际
   │
迁移       新情境、成对案例；真实项目中的使用
```

- **排程**：用个人化记忆模型估计遗忘，例如 FSRS（Ye et al., 2022），而不是 DeepTutor 式的固定间隔表。注意 FSRS 主要在闪卡数据上验证；用于"重建一个心智模型"这类复杂任务时，排程参数是待验证的假设。
- **达标重学**：每次复习回忆到正确一次即停；在不同的日子累计达标三次以上，才算稳定的延迟证据。
- **衰减**：预测回忆概率低于阈值时显示"需要唤醒"，而不是继续显示上次的等级。

### 4.4 知识类型决定练习形式

借用 KLI 框架（Koedinger et al., 2012）的思路：不同类型的知识需要不同的教学机制。

| | 事实 / 术语 | 概念 / 原理 | 程序 / 技能 | 判断 / 设计 |
|---|---|---|---|---|
| 预测形式 | 猜含义 | 预测现象或结果 | 先看样例，不先尝试 | 先给出自己的方案 |
| 主要练习 | 短答检索 + 间隔 | 解释、对比、举反例、闭卷画结构 | 样例 → 渐退 → 独立做题 → 交错 | 对比案例 → 项目 |
| 反馈时机 | 可延迟 | 作答后立即，按量规逐条 | 逐步即时 | 作答后，含取舍讨论 |
| 主要风险 | 死记硬背 | 讲得流畅但不会用 | 新手过载 | 没有标准答案，难以评估 |

### 4.5 证据数据模型（草案）

```ts
interface KnowledgeUnit {
  id: string
  projectId: string
  kind: 'fact' | 'concept' | 'procedure' | 'judgment'
  sourceRefs: Reference[]          // 复用现有 Reference 协议
}

interface Attempt {
  id: string
  unitId: string
  phase: 'prediction' | 'scaffolded' | 'independent' | 'review' | 'transfer'
  rawOutput: AttemptOutput         // 不可变
  closedBook: boolean              // 输出时资料面板是否收起
  pastedFromSourceRatio: number    // 与来源原文的重合比例
  assistanceLevel: 0 | 1 | 2 | 3 | 4
  confidence?: 1 | 2 | 3 | 4 | 5  // 反馈前填写
  context: 'same' | 'variant' | 'novel'
  sleptSinceLastAttempt: boolean
  createdAt: string
}

interface Feedback {
  attemptId: string
  rubric: { criterion: string; met: boolean | null; evidence: string }[]
  judge: 'llm' | 'self' | 'human'
  judgeVersion?: string
  disputed?: boolean
}

interface Repair {
  attemptId: string
  revisedOutput: AttemptOutput
  assistanceLevel: 0 | 1 | 2 | 3 | 4
}

interface UnderstandingVersion {
  unitId: string
  text: string
  authorship: 'user' | 'user-edited-ai'
  editRatio?: number
  derivedFromAttemptIds: string[]
}

interface MemoryState {
  unitId: string
  stability: number
  difficulty: number
  predictedRecall: number
  calibrationGap: number           // 用户预测 − 实际结果
}
```

等级从 Attempt 推导，不由 LLM 直接宣布：

| 等级 | 条件 |
|---|---|
| L1 正在学习 | 有预测或讲解记录 |
| L2 支架下完成 | 有成功的 Attempt，帮助等级 ≥1 |
| L3 当场独立 | 成功、帮助等级 0、闭卷、与来源的重合比例低于阈值 |
| L4 延迟独立 | 满足 L3，且跨过睡眠，并在至少两个不同的日子达标 |
| L5 能迁移 | 满足 L3，且情境为 `novel` |
| 衰减 | `predictedRecall` 低于阈值时显示"需要唤醒"，历史证据保留 |

### 4.6 AI 角色按阶段受约束

| 阶段 | AI 角色 | 可以 | 不可以 |
|---|---|---|---|
| 预测 | 提问者 | 给情境、问直觉问题 | 评分、纠正、讲答案 |
| 讲解 | 讲解者 | 分段讲、引用用户的猜测、给样例 | 一次讲完整章 |
| 有支架练习 | 教练 | 按提示阶梯给帮助 | 跳级直接给完整解答 |
| 独立输出 | 新手学生，或沉默 | 以新手身份追问"为什么" | 提示、纠正、补全；调用 `mindmap_update` |
| 反馈 | 评审者 | 按量规指出缺口、对照原 Attempt | 改写成"标准答案"覆盖用户版本 |
| 复习 | 出题者 | 出变式题、交错易混概念 | 先展示旧卡再问"还记得吗" |

这张表就是 Bastani et al. (2025) 中"护栏"在产品里的具体形态：AI 能力不变，变的是每个阶段允许它做什么。

### 4.7 低压力输出（回答想法 002）

想法 002 问：如何让人无压力地输出？证据给出五个具体手段：

1. **降低评价威胁**：不计分、只给自己看、可以删除。不计分的检索练习会降低焦虑（Agarwal et al., 2014），用检索练习学过的内容在压力下也不受影响（Smith et al., 2016）。
2. **换输出对象**：讲给"新手"听，而不是答给"考官"。
3. **从小到大**：一句话预测 → 一段解释 → 完整模型。第一步永远不超过一分钟。
4. **降低启动成本**：3/5/10 分钟的固定时长；提供句子开头；允许口述后转写。
5. **重新定义错误**：预测阶段明确说"猜错很正常，这会帮你记得更牢"；高把握度的错误恰恰最容易被纠正。

### 4.8 "难但有掌控感"：正面处理流失风险

合意困难（Bjork, 1994）的代价是：用户会觉得学得更慢、更累，于是倾向于回到重读和看总结。这是本产品最大的留存风险。

- **用用户自己的数据说服用户**：光讲道理不够（Yan et al., 2016）。展示"学完时预测能记住"与"两天后实际回忆"之间的差距；
- **难度控制在可完成的区间**：让学习者停留在"刚好够不到"的区域（Metcalfe & Kornell, 2005）。"约 85% 成功率"的说法来自机器学习模型的理论推导（Wilson et al., 2019），用在人身上只是起点假设，需要在产品中校准；
- **自主但知情**：用户可以选择重读或直接看答案，系统说明代价但不阻止；
- **每次结束时都有真实收获**：至少一条当场证据，见第三节第 7 条。

### 4.9 与现有工作台的对接

现有基础设施大部分可以直接复用：

| 学习需求 | 现有能力 | 需要补的部分 |
|---|---|---|
| 闭卷独立输出 | Workbench 的 park/restore | "闭卷模式"：独立输出时暂时收起资料与 Browser 面板，记录 `closedBook` |
| 反馈后回到原文 | Reference 与 reveal | 每道题锚定来源 locator |
| 判断是否照抄 | Reference 的 fingerprint 与 quote | 计算输出与来源原文的重合比例 |
| 闭卷画结构 | Drawnix 与 `mindmap_*` 工具 | 独立阶段禁止 AI 写入 |
| 留下这次理解 | Add Note | 改为用户书写、AI 只提问；记录作者权 |
| 讲解时并排阅读 | 多面板 Workbench | 讲解阶段并排符合空间邻近原则；独立阶段切换为单焦点 |

### 4.10 如何验证

- **单元级随机化**：在同一用户内，把知识单元随机分配到"先预测"和"直接讲解"等条件，比较 2 天、7 天的闭卷回忆。成人自学的样本量小，单元级随机比用户级 A/B 的统计效率高得多；
- **留出探针**：评估用的延迟题和迁移题不出现在练习中，防止指标被"刷熟题"抬高；
- **主要指标**：7 天无辅助回忆率、迁移成功率、首次独立输出用时、校准差；
- **护栏指标**：会话完成率、主动跳过率、主观负担。若某机制提高了回忆却导致大量流失，先调剂量（问题数量、时长），再决定取舍；
- **失败判据**：沿用"第二记忆"文档第九节的失败反例，并新增一条——预测阶段的跳过率持续高于一半，说明问题设计不当或压力过大。

## 五、建议替换后的"明确不做"清单

- 不把后台能力平铺成工具箱；一次只推荐一步，给出理由，允许改选。
- 不做分流式诊断测验；但新主题从一次不计分的预测开始。
- 不要求未学用户完整画图、解释或证明；从一句话开始。
- 不默认生成总结、播客、现成导图等消费型产物；检索型产物只能先作答再看答案。
- 不用积分、排行等外在奖励换取学习行为；伙伴、世界观不作为前置步骤。
- 不让未经用户加工的 AI 产物进入"我的理解"；修改过的按作者权和修改比例记录。
- 不把时长、对话数、生成物数、图谱密度叫作成长；投入与成长分开展示。
- 不宣布"已掌握"；能力状态由多次、跨时间、跨情境的闭卷 Attempt 推导，并会衰减。
- 用户尝试前不展示答案；提供分级提示并记录；修正永不覆盖原始 Attempt。
- 不让用户做文书型维护；用自己的话改写、说明关联仍由用户完成，每次只要一句话。
- 不在同一会话末尾安排"延迟回忆"；第一次延迟回忆至少跨过一夜。
- 不按"学习风格"选择呈现方式；按内容结构选择。

## 六、需要产品决策的问题

1. **首批用户与知识类型。** 技术概念、语言、考试、职业技能所需的练习形式差别很大（4.4 节），这决定第一版做哪一列。
2. **是否采用 FSRS 类记忆模型。** 开源、可本地运行；但对复杂理解任务的排程需要自行验证。
3. **是否允许"找出 AI 草稿中的错误"作为练习。** 有证据支持，但需要清楚标注，避免用户把植入的错误记成事实。
4. **第一版是否支持口述输出。** 能显著降低输出成本，但转写和评审链路更复杂。
5. **如何保证 LLM 评审的可信度。** 量规、依据、申诉是最低要求；是否还需要人工抽检或用户自评校准。

## 参考文献

**记忆与检索**

- Adesope, O. O., Trevisan, D. A., & Sundararajan, N. (2017). Rethinking the use of tests: A meta-analysis of practice testing. *Review of Educational Research*.
- Anderson, M. C., Bjork, R. A., & Bjork, E. L. (1994). Remembering can cause forgetting. *JEP: Learning, Memory, and Cognition*.
- Bertsch, S., Pesta, B. J., Wiscott, R., & McDaniel, M. A. (2007). The generation effect: A meta-analytic review. *Memory & Cognition*.
- Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006). Distributed practice in verbal recall tasks. *Psychological Bulletin*.
- Cepeda, N. J., Vul, E., Rohrer, D., Wixted, J. T., & Pashler, H. (2008). Spacing effects in learning: A temporal ridgeline of optimal retention. *Psychological Science*.
- Chan, J. C. K., McDermott, K. B., & Roediger, H. L. (2006). Retrieval-induced facilitation. *JEP: General*.
- Karpicke, J. D., & Roediger, H. L. (2007). Expanding retrieval practice promotes short-term retention, but equally spaced retrieval enhances long-term retention. *JEP: LMC*.
- Kornell, N., Hays, M. J., & Bjork, R. A. (2009). Unsuccessful retrieval attempts enhance subsequent learning. *JEP: LMC*.
- Pan, S. C., & Carpenter, S. K. (2023). Prequestioning and pretesting effects: A review. *Educational Psychology Review*.
- Rawson, K. A., & Dunlosky, J. (2011). Optimizing schedules of retrieval practice for durable and efficient learning. *JEP: General*.
- Rawson, K. A., Dunlosky, J., & Sciartelli, S. M. (2013). The power of successive relearning. *Educational Psychology Review*.
- Richland, L. E., Kornell, N., & Kao, L. S. (2009). The pretesting effect. *JEP: Applied*.
- Roediger, H. L., & Karpicke, J. D. (2006). Test-enhanced learning. *Psychological Science*.
- Rowland, C. A. (2014). The effect of testing versus restudy on retention: A meta-analytic review. *Psychological Bulletin*.
- Slamecka, N. J., & Graf, P. (1978). The generation effect. *JEP: Human Learning and Memory*.
- Ye, J., Su, J., & Cao, Y. (2022). A stochastic shortest path algorithm for optimizing spaced repetition scheduling. *KDD*.

**理解、图式与迁移**

- Alfieri, L., Nokes-Malach, T. J., & Schunn, C. D. (2013). Learning through case comparisons: A meta-analytic review. *Educational Psychologist*.
- Bisra, K., Liu, Q., Nesbit, J. C., Salimi, F., & Winne, P. H. (2018). Inducing self-explanation: A meta-analysis. *Educational Psychology Review*.
- Blunt, J. R., & Karpicke, J. D. (2014). Learning with retrieval-based concept mapping. *Journal of Educational Psychology*.
- Brunmair, M., & Richter, T. (2019). Similarity matters: A meta-analysis of interleaved learning and its moderators. *Psychological Bulletin*.
- Chi, M. T. H., Bassok, M., Lewis, M. W., Reimann, P., & Glaser, R. (1989). Self-explanations. *Cognitive Science*.
- Chi, M. T. H., & Wylie, R. (2014). The ICAP framework. *Educational Psychologist*.
- Cowan, N. (2001). The magical number 4 in short-term memory. *Behavioral and Brain Sciences*.
- Fiorella, L., & Zhang, Q. (2018). Drawing on the relevance of learner-generated drawing. *Educational Psychology Review*.
- Gentner, D., Loewenstein, J., & Thompson, L. (2003). Learning and transfer: A general role for analogical encoding. *Journal of Educational Psychology*.
- Kalyuga, S., Ayres, P., Chandler, P., & Sweller, J. (2003). The expertise reversal effect. *Educational Psychologist*.
- Kapur, M. (2008). Productive failure. *Cognition and Instruction*.
- Karpicke, J. D., & Blunt, J. R. (2011). Retrieval practice produces more learning than elaborative studying with concept mapping. *Science*.
- Kirschner, P. A., Sweller, J., & Clark, R. E. (2006). Why minimal guidance during instruction does not work. *Educational Psychologist*.
- Koedinger, K. R., Corbett, A. T., & Perfetti, C. (2012). The Knowledge-Learning-Instruction framework. *Cognitive Science*.
- Mayer, R. E. (2009). *Multimedia Learning* (2nd ed.). Cambridge University Press.
- Renkl, A., & Atkinson, R. K. (2003). Structuring the transition from example study to problem solving. *Educational Psychologist*.
- Rohrer, D., Dedrick, R. F., & Stershic, S. (2015). Interleaved practice improves mathematics learning. *Journal of Educational Psychology*.
- Sinha, T., & Kapur, M. (2021). When problem solving followed by instruction works: Evidence for productive failure. *Review of Educational Research*.
- Wammes, J. D., Meade, M. E., & Fernandes, M. A. (2016). The drawing effect. *Quarterly Journal of Experimental Psychology*.

**反馈、错误与元认知**

- Adams, D. M., McLaren, B. M., et al. (2014). Using erroneous examples to improve mathematics learning with a web-based tutoring system. *Computers in Human Behavior*.
- Bjork, R. A. (1994). Memory and metamemory considerations in the training of human beings. In *Metacognition: Knowing about Knowing*. MIT Press.
- Butler, A. C., & Roediger, H. L. (2008). Feedback enhances the positive effects and reduces the negative effects of multiple-choice testing. *Memory & Cognition*.
- Butterfield, B., & Metcalfe, J. (2001). Errors committed with high confidence are hypercorrected. *JEP: LMC*.
- Dunlosky, J., Rawson, K. A., Marsh, E. J., Nathan, M. J., & Willingham, D. T. (2013). Improving students' learning with effective learning techniques. *Psychological Science in the Public Interest*.
- Große, C. S., & Renkl, A. (2007). Finding and fixing errors in worked examples. *Learning and Instruction*.
- Hattie, J., & Timperley, H. (2007). The power of feedback. *Review of Educational Research*.
- Karpicke, J. D., Butler, A. C., & Roediger, H. L. (2009). Metacognitive strategies in student learning. *Memory*.
- Kluger, A. N., & DeNisi, A. (1996). The effects of feedback interventions on performance. *Psychological Bulletin*.
- Koedinger, K. R., & Aleven, V. (2007). Exploring the assistance dilemma in experiments with cognitive tutors. *Educational Psychology Review*.
- Koriat, A., & Bjork, R. A. (2005). Illusions of competence in monitoring one's knowledge during study. *JEP: LMC*.
- Kornell, N., & Bjork, R. A. (2008). Learning concepts and categories: Is spacing the "enemy of induction"? *Psychological Science*.
- Metcalfe, J., & Kornell, N. (2005). A region of proximal learning model of study time allocation. *Journal of Memory and Language*.
- Nelson, T. O., & Dunlosky, J. (1991). When people's judgments of learning are extremely accurate at predicting subsequent recall. *Psychological Science*.
- Pashler, H., Cepeda, N. J., Wixted, J. T., & Rohrer, D. (2005). When does feedback facilitate learning of words? *JEP: LMC*.
- Shute, V. J. (2008). Focus on formative feedback. *Review of Educational Research*.
- Wilson, R. C., Shenhav, A., Straccia, M., & Cohen, J. D. (2019). The Eighty Five Percent Rule for optimal learning. *Nature Communications*.
- Wisniewski, B., Zierer, K., & Hattie, J. (2020). The power of feedback revisited. *Frontiers in Psychology*.
- Yan, V. X., Bjork, E. L., & Bjork, R. A. (2016). On the difficulty of mending metacognitive illusions. *JEP: General*.
- Zheng, L., et al. (2023). Judging LLM-as-a-judge with MT-Bench and Chatbot Arena. *NeurIPS*.

**动机与情绪**

- Agarwal, P. K., D'Antonio, L., Roediger, H. L., McDermott, K. B., & McDaniel, M. A. (2014). Classroom-based programs of retrieval practice reduce middle school and high school students' test anxiety. *Journal of Applied Research in Memory and Cognition*.
- Chase, C. C., Chin, D. B., Oppezzo, M. A., & Schwartz, D. L. (2009). Teachable agents and the protégé effect. *Journal of Science Education and Technology*.
- de Quervain, D. J.-F., et al. (2000). Acute cortisone administration impairs retrieval of long-term declarative memory in humans. *Nature Neuroscience*.
- Deci, E. L., Koestner, R., & Ryan, R. M. (1999). A meta-analytic review of experiments examining the effects of extrinsic rewards on intrinsic motivation. *Psychological Bulletin*.
- Fiorella, L., & Mayer, R. E. (2013). The relative benefits of learning by teaching and teaching expectancy. *Contemporary Educational Psychology*.
- Gollwitzer, P. M., & Sheeran, P. (2006). Implementation intentions and goal achievement: A meta-analysis. *Advances in Experimental Social Psychology*.
- Gruber, M. J., Gelman, B. D., & Ranganath, C. (2014). States of curiosity modulate hippocampus-dependent learning via the dopaminergic circuit. *Neuron*.
- Hulleman, C. S., & Harackiewicz, J. M. (2009). Promoting interest and performance in high school science classes. *Science*.
- Kang, M. J., et al. (2009). The wick in the candle of learning: Epistemic curiosity activates reward circuitry and enhances memory. *Psychological Science*.
- Kivetz, R., Urminsky, O., & Zheng, Y. (2006). The goal-gradient hypothesis resurrected. *Journal of Marketing Research*.
- Kobayashi, K. (2019). Learning by preparing-to-teach and teaching: A meta-analysis. *Japanese Psychological Research*.
- Ryan, R. M., & Deci, E. L. (2000). Self-determination theory and the facilitation of intrinsic motivation. *American Psychologist*.
- Sailer, M., & Homner, L. (2020). The gamification of learning: A meta-analysis. *Educational Psychology Review*.
- Scheibehenne, B., Greifeneder, R., & Todd, P. M. (2010). Can there ever be too many options? *Journal of Consumer Research*.
- Smith, A. M., Floerke, V. A., & Thomas, A. K. (2016). Retrieval practice protects memory against acute stress. *Science*.

**神经机制**

- Bruer, J. T. (1997). Education and the brain: A bridge too far. *Educational Researcher*.
- Diekelmann, S., & Born, J. (2010). The memory function of sleep. *Nature Reviews Neuroscience*.
- Mazza, S., et al. (2016). Relearn faster and retain longer: Along with practice, sleep makes perfect. *Psychological Science*.
- McClelland, J. L., McNaughton, B. L., & O'Reilly, R. C. (1995). Why there are complementary learning systems in the hippocampus and neocortex. *Psychological Review*.
- Monsell, S. (2003). Task switching. *Trends in Cognitive Sciences*.
- Nader, K., Schafe, G. E., & LeDoux, J. E. (2000). Fear memories require protein synthesis in the amygdala for reconsolidation after retrieval. *Nature*.
- Pashler, H., McDaniel, M., Rohrer, D., & Bjork, R. (2008). Learning styles: Concepts and evidence. *Psychological Science in the Public Interest*.
- Schultz, W., Dayan, P., & Montague, P. R. (1997). A neural substrate of prediction and reward. *Science*.
- Simons, D. J., et al. (2016). Do "brain-training" programs work? *Psychological Science in the Public Interest*.
- Tse, D., et al. (2007). Schemas and memory consolidation. *Science*.
- van Kesteren, M. T. R., Ruiter, D. J., Fernández, G., & Henson, R. N. (2012). How schema and novelty augment memory formation. *Trends in Neurosciences*.

**生成式 AI 与学习**

- Bastani, H., et al. (2025). Generative AI without guardrails can harm learning: Evidence from high school mathematics. *PNAS*.
- Fan, Y., et al. (2025). Beware of metacognitive laziness: Effects of generative artificial intelligence on learning motivation, processes, and performance. *British Journal of Educational Technology*.
- Kestin, G., et al. (2025). AI tutoring outperforms in-class active learning: An RCT. *Scientific Reports*.
- Kosmyna, N., et al. (2025). Your brain on ChatGPT: Accumulation of cognitive debt when using an AI assistant for essay writing task. arXiv 预印本。
- Risko, E. F., & Gilbert, S. J. (2016). Cognitive offloading. *Trends in Cognitive Sciences*.
