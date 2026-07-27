import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'

import {
  CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID,
  CONTENT_WORKSPACE_STATE_VERSION,
  closeContentWorkspaceTab,
  closeContentWorkspaceTabAtom,
  contentWorkspaceFileNavigationAtomFamily,
  contentWorkspaceStateAtomFamily,
  createDefaultContentWorkspaceState,
  getContentWorkspaceStorageKey,
  openBrowserInContentWorkspace,
  openContentWorkspaceBrowserAtom,
  openContentWorkspaceFileAtom,
  openFileInContentWorkspace,
  parsePersistedContentWorkspaceState,
  renameBrowserInContentWorkspace,
  showContentWorkspaceReferenceAtom,
} from '../content-workspace'

describe('content workspace state', () => {
  it('starts with one fixed Main Chat tab', () => {
    expect(createDefaultContentWorkspaceState()).toEqual({
      tabs: [{ id: CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID, type: 'chat', title: 'Main Chat' }],
      activeTabId: CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID,
    })
  })

  it('normalizes file paths and reuses an existing file tab', () => {
    const initial = createDefaultContentWorkspaceState()
    const opened = openFileInContentWorkspace(initial, './books\\os.epub', 'file-1')
    const reopened = openFileInContentWorkspace(opened, 'books/os.epub', 'file-2')

    expect(reopened.tabs).toEqual([
      { id: CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID, type: 'chat', title: 'Main Chat' },
      { id: 'file-1', type: 'file', path: 'books/os.epub', title: 'os.epub' },
    ])
    expect(reopened.activeTabId).toBe('file-1')
    expect(() => openFileInContentWorkspace(initial, '../secret.txt')).toThrow()
  })

  it('reuses browser instances and updates their titles', () => {
    const initial = createDefaultContentWorkspaceState()
    const opened = openBrowserInContentWorkspace(
      initial,
      { instanceId: 'browser-1', title: 'Course' },
      'browser-tab-1',
    )
    const reopened = openBrowserInContentWorkspace(opened, {
      instanceId: 'browser-1',
      title: 'Lecture 3',
    })

    expect(reopened.tabs).toEqual([
      { id: CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID, type: 'chat', title: 'Main Chat' },
      {
        id: 'browser-tab-1',
        type: 'browser',
        instanceId: 'browser-1',
        title: 'Lecture 3',
      },
    ])
    expect(renameBrowserInContentWorkspace(reopened, 'browser-1', 'Notes').tabs[1])
      .toMatchObject({ title: 'Notes' })
  })

  it('never closes Main Chat and chooses a neighbor after closing an active tab', () => {
    const withFile = openFileInContentWorkspace(
      createDefaultContentWorkspaceState(),
      'notes.md',
      'file-1',
    )

    expect(closeContentWorkspaceTab(withFile, CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID))
      .toBe(withFile)
    expect(closeContentWorkspaceTab(withFile, 'file-1')).toEqual(
      createDefaultContentWorkspaceState(),
    )
  })

  it('repairs persisted state and drops non-durable browser instances', () => {
    const restored = parsePersistedContentWorkspaceState({
      version: CONTENT_WORKSPACE_STATE_VERSION,
      tabs: [
        { id: 'old-chat', type: 'chat', title: 'Old' },
        { id: 'file-1', type: 'file', path: './book.epub', title: 'Old title' },
        { id: 'file-2', type: 'file', path: 'book.epub', title: 'Duplicate' },
        { id: 'browser-1', type: 'browser', instanceId: 'instance-1', title: 'Docs' },
        { id: 'browser-2', type: 'browser', instanceId: 'instance-1', title: 'Duplicate' },
      ],
      activeTabId: 'browser-1',
    })

    expect(restored.tabs).toEqual([
      { id: CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID, type: 'chat', title: 'Main Chat' },
      { id: 'file-1', type: 'file', path: 'book.epub', title: 'book.epub' },
    ])
    expect(restored.activeTabId).toBe(CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID)
  })

  it('uses a session-scoped storage key', () => {
    expect(getContentWorkspaceStorageKey({
      workspaceId: 'workspace-a',
      sessionId: 'session-1',
    })).toBe('stair-content-workspace:workspace-a:session-1')
    expect(getContentWorkspaceStorageKey({
      workspaceId: 'workspace-a',
      sessionId: 'session-2',
    })).not.toBe(getContentWorkspaceStorageKey({
      workspaceId: 'workspace-a',
      sessionId: 'session-1',
    }))
  })

  it('keeps file navigation per session and clears it for a normal file open', () => {
    const store = createStore()
    const key = { workspaceId: 'workspace-a', sessionId: 'session-1' }

    expect(store.set(showContentWorkspaceReferenceAtom, {
      ...key,
      reference: {
        projectId: 'project-1',
        path: 'books/os.epub',
        quote: 'process',
        locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/4!/4/2:0)' },
      },
    })).toBe(true)
    expect(store.get(contentWorkspaceFileNavigationAtomFamily(key))).toMatchObject({
      path: 'books/os.epub',
      locator: { type: 'epub-cfi' },
    })

    expect(store.set(openContentWorkspaceFileAtom, { ...key, path: 'books/os.epub' }))
      .toBe(true)
    expect(store.get(contentWorkspaceFileNavigationAtomFamily(key))).toBeNull()
  })

  it('isolates tab state and actions between sessions', () => {
    const store = createStore()
    const first = { workspaceId: 'workspace-a', sessionId: 'session-1' }
    const second = { workspaceId: 'workspace-a', sessionId: 'session-2' }

    expect(store.set(openContentWorkspaceBrowserAtom, {
      ...first,
      instanceId: 'browser-1',
      title: 'Course',
    })).toBe(true)
    expect(store.get(contentWorkspaceStateAtomFamily(first)).tabs).toHaveLength(2)
    expect(store.get(contentWorkspaceStateAtomFamily(second)).tabs).toHaveLength(1)

    const browserTab = store.get(contentWorkspaceStateAtomFamily(first)).tabs[1]
    expect(store.set(closeContentWorkspaceTabAtom, { ...first, tabId: browserTab.id }))
      .toBe(true)
    expect(store.get(contentWorkspaceStateAtomFamily(first)).tabs).toHaveLength(1)
  })
})
