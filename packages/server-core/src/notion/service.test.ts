import { describe, it, expect } from 'bun:test'
import { ProjectNotionService } from './service'

const root = '11111111-1111-1111-1111-111111111111'
const page = '22222222-2222-2222-2222-222222222222'
const block = '33333333-3333-3333-3333-333333333333'
const outside = '44444444-4444-4444-4444-444444444444'
const binding = { sourceSlug: 'notion', rootPageId: root }
const rootEntity = { object: 'page', id: root, parent: { type: 'workspace', workspace: true } }
const pageEntity = { object: 'page', id: page, parent: { type: 'page_id', page_id: root }, properties: { title: { type: 'title', title: [{ plain_text: 'Notes' }] } } }

function fixture(handler: (path: string, init?: RequestInit) => unknown) {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const request = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.notion.com/v1/', '')
    calls.push({ path, init })
    const result = handler(path, init)
    return result instanceof Response ? result : Response.json(result)
  }, { preconnect() {} })
  return { service: new ProjectNotionService(binding, {}, request), calls }
}

describe('Project Notion REST service', () => {
  it('finds subpages inside ordinary blocks and across pagination without flattening grandchildren', async () => {
    const { service } = fixture(path => {
      if (path === `pages/${root}`) return rootEntity
      if (path.includes(`/blocks`)) throw new Error('bad route')
      if (path.startsWith(`blocks/${root}/children`) && !path.includes('start_cursor')) return { results: [{ id: block, type: 'toggle', has_children: true }], has_more: true, next_cursor: 'next' }
      if (path.includes('start_cursor')) return { results: [{ id: outside, type: 'child_database', child_database: { title: 'Tracker' }, has_children: true }], has_more: false }
      if (path.startsWith(`blocks/${block}/children`)) return { results: [{ id: page, type: 'child_page', child_page: { title: 'Notes' }, has_children: true }], has_more: false }
      throw new Error(path)
    })
    expect(await service.children()).toEqual([
      { pageId: outside, title: 'Tracker', url: `https://www.notion.so/${outside.replaceAll('-', '')}`, kind: 'database' },
      { pageId: page, title: 'Notes', url: `https://www.notion.so/${page.replaceAll('-', '')}`, kind: 'page' },
    ])
  })

  it('rejects a readable page outside the configured root before fetching its content', async () => {
    const { service, calls } = fixture(() => ({ object: 'page', id: outside, parent: { type: 'workspace' } }))
    await expect(service.read(outside)).rejects.toThrow('NOTION_OUTSIDE_PROJECT')
    expect(calls).toHaveLength(1)
  })

  it('walks block parents and rejects cycles', async () => {
    const { service } = fixture(path => path === `pages/${page}`
      ? { ...pageEntity, parent: { type: 'block_id', block_id: block } }
      : { id: block, object: 'block', parent: { type: 'block_id', block_id: block } })
    await expect(service.assertWithinRoot(page)).rejects.toThrow('NOTION_INVALID_PARENT')
  })

  it('does not write if the workbench switches pages during the remote read', async () => {
    const { service, calls } = fixture(path => path.endsWith('/markdown?markdown_version=v2')
      ? { markdown: 'Old text', truncated: false, unknown_block_ids: [] }
      : path === `pages/${page}` ? pageEntity : rootEntity)
    await expect(service.write({ expectedPageId: page, content: 'New note' }, async () => { throw new Error('PAGE_CHANGED') })).rejects.toThrow('PAGE_CHANGED')
    expect(calls.some(call => call.init?.method === 'PATCH')).toBe(false)
  })

  it('uses targeted replacement and returns warnings instead of claiming ignored content was saved', async () => {
    const { service, calls } = fixture((path, init) => {
      if (init?.method === 'PATCH') return { markdown: 'New text', truncated: false, unknown_block_ids: [], warnings: [{ code: 'unsupported_tag' }] }
      return path.includes('/markdown?') ? { markdown: 'Old text', truncated: false, unknown_block_ids: [] } : path === `pages/${page}` ? pageEntity : rootEntity
    })
    const result = await service.write({ expectedPageId: page, content: 'New', oldText: 'Old' }, async () => {})
    expect(result.markdown).toBe('New text')
    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({ markdown_version: 'v2', type: 'update_content', update_content: { content_updates: [{ old_str: 'Old', new_str: 'New' }] } })
    expect(result).toHaveProperty('warnings')
  })

  it('refuses ambiguous replacements and incomplete pages', async () => {
    for (const document of [{ markdown: 'same same', truncated: false, unknown_block_ids: [] }, { markdown: 'same', truncated: true, unknown_block_ids: [block] }]) {
      const { service, calls } = fixture(path => path.includes('/markdown?') ? document : path === `pages/${page}` ? pageEntity : rootEntity)
      await expect(service.write({ expectedPageId: page, oldText: 'same', content: 'new' }, async () => {})).rejects.toThrow()
      expect(calls.some(call => call.init?.method === 'PATCH')).toBe(false)
    }
  })

  it('does not automatically repeat an indeterminate write', async () => {
    const { service, calls } = fixture((path, init) => {
      if (init?.method === 'PATCH') throw new Error('connection reset after request')
      return path.includes('/markdown?') ? { markdown: '', truncated: false, unknown_block_ids: [] } : path === `pages/${page}` ? pageEntity : rootEntity
    })
    await expect(service.write({ expectedPageId: page, content: 'Note' }, async () => {})).rejects.toThrow('NOTION_WRITE_UNKNOWN')
    expect(calls.filter(call => call.init?.method === 'PATCH')).toHaveLength(1)
  })
})
