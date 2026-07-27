import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'

import {
  RIGHT_WORKSPACE_STATE_VERSION,
  closeRightWorkspaceTab,
  createDefaultRightWorkspaceSession,
  getRightWorkspaceGlobalStorageKey,
  getRightWorkspaceSessionStorageKey,
  openFileInRightWorkspace,
  renameArtifactInRightWorkspace,
  parsePersistedRightWorkspaceGlobal,
  parsePersistedRightWorkspaceSession,
  rightWorkspaceContextAtom,
  rightWorkspaceGlobalAtom,
  rightWorkspaceFileNavigationAtom,
  rightWorkspaceSessionAtom,
  showRightWorkspaceFileAtom,
  showRightWorkspaceReferenceAtom,
  showRightWorkspaceArtifactAtom,
  updateRightWorkspaceFileExplorer,
} from '../right-workspace'

describe('right workspace state', () => {
  it('starts every focused session with one active New tab', () => {
    const state = createDefaultRightWorkspaceSession()

    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ type: 'new', title: 'New tab' })
    expect(state.activeTabId).toBe(state.tabs[0].id)
    expect(state.fileExplorerVisible).toBe(false)
  })

  it('normalizes project-relative paths and activates an existing file tab', () => {
    const initial = createDefaultRightWorkspaceSession('new-1')
    const opened = openFileInRightWorkspace(initial, './books\\operating-systems.epub', 'file-1')
    const reopened = openFileInRightWorkspace(opened, 'books/operating-systems.epub', 'file-2')

    expect(reopened.tabs.filter((tab) => tab.type === 'file')).toEqual([
      {
        id: 'file-1',
        type: 'file',
        path: 'books/operating-systems.epub',
        title: 'operating-systems.epub',
      },
    ])
    expect(reopened.activeTabId).toBe('file-1')
  })

  it('rejects paths that can escape the project working directory', () => {
    const initial = createDefaultRightWorkspaceSession('new-1')

    expect(() => openFileInRightWorkspace(initial, '../secret.txt', 'file-1')).toThrow()
    expect(() => openFileInRightWorkspace(initial, '/tmp/secret.txt', 'file-2')).toThrow()
    expect(() => openFileInRightWorkspace(initial, 'C:\\secret.txt', 'file-3')).toThrow()
  })

  it('replaces the last closed tab with a New tab and chooses a neighbor otherwise', () => {
    const initial = updateRightWorkspaceFileExplorer(
      createDefaultRightWorkspaceSession('new-1'),
      { visible: true, expandedDirectories: ['books'] },
    )
    const withFile = openFileInRightWorkspace(initial, 'notes/chapter-1.md', 'file-1')

    const afterFileClose = closeRightWorkspaceTab(withFile, 'file-1', 'new-2')
    expect(afterFileClose.activeTabId).toBe('new-1')

    const afterLastClose = closeRightWorkspaceTab(afterFileClose, 'new-1', 'new-2')
    expect(afterLastClose.tabs).toEqual([
      { id: 'new-2', type: 'new', title: 'New tab' },
    ])
    expect(afterLastClose.activeTabId).toBe('new-2')
    expect(afterLastClose.fileExplorerVisible).toBe(true)
    expect(afterLastClose.expandedDirectories).toEqual(['books'])
  })

  it('migrates legacy file tabs out of the right sidebar and repairs a stale active id', () => {
    const restored = parsePersistedRightWorkspaceSession({
      version: RIGHT_WORKSPACE_STATE_VERSION,
      tabs: [
        { id: 'file-1', type: 'file', path: './book.epub', title: 'Old title' },
        { id: 'file-2', type: 'file', path: 'book.epub', title: 'Duplicate' },
        { id: 'chat-1', type: 'sideChat', sessionId: 'side-1', title: 'Questions' },
      ],
      activeTabId: 'missing-tab',
      fileExplorerVisible: true,
      fileExplorerWidth: 9999,
      expandedDirectories: ['.', 'chapters', '../outside'],
      fileExplorerScrollTop: 48,
    })

    expect(restored.tabs).toEqual([
      { id: 'chat-1', type: 'sideChat', sessionId: 'side-1', title: 'Questions' },
    ])
    expect(restored.activeTabId).toBe('chat-1')
    expect(restored.fileExplorerWidth).toBe(420)
    expect(restored.expandedDirectories).toEqual(['chapters'])
    expect(restored.fileExplorerScrollTop).toBe(48)
  })

  it('falls back safely for malformed or future persisted state', () => {
    const malformed = parsePersistedRightWorkspaceSession({ version: 1, tabs: 'nope' })
    const future = parsePersistedRightWorkspaceSession({
      version: RIGHT_WORKSPACE_STATE_VERSION + 1,
      tabs: [],
    })

    expect(malformed.tabs[0].type).toBe('new')
    expect(future.tabs[0].type).toBe('new')
    expect(parsePersistedRightWorkspaceGlobal({ visible: 'yes', width: -1 })).toEqual({
      visible: false,
      width: 440,
    })
    expect(parsePersistedRightWorkspaceGlobal({
      version: RIGHT_WORKSPACE_STATE_VERSION,
      visible: true,
      width: 9999,
    })).toEqual({ visible: true, width: 640 })
  })

  it('reveals a file only when a focused workspace session is available', () => {
    const store = createStore()

    expect(store.set(showRightWorkspaceFileAtom, 'book.epub')).toBe(false)

    store.set(rightWorkspaceContextAtom, { workspaceId: 'workspace-a', sessionId: 'session-1' })
    expect(store.set(showRightWorkspaceFileAtom, 'book.epub')).toBe(true)
    expect(store.get(rightWorkspaceGlobalAtom).visible).toBe(true)
    expect(store.get(rightWorkspaceSessionAtom).tabs.at(-1)).toMatchObject({
      type: 'file',
      path: 'book.epub',
    })
  })

  it('opens a referenced file and retains its precise locator for the viewer', () => {
    const store = createStore()
    store.set(rightWorkspaceContextAtom, { workspaceId: 'workspace-a', sessionId: 'session-1' })

    expect(store.set(showRightWorkspaceReferenceAtom, {
      projectId: 'project-1',
      path: 'books/os.epub',
      quote: 'process',
      locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/4!/4/2:0)' },
    })).toBe(true)

    expect(store.get(rightWorkspaceSessionAtom).tabs.at(-1)).toMatchObject({
      type: 'file',
      path: 'books/os.epub',
    })
    expect(store.get(rightWorkspaceFileNavigationAtom)).toMatchObject({
      path: 'books/os.epub',
      locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/4!/4/2:0)' },
    })
  })

  it('reveals a persisted Artifact in a deduplicated tab', () => {
    const store = createStore()
    store.set(rightWorkspaceContextAtom, { workspaceId: 'workspace-a', sessionId: 'session-1' })
    expect(store.set(showRightWorkspaceArtifactAtom, { artifactId: 'artifact-1', title: 'Notes' })).toBe(true)
    expect(store.set(showRightWorkspaceArtifactAtom, { artifactId: 'artifact-1', title: 'Notes' })).toBe(true)
    expect(store.get(rightWorkspaceSessionAtom).tabs.filter(tab => tab.type === 'artifact')).toHaveLength(1)
    expect(store.get(rightWorkspaceGlobalAtom).visible).toBe(true)
  })

  it('renames only the matching Artifact tab', () => {
    const initial = {
      ...createDefaultRightWorkspaceSession('new-1'),
      tabs: [
        { id: 'artifact-tab-1', type: 'artifact' as const, artifactId: 'artifact-1', title: 'Old title' },
        { id: 'artifact-tab-2', type: 'artifact' as const, artifactId: 'artifact-2', title: 'Other title' },
      ],
      activeTabId: 'artifact-tab-1',
    }

    expect(renameArtifactInRightWorkspace(initial, 'artifact-1', '  New title  ').tabs).toEqual([
      { id: 'artifact-tab-1', type: 'artifact', artifactId: 'artifact-1', title: 'New title' },
      { id: 'artifact-tab-2', type: 'artifact', artifactId: 'artifact-2', title: 'Other title' },
    ])
    expect(renameArtifactInRightWorkspace(initial, 'artifact-1', '  ')).toBe(initial)
  })

  it('keeps file explorer UI state in the session-scoped payload', () => {
    const initial = createDefaultRightWorkspaceSession('new-1')
    const next = updateRightWorkspaceFileExplorer(initial, {
      visible: true,
      width: 310,
      expandedDirectories: ['chapters', 'chapters/part-1'],
      scrollTop: 72,
    })

    expect(next).toMatchObject({
      fileExplorerVisible: true,
      fileExplorerWidth: 310,
      expandedDirectories: ['chapters', 'chapters/part-1'],
      fileExplorerScrollTop: 72,
    })
  })

  it('uses separate workspace-global and workspace-session storage keys', () => {
    expect(getRightWorkspaceGlobalStorageKey('workspace-a')).toBe(
      'craft-right-workspace:global:workspace-a',
    )
    expect(getRightWorkspaceSessionStorageKey('workspace-a', 'session-1')).toBe(
      'craft-right-workspace:session:workspace-a:session-1',
    )
    expect(getRightWorkspaceSessionStorageKey('workspace-a', 'session-2')).not.toBe(
      getRightWorkspaceSessionStorageKey('workspace-a', 'session-1'),
    )
  })
})
