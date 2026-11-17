// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'http://localhost:5176',
  integrations: [
    starlight({
      title: 'Stair',
      description: '为学习场景打造的桌面工作台：读材料、做加工、产出你自己的理解。',
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales: {
        root: {
          label: '简体中文',
          lang: 'zh-CN',
        },
      },
      customCss: ['./src/styles/custom.css'],
      components: {
        Sidebar: './src/overrides/Sidebar.astro',
        SiteTitle: './src/overrides/SiteTitle.astro',
        PageTitle: './src/overrides/PageTitle.astro',
      },
      sidebar: [
        {
          label: '开始使用',
          items: [
            { label: 'Stair 是什么', slug: 'start/welcome' },
            { label: '安装与启动', slug: 'start/install' },
            { label: '第一个 Project 与 Session', slug: 'start/first-project' },
            { label: '反馈与支持', slug: 'start/feedback' },
          ],
        },
        {
          label: '核心功能',
          items: [
            { label: '多面板工作台', slug: 'core/workbench' },
            { label: 'Project Files', slug: 'core/project-files' },
            { label: 'Notion', slug: 'core/notion' },
            { label: 'Reader：EPUB 与 PDF', slug: 'core/reader' },
            { label: '引用与笔记', slug: 'core/citations-notes' },
            { label: '内置浏览器', slug: 'core/browser' },
            { label: 'Drawnix 白板', slug: 'core/drawnix' },
            { label: 'Agent 工具', slug: 'core/agent-tools' },
            { label: '布局与偏好', slug: 'core/layouts' },
          ],
        },
        {
          label: '工作流',
          items: [{ label: '读 → 引 → 思 → 图 → 写', slug: 'guide/reading-loop' }],
        },
        {
          label: '帮助',
          items: [
            { label: '快捷键', slug: 'help/shortcuts' },
            { label: '常见问题', slug: 'help/faq' },
          ],
        },
        // 产品介绍体系（面向用户）：分组标签与 src/overrides/sections.ts 保持一致
        // 结构：总览 → 六个空间（沿学习主线）→ 底座；每个空间是 design/<space>/ 目录，
        // 空间 id 与名称见 src/design/catalog.ts 的 SPACES
        {
          label: '产品介绍',
          items: [
            { label: '我希望解决的问题', slug: 'design/why' },
            { label: '认识 Stair', slug: 'design' },
            { label: '产品全景', slug: 'design/map' },
            { label: '一次学习的全过程', slug: 'design/learning-loop' },
            { label: 'Stair 不会做的事', slug: 'design/boundaries' },
            { label: '产品思考', slug: 'design/ideas' },
            { label: '首页 · 接着学', collapsed: true, items: [{ autogenerate: { directory: 'design/home' } }] },
            { label: '资料 · 读进来', collapsed: true, items: [{ autogenerate: { directory: 'design/sources' } }] },
            { label: '学习 · 想明白', collapsed: true, items: [{ autogenerate: { directory: 'design/learn' } }] },
            { label: '练习 · 讲出来、记得住', collapsed: true, items: [{ autogenerate: { directory: 'design/practice' } }] },
            { label: '实战 · 用得上', collapsed: true, items: [{ autogenerate: { directory: 'design/apply' } }] },
            { label: '成长 · 看见进步', collapsed: true, items: [{ autogenerate: { directory: 'design/growth' } }] },
            { label: '工作台与 AI · 底座', collapsed: true, items: [{ autogenerate: { directory: 'design/foundation' } }] },
          ],
        },
        {
          label: '开发文档',
          collapsed: true,
          items: [
            { label: '架构总览', slug: 'dev/overview' },
            { label: '工作台命令契约', slug: 'dev/workbench-commands' },
            { label: '持久化', slug: 'dev/persistence' },
            { label: '原生浏览器运行时', slug: 'dev/browser-runtime' },
            { label: '数据与安全边界', slug: 'dev/data-and-security' },
            { label: '打包与更新', slug: 'dev/packaging-updates' },
            { label: '回归验收体系', slug: 'dev/regression' },
            { label: '开发环境与脚本', slug: 'dev/development-setup' },
            { label: '术语表', slug: 'dev/glossary' },
          ],
        },
        // 产品规格：给团队看的定位、原则、模块与流程；功能页本身在产品介绍下
        {
          label: '产品规格',
          items: [
            { label: '规格先行流程', slug: 'dev/spec/process' },
            { label: '定位', slug: 'dev/spec/positioning' },
            { label: '目标与衡量', slug: 'dev/spec/goals' },
            { label: '设计原则', slug: 'dev/spec/principles' },
            { label: '边界与理由', slug: 'dev/spec/boundaries' },
            { label: '学习系统设计', slug: 'dev/spec/learning-system' },
            { label: '模块地图', slug: 'dev/spec/modules' },
            { label: '参考与证据', slug: 'dev/spec/research' },
          ],
        },
        {
          label: '设计决策',
          collapsed: true,
          items: [{ autogenerate: { directory: 'dev/spec/decisions' } }],
        },
      ],
    }),
  ],
});
