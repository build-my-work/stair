import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { PersistedWorkbenchLayoutDocument } from '@craft-agent/shared/workbench-layout'
import {
  hydrateWorkbenchLayouts,
  restoreWorkbenchLayoutsAtom,
  serializeWorkbenchLayouts,
  workbenchPersistenceOperationsAtom,
} from '../workbench-persistence'
import {
  workbenchAtom,
  workbenchPersistenceReadyAtom,
  type WindowWorkbench,
} from '../workbench-state'
import {
  initializeWorkbenchAtom,
  showSessionInPrimaryAtom,
} from '../workbench-commands'

describe('Renderer Workbench persistence codec', () => {
  it('does not enable writes after a failed restore read', async () => {
    const store = createStore()
    store.set(initializeWorkbenchAtom, {
      workspaceId: 'workspace-a',
      defaultProjectId: 'project-a',
    })
    let attempts = 0
    store.set(workbenchPersistenceOperationsAtom, {
      read: async () => {
        attempts += 1
        throw new Error('transport unavailable')
      },
    })

    expect(await store.set(restoreWorkbenchLayoutsAtom, {
      workspaceId: 'workspace-a',
      defaultProjectId: 'project-a',
    })).toBe(false)
    expect(attempts).toBe(3)
    expect(store.get(workbenchPersistenceReadyAtom)).toBe(false)
  })

  it('restores Workspace layouts after startup navigation changes the active Project', async () => {
    const store = createStore()
    store.set(initializeWorkbenchAtom, {
      workspaceId: 'workspace-a',
      defaultProjectId: 'project-a',
    })
    const current = store.get(workbenchAtom)
    store.set(workbenchAtom, {
      ...current,
      activeProjectId: 'project-b',
      layoutsByProject: {
        ...current.layoutsByProject,
        'project-b': {
          primary: null,
          auxiliary: [],
          previewPanelId: null,
          focusedPanelId: null,
        },
      },
    })
    let attempts = 0
    store.set(workbenchPersistenceOperationsAtom, {
      read: async () => {
        attempts += 1
        return { version: 1, layoutsByProject: {} }
      },
    })

    expect(await store.set(restoreWorkbenchLayoutsAtom, {
      workspaceId: 'workspace-a',
      defaultProjectId: 'project-a',
    })).toBe(true)
    expect(attempts).toBe(1)
    expect(store.get(workbenchAtom).activeProjectId).toBe('project-b')
    expect(store.get(workbenchPersistenceReadyAtom)).toBe(true)
  })

  it('merges untouched persisted layouts around concurrent same-Workspace changes', async () => {
    const store = createStore()
    store.set(initializeWorkbenchAtom, {
      workspaceId: 'workspace-a',
      defaultProjectId: 'project-a',
    })
    let resolveRead!: (document: PersistedWorkbenchLayoutDocument) => void
    store.set(workbenchPersistenceOperationsAtom, {
      read: () => new Promise(resolve => { resolveRead = resolve }),
    })
    const restoring = store.set(restoreWorkbenchLayoutsAtom, {
      workspaceId: 'workspace-a',
      defaultProjectId: 'project-a',
    })
    store.set(showSessionInPrimaryAtom, {
      sessionId: 'session-created-while-loading',
      projectId: 'project-a',
    })
    resolveRead({
      version: 1,
      layoutsByProject: {
        'project-a': {
          primary: null,
          auxiliary: [{
            id: 'saved-file-a',
            kind: 'project-file',
            relativePath: 'saved-a.md',
            presentation: 'explicit',
            chatTargetSessionId: null,
            widthRatio: 1,
          }],
          previewPanelId: null,
          focusedPanelId: 'saved-file-a',
        },
        'project-b': {
          primary: null,
          auxiliary: [{
            id: 'saved-file-b',
            kind: 'project-file',
            relativePath: 'saved-b.md',
            presentation: 'explicit',
            chatTargetSessionId: null,
            widthRatio: 1,
          }],
          previewPanelId: null,
          focusedPanelId: 'saved-file-b',
        },
      },
    })

    expect(await restoring).toBe(true)
    const restored = store.get(workbenchAtom)
    expect(restored.layoutsByProject['project-a']?.primary?.sessionId)
      .toBe('session-created-while-loading')
    expect(restored.layoutsByProject['project-a']?.auxiliary[0]?.id).toBe('saved-file-a')
    expect(restored.layoutsByProject['project-b']?.auxiliary[0]?.id).toBe('saved-file-b')
    expect(store.get(workbenchPersistenceReadyAtom)).toBe(true)
  })

  it('drops a stale restore response after switching Workspace', async () => {
    const store = createStore()
    store.set(initializeWorkbenchAtom, {
      workspaceId: 'workspace-a',
      defaultProjectId: 'project-a',
    })
    let resolveWorkspaceA!: (document: PersistedWorkbenchLayoutDocument) => void
    store.set(workbenchPersistenceOperationsAtom, {
      read: () => new Promise(resolve => { resolveWorkspaceA = resolve }),
    })
    const restoringWorkspaceA = store.set(restoreWorkbenchLayoutsAtom, {
      workspaceId: 'workspace-a',
      defaultProjectId: 'project-a',
    })

    store.set(initializeWorkbenchAtom, {
      workspaceId: 'workspace-b',
      defaultProjectId: 'project-b',
    })

    resolveWorkspaceA({ version: 1, layoutsByProject: {} })
    expect(await restoringWorkspaceA).toBe(false)
    expect(store.get(workbenchPersistenceReadyAtom)).toBe(false)

    store.set(workbenchPersistenceOperationsAtom, {
      read: async () => ({
        version: 1,
        layoutsByProject: {
          'project-b': {
            primary: null,
            auxiliary: [{
              id: 'saved-file-b',
              kind: 'project-file',
              relativePath: 'saved-b.md',
              presentation: 'explicit',
              chatTargetSessionId: null,
              widthRatio: 1,
            }],
            previewPanelId: null,
            focusedPanelId: 'saved-file-b',
          },
        },
      }),
    })
    expect(await store.set(restoreWorkbenchLayoutsAtom, {
      workspaceId: 'workspace-b',
      defaultProjectId: 'project-b',
    })).toBe(true)

    const restored = store.get(workbenchAtom)
    expect(restored.workspaceId).toBe('workspace-b')
    expect(restored.layoutsByProject['project-b']?.auxiliary[0]?.id).toBe('saved-file-b')
    expect(store.get(workbenchPersistenceReadyAtom)).toBe(true)
  })

  it('retries a transient restore read before enabling persistence', async () => {
    const store = createStore()
    store.set(initializeWorkbenchAtom, {
      workspaceId: 'workspace-a',
      defaultProjectId: 'project-a',
    })
    let attempts = 0
    store.set(workbenchPersistenceOperationsAtom, {
      read: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('transport starting')
        return { version: 1, layoutsByProject: {} }
      },
    })

    expect(await store.set(restoreWorkbenchLayoutsAtom, {
      workspaceId: 'workspace-a',
      defaultProjectId: 'project-a',
    })).toBe(true)
    expect(attempts).toBe(2)
    expect(store.get(workbenchPersistenceReadyAtom)).toBe(true)
  })

  it('persists semantic layout only and reconstructs transient Browser state', () => {
    const state: WindowWorkbench = {
      workspaceId: 'workspace-a',
      activeProjectId: 'project-a',
      layoutsByProject: {
        'project-a': {
          primary: {
            id: 'session-panel-a',
            kind: 'session',
            sessionId: 'session-a',
            projectId: 'project-a',
            widthRatio: 2,
          },
          auxiliary: [{
            id: 'browser-panel-a',
            kind: 'browser',
            projectId: 'project-a',
            runtimeId: 'runtime-must-not-persist',
            url: 'https://example.com/',
            title: 'Example',
            chatTargetSessionId: 'session-a',
            widthRatio: 1,
            restoreOnActivation: false,
          }, {
            id: 'file-panel-a',
            kind: 'project-file',
            projectId: 'project-a',
            relativePath: 'docs/a.md',
            presentation: 'explicit',
            chatTargetSessionId: 'session-a',
            openIntent: {
              expectedFingerprint: `sha256:${'a'.repeat(64)}`,
              locator: { type: 'text-quote', exact: 'selected text', start: 0, end: 13 },
            },
            openIntentRevision: 7,
            widthRatio: 1,
          }],
          previewPanelId: null,
          focusedPanelId: 'browser-panel-a',
        },
      },
    }

    const serialized = serializeWorkbenchLayouts(state)
    expect(JSON.stringify(serialized)).not.toContain('runtime-must-not-persist')
    expect(JSON.stringify(serialized)).not.toContain('openIntent')

    expect(hydrateWorkbenchLayouts(serialized)).toEqual({
      'project-a': {
        primary: state.layoutsByProject['project-a']!.primary,
        auxiliary: [{
          id: 'browser-panel-a',
          kind: 'browser',
          projectId: 'project-a',
          runtimeId: null,
          url: 'https://example.com/',
          title: 'Example',
          chatTargetSessionId: 'session-a',
          widthRatio: 1,
          restoreOnActivation: true,
        }, {
          id: 'file-panel-a',
          kind: 'project-file',
          projectId: 'project-a',
          relativePath: 'docs/a.md',
          presentation: 'explicit',
          chatTargetSessionId: 'session-a',
          openIntent: undefined,
          openIntentRevision: 0,
          widthRatio: 1,
        }],
        previewPanelId: null,
        focusedPanelId: 'browser-panel-a',
      },
    })
  })

  it('hydrates every persisted Project independently', () => {
    const document: PersistedWorkbenchLayoutDocument = {
      version: 1,
      layoutsByProject: {
        'project-a': {
          primary: null,
          auxiliary: [],
          previewPanelId: null,
          focusedPanelId: null,
        },
        'project-b': {
          primary: null,
          auxiliary: [{
            id: 'file-b',
            kind: 'project-file',
            relativePath: 'b.md',
            presentation: 'explicit',
            chatTargetSessionId: null,
            widthRatio: 1,
          }],
          previewPanelId: null,
          focusedPanelId: 'file-b',
        },
      },
    }

    expect(Object.keys(hydrateWorkbenchLayouts(document))).toEqual(['project-a', 'project-b'])
  })
})
