import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  focusedPanelIdAtom,
  openOrReuseProjectFileAtom,
  panelStackAtom,
  pushPanelAtom,
} from '@/atoms/panel-stack'
import { focusExistingProjectSessionPanel } from '../project-session-panel-navigation'

describe('focusExistingProjectSessionPanel', () => {
  it('canonicalizes and focuses an existing generic session panel without adding a panel', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/session-1' })
    const sessionPanelId = store.get(panelStackAtom)[0].id
    store.set(pushPanelAtom, { route: 'allSessions/session/session-2' })

    expect(focusExistingProjectSessionPanel(store, 'os', 'session-1')).toBe(true)

    const stack = store.get(panelStackAtom)
    expect(stack).toHaveLength(2)
    expect(stack[0]).toMatchObject({
      id: sessionPanelId,
      route: {
        kind: 'navigation',
        viewRoute: 'projects/project/os/session/session-1',
      },
    })
    expect(store.get(focusedPanelIdAtom)).toBe(sessionPanelId)
  })

  it('rebases the file companion owned by a canonicalized session panel', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/session-1' })
    const owner = store.get(panelStackAtom)[0]
    store.set(openOrReuseProjectFileAtom, {
      ownerPanelId: owner.id,
      projectId: 'project-1',
      contextRoute: 'allSessions/session/session-1',
      relativePath: 'notes/chapter.md',
    })

    expect(focusExistingProjectSessionPanel(store, 'os', 'session-1')).toBe(true)

    const stack = store.get(panelStackAtom)
    expect(stack).toHaveLength(2)
    expect(stack.map(entry => entry.route)).toEqual([
      {
        kind: 'navigation',
        viewRoute: 'projects/project/os/session/session-1',
      },
      {
        kind: 'projectFile',
        projectId: 'project-1',
        relativePath: 'notes/chapter.md',
        contextRoute: 'projects/project/os/session/session-1',
      },
    ])
    expect(stack[1].ownerPanelId).toBe(owner.id)
    expect(store.get(focusedPanelIdAtom)).toBe(owner.id)
  })

  it('leaves panel state untouched when the session is not open', () => {
    const store = createStore()
    store.set(pushPanelAtom, { route: 'allSessions/session/session-2' })
    const previousStack = store.get(panelStackAtom)
    const previousFocus = store.get(focusedPanelIdAtom)

    expect(focusExistingProjectSessionPanel(store, 'os', 'session-1')).toBe(false)
    expect(store.get(panelStackAtom)).toBe(previousStack)
    expect(store.get(focusedPanelIdAtom)).toBe(previousFocus)
  })
})
