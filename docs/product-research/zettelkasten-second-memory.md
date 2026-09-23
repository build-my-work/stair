# Zettelkasten Second Memory 产品参考档案

> 审计日期：2026-09-01<br>
> 官方仓库：<https://github.com/cx2002302-lang/zettelkasten-second-memory><br>
> 固定版本：[`731b58836e2c579dd8cba126b2c092ad5984d8d6`](https://github.com/cx2002302-lang/zettelkasten-second-memory/tree/731b58836e2c579dd8cba126b2c092ad5984d8d6)（`v1.0.0-beta.8`）<br>
> 完整源码审计：[`../code-research/zettelkasten-second-memory-product-integration.md`](../code-research/zettelkasten-second-memory-product-integration.md)

## 一句话定位

它是面向 AI Agent 的持久 Zettelkasten 基础设施：把对话蒸馏成原子笔记，通过语义链接、全文检索、审核和归档形成长期知识库，而不是直接面向学习者的教学产品。[官方 README](https://github.com/cx2002302-lang/zettelkasten-second-memory/blob/731b58836e2c579dd8cba126b2c092ad5984d8d6/README.zh.md#L34-L50)

## 已验证的核心机制

- `atomic / structure / source` 三种笔记、`FLEETING / LITERATURE / PERMANENT` 生命周期，以及 11 种正反向语义关系。[核心类型](https://github.com/cx2002302-lang/zettelkasten-second-memory/blob/731b58836e2c579dd8cba126b2c092ad5984d8d6/src/core/types.ts#L1-L65)
- CEQRC：`Capture → Explain → Question → Refine → Connect`，五阶段均通过 LLM Provider 处理。[CEQRC 引擎](https://github.com/cx2002302-lang/zettelkasten-second-memory/blob/731b58836e2c579dd8cba126b2c092ad5984d8d6/src/service/ceqrc-engine.ts#L28-L127)
- 会话切片、摘要、去重、创建或合并笔记，并可自动创建建议链接。[蒸馏服务](https://github.com/cx2002302-lang/zettelkasten-second-memory/blob/731b58836e2c579dd8cba126b2c092ad5984d8d6/src/service/distiller-service.ts#L65-L113)
- 前台聊天 Agent 只读，后台知识 Agent 才拥有创建、更新、连边和蒸馏权限。[权限模型](https://github.com/cx2002302-lang/zettelkasten-second-memory/blob/731b58836e2c579dd8cba126b2c092ad5984d8d6/src/integration/agent-config.ts#L84-L135)

## 最值得 Stair 借鉴的部分

1. 原子化且带来源的长期理解单元。
2. 新理解与旧理解之间有明确关系和关系理由。
3. AI 自动承担搜索、去重和候选关联。
4. 教学 Agent 与记忆写入权限分离，避免对话过程中静默污染长期记忆。
5. 旧知识能在未来任务中重新被检索，而不是学习结束后沉底。

## 不能照搬的部分

上游目标是让 Agent 找得到知识，而 Stair 的目标是让人能无辅助想起并应用。其 CEQRC 中的 Explain、Question 和 Refine 实际也是由 LLM 生成；如果直接照搬，用户只会得到更多经过 AI 整理的新输入。

此外，上游 Review 是对内容做 `approve / reject / modify / flag` 的审核，不等于学习中的闭卷复习。[审核文档](https://github.com/cx2002302-lang/zettelkasten-second-memory/blob/731b58836e2c579dd8cba126b2c092ad5984d8d6/skills/brain/docs/06-review-feedback.md#L18-L62)

因此不应照搬：

- 自动把 AI 总结晋升为“我的知识”；
- 用置信度、笔记数、链接数、Glow 或 Zombie 代表掌握；
- 向普通用户暴露 11 种链接、Inbox、Zettels 和图谱维护；
- 让用户尚未学习就先拆卡、连边或整理知识库。

## 映射到 Stair

Zettelkasten 不成为新一级入口，而成为贯穿现有产品的“我的理解”层：

| Stair 入口 | 融入方式 |
|---|---|
| 首页 | 在继续学习或到期练习中唤醒相关旧理解，不出现知识库维护待办 |
| 学习 | 新主题坚持 Learn First；用户完成解释或修正后才产生候选理解 |
| 练习 | 先隐藏旧理解，让用户闭卷重建，再揭示“过去的你” |
| 项目 | 旧理解按任务相关性被唤起，应用结果成为例子、反例或迁移证据 |
| 资料 | 来源与“由此形成的我的理解”双向可追溯 |
| 成长 | 展示理解版本与行为证据，不展示图谱密度 |

## 对最终产品的贡献

它补齐的是“资料”和“能力证据”之间的中间层：

```text
来源记忆：资料和 AI 说了什么
我的理解：我目前怎样解释和连接
能力证据：我能否无辅助回忆并应用
```

产品原则：**资料可以自动捕获，理解必须由用户挣得，掌握必须由行为证明。**

## 当前代码边界

当前插件初始化给 CEQRC 和蒸馏注入的是未配置便抛错的空 LLM Provider，注册的 `session_end` 处理也只记录日志，因此本阶段适合借鉴机制，不适合直接作为 Stair 的生产依赖。[插件生命周期](https://github.com/cx2002302-lang/zettelkasten-second-memory/blob/731b58836e2c579dd8cba126b2c092ad5984d8d6/src/plugin/lifecycle.ts#L38-L79)
