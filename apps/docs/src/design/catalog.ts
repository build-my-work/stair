/**
 * 产品设计体系的共享目录：功能状态与模块清单。
 * 功能页 frontmatter 的 status / module 取值必须出现在这里；
 * 模块地图和功能看板都从这里读取顺序与名称。
 */

export type FeatureStatus = 'exploring' | 'planned' | 'in-progress' | 'shipped' | 'dropped';

export const STATUS: Record<FeatureStatus, { label: string; variant: 'note' | 'tip' | 'caution' | 'success' | 'danger' | 'default' }> = {
  exploring: { label: '构思中', variant: 'default' },
  planned: { label: '计划中', variant: 'note' },
  'in-progress': { label: '开发中', variant: 'caution' },
  shipped: { label: '已上线', variant: 'success' },
  dropped: { label: '不做了', variant: 'danger' },
};

/**
 * 面向用户的产品结构：一条学习主线 → 六个空间 + 一个底座 → 功能。
 * 每个空间对应 content/docs/design/<id>/ 目录，目录下的 index.mdx 是空间概览，其余是功能页。
 */
export interface SpaceDef {
  id: string;
  name: string;
  /** 在学习主线上负责的那一段；底座为空 */
  step?: string;
  /** 一句话：你来这里做什么 */
  tagline: string;
}

export const SPACES: SpaceDef[] = [
  { id: 'home', name: '首页', tagline: '每次打开，从上次停下的地方接着学。' },
  { id: 'sources', name: '资料', step: '读进来', tagline: '把书、论文和网页放进来，读到哪就从哪开始学。' },
  { id: 'learn', name: '学习', step: '想明白', tagline: '从没学过到初步理解：先猜，再一小段一小段地听，边听边说。' },
  { id: 'practice', name: '练习', step: '讲出来、记得住', tagline: '合上书自己讲、自己做，隔天再回忆，确认是真的会了。' },
  { id: 'apply', name: '实战', step: '用得上', tagline: '在没见过的问题和真实的任务里，把学过的东西用出来。' },
  { id: 'growth', name: '成长', tagline: '看见自己从需要提示，走到能独立讲清、隔天还记得、换个场景也会用。' },
  { id: 'foundation', name: '工作台与 AI', tagline: '所有空间共用的底座：按主题分开的学习空间、并排的工作台、你的笔记文件和身边的 AI。' },
];

export function spaceOfEntryId(id: string): SpaceDef | undefined {
  const dir = id.split('/')[1];
  return SPACES.find((s) => s.id === dir);
}

export type LayerId = 'entry' | 'engine' | 'workbench';

export const LAYERS: { id: LayerId; name: string; summary: string }[] = [
  {
    id: 'entry',
    name: '学习入口',
    summary: '用户直接看到的六个入口。每个入口回答"我现在来这里做什么"，复杂能力藏在后面。',
  },
  {
    id: 'engine',
    name: '学习引擎',
    summary: '没有独立界面的后台能力：决定下一步做什么、记录发生过什么、安排什么时候再来。',
  },
  {
    id: 'workbench',
    name: '工作台底座',
    summary: '已经交付的桌面工作台：容器、面板、材料、引用和画布。学习层直接建在它上面。',
  },
];

export interface ModuleDef {
  id: string;
  name: string;
  layer: LayerId;
  /** 一句话职责 */
  role: string;
  /** 依赖的其他模块 id */
  dependsOn?: string[];
}

export const MODULES: ModuleDef[] = [
  { id: 'home', name: '首页', layer: 'entry', role: '把用户带回上次停下的那个具体动作。', dependsOn: ['orchestrator', 'evidence'] },
  { id: 'learn', name: '学习', layer: 'entry', role: '从没学过到初步理解，再把主导权交回用户。', dependsOn: ['orchestrator', 'reader', 'reference', 'agent'] },
  { id: 'practice', name: '练习', layer: 'entry', role: '闭卷回忆、解释和操作，留下可比较的尝试记录。', dependsOn: ['orchestrator', 'evidence', 'memory', 'workbench'] },
  { id: 'apply', name: '实战', layer: 'entry', role: '在真实任务里用上学过的东西，产出作品或决策。', dependsOn: ['evidence', 'files'] },
  { id: 'sources', name: '资料', layer: 'entry', role: '导入、阅读、定位和追溯来源。', dependsOn: ['files', 'reader', 'browser', 'reference'] },
  { id: 'growth', name: '成长', layer: 'entry', role: '展示能力怎样从需要帮助走到能迁移。', dependsOn: ['evidence', 'memory'] },

  { id: 'orchestrator', name: '学习编排', layer: 'engine', role: '判断当前阶段，只推荐一个主动作，并约束 AI 在这个阶段能做什么。', dependsOn: ['evidence', 'memory', 'agent'] },
  { id: 'evidence', name: '证据模型', layer: 'engine', role: '保存每次尝试、得到的帮助、反馈和修正，并推导能力等级。', dependsOn: ['project-session', 'reference'] },
  { id: 'memory', name: '记忆排程', layer: 'engine', role: '估计遗忘，安排下一次回忆的时间。', dependsOn: ['evidence'] },

  { id: 'project-session', name: 'Project 与 Session', layer: 'workbench', role: '所有内容的归属边界：一个主题一个 Project，会话不跨 Project。' },
  { id: 'workbench', name: '多面板工作台', layer: 'workbench', role: '把材料、笔记和会话并排放在一屏，并按 Project 记住布局。', dependsOn: ['project-session'] },
  { id: 'files', name: 'Project Files', layer: 'workbench', role: '管理 Project 目录下的 Markdown 与文本，自动保存。', dependsOn: ['project-session'] },
  { id: 'reader', name: 'Reader', layer: 'workbench', role: '阅读 EPUB 和 PDF，划线、跳转、记住进度。', dependsOn: ['files'] },
  { id: 'reference', name: '引用', layer: 'workbench', role: '把任意选区变成可跳回原文的结构化引用，送进会话或笔记。', dependsOn: ['project-session'] },
  { id: 'browser', name: '内置浏览器', layer: 'workbench', role: '在工作台里看网页资料，网页选区同样可以引用。', dependsOn: ['workbench', 'reference'] },
  { id: 'drawnix', name: 'Drawnix 画布', layer: 'workbench', role: '画导图和结构图，agent 可以读写当前打开的画板。', dependsOn: ['files'] },
  { id: 'agent', name: 'Agent 会话', layer: 'workbench', role: '与 AI 的对话线程，带着引用上下文，能调用 Project 内的工具。', dependsOn: ['project-session', 'reference'] },
];

export function moduleById(id: string | undefined): ModuleDef | undefined {
  return MODULES.find((m) => m.id === id);
}
