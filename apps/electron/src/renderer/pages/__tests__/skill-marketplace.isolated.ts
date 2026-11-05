import { afterEach, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { createRequire } from 'node:module'
import type { SkillCatalogEntry, SkillImportSource, PreparedSkillImport } from '@craft-agent/shared/skills/marketplace'

const require = createRequire(import.meta.url)
const domino = require('@mixmark-io/domino')
// React detects input-event support when the renderer is first imported.
const initialWindow = domino.createWindow('<!doctype html><html><body></body></html>')
initialWindow.document.oninput = null
Object.assign(globalThis, { window: initialWindow, document: initialWindow.document })
const { createRoot } = await import('react-dom/client')
let importProps: { onPrepare: (source: SkillImportSource) => void; disabled: boolean }
let previewProps: { prepared: PreparedSkillImport; busy: boolean; installed: string[]; onInstall: (ids: string[], replace: boolean) => void } | undefined
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('sonner', () => ({ toast: { success() {} } }))
mock.module('@/context/AppShellContext', () => ({ useActiveWorkspace: () => ({ name: 'Test workspace' }) }))
mock.module('@/lib/navigate', () => ({ routes: { view: { skills: (slug: string) => slug } }, navigate() {} }))
mock.module('@/components/ui/button', () => ({ Button: ({ children, size, variant, ...props }: any) => React.createElement('button', props, children) }))
mock.module('@/components/ui/skill-avatar', () => ({ SkillAvatar: () => null }))
mock.module('@/components/skills/SkillImportMenu', () => ({ SkillImportMenu: (props: typeof importProps) => { importProps = props; return null } }))
mock.module('@/components/skills/SkillInstallPreview', () => ({ SkillInstallPreview: (props: NonNullable<typeof previewProps>) => { previewProps = props; return null } }))
const { default: SkillMarketplacePage } = await import('../SkillMarketplacePage')
const { skillsAtom } = await import('../../atoms/skills')

const prepared: PreparedSkillImport = {
  token: 'preview', expiresAt: Date.now() + 60000, candidates: [{
    id: 'one', slug: 'one', name: 'One', description: 'Test skill', content: 'Instructions',
    requiredSources: [], alwaysAllow: [], files: [{ path: 'SKILL.md', size: 10 }],
    origin: { schemaVersion: 1, source: 'folder', identity: 'folder:one', installedAt: new Date().toISOString(), contentHash: 'hash' },
  }],
}
let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  previewProps = undefined
})

function setup(api: Record<string, unknown>) {
  const w = domino.createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Node: w.Node, IS_REACT_ACT_ENVIRONMENT: true })
  w.electronAPI = { getSkills: async () => [], searchSkillMarketplace: async () => [], ...api }
  const store = createStore()
  root = createRoot(w.document.getElementById('root'))
  return {
    store,
    text: () => w.document.body.textContent as string,
    selectMarket: async (label: string) => {
      const button = Array.from(w.document.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
        .find(button => button.textContent === label)!
      await act(async () => button.click())
    },
    search: async (query: string) => {
      const input = w.document.querySelector('input')
      await act(async () => {
        Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!.call(input, query)
        input.dispatchEvent(new w.Event('input', { bubbles: true }))
      })
    },
    render: async (workingDirectory: string, workspaceId = 'workspace') => {
      await act(async () => root!.render(React.createElement(Provider, { store },
        React.createElement(SkillMarketplacePage, { key: workspaceId, workspaceId, workingDirectory }))))
    },
  }
}

async function settleSearch() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
}

const popular: SkillCatalogEntry = {
  id: 'skills-sh:owner/repo/popular', name: 'Popular skill', description: 'owner/repo', market: 'skills-sh',
  url: 'https://skills.sh/owner/repo/popular', source: { kind: 'github', url: 'https://github.com/owner/repo', skill: 'popular' },
}

test('skills.sh displays popular skills, switches to keyword results, and restores popular skills after clearing', async () => {
  const calls: string[] = []
  const h = setup({ searchSkillMarketplace: async (_workspace: string, market: string, query: string) => {
    calls.push(market + ':' + query)
    return [{ ...popular, name: query ? 'Search result' : popular.name }]
  } })
  await h.render('/project')
  await h.selectMarket('skills.sh')
  await settleSearch()
  expect(h.text()).toContain('Popular skill')
  expect(h.text()).toContain('skillMarket.popularHint')
  expect(h.text()).not.toContain('skillMarket.searchHint')
  expect(h.text()).not.toContain('skillMarket.noResults')

  await h.search('agent')
  await settleSearch()
  expect(h.text()).toContain('Search result')
  expect(h.text()).not.toContain('Popular skill')
  expect(h.text()).not.toContain('skillMarket.popularHint')
  await act(async () => (document.querySelector('[aria-label="skillMarket.clearSearch"]') as HTMLButtonElement).click())
  await settleSearch()
  expect(h.text()).toContain('Popular skill')
  expect(calls).toEqual(['skills-sh:', 'skills-sh:agent', 'skills-sh:'])
})

test('skills.sh single-character input shows guidance without claiming there are no matching skills', async () => {
  const calls: string[] = []
  const h = setup({ searchSkillMarketplace: async (_workspace: string, _market: string, query: string) => {
    calls.push(query)
    return []
  } })
  await h.render('/project')
  await h.selectMarket('skills.sh')
  await h.search('a')
  await settleSearch()
  expect(calls).toEqual(['a'])
  expect(h.text()).toContain('skillMarket.searchHint')
  expect(h.text()).not.toContain('skillMarket.noResults')
  expect(h.text()).not.toContain('skillMarket.popularHint')
  await h.search('absent')
  await settleSearch()
  expect(h.text()).toContain('skillMarket.noResults')
  expect(h.text()).not.toContain('skillMarket.searchHint')
})

test('empty popular feed has a browse empty state instead of a failed-search message', async () => {
  const h = setup({})
  await h.render('/project')
  await h.selectMarket('skills.sh')
  await h.search('   ')
  await settleSearch()
  expect(h.text()).toContain('skillMarket.noSkills')
  expect(h.text()).not.toContain('skillMarket.noResults')
  expect(h.text()).not.toContain('skillMarket.searchHint')
})

test('a popular feed failure keeps EduHub results visible and can be retried', async () => {
  let failed = true
  const h = setup({ searchSkillMarketplace: async (_workspace: string, market: string) => {
    if (market === 'skills-sh') {
      if (failed) throw new Error('HTTP 503')
      return [popular]
    }
    return [{ ...popular, id: 'eduhub:one', name: 'EduHub skill', market: 'eduhub', source: { kind: 'eduhub', slug: 'one' } }]
  } })
  await h.render('/project')
  await settleSearch()
  expect(h.text()).toContain('EduHub skill')
  expect(h.text()).toContain('skills.sh: HTTP 503')
  expect(h.text()).not.toContain('skillMarket.noResults')
  failed = false
  await act(async () => (document.querySelector('[role="alert"] button') as HTMLButtonElement).click())
  await settleSearch()
  expect(h.text()).toContain('Popular skill')
  expect(h.text()).toContain('EduHub skill')
  expect(document.querySelector('[role="alert"]')).toBeFalsy()
})

test('changing the session directory during workspace import does not lose its preview or leave it busy', async () => {
  let finish!: (value: PreparedSkillImport) => void
  const pending = new Promise<PreparedSkillImport>(resolve => { finish = resolve })
  const h = setup({ prepareSkillImport: () => pending })
  await h.render('/project-a')
  await act(async () => importProps.onPrepare({ kind: 'github', url: 'https://github.com/owner/repo' }))
  expect(importProps.disabled).toBe(true)
  await h.render('/project-b')
  await act(async () => { finish(prepared); await pending })
  expect(previewProps?.prepared.token).toBe('preview')
  expect(previewProps?.busy).toBe(false)
})

test('installation refreshes skills for the latest session directory and preserves its result', async () => {
  let finish!: (value: { installed: string[]; failed: [] }) => void
  const pending = new Promise<{ installed: string[]; failed: [] }>(resolve => { finish = resolve })
  let installed = false
  const h = setup({
    prepareSkillImport: async () => prepared,
    installSkills: () => pending,
    getSkills: async (_workspace: string, directory: string) => installed ? [{ slug: directory, metadata: { name: 'One', description: 'Test skill' } }] : [],
  })
  await h.render('/project-a')
  await act(async () => importProps.onPrepare({ kind: 'github', url: 'https://github.com/owner/repo' }))
  await act(async () => previewProps!.onInstall(['one'], false))
  await h.render('/project-b')
  installed = true
  await act(async () => { finish({ installed: ['one'], failed: [] }); await pending })
  expect(previewProps?.installed).toEqual(['one'])
  expect(previewProps?.busy).toBe(false)
  expect(h.store.get(skillsAtom).map(skill => skill.slug)).toEqual(['/project-b'])
})

test('a late preview from an unmounted workspace cannot populate the new workspace', async () => {
  let finish!: (value: PreparedSkillImport) => void
  const pending = new Promise<PreparedSkillImport>(resolve => { finish = resolve })
  const h = setup({ prepareSkillImport: () => pending })
  await h.render('/project-a')
  await act(async () => importProps.onPrepare({ kind: 'github', url: 'https://github.com/owner/repo' }))
  await h.render('/project-b', 'other-workspace')
  await act(async () => { finish(prepared); await pending })
  expect(previewProps).toBeUndefined()
  expect(importProps.disabled).toBe(false)
})
