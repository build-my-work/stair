import { describe, expect, it } from 'bun:test'
import {
  applyProductBranding,
  applyProductBrandingToMessages,
  CRAFT_PRODUCT_NAME,
  STAIR_COAUTHOR_EMAIL,
  STAIR_PRODUCT_NAME,
} from './stair-branding'

describe('Stair 品牌', () => {
  it('默认 Craft 入口保持原品牌', () => {
    expect(applyProductBranding('Welcome to Craft Agents', CRAFT_PRODUCT_NAME)).toBe(
      'Welcome to Craft Agents',
    )
  })

  it('只替换产品展示名，不改写上游服务名', () => {
    expect(applyProductBranding('Welcome to Craft Agents', STAIR_PRODUCT_NAME)).toBe(
      'Welcome to Stair',
    )
    expect(applyProductBranding('Message Craft Agent', STAIR_PRODUCT_NAME)).toBe(
      'Message Stair',
    )
    expect(applyProductBranding('Use Craft Agents Backend', STAIR_PRODUCT_NAME)).toBe(
      'Use Craft Agents Backend',
    )
    expect(applyProductBranding('Search Craft Agents Docs', STAIR_PRODUCT_NAME)).toBe(
      'Search Craft Agents Docs',
    )
  })

  it('使用 Stair 共著者身份', () => {
    expect(
      applyProductBranding(
        'Co-Authored-By: Craft Agent <agents-noreply@craft.do>',
        STAIR_PRODUCT_NAME,
      ),
    ).toBe(`Co-Authored-By: Stair <${STAIR_COAUTHOR_EMAIL}>`)
  })

  it('只改写翻译值，不改写翻译键', () => {
    expect(
      applyProductBrandingToMessages(
        { 'menu.aboutCraftAgents': 'About Craft Agents' },
        STAIR_PRODUCT_NAME,
      ),
    ).toEqual({ 'menu.aboutCraftAgents': 'About Stair' })
  })
})
