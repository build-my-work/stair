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
      ],
    }),
  ],
});
