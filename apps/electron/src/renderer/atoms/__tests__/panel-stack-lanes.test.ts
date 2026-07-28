import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  backFromProjectFilePanelAtom,
  closePanelAtom,
  consumeProjectFileOpenIntentAtom,
  focusedPanelIdAtom,
  focusedSessionIdAtom,
  getProjectFileOwnerPanelId,
  openOrReuseProjectFileAtom,
  panelStackAtom,
  projectFileOpenIntentsAtom,
  parseSessionIdFromRoute,
  pushPanelAtom,
  restorePanelLayoutAtom,
  setProjectFileChatTargetAtom,
  updateFocusedPanelRouteAtom,
  visibleSessionIdsAtom,
  type PanelStackEntry,
} from '../panel-stack'
import {
  deserializePanelLayoutV1,
  serializePanelLayoutV1,
} from '../../lib/panel-layout-codec'
import { updatePanelLayoutSearchParam } from '../../contexts/navigation-history'
import type { ViewRoute } from '../../../shared/routes'

function getStack(store: ReturnType<typeof createStore>): PanelStackEntry[] {
  return store.get(panelStackAtom)
}

function viewRoutes(store: ReturnType<typeof createStore>): Array<ViewRoute | string> {
  return getStack(store).map(entry => (
    entry.route.kind === 'navigation'
      ? entry.route.viewRoute
      : entry.route.relativePath
  ))
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
    store.set(setProjectFileChatTargetAtom, {
      panelId: openedFile.id,
      sessionId: 'session-2',
    })

    const stack = getStack(store)
    const focusedPanelId = store.get(focusedPanelIdAtom)
    const encoded = serializePanelLayoutV1(stack, focusedPanelId)
    const searchParams = new URLSearchParams('ws=my-workspace')
    const urlLayout = updatePanelLayoutSearchParam(
      searchParams,
      stack,
      focusedPanelId,
    )
    const layout = deserializePanelLayoutV1(
      searchParams.get('layout')!,
    )

    expect(stack.every(panel => panel.proportion > 0)).toBe(true)
    expect(encoded).not.toBeNull()
    expect(urlLayout).toBe(encoded)
    expect(searchParams.get('ws')).toBe('my-workspace')
    expect(layout).toMatchObject({
      version: 1,
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
    store.set(setProjectFileChatTargetAtom, {
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

  it('isolates companions between duplicate physical owner panels', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const [firstOwner, secondOwner] = getStack(store)

    openProjectFile(store, secondOwner.id, 'second.ts')
    openProjectFile(store, firstOwner.id, 'first.ts')

    const stack = getStack(store)
    expect(viewRoutes(store)).toEqual([
      'allSessions/session/s1',
      'first.ts',
      'allSessions/session/s1',
      'second.ts',
    ])
    expect(stack[1].ownerPanelId).toBe(firstOwner.id)
    expect(stack[3].ownerPanelId).toBe(secondOwner.id)
  })

  it('does not infer an owner from route or position', () => {
    const store = createStore()
    store.set(panelStackAtom, [
      {
        id: 'owner',
        route: { kind: 'navigation', viewRoute: 'allSessions/session/s1' },
        proportion: 0.5,
      },
      {
        id: 'file',
        route: {
          kind: 'projectFile',
          projectId: 'project-1',
          relativePath: 'book.epub',
          contextRoute: 'allSessions/session/s1',
        },
        proportion: 0.5,
      },
    ])

    expect(getProjectFileOwnerPanelId(getStack(store), 'file')).toBeNull()
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

  it('reuses the focused orphan without attaching it to a duplicate route owner', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const [firstOwner, secondOwner] = getStack(store)
    openProjectFile(store, firstOwner.id, 'first.ts')
    const orphanId = getStack(store)[1].id
    store.set(closePanelAtom, firstOwner.id)
    store.set(focusedPanelIdAtom, orphanId)

    openProjectFile(store, undefined, 'first-updated.ts')

    const orphan = getStack(store).find(panel => panel.id === orphanId)
    expect(orphan?.ownerPanelId).toBeUndefined()
    expect(orphan?.route).toMatchObject({ relativePath: 'first-updated.ts' })
    expect(getProjectFileOwnerPanelId(getStack(store), orphanId)).toBeNull()
    expect(getStack(store).some(panel => panel.id === secondOwner.id)).toBe(true)
  })

  it('Compact Back closes a companion and explicitly focuses its owner', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const owner = getStack(store)[0]
    openProjectFile(store, owner.id, 'README.md')
    const file = getStack(store)[1]

    store.set(backFromProjectFilePanelAtom, file.id)

    expect(getStack(store)).toHaveLength(1)
    expect(store.get(focusedPanelIdAtom)).toBe(owner.id)
  })

  it('Compact Back replaces an orphan with its navigation context', () => {
    const store = createStore()
    store.set(restorePanelLayoutAtom, {
      version: 1,
      entries: [{
        key: 'p0',
        route: {
          kind: 'projectFile',
          projectId: 'project-1',
          relativePath: 'README.md',
          contextRoute: 'projects/project/demo',
        },
        proportion: 1,
      }],
      focusedKey: 'p0',
    })
    const fileId = getStack(store)[0].id

    store.set(backFromProjectFilePanelAtom, fileId)

    expect(getStack(store)[0]).toMatchObject({
      id: fileId,
      route: {
        kind: 'navigation',
        viewRoute: 'projects/project/demo',
      },
    })
    expect(store.get(focusedPanelIdAtom)).toBe(fileId)
  })

  it('restores duplicate routes, owner, focus, and normalized proportions from V1', () => {
    const store = createStore()
    store.set(restorePanelLayoutAtom, {
      version: 1,
      entries: [
        {
          key: 'p0',
          route: { kind: 'navigation', viewRoute: 'allSessions/session/s1' },
          proportion: 2,
        },
        {
          key: 'p1',
          route: { kind: 'navigation', viewRoute: 'allSessions/session/s1' },
          proportion: 3,
        },
        {
          key: 'p2',
          route: {
            kind: 'projectFile',
            projectId: 'project-1',
            relativePath: 'book.epub',
            contextRoute: 'allSessions/session/s1',
          },
          proportion: 5,
          ownerKey: 'p0',
        },
      ],
      focusedKey: 'p1',
    })

    const [firstOwner, secondOwner, file] = getStack(store)
    expect(firstOwner.id).not.toBe(secondOwner.id)
    expect(file.ownerPanelId).toBe(firstOwner.id)
    expect(store.get(focusedPanelIdAtom)).toBe(secondOwner.id)
    expect(getStack(store).map(panel => panel.proportion)).toEqual([0.2, 0.3, 0.5])
  })

  it('does not create more than eight panels', () => {
    const store = createStore()
    for (let index = 0; index < 10; index += 1) {
      store.set(pushPanelAtom, { route: 'settings' })
    }
    expect(getStack(store)).toHaveLength(8)
  })
})
