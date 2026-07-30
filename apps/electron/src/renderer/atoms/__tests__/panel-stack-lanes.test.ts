import { describe, expect, it } from 'bun:test'
import { createStore as createJotaiStore } from 'jotai'
import {
  backFromCompanionPanelAtom,
  closePanelAtom,
  consumeProjectFileOpenIntentAtom,
  focusedPanelIdAtom,
  focusedSessionIdAtom,
  getPanelOwnerPanelId,
  openOrFocusBrowserPanelAtom,
  openOrReuseProjectFileAtom,
  panelStackAtom,
  panelViewportWidthAtom,
  projectFileOpenIntentsAtom,
  parseSessionIdFromRoute,
  pushPanelAtom,
  reorderPanelAtom,
  resizePanelAtom,
  restorePanelLayoutAtom,
  setCompanionChatTargetAtom,
  updateFocusedPanelRouteAtom,
  visibleSessionIdsAtom,
  type PanelStackEntry,
} from '../panel-stack'
import {
  deserializePanelLayout,
  serializePanelLayout,
} from '../../lib/panel-layout-codec'
import { updatePanelLayoutSearchParam } from '../../contexts/navigation-history'
import type { ViewRoute } from '../../../shared/routes'

const PANEL_VIEWPORT_WIDTH = 1_200
const DEFAULT_WIDTH_RATIO = 560 / PANEL_VIEWPORT_WIDTH
const EPUB_WIDTH_RATIO = 840 / PANEL_VIEWPORT_WIDTH

function createStore() {
  const store = createJotaiStore()
  store.set(panelViewportWidthAtom, PANEL_VIEWPORT_WIDTH)
  return store
}

function getStack(store: ReturnType<typeof createStore>): PanelStackEntry[] {
  return store.get(panelStackAtom)
}

function viewRoutes(store: ReturnType<typeof createStore>): Array<ViewRoute | string> {
  return getStack(store).map((entry) => {
    switch (entry.route.kind) {
      case 'navigation':
        return entry.route.viewRoute
      case 'projectFile':
        return entry.route.relativePath
      case 'browser':
        return entry.route.browserId
    }
  })
}

function openProjectFile(
  store: ReturnType<typeof createStore>,
  ownerPanelId: string | undefined,
  relativePath: string,
  contextRoute: ViewRoute = 'allSessions/session/s1',
) {
  store.set(openOrReuseProjectFileAtom, {
    ownerPanelId,
    projectId: 'project-1',
    relativePath,
    contextRoute,
  })
}

describe('panel stack content routes', () => {
  it('treats project-session routes as Session panels', () => {
    const route = 'projects/project/os/session/s1'
    expect(parseSessionIdFromRoute(route)).toBe('s1')

    const store = createStore()
    store.set(pushPanelAtom, { route })
    expect(store.get(focusedSessionIdAtom)).toBe('s1')
  })

  it('does not mistake a project slug named session for a Session route', () => {
    expect(parseSessionIdFromRoute('projects/project/session')).toBeNull()
  })

  it('stores ordinary navigation as a discriminated content route', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'sources/source/github' })
    store.set(pushPanelAtom, { route: 'settings' })

    expect(getStack(store).map(panel => panel.route)).toEqual([
      { kind: 'navigation', viewRoute: 'allSessions/session/s1' },
      { kind: 'navigation', viewRoute: 'sources/source/github' },
      { kind: 'navigation', viewRoute: 'settings' },
    ])
  })

  it('reuses a Session panel and rebases its companion to the requested route', () => {
    const store = createStore()
    store.set(pushPanelAtom, {
      route: 'allSessions/session/s1',
    })
    const sessionPanelId = getStack(store)[0].id
    openProjectFile(store, sessionPanelId, 'book.epub')

    const reusedPanelId = store.set(pushPanelAtom, {
      route: 'projects/project/os/session/s1',
    })

    expect(reusedPanelId).toBe(sessionPanelId)
    const stack = getStack(store)
    expect(stack).toHaveLength(2)
    expect(stack.map(panel => panel.route)).toEqual([
      {
        kind: 'navigation',
        viewRoute: 'projects/project/os/session/s1',
      },
      {
        kind: 'projectFile',
        projectId: 'project-1',
        relativePath: 'book.epub',
        contextRoute: 'projects/project/os/session/s1',
      },
    ])
    expect(store.get(focusedPanelIdAtom)).toBe(sessionPanelId)
  })

  it('assigns independent defaults without resizing existing panels', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const owner = getStack(store)[0]

    openProjectFile(store, owner.id, 'book.epub')

    expect(getStack(store).map(panel => panel.widthRatio)).toEqual([
      DEFAULT_WIDTH_RATIO,
      EPUB_WIDTH_RATIO,
    ])
  })

  it('resizes only the target Panel without normalizing its neighbors', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const owner = getStack(store)[0]
    openProjectFile(store, owner.id, 'book.epub')

    store.set(resizePanelAtom, {
      panelId: owner.id,
      widthRatio: 0.75,
    })

    expect(getStack(store).map(panel => panel.widthRatio)).toEqual([
      0.75,
      EPUB_WIDTH_RATIO,
    ])
    expect(
      getStack(store).reduce((sum, panel) => sum + panel.widthRatio, 0),
    ).toBeGreaterThan(1)
  })

  it('reorders panels without changing focus, width, or owner identity and restores that order', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })
    const [owner, secondSession] = getStack(store)
    openProjectFile(store, owner.id, 'book.epub')
    const file = getStack(store)[1]
    store.set(resizePanelAtom, {
      panelId: file.id,
      widthRatio: 0.81,
    })
    store.set(focusedPanelIdAtom, file.id)

    expect(store.set(reorderPanelAtom, {
      panelId: owner.id,
      overPanelId: secondSession.id,
    })).toBe(true)

    const reordered = getStack(store)
    expect(reordered.map(panel => panel.id)).toEqual([
      file.id,
      secondSession.id,
      owner.id,
    ])
    expect(reordered.find(panel => panel.id === file.id)).toMatchObject({
      ownerPanelId: owner.id,
      widthRatio: 0.81,
    })
    expect(store.get(focusedPanelIdAtom)).toBe(file.id)

    const layout = deserializePanelLayout(serializePanelLayout(
      reordered,
      store.get(focusedPanelIdAtom),
    )!)
    const restoredStore = createStore()
    restoredStore.set(restorePanelLayoutAtom, layout!)

    expect(viewRoutes(restoredStore)).toEqual([
      'book.epub',
      'allSessions/session/s2',
      'allSessions/session/s1',
    ])
    const [restoredFile, , restoredOwner] = getStack(restoredStore)
    expect(restoredFile).toMatchObject({
      ownerPanelId: restoredOwner.id,
      widthRatio: 0.81,
    })
    expect(restoredStore.get(focusedPanelIdAtom)).toBe(restoredFile.id)
  })

  it('ignores panel reorder requests with missing or identical targets', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })
    const stack = getStack(store)

    expect(store.set(reorderPanelAtom, {
      panelId: stack[0].id,
      overPanelId: stack[0].id,
    })).toBe(false)
    expect(store.set(reorderPanelAtom, {
      panelId: stack[0].id,
      overPanelId: 'missing',
    })).toBe(false)
    expect(getStack(store)).toBe(stack)
  })

  it('does not rewrite ratios when the PanelStack viewport changes', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const before = getStack(store).map(panel => panel.widthRatio)

    store.set(panelViewportWidthAtom, 1_600)

    expect(getStack(store).map(panel => panel.widthRatio)).toEqual(before)
  })

  it('updates the focused panel with a navigation route', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'sources/source/github' })
    const sourcePanel = getStack(store)[1]
    store.set(focusedPanelIdAtom, sourcePanel.id)

    store.set(updateFocusedPanelRouteAtom, 'allSessions/session/s2')

    expect(viewRoutes(store)).toEqual([
      'allSessions/session/s1',
      'allSessions/session/s2',
    ])
  })

  it('focuses an existing Session instead of replacing the focused panel', () => {
    const store = createStore()
    store.set(pushPanelAtom, {
      route: 'allSessions/session/s1',
    })
    const sessionPanelId = getStack(store)[0].id
    store.set(pushPanelAtom, { route: 'sources/source/github' })

    store.set(
      updateFocusedPanelRouteAtom,
      'projects/project/os/session/s1',
    )

    expect(viewRoutes(store)).toEqual([
      'projects/project/os/session/s1',
      'sources/source/github',
    ])
    expect(store.get(focusedPanelIdAtom)).toBe(sessionPanelId)
  })

  it('opens a Project File immediately after its physical owner', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })
    const owner = getStack(store)[0]

    openProjectFile(store, owner.id, 'src/index.ts')

    const stack = getStack(store)
    expect(viewRoutes(store)).toEqual([
      'allSessions/session/s1',
      'src/index.ts',
      'allSessions/session/s2',
    ])
    expect(stack[1].route).toEqual({
      kind: 'projectFile',
      projectId: 'project-1',
      relativePath: 'src/index.ts',
      contextRoute: 'allSessions/session/s1',
    })
    expect(stack[1].ownerPanelId).toBe(owner.id)
    expect(store.get(focusedPanelIdAtom)).toBe(stack[1].id)
  })

  it('serializes and restores a newly opened Project File with owner and focus', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'projects/project/os/session/s1' })
    const owner = getStack(store)[0]

    openProjectFile(
      store,
      owner.id,
      '书籍/操作系统导论.epub',
      'projects/project/os/session/s1',
    )
    const openedFile = getStack(store)[1]
    store.set(setCompanionChatTargetAtom, {
      panelId: openedFile.id,
      sessionId: 'session-2',
    })

    const stack = getStack(store)
    const focusedPanelId = store.get(focusedPanelIdAtom)
    const encoded = serializePanelLayout(stack, focusedPanelId)
    const searchParams = new URLSearchParams('ws=my-workspace')
    const urlLayout = updatePanelLayoutSearchParam(
      searchParams,
      stack,
      focusedPanelId,
    )
    const layout = deserializePanelLayout(
      searchParams.get('layout')!,
    )

    expect(stack.map(panel => panel.widthRatio)).toEqual([
      DEFAULT_WIDTH_RATIO,
      EPUB_WIDTH_RATIO,
    ])
    expect(encoded).not.toBeNull()
    expect(urlLayout).toBe(encoded)
    expect(searchParams.get('ws')).toBe('my-workspace')
    expect(layout).toMatchObject({
      version: 2,
      entries: [
        {
          key: 'p0',
          route: {
            kind: 'navigation',
            viewRoute: 'projects/project/os/session/s1',
          },
        },
        {
          key: 'p1',
          route: {
            kind: 'projectFile',
            projectId: 'project-1',
            relativePath: '书籍/操作系统导论.epub',
            contextRoute: 'projects/project/os/session/s1',
          },
          ownerKey: 'p0',
          chatTargetSessionId: 'session-2',
        },
      ],
      focusedKey: 'p1',
    })

    const restoredStore = createStore()
    restoredStore.set(restorePanelLayoutAtom, layout!)
    const [restoredOwner, restoredFile] = getStack(restoredStore)
    expect(restoredFile.ownerPanelId).toBe(restoredOwner.id)
    expect(restoredFile.chatTargetSessionId).toBe('session-2')
    expect(restoredStore.get(focusedPanelIdAtom)).toBe(restoredFile.id)
  })

  it('reuses the Project File companion for the same physical owner', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const owner = getStack(store)[0]
    openProjectFile(store, owner.id, 'src/first.ts')
    const companionId = getStack(store)[1].id
    store.set(setCompanionChatTargetAtom, {
      panelId: companionId,
      sessionId: 'session-2',
    })

    openProjectFile(store, owner.id, 'src/second.ts')

    const stack = getStack(store)
    expect(stack).toHaveLength(2)
    expect(stack[1].id).toBe(companionId)
    expect(stack[1].route.kind).toBe('projectFile')
    expect(stack[1].chatTargetSessionId).toBeUndefined()
    expect(viewRoutes(store)[1]).toBe('src/second.ts')
  })

  it('keeps reopen intent runtime-only and consumes it exactly once', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const owner = getStack(store)[0]
    const intent = {
      expectedFingerprint: `sha256:${'a'.repeat(64)}` as const,
      locator: {
        type: 'epub-cfi' as const,
        cfiRange: 'epubcfi(/6/2!/4/2:0)',
      },
    }

    store.set(openOrReuseProjectFileAtom, {
      ownerPanelId: owner.id,
      projectId: 'project-1',
      relativePath: 'book.epub',
      contextRoute: 'allSessions/session/s1',
      preferExistingFile: true,
      intent,
    })
    const filePanel = getStack(store)[1]

    expect(store.get(projectFileOpenIntentsAtom).get(filePanel.id)).toEqual(intent)
    expect(store.set(consumeProjectFileOpenIntentAtom, filePanel.id)).toEqual(intent)
    expect(store.set(consumeProjectFileOpenIntentAtom, filePanel.id)).toBeUndefined()
  })

  it('reuses a matching sent-reference file across owners without changing its owner or context', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })
    const [firstOwner, secondOwner] = getStack(store)

    store.set(openOrReuseProjectFileAtom, {
      ownerPanelId: firstOwner.id,
      projectId: 'project-1',
      relativePath: 'book.epub',
      contextRoute: 'allSessions/session/s1',
    })
    const existingFilePanel = getStack(store).find(entry => (
      entry.route.kind === 'projectFile'
      && entry.route.projectId === 'project-1'
      && entry.route.relativePath === 'book.epub'
    ))
    expect(existingFilePanel).toBeDefined()
    const panelCountBeforeReopen = getStack(store).length
    const intent = {
      expectedFingerprint: `sha256:${'b'.repeat(64)}` as const,
      locator: {
        type: 'epub-cfi' as const,
        cfiRange: 'epubcfi(/6/8!/4/2:12)',
      },
    }
    const sentReferenceRequest = {
      ownerPanelId: secondOwner.id,
      projectId: 'project-1',
      relativePath: 'book.epub',
      contextRoute: 'allSessions/session/s2' as const,
      preferExistingFile: true,
      intent,
    }

    store.set(openOrReuseProjectFileAtom, sentReferenceRequest)

    expect(getStack(store)).toHaveLength(panelCountBeforeReopen)
    expect(store.get(focusedPanelIdAtom)).toBe(existingFilePanel!.id)
    expect(
      getStack(store).find(entry => entry.id === existingFilePanel!.id),
    ).toMatchObject({
      ownerPanelId: firstOwner.id,
      route: {
        kind: 'projectFile',
        projectId: 'project-1',
        relativePath: 'book.epub',
        contextRoute: 'allSessions/session/s1',
      },
    })
    expect(
      store.get(projectFileOpenIntentsAtom).get(existingFilePanel!.id),
    ).toEqual(intent)
  })

  it('keeps matching ordinary file opens isolated per owner without preferExistingFile', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })
    const [firstOwner, secondOwner] = getStack(store)

    openProjectFile(
      store,
      firstOwner.id,
      'book.epub',
      'allSessions/session/s1',
    )
    openProjectFile(
      store,
      secondOwner.id,
      'book.epub',
      'allSessions/session/s2',
    )

    const matchingFilePanels = getStack(store).filter(entry => (
      entry.route.kind === 'projectFile'
      && entry.route.projectId === 'project-1'
      && entry.route.relativePath === 'book.epub'
    ))
    expect(getStack(store)).toHaveLength(4)
    expect(matchingFilePanels).toHaveLength(2)
    expect(matchingFilePanels.map(entry => entry.ownerPanelId)).toEqual([
      firstOwner.id,
      secondOwner.id,
    ])
  })

  it('keeps one visible Drawnix Board across physical owners', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })
    const [firstOwner, secondOwner] = getStack(store)

    openProjectFile(
      store,
      firstOwner.id,
      'maps/tutorial.drawnix',
      'allSessions/session/s1',
    )
    const boardPanel = getStack(store).find(entry => (
      entry.route.kind === 'projectFile'
      && entry.route.relativePath === 'maps/tutorial.drawnix'
    ))!

    openProjectFile(
      store,
      secondOwner.id,
      'maps/tutorial.drawnix',
      'allSessions/session/s2',
    )

    expect(getStack(store)).toHaveLength(3)
    expect(getStack(store).filter(entry => (
      entry.route.kind === 'projectFile'
      && entry.route.relativePath === 'maps/tutorial.drawnix'
    ))).toHaveLength(1)
    expect(store.get(focusedPanelIdAtom)).toBe(boardPanel.id)
    expect(getStack(store).find(entry => entry.id === boardPanel.id)).toMatchObject({
      ownerPanelId: firstOwner.id,
      route: {
        contextRoute: 'allSessions/session/s1',
      },
    })
  })

  it('reuses a matching non-focused orphan for a preferred reference without rebinding it', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })
    const [firstOwner, secondOwner] = getStack(store)

    openProjectFile(
      store,
      firstOwner.id,
      'book.epub',
      'allSessions/session/s1',
    )
    const orphan = getStack(store).find(entry => (
      entry.route.kind === 'projectFile'
      && entry.route.projectId === 'project-1'
      && entry.route.relativePath === 'book.epub'
    ))
    expect(orphan).toBeDefined()
    store.set(closePanelAtom, firstOwner.id)
    store.set(focusedPanelIdAtom, secondOwner.id)
    const panelCountBeforeReopen = getStack(store).length
    const intent = {
      expectedFingerprint: `sha256:${'c'.repeat(64)}` as const,
      locator: {
        type: 'epub-cfi' as const,
        cfiRange: 'epubcfi(/6/10!/4/2:6)',
      },
    }
    const sentReferenceRequest = {
      ownerPanelId: secondOwner.id,
      projectId: 'project-1',
      relativePath: 'book.epub',
      contextRoute: 'allSessions/session/s2' as const,
      preferExistingFile: true,
      intent,
    }

    store.set(openOrReuseProjectFileAtom, sentReferenceRequest)

    expect(getStack(store)).toHaveLength(panelCountBeforeReopen)
    expect(store.get(focusedPanelIdAtom)).toBe(orphan!.id)
    const reusedOrphan = getStack(store).find(entry => entry.id === orphan!.id)
    expect(reusedOrphan?.ownerPanelId).toBeUndefined()
    expect(reusedOrphan?.route).toEqual({
      kind: 'projectFile',
      projectId: 'project-1',
      relativePath: 'book.epub',
      contextRoute: 'allSessions/session/s1',
    })
    expect(store.get(projectFileOpenIntentsAtom).get(orphan!.id)).toEqual(intent)
  })

  it('does not infer an owner from route or position', () => {
    const store = createStore()
    store.set(panelStackAtom, [
      {
        id: 'owner',
        route: { kind: 'navigation', viewRoute: 'allSessions/session/s1' },
        widthRatio: DEFAULT_WIDTH_RATIO,
      },
      {
        id: 'file',
        route: {
          kind: 'projectFile',
          projectId: 'project-1',
          relativePath: 'book.epub',
          contextRoute: 'allSessions/session/s1',
        },
        widthRatio: EPUB_WIDTH_RATIO,
      },
    ])

    expect(getPanelOwnerPanelId(getStack(store), 'file')).toBeNull()
  })

  it('clears owner when its navigation panel closes and excludes the orphan from visible chats', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const owner = getStack(store)[0]
    openProjectFile(store, owner.id, 'src/index.ts')
    const file = getStack(store)[1]

    store.set(closePanelAtom, owner.id)

    expect(getStack(store)[0]).toMatchObject({
      id: file.id,
      ownerPanelId: undefined,
    })
    expect([...store.get(visibleSessionIdsAtom)]).toEqual([])
  })

  it('reuses the focused orphan without attaching it to an unrelated owner', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })
    const [firstOwner, secondOwner] = getStack(store)
    openProjectFile(store, firstOwner.id, 'first.ts')
    const orphanId = getStack(store)[1].id
    store.set(closePanelAtom, firstOwner.id)
    store.set(focusedPanelIdAtom, orphanId)

    openProjectFile(store, undefined, 'first-updated.ts')

    const orphan = getStack(store).find(panel => panel.id === orphanId)
    expect(orphan?.ownerPanelId).toBeUndefined()
    expect(orphan?.route).toMatchObject({ relativePath: 'first-updated.ts' })
    expect(getPanelOwnerPanelId(getStack(store), orphanId)).toBeNull()
    expect(getStack(store).some(panel => panel.id === secondOwner.id)).toBe(true)
  })

  it('Compact Back closes a companion and explicitly focuses its owner', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const owner = getStack(store)[0]
    openProjectFile(store, owner.id, 'README.md')
    const file = getStack(store)[1]

    store.set(backFromCompanionPanelAtom, file.id)

    expect(getStack(store)).toHaveLength(1)
    expect(store.get(focusedPanelIdAtom)).toBe(owner.id)
  })

  it('Compact Back replaces an orphan with its navigation context', () => {
    const store = createStore()
    store.set(restorePanelLayoutAtom, {
      version: 2,
      entries: [{
        key: 'p0',
        route: {
          kind: 'projectFile',
          projectId: 'project-1',
          relativePath: 'README.md',
          contextRoute: 'projects/project/demo',
        },
        widthRatio: DEFAULT_WIDTH_RATIO,
      }],
      focusedKey: 'p0',
    })
    const fileId = getStack(store)[0].id

    store.set(backFromCompanionPanelAtom, fileId)

    expect(getStack(store)[0]).toMatchObject({
      id: fileId,
      route: {
        kind: 'navigation',
        viewRoute: 'projects/project/demo',
      },
    })
    expect(store.get(focusedPanelIdAtom)).toBe(fileId)
  })

  it('Compact Back closes an orphan when its Session panel already exists', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const owner = getStack(store)[0]
    openProjectFile(
      store,
      owner.id,
      'README.md',
      'projects/project/demo/session/s1',
    )
    const fileId = getStack(store)[1].id
    store.set(closePanelAtom, owner.id)
    store.set(pushPanelAtom, {
      route: 'allSessions/session/s1',
    })
    const sessionPanelId = getStack(store)[1].id
    store.set(focusedPanelIdAtom, fileId)

    store.set(backFromCompanionPanelAtom, fileId)

    expect(getStack(store)).toEqual([
      expect.objectContaining({
        id: sessionPanelId,
        route: {
          kind: 'navigation',
          viewRoute: 'projects/project/demo/session/s1',
        },
      }),
    ])
    expect(store.get(focusedPanelIdAtom)).toBe(sessionPanelId)
  })

  it('rejects a layout with duplicate Session panels', () => {
    const store = createStore()
    const restored = store.set(restorePanelLayoutAtom, {
      version: 2,
      entries: [
        {
          key: 'p0',
          route: { kind: 'navigation', viewRoute: 'allSessions/session/s1' },
          widthRatio: 0.47,
        },
        {
          key: 'p1',
          route: { kind: 'navigation', viewRoute: 'allSessions/session/s1' },
          widthRatio: 0.60,
        },
      ],
      focusedKey: 'p1',
    })

    expect(restored).toBe(false)
    expect(getStack(store)).toEqual([])
    expect(store.get(focusedPanelIdAtom)).toBeNull()
  })

  it('rejects a restored layout with duplicate Drawnix Boards', () => {
    const store = createStore()
    const restored = store.set(restorePanelLayoutAtom, {
      version: 2,
      entries: [
        {
          key: 'p0',
          route: {
            kind: 'projectFile',
            projectId: 'project-1',
            relativePath: 'maps/tutorial.drawnix',
            contextRoute: 'allSessions/session/s1',
          },
          widthRatio: 0.47,
        },
        {
          key: 'p1',
          route: {
            kind: 'projectFile',
            projectId: 'project-1',
            relativePath: 'maps/tutorial.drawnix',
            contextRoute: 'allSessions/session/s2',
          },
          widthRatio: 0.60,
        },
      ],
      focusedKey: 'p1',
    })

    expect(restored).toBe(false)
    expect(getStack(store)).toEqual([])
  })

  it('does not create more than eight panels', () => {
    const store = createStore()
    for (let index = 0; index < 10; index += 1) {
      store.set(pushPanelAtom, { route: 'settings' })
    }
    expect(getStack(store)).toHaveLength(8)
  })

  it('focuses an existing Session when the panel limit is reached', () => {
    const store = createStore()
    store.set(pushPanelAtom, {
      route: 'allSessions/session/s1',
    })
    const sessionPanelId = getStack(store)[0].id
    for (let index = 0; index < 7; index += 1) {
      store.set(pushPanelAtom, { route: 'settings' })
    }

    const reusedPanelId = store.set(pushPanelAtom, {
      route: 'projects/project/os/session/s1',
    })

    expect(getStack(store)).toHaveLength(8)
    expect(reusedPanelId).toBe(sessionPanelId)
    expect(store.get(focusedPanelIdAtom)).toBe(sessionPanelId)
  })

  it('opens multiple browser companions after the anchor and dedupes by browser id', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const anchor = getStack(store)[0]
    openProjectFile(store, anchor.id, 'book.epub')

    store.set(openOrFocusBrowserPanelAtom, {
      browserId: 'browser-a',
      contextRoute: 'allSessions/session/s1',
      ownerPanelId: anchor.id,
    })
    store.set(openOrFocusBrowserPanelAtom, {
      browserId: 'browser-b',
      contextRoute: 'allSessions/session/s1',
      ownerPanelId: anchor.id,
    })
    store.set(openOrFocusBrowserPanelAtom, {
      browserId: 'browser-a',
      contextRoute: 'allSessions/session/s1',
      ownerPanelId: anchor.id,
    })

    const stack = getStack(store)
    expect(stack.map(entry => (
      entry.route.kind === 'browser' ? entry.route.browserId : entry.route.kind
    ))).toEqual(['navigation', 'projectFile', 'browser-a', 'browser-b'])
    expect(stack.filter(entry => entry.route.kind === 'browser')).toHaveLength(2)
    expect(store.get(focusedPanelIdAtom)).toBe(stack[2].id)
    expect(getPanelOwnerPanelId(stack, stack[3].id)).toBe(anchor.id)
  })

  it('orphans browser companions without destroying their resource identity', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const anchor = getStack(store)[0]
    store.set(openOrFocusBrowserPanelAtom, {
      browserId: 'browser-a',
      contextRoute: 'allSessions/session/s1',
      ownerPanelId: anchor.id,
    })
    const browser = getStack(store)[1]

    store.set(closePanelAtom, anchor.id)

    expect(getStack(store)).toHaveLength(1)
    expect(getStack(store)[0].route).toMatchObject({
      kind: 'browser',
      browserId: 'browser-a',
    })
    expect(getStack(store)[0].ownerPanelId).toBeUndefined()
    expect(browser.id).toBe(getStack(store)[0].id)
    expect(store.get(visibleSessionIdsAtom).size).toBe(0)
  })

  it('stores and restores a Browser companion Chat target', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const anchor = getStack(store)[0]
    store.set(openOrFocusBrowserPanelAtom, {
      browserId: 'browser-a',
      contextRoute: 'allSessions/session/s1',
      ownerPanelId: anchor.id,
    })
    const browser = getStack(store)[1]

    store.set(setCompanionChatTargetAtom, {
      panelId: browser.id,
      sessionId: 'session-2',
    })
    const encoded = serializePanelLayout(
      getStack(store),
      store.get(focusedPanelIdAtom),
    )
    const layout = deserializePanelLayout(encoded!)
    const restoredStore = createStore()
    restoredStore.set(restorePanelLayoutAtom, layout!)

    expect(getStack(store)[1].chatTargetSessionId).toBe('session-2')
    expect(getStack(restoredStore)[1].chatTargetSessionId).toBe('session-2')
  })
})
