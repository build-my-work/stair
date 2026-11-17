import { expect, it } from 'bun:test'
import { notionPageIdFromUrl, parseNotionPage } from './index'

it('parses full Notion page URLs, ignores block anchors, and rejects ambiguous peek or foreign URLs', () => {
  const id = '11111111-1111-1111-1111-111111111111'
  expect(parseNotionPage('https://www.notion.so/My-notes-11111111111111111111111111111111#another-block')).toBe(id)
  expect(parseNotionPage(id)).toBe(id)
  expect(parseNotionPage('https://app.notion.com/p/41b445a7c06180e6a036e3eb63d711a2?source=copy_link')).toBe('41b445a7-c061-80e6-a036-e3eb63d711a2')
  expect(notionPageIdFromUrl('https://www.notion.so/11111111111111111111111111111111?p=22222222222222222222222222222222')).toBeNull()
  expect(notionPageIdFromUrl('https://evil.test/11111111111111111111111111111111')).toBeNull()
  expect(() => parseNotionPage('../outside')).toThrow()
})
