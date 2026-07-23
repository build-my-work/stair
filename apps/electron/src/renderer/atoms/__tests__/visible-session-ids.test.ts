import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  panelStackAtom,
  setEmbeddedSessionVisibilityAtom,
  visibleSessionIdsAtom,
} from '../panel-stack'

describe('visibleSessionIdsAtom', () => {
  it('unions main-panel and active embedded side-chat sessions', () => {
    const store = createStore()
    store.set(panelStackAtom, [{
      id: 'panel-1',
      route: 'allSessions/session/main',
      proportion: 1,
      panelType: 'session',
      laneId: 'main',
    }])

    store.set(setEmbeddedSessionVisibilityAtom, { sessionId: 'side', visible: true })
    expect(store.get(visibleSessionIdsAtom)).toEqual(new Set(['main', 'side']))

    store.set(setEmbeddedSessionVisibilityAtom, { sessionId: 'side', visible: false })
    expect(store.get(visibleSessionIdsAtom)).toEqual(new Set(['main']))
  })
})
