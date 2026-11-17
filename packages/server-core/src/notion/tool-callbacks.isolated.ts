import { describe, it, expect, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcServer } from '../transport'
import type { NotionHostRequest, NotionHostState } from '@craft-agent/session-tools-core/notion'
import { createProject, updateProject } from '@craft-agent/shared/projects'

mock.module('@craft-agent/shared/sources', () => ({
  loadSource: () => ({ config: { type: 'api', api: { authType: 'bearer', baseUrl: 'https://api.notion.com' } } }),
  getSourceCredentialManager: () => ({ getApiCredential: async () => 'fixture-token' }),
}))
const { ProjectNotionTools } = await import('./tool-callbacks')
const root = '11111111-1111-1111-1111-111111111111'
const page = '22222222-2222-2222-2222-222222222222'
const other = '33333333-3333-3333-3333-333333333333'

async function fixture(run: (test: {
  tools: InstanceType<typeof ProjectNotionTools>
  states: Map<string, NotionHostState>
  writes: string[]
  setBinding: () => void
  afterWrite: () => void
  failNextWrite: () => void
}) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'stair-notion-tools-'))
  const originalFetch = globalThis.fetch
  try {
    const project = createProject(directory, { name: 'A' })
    updateProject(directory, project.slug, { notion: { sourceSlug: 'notion', rootPageId: root } })
    const session = { projectId: project.id, workspace: { id: 'workspace-a', rootPath: directory } }
    const states = new Map<string, NotionHostState>([['window-a', { hasPanel: true, canOpen: true, pageId: page, revision: 'rev-1' }]])
    const writes: string[] = []
    let switchOnWrite = false
    let failWrite = false
    globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url)
      if (init?.method === 'PATCH') {
        writes.push(path)
        if (failWrite) { failWrite = false; throw new Error('Lost response') }
        if (switchOnWrite) states.get('window-a')!.pageId = other
        return Response.json({ markdown: 'New note', truncated: false, unknown_block_ids: [] })
      }
      if (path.includes('/markdown?')) return Response.json({ markdown: 'Old note', truncated: false, unknown_block_ids: [] })
      const id = path.split('/').at(-1)!
      return Response.json({ id, object: 'page', parent: id === root || id === other ? { type: 'workspace' } : { type: 'page_id', page_id: root } })
    }, { preconnect() {} })
    const server = {
      findClientsWithCapability: () => [...states.keys()],
      hasClientCapability: (id: string) => states.has(id),
      invokeClient: async (id: string, _channel: string, req: NotionHostRequest) => {
        const state = states.get(id)!
        if (req.action === 'open') { state.hasPanel = true; state.pageId = req.pageId; state.revision = 'opened' }
        return { ...state }
      },
    } as unknown as RpcServer
    const tools = new ProjectNotionTools(() => server, () => session)
    await run({ tools, states, writes,
      setBinding: () => { updateProject(directory, project.slug, { notion: { sourceSlug: 'changed', rootPageId: root } }) },
      afterWrite: () => { switchOnWrite = true },
      failNextWrite: () => { failWrite = true },
    })
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }) }
}

describe('current Project Notion tool targeting', () => {
  it('opens an existing page in an active Project that initially has no panel, then reads and writes it', () => fixture(async ({ tools, states, writes }) => {
    states.set('window-a', { hasPanel: false, canOpen: true, pageId: null, revision: null })
    await expect(tools.write({ expectedPageId: page, content: 'note' })).rejects.toThrow('NOTION_TARGET_CHANGED')
    await tools.open(page)
    expect(await tools.read({})).toHaveProperty('pageId', page)
    await tools.write({ expectedPageId: page, content: 'note' })
    expect(writes).toHaveLength(1)
  }))
  it('stops when a user switches pages after the Agent reads', () => fixture(async ({ tools, states, writes }) => {
    await tools.read({})
    states.get('window-a')!.pageId = other
    await expect(tools.write({ expectedPageId: page, content: 'note' })).rejects.toThrow('NOTION_PAGE_CHANGED')
    expect(writes).toHaveLength(0)
  }))
  it('keeps an already-dispatched write on its original page', () => fixture(async ({ tools, writes, afterWrite }) => {
    await tools.read({})
    afterWrite()
    await tools.write({ expectedPageId: page, content: 'note' })
    expect(writes).toEqual([`https://api.notion.com/v1/pages/${page}/markdown`])
  }))
  it('does not route an interrupted write to another window', () => fixture(async ({ tools, states, writes }) => {
    await tools.read({})
    const state = states.get('window-a')!
    states.delete('window-a'); states.set('window-b', state)
    await expect(tools.write({ expectedPageId: page, content: 'note' })).rejects.toThrow('NOTION_HOST_CHANGED')
    expect(writes).toHaveLength(0)
  }))
  it('rejects duplicate hosts, a changed binding, and an out-of-root target', () => fixture(async ({ tools, states, writes, setBinding }) => {
    states.set('window-b', { ...states.get('window-a')! })
    await expect(tools.open(page)).rejects.toThrow('NOTION_AMBIGUOUS_HOST')
    states.delete('window-b')
    await tools.read({})
    setBinding()
    await expect(tools.write({ expectedPageId: page, content: 'note' })).rejects.toThrow('NOTION_TARGET_CHANGED')
    await expect(tools.open(other)).rejects.toThrow('NOTION_OUTSIDE_PROJECT')
    expect(writes).toHaveLength(0)
  }))
  it('requires a fresh read after an indeterminate write before allowing another write', () => fixture(async ({ tools, writes, failNextWrite }) => {
    await tools.read({})
    failNextWrite()
    await expect(tools.write({ expectedPageId: page, content: 'note' })).rejects.toThrow('NOTION_WRITE_UNKNOWN')
    await expect(tools.write({ expectedPageId: page, content: 'note' })).rejects.toThrow('NOTION_TARGET_CHANGED')
    expect(writes).toHaveLength(1)
    await tools.read({})
    await tools.write({ expectedPageId: page, content: 'note' })
    expect(writes).toHaveLength(2)
  }))

})
