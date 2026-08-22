import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  activeProjectWorkbenchAtom,
  workbenchAtom,
  workbenchKeyboardFocusRevisionAtom,
  workbenchPanelRevealRevisionAtom,
  workbenchPanelsAtom,
} from '../workbench-state'
import type { WorkbenchPanel } from '../workbench-state'
import {
  closeWorkbenchPanelAtom,
  focusNextWorkbenchPanelAtom,
  focusPreviousWorkbenchPanelAtom,
  focusWorkbenchPanelAtom,
  initializeWorkbenchAtom,
  openSessionFromProjectFileAtom,
  openSessionInNewPanelAtom,
  openProjectFileInPanelAtom,
  openProjectFilePreviewAtom,
  reorderAuxiliaryPanelAtom,
  removeSessionFromWorkbenchAtom,
  resizeWorkbenchPanelAtom,
  setProjectFileChatTargetAtom,
  selectSessionFromNavigatorAtom,
  showSessionInPrimaryAtom,
  switchWorkbenchProjectAtom,
} from '../workbench-commands'
import {
  registerOpenProjectFileDocument,
} from '@/components/project-files/project-file-document-registry'

function initializedStore() {
  const store = createStore()
  expect(store.set(initializeWorkbenchAtom, {
    workspaceId: 'workspace-a',
    defaultProjectId: 'project-a',
  })).toBe(true)
  return store
}

function sessionIds(store: ReturnType<typeof createStore>) {
  const layout = store.get(activeProjectWorkbenchAtom)
  return {
    primary: layout?.primary?.sessionId ?? null,
    auxiliary: layout?.auxiliary.flatMap(panel => panel.kind === 'session' ? [panel.sessionId] : []) ?? [],
    focusedPanelId: layout?.focusedPanelId ?? null,
  }
}

function isSessionPanel(panel: WorkbenchPanel): panel is Extract<WorkbenchPanel, { kind: 'session' }> {
  return panel.kind === 'session'
}

function projectFilePanel(
  store: ReturnType<typeof createStore>,
  relativePath: string,
): Extract<WorkbenchPanel, { kind: 'project-file' }> {
  const panel = store.get(activeProjectWorkbenchAtom)?.auxiliary.find(candidate => (
    candidate.kind === 'project-file' && candidate.relativePath === relativePath
  ))
  expect(panel?.kind).toBe('project-file')
  return panel as Extract<WorkbenchPanel, { kind: 'project-file' }>
}

describe('Session-only Workbench commands', () => {
  it('initializes one empty default-Project layout', () => {
    const store = initializedStore()

    expect(store.get(workbenchAtom)).toEqual({
      workspaceId: 'workspace-a',
      activeProjectId: 'project-a',
      layoutsByProject: {
        'project-a': {
          primary: null,
          auxiliary: [],
          previewPanelId: null,
          focusedPanelId: null,
        },
      },
    })
  })

  it('resizes only one Panel without changing neighboring ratios, order, or Focus', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-c', projectId: 'project-a' })
    const before = store.get(workbenchPanelsAtom)
    const focusedPanelId = store.get(activeProjectWorkbenchAtom)!.focusedPanelId

    expect(store.set(resizeWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: before[0]!.id,
      widthRatio: 1.5,
    })).toBe(true)

    const after = store.get(workbenchPanelsAtom)
    expect(after.map(panel => panel.id)).toEqual(before.map(panel => panel.id))
    expect(after.map(panel => panel.widthRatio)).toEqual([1.5, 1, 1])
    expect(store.get(activeProjectWorkbenchAtom)!.focusedPanelId).toBe(focusedPanelId)

    expect(store.set(resizeWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: 'missing',
      widthRatio: 1,
    })).toBe(false)
  })

  it('reorders only Auxiliary Panels and preserves Primary and Focus', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-b', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-c', projectId: 'project-a' })
    const layout = store.get(activeProjectWorkbenchAtom)!
    const focusedPanelId = layout.focusedPanelId

    expect(store.set(reorderAuxiliaryPanelAtom, {
      projectId: 'project-a',
      panelId: layout.auxiliary[2]!.id,
      toIndex: 0,
    })).toBe(true)

    const reordered = store.get(activeProjectWorkbenchAtom)!
    expect(reordered.primary?.sessionId).toBe('primary')
    expect(reordered.auxiliary.filter(isSessionPanel).map(panel => panel.sessionId))
      .toEqual(['aux-c', 'aux-a', 'aux-b'])
    expect(reordered.focusedPanelId).toBe(focusedPanelId)

    expect(store.set(reorderAuxiliaryPanelAtom, {
      projectId: 'project-a',
      panelId: reordered.primary!.id,
      toIndex: 0,
    })).toBe(false)
  })

  it('ordinary selection replaces Primary and never grows Auxiliary', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })

    const beforeAuxiliary = store.get(activeProjectWorkbenchAtom)!.auxiliary.length
    expect(await store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-c',
      projectId: 'project-a',
    })).toBe(true)

    expect(sessionIds(store)).toMatchObject({
      primary: 'session-c',
      auxiliary: ['session-b'],
    })
    expect(store.get(activeProjectWorkbenchAtom)!.auxiliary.length).toBe(beforeAuxiliary)
  })

  it('ordinary selection focuses an already-visible Session without duplication', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const before = store.get(workbenchPanelsAtom)
    const target = before.find(panel => isSessionPanel(panel) && panel.sessionId === 'session-a')!

    expect(await store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-a',
      projectId: 'project-a',
    })).toBe(true)

    expect(store.get(workbenchPanelsAtom)).toEqual(before)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(target.id)
  })

  it('requests reveal every time Navigator selects an already-visible Session', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const target = store.get(workbenchPanelsAtom).find(panel => (
      isSessionPanel(panel) && panel.sessionId === 'session-b'
    ))!
    const before = store.get(workbenchPanelRevealRevisionAtom)

    expect(await store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(target.id)
    expect(store.get(workbenchPanelRevealRevisionAtom)).toBe(before + 1)

    expect(await store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(true)
    expect(store.get(workbenchPanelRevealRevisionAtom)).toBe(before + 2)
  })

  it('cross-Project ordinary selection parks the current layout and restores it later', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const projectASnapshot = structuredClone(store.get(activeProjectWorkbenchAtom))

    expect(await store.set(selectSessionFromNavigatorAtom, {
      sessionId: 'session-c',
      projectId: 'project-b',
    })).toBe(true)
    expect(store.get(workbenchAtom).activeProjectId).toBe('project-b')
    expect(sessionIds(store)).toMatchObject({ primary: 'session-c', auxiliary: [] })

    expect(await store.set(switchWorkbenchProjectAtom, { projectId: 'project-a' })).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)).toEqual(projectASnapshot)
  })

  it('Primary creation commits only into the active Project and keeps Aux delta zero', () => {
    const store = initializedStore()
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-a', projectId: 'project-a' })
    const before = structuredClone(store.get(workbenchAtom))

    expect(store.set(showSessionInPrimaryAtom, {
      sessionId: 'wrong-project',
      projectId: 'project-b',
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)

    expect(store.set(showSessionInPrimaryAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(true)
    expect(sessionIds(store)).toMatchObject({ primary: 'session-b', auxiliary: ['session-a'] })
  })

  it('explicit new Panel inserts after focus and grows Auxiliary exactly once', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    const source = store.get(workbenchPanelsAtom).find(panel => (
      isSessionPanel(panel) && panel.sessionId === 'session-b'
    ))!
    store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId: source.id })

    const beforeCount = store.get(activeProjectWorkbenchAtom)!.auxiliary.length
    expect(store.set(openSessionInNewPanelAtom, {
      sessionId: 'session-c',
      projectId: 'project-a',
    })).toBe(true)

    expect(sessionIds(store)).toMatchObject({
      primary: 'session-a',
      auxiliary: ['session-b', 'session-c'],
    })
    expect(store.get(activeProjectWorkbenchAtom)!.auxiliary.length).toBe(beforeCount + 1)
  })

  it('explicit new Panel with no focus starts at Auxiliary index zero', () => {
    const store = initializedStore()

    expect(store.set(openSessionInNewPanelAtom, {
      sessionId: 'session-a',
      projectId: 'project-a',
    })).toBe(true)
    expect(sessionIds(store)).toMatchObject({ primary: null, auxiliary: ['session-a'] })
  })

  it('branch placement inserts after its visible source and preserves the source', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'source-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'source-b', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'tail', projectId: 'project-a' })

    expect(store.set(openSessionInNewPanelAtom, {
      sessionId: 'branch',
      projectId: 'project-a',
      afterSessionId: 'source-b',
    })).toBe(true)
    expect(sessionIds(store)).toMatchObject({
      primary: 'source-a',
      auxiliary: ['source-b', 'branch', 'tail'],
    })
  })

  it('rejects focus and explicit Panel mutation against a parked Project', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    const panelId = store.get(workbenchPanelsAtom)[0].id
    await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })
    const before = structuredClone(store.get(workbenchAtom))

    expect(store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId })).toBe(false)
    expect(store.set(openSessionInNewPanelAtom, {
      sessionId: 'session-b',
      projectId: 'project-a',
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)
  })

  it('closing Primary leaves it null and focuses the Panel to its right', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-b', projectId: 'project-a' })
    const primary = store.get(workbenchPanelsAtom)[0]
    store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId: primary.id })

    expect(await store.set(closeWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: primary.id,
    })).toBe(true)
    const layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.primary).toBeNull()
    expect(layout.auxiliary.filter(isSessionPanel).map(panel => panel.sessionId)).toEqual(['aux-a', 'aux-b'])
    expect(layout.focusedPanelId).toBe(layout.auxiliary[0].id)
  })

  it('closing focused Auxiliary falls back right, then left, then Primary', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-b', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-c', projectId: 'project-a' })

    let layout = store.get(activeProjectWorkbenchAtom)!
    store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[1].id })
    await store.set(closeWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[1].id })
    layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.auxiliary.filter(isSessionPanel).map(panel => panel.sessionId)).toEqual(['aux-a', 'aux-c'])
    expect(layout.focusedPanelId).toBe(layout.auxiliary[1].id)

    await store.set(closeWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[1].id })
    layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.focusedPanelId).toBe(layout.auxiliary[0].id)

    await store.set(closeWorkbenchPanelAtom, { projectId: 'project-a', panelId: layout.auxiliary[0].id })
    layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.focusedPanelId).toBe(layout.primary?.id ?? null)
  })

  it('cycles focus forward and backward through Primary and ordered Auxiliary panels', () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'aux-b', projectId: 'project-a' })
    const panels = store.get(workbenchPanelsAtom)
    store.set(focusWorkbenchPanelAtom, { projectId: 'project-a', panelId: panels[0].id })
    const beforeRevision = store.get(workbenchKeyboardFocusRevisionAtom)

    expect(store.set(focusNextWorkbenchPanelAtom)).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(panels[1].id)
    expect(store.set(focusPreviousWorkbenchPanelAtom)).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(panels[0].id)
    expect(store.set(focusPreviousWorkbenchPanelAtom)).toBe(true)
    expect(store.get(activeProjectWorkbenchAtom)?.focusedPanelId).toBe(panels[2].id)
    expect(store.get(workbenchKeyboardFocusRevisionAtom)).toBe(beforeRevision + 3)
  })

  it('removes a deleted Session from its parked Project without switching Project', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'session-a', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'session-b', projectId: 'project-a' })
    await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })

    expect(store.set(removeSessionFromWorkbenchAtom, 'session-a')).toBe(true)
    expect(store.get(workbenchAtom).activeProjectId).toBe('project-b')
    expect(store.get(workbenchAtom).layoutsByProject['project-a'].primary).toBeNull()
    const remaining = store.get(workbenchAtom).layoutsByProject['project-a'].auxiliary[0]
    expect(remaining.kind === 'session' ? remaining.sessionId : null).toBe('session-b')
  })
})

describe('Project File Workbench commands', () => {
  it('只设置同 Project Chat Target，不修改 Panel 展示、顺序或 Focus', async () => {
    const store = initializedStore()
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/one.md',
    })
    const before = structuredClone(store.get(activeProjectWorkbenchAtom)!)
    const panel = before.auxiliary.find(candidate => candidate.kind === 'project-file')!

    expect(store.set(setProjectFileChatTargetAtom, {
      panelId: panel.id,
      projectId: 'project-a',
      sessionId: 'session-a',
      sessionProjectId: 'project-a',
    })).toBe(true)
    const next = store.get(activeProjectWorkbenchAtom)!
    expect(next.primary).toEqual(before.primary)
    expect(next.auxiliary.map(candidate => candidate.id))
      .toEqual(before.auxiliary.map(candidate => candidate.id))
    expect(next.focusedPanelId).toBe(before.focusedPanelId)
    expect(next.auxiliary.find(candidate => candidate.id === panel.id))
      .toEqual(expect.objectContaining({ chatTargetSessionId: 'session-a' }))

    const accepted = structuredClone(store.get(workbenchAtom))
    expect(store.set(setProjectFileChatTargetAtom, {
      panelId: panel.id,
      projectId: 'project-a',
      sessionId: 'session-b',
      sessionProjectId: 'project-b',
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(accepted)
  })

  it('New Chat 等待期间焦点切到其他 Panel，仍紧邻来源文件 Panel 原子提交', async () => {
    const store = initializedStore()
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/source.md',
    })
    const source = projectFilePanel(store, 'docs/source.md')
    store.set(openSessionInNewPanelAtom, {
      sessionId: 'focused-elsewhere',
      projectId: 'project-a',
    })

    expect(store.set(openSessionFromProjectFileAtom, {
      sessionId: 'new-session',
      sessionProjectId: 'project-a',
      source: {
        panelId: source.id,
        projectId: 'project-a',
        relativePath: 'docs/source.md',
      },
    })).toBe(true)

    const layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.auxiliary.map(panel => (
      panel.kind === 'session'
        ? `session:${panel.sessionId}`
        : panel.kind === 'project-file'
          ? `file:${panel.relativePath}`
          : `browser:${panel.runtimeId}`
    ))).toEqual([
      'file:docs/source.md',
      'session:new-session',
      'session:focused-elsewhere',
    ])
    expect(projectFilePanel(store, 'docs/source.md').chatTargetSessionId).toBe('new-session')
    expect(layout.focusedPanelId).toBe(layout.auxiliary[1].id)
  })

  it('New Chat 等待期间 Preview 被替换时拒绝提交且不修改新文件 target', async () => {
    const store = initializedStore()
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/source.md',
    })
    const source = projectFilePanel(store, 'docs/source.md')
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/replacement.md',
    })
    const before = structuredClone(store.get(workbenchAtom))

    expect(store.set(openSessionFromProjectFileAtom, {
      sessionId: 'new-session',
      sessionProjectId: 'project-a',
      source: {
        panelId: source.id,
        projectId: 'project-a',
        relativePath: 'docs/source.md',
      },
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)
    expect(projectFilePanel(store, 'docs/replacement.md').chatTargetSessionId).toBeNull()
  })

  it('New Chat 等待期间来源 Panel 被关闭时拒绝提交且不残留 Session Panel', async () => {
    const store = initializedStore()
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/source.md',
    })
    const source = projectFilePanel(store, 'docs/source.md')
    expect(await store.set(closeWorkbenchPanelAtom, {
      projectId: 'project-a',
      panelId: source.id,
    })).toBe(true)
    const before = structuredClone(store.get(workbenchAtom))

    expect(store.set(openSessionFromProjectFileAtom, {
      sessionId: 'new-session',
      sessionProjectId: 'project-a',
      source: {
        panelId: source.id,
        projectId: 'project-a',
        relativePath: 'docs/source.md',
      },
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)
    expect(store.get(workbenchPanelsAtom).some(panel => (
      panel.kind === 'session' && panel.sessionId === 'new-session'
    ))).toBe(false)
  })

  it('New Chat 等待期间切换 Project 时拒绝写入当前或 parked layout', async () => {
    const store = initializedStore()
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/source.md',
    })
    const source = projectFilePanel(store, 'docs/source.md')
    expect(await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })).toBe(true)
    const before = structuredClone(store.get(workbenchAtom))

    expect(store.set(openSessionFromProjectFileAtom, {
      sessionId: 'new-session',
      sessionProjectId: 'project-a',
      source: {
        panelId: source.id,
        projectId: 'project-a',
        relativePath: 'docs/source.md',
      },
    })).toBe(false)
    expect(store.get(workbenchAtom)).toEqual(before)
    const parkedSource = store.get(workbenchAtom).layoutsByProject['project-a'].auxiliary[0]
    expect(parkedSource).toEqual(expect.objectContaining({ chatTargetSessionId: null }))
  })

  it('点击消息引用复用当前文件 Panel，并传递 locator 而不增加 Panel', async () => {
    const store = initializedStore()
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'book.epub',
    })
    const before = structuredClone(store.get(activeProjectWorkbenchAtom)!)
    const beforeReveal = store.get(workbenchPanelRevealRevisionAtom)

    expect(await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'book.epub',
      openIntent: {
        expectedFingerprint: `sha256:${'c'.repeat(64)}`,
        locator: {
          type: 'epub-cfi',
          cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:7)',
        },
      },
    })).toBe(true)

    const next = store.get(activeProjectWorkbenchAtom)!
    expect(next.auxiliary).toHaveLength(before.auxiliary.length)
    expect(next.auxiliary[0]).toEqual(expect.objectContaining({
      openIntent: expect.objectContaining({
        locator: expect.objectContaining({ type: 'epub-cfi' }),
      }),
    }))
    expect(store.get(workbenchPanelRevealRevisionAtom)).toBe(beforeReveal + 1)
  })

  it('重复点击同一文件 locator 也递增 Panel 内的 reveal 意图版本', async () => {
    const store = initializedStore()
    const openIntent = {
      expectedFingerprint: `sha256:${'c'.repeat(64)}` as const,
      locator: {
        type: 'text-quote' as const,
        exact: 'same quote',
        start: 0,
        end: 10,
      },
    }
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'notes.md',
      openIntent,
    })
    const first = store.get(activeProjectWorkbenchAtom)!.auxiliary[0]
    expect(first).toEqual(expect.objectContaining({ openIntentRevision: 1 }))

    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'notes.md',
      openIntent,
    })
    const second = store.get(activeProjectWorkbenchAtom)!.auxiliary[0]
    expect(second).toEqual(expect.objectContaining({
      id: first?.id,
      openIntentRevision: 2,
    }))
  })

  it('复用唯一 Preview，不修改 Primary 或显式 Auxiliary', async () => {
    const store = initializedStore()
    store.set(showSessionInPrimaryAtom, { sessionId: 'primary', projectId: 'project-a' })
    store.set(openSessionInNewPanelAtom, { sessionId: 'explicit-session', projectId: 'project-a' })

    expect(await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/one.md',
    })).toBe(true)
    const first = structuredClone(store.get(activeProjectWorkbenchAtom)!)
    let flushCount = 0
    const unregister = registerOpenProjectFileDocument('project-a', 'docs/one.md', {
      flush: async () => { flushCount += 1 },
    })

    try {
      expect(await store.set(openProjectFilePreviewAtom, {
        projectId: 'project-a',
        relativePath: 'docs/two.md',
      })).toBe(true)
    } finally {
      unregister()
    }

    const next = store.get(activeProjectWorkbenchAtom)!
    expect(flushCount).toBe(1)
    expect(next.primary).toEqual(first.primary)
    expect(next.auxiliary).toHaveLength(first.auxiliary.length)
    expect(next.auxiliary.filter(panel => panel.kind === 'session'))
      .toEqual(first.auxiliary.filter(panel => panel.kind === 'session'))
    expect(next.auxiliary.filter(panel => panel.kind === 'project-file')).toEqual([
      expect.objectContaining({
        relativePath: 'docs/two.md',
        presentation: 'preview',
      }),
    ])
  })

  it('显式打开总是使用持久 Auxiliary，不占用 Preview', async () => {
    const store = initializedStore()
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/one.md',
    })
    const previewId = store.get(activeProjectWorkbenchAtom)!.previewPanelId

    expect(store.set(openProjectFileInPanelAtom, {
      projectId: 'project-a',
      relativePath: 'docs/one.md',
    })).toBe(true)
    const layout = store.get(activeProjectWorkbenchAtom)!
    expect(layout.previewPanelId).toBe(previewId)
    expect(layout.auxiliary.filter(panel => panel.kind === 'project-file')).toEqual([
      expect.objectContaining({ presentation: 'preview' }),
      expect.objectContaining({ presentation: 'explicit' }),
    ])
  })

  it('flush 失败时拒绝替换 Preview、关闭 Panel 和切换 Project', async () => {
    const store = initializedStore()
    await store.set(openProjectFilePreviewAtom, {
      projectId: 'project-a',
      relativePath: 'docs/dirty.md',
    })
    const before = structuredClone(store.get(workbenchAtom))
    const previewId = store.get(activeProjectWorkbenchAtom)!.previewPanelId!
    const unregister = registerOpenProjectFileDocument('project-a', 'docs/dirty.md', {
      flush: async () => { throw new Error('save failed') },
    })

    try {
      expect(await store.set(openProjectFilePreviewAtom, {
        projectId: 'project-a',
        relativePath: 'docs/next.md',
      })).toBe(false)
      expect(store.get(workbenchAtom)).toEqual(before)

      expect(await store.set(closeWorkbenchPanelAtom, {
        projectId: 'project-a',
        panelId: previewId,
      })).toBe(false)
      expect(store.get(workbenchAtom)).toEqual(before)

      expect(await store.set(switchWorkbenchProjectAtom, { projectId: 'project-b' })).toBe(false)
      expect(store.get(workbenchAtom)).toEqual(before)
    } finally {
      unregister()
    }
  })
})
