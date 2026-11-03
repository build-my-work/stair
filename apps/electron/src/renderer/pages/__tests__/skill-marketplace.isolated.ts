import { afterEach, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { createRequire } from 'node:module'
import type { SkillImportSource, PreparedSkillImport } from '@craft-agent/shared/skills/marketplace'

const require = createRequire(import.meta.url)
const domino = require('@mixmark-io/domino')
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
    render: async (workingDirectory: string, workspaceId = 'workspace') => {
      await act(async () => root!.render(React.createElement(Provider, { store },
        React.createElement(SkillMarketplacePage, { key: workspaceId, workspaceId, workingDirectory }))))
    },
  }
}

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
