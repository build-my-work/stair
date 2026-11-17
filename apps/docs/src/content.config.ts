import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

/**
 * 产品设计体系（/design/）的功能页额外携带的字段。
 * 其他页面不填，全部可选；功能看板只读取带 status 的页面。
 */
const designFields = z.object({
  /** 功能所处阶段，见 /design/process/ 的状态说明 */
  status: z.enum(['exploring', 'planned', 'in-progress', 'shipped', 'dropped']).optional(),
  /** 所属模块，取值与模块地图中的模块 id 一致 */
  module: z.string().optional(),
  /** 对应 docs/stair-full-regression.md 的 Case ID；shipped 的功能必须填写 */
  cases: z.array(z.string()).optional(),
  /** 该功能主要落实的设计原则编号（/design/principles/） */
  principles: z.array(z.number().int()).optional(),
});

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema({ extend: designFields }) }),
};
