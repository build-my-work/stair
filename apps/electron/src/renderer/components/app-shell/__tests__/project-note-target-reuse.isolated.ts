import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { referenceKey, type Reference } from '@craft-agent/core'
import { isProjectNoteTargetPath } from '@craft-agent/shared/protocol'
import * as storage from '../../../lib/local-storage'

// Exercise the actual AppShell callbacks without booting its unrelated chat,
// navigation and provider surfaces. No copy of the Add Note workflow lives here.
const shell = readFileSync(new URL('../AppShell.tsx', import.meta.url), 'utf8')
const start = shell.indexOf('  const [pendingProjectNote,')
const end = shell.indexOf('  const handleRevealReference', start)
const confirmStart = shell.indexOf('  const confirmProjectNoteTarget')
const confirmEnd = shell.indexOf('  const hasPendingPrompt', confirmStart)
if ([start, end, confirmStart, confirmEnd].some(index => index < 0)) {
  throw new Error('AppShell Add Note callback boundaries changed')
}
const source = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  const { useRef, useState, useCallback } = React;
  return function useNoteActions(context) {
    const { activeWorkspaceId, projects, sessionMetaMap, setSessionMetaMap } = context;
    const t = key => key;
    const toast = { success() {}, error() {} };
    ${shell.slice(start, end)}
    ${shell.slice(confirmStart, confirmEnd)}
    return { add: handleAddSelectionNote, confirm: confirmProjectNoteTarget,
      cancel: cancelProjectNoteTargetDialog, pending: pendingProjectNote, error: projectNoteError };
  }
`)
type Actions = {
  add(reference: Reference, sessionId?: string | null, mode?: 'current' | 'choose-target'): Promise<string | null>
  confirm(path: string): Promise<void>
  cancel(): void
  pending: { initialPath?: string; recentPaths: string[] } | null
  error: string
}
type Context = {
  activeWorkspaceId: string
  projects: { config: { id: string; workingDirectory: string } }[]
  sessionMetaMap: Map<string, { id: string; projectId: string; projectNoteTargetPath?: string; projectNoteRecentTargetPaths?: string[] }>
  setSessionMetaMap(update: (value: Context['sessionMetaMap']) => Context['sessionMetaMap']): void
}
const useNoteActions = new Function('React', 'storage', 'referenceKey', 'isProjectNoteTargetPath', source)(
  React, storage, referenceKey, isProjectNoteTargetPath,
) as (context: Context) => Actions
const domino = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createWindow(html: string): Window & typeof globalThis
}
let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
})

function selection(quote: string, projectId = 'project-a'): Reference {
  return {
    version: 1, kind: 'project-file', projectId, relativePath: 'book.epub',
    sourceFingerprint: 'sha256:book', fileName: 'book.epub', quote,
    locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/4!/4/2/1:0)' },
  }
}

async function setup() {
  const browserWindow = domino.createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  const stored = new Map<string, string>()
  Object.assign(globalThis, {
    window: browserWindow, document: browserWindow.document,
    navigator: browserWindow.navigator, HTMLElement: browserWindow.HTMLElement,
    Node: browserWindow.Node, IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value) },
    },
  })
  const writes: { relativePath: string; selection: Reference }[] = []
  const context: Context = {
    activeWorkspaceId: 'workspace-a',
    projects: ['project-a', 'project-b'].map(id => ({ config: { id, workingDirectory: `/${id}` } })),
    sessionMetaMap: new Map(),
    setSessionMetaMap(update) { context.sessionMetaMap = update(context.sessionMetaMap) },
  }
  let configureError: string | undefined
  let appendError: string | undefined
  Object.assign(window, { electronAPI: {
    configureProjectNoteTarget: async (request: { relativePath: string }) => {
      if (configureError) throw new Error(configureError)
      return { ...request, projectRootFingerprint: 'root', recentPaths: [] }
    },
    appendProjectNote: async (request: typeof writes[number]) => {
      if (appendError) throw new Error(appendError)
      writes.push(request)
    },
  } })
  let actions: Actions
  function Harness() { actions = useNoteActions(context); return null }
  root = createRoot(document.getElementById('root')!)
  const render = async () => { await act(async () => root!.render(React.createElement(Harness))) }
  await render()
  return {
    context, writes, stored, render,
    get actions() { return actions! },
    set configureError(value: string | undefined) { configureError = value },
    set appendError(value: string | undefined) { appendError = value },
    async choose(path: string, quote = 'first selection') {
      let pending!: Promise<string | null>
      await act(async () => { pending = actions.add(selection(quote)) })
      expect(actions!.pending).toBeTruthy()
      await act(async () => { await actions.confirm(path) })
      await expect(pending).resolves.toBe(path)
    },
    async add(quote: string, projectId = 'project-a', mode: 'current' | 'choose-target' = 'current', sessionId: string | null = null) {
      // Do not await the action: a reappearing picker waits for user input.
      await act(async () => { void actions.add(selection(quote, projectId), sessionId, mode) })
    },
    async remount() {
      await act(async () => root!.unmount())
      root = createRoot(document.getElementById('root')!)
      await render()
    },
  }
}

describe('Add Note target reuse without a Chat target', () => {
  it('uses the chosen file for the second selection without reopening the picker', async () => {
    const app = await setup()
    await app.choose('notes.md')
    await app.add('second selection')
    expect(app.actions.pending).toBeNull()
    expect(app.writes.map(write => [write.relativePath, write.selection.quote])).toEqual([
      ['notes.md', 'first selection'], ['notes.md', 'second selection'],
    ])
  })

  it('restores the target after the shell is remounted', async () => {
    const app = await setup()
    await app.choose('notes.md')
    await app.remount()
    await app.add('after reopening')
    expect(app.actions.pending).toBeNull()
    expect(app.writes.at(-1)?.relativePath).toBe('notes.md')
    expect(app.writes).toHaveLength(2)
  })

  it('opens the picker with the saved target and keeps it when cancelled', async () => {
    const app = await setup()
    await app.choose('notes.md')
    await app.add('change target', 'project-a', 'choose-target')
    expect(app.actions.pending).toMatchObject({ initialPath: 'notes.md', recentPaths: ['notes.md'] })
    await act(async () => app.actions.cancel())
    await app.add('after cancel')
    expect(app.actions.pending).toBeNull()
    expect(app.writes.at(-1)?.relativePath).toBe('notes.md')
    expect(app.writes).toHaveLength(2)
  })

  it('remembers a replacement target and lists the previous file', async () => {
    const app = await setup()
    await app.choose('notes.md')
    await app.add('new target selection', 'project-a', 'choose-target')
    await act(async () => app.actions.confirm('other.md'))
    await app.add('after changing target')
    expect(app.writes.at(-1)?.relativePath).toBe('other.md')
    await app.add('show recent files', 'project-a', 'choose-target')
    expect(app.actions.pending).toMatchObject({ initialPath: 'other.md', recentPaths: ['other.md', 'notes.md'] })
  })

  it.each(['project', 'workspace', 'root'] as const)('does not reuse the target after changing %s', async scope => {
    const app = await setup()
    await app.choose('notes.md')
    if (scope === 'workspace') app.context.activeWorkspaceId = 'workspace-b'
    if (scope === 'root') app.context.projects = [{ config: { id: 'project-a', workingDirectory: '/replacement' } }]
    await app.render()
    await app.add('different scope', scope === 'project' ? 'project-b' : 'project-a')
    expect(app.actions.pending).toMatchObject({ recentPaths: [] })
    expect(app.actions.pending?.initialPath).toBeUndefined()
    expect(app.writes).toHaveLength(1)
  })

  it('does not remember a failed write', async () => {
    const app = await setup()
    app.appendError = 'PROJECT_NOTE_WRITE_FAILED: disk full'
    await app.add('cannot write')
    await act(async () => app.actions.confirm('failed.md'))
    expect(app.actions.error).toContain('disk full')
    await act(async () => app.actions.cancel())
    app.appendError = undefined
    await app.add('try again')
    expect(app.actions.pending?.initialPath).toBeUndefined()
    expect(app.actions.pending?.recentPaths).toEqual([])
    expect(app.writes).toHaveLength(0)
  })

  it('asks for a new target if the remembered file is missing', async () => {
    const app = await setup()
    await app.choose('notes.md')
    app.configureError = 'PROJECT_NOTE_TARGET_NOT_FOUND: file removed'
    await app.add('after file removal')
    expect(app.actions.pending).toBeTruthy()
    expect(app.writes).toHaveLength(1)
    app.configureError = undefined
    await act(async () => app.actions.confirm('replacement.md'))
    await app.add('following selection')
    expect(app.actions.pending).toBeNull()
    expect(app.writes.at(-1)?.relativePath).toBe('replacement.md')
  })

  it('keeps a Chat-specific target ahead of the Project fallback', async () => {
    const app = await setup()
    await app.choose('project-notes.md')
    app.context.sessionMetaMap.set('chat-a', { id: 'chat-a', projectId: 'project-a', projectNoteTargetPath: 'chat-notes.md' })
    await app.render()
    await app.add('chat selection', 'project-a', 'current', 'chat-a')
    expect(app.actions.pending).toBeNull()
    expect(app.writes.at(-1)?.relativePath).toBe('chat-notes.md')
  })

  it('ignores malformed stored preferences', async () => {
    const app = await setup()
    await app.choose('notes.md')
    const key = [...app.stored.keys()][0]!
    app.stored.set(key, JSON.stringify(['../outside.md', 'image.png', null]))
    await app.add('invalid saved target')
    expect(app.actions.pending?.recentPaths).toEqual([])
    expect(app.writes).toHaveLength(1)
  })
})
