/**
 * 站点的三个体系：使用指南（guide）、产品介绍（design）、技术文档（dev，含产品规格）。
 * Sidebar 与 SiteTitle 都按路径判断当前体系，分组标签必须与 astro.config.mjs 的 sidebar 一致。
 */
export type Section = 'guide' | 'design' | 'dev';

export const SECTION_GROUPS: Record<Exclude<Section, 'guide'>, string[]> = {
  design: ['产品介绍'],
  dev: ['开发文档', '产品规格', '设计决策'],
};

export function sectionOf(pathname: string): Section {
  if (pathname.startsWith('/dev/')) return 'dev';
  if (pathname.startsWith('/design/')) return 'design';
  return 'guide';
}
