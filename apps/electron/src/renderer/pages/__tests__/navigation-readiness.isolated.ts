import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DEFAULT_NAVIGATION_STATE, isSessionsNavigation } from '../../../shared/types'
import { buildRouteFromNavigationState } from '../../../shared/route-parser'

const repo = new URL('../../../../../..', import.meta.url).pathname
const require = createRequire(`${repo}/apps/electron/package.json`)
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const domino = require('@mixmark-io/domino')
const file = readFileSync(`${repo}/apps/electron/src/renderer/contexts/NavigationContext.tsx`, 'utf8')
const start = file.indexOf('  useEffect(() => {\n    if (suppressAutoSelectRef.current')
const end = file.indexOf('\n\n  return (', start)
if (start < 0 || end < 0) throw new Error('Production effect boundaries changed')
const source = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  return function useAutomaticNavigation(context) {
    const { useEffect } = React;
    const { suppressAutoSelectRef, isReady, isSessionsReady, workspaceId, baseNavigationState,
      resolveAutoSelection, applyViewRoute, restoredWorkspaceId } = context;
    ${file.slice(start, end)}
  }
`)
const useAutomaticNavigation = new Function('React', 'isSessionsNavigation', 'buildRouteFromNavigationState', source)(
  React, isSessionsNavigation, buildRouteFromNavigationState)
let root: any
afterEach(async () => { if (root) await act(async () => root.unmount()); root = undefined })

test('W03: automatic selection must wait until initial session and route restoration is ready', async () => {
  const w = domino.createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Node: w.Node, IS_REACT_ACT_ENVIRONMENT: true })
  const calls: unknown[] = []
  const context = { isReady: true, isSessionsReady: false, workspaceId: 'workspace-a',
    restoredWorkspaceId: null as string | null, suppressAutoSelectRef: { current: false }, baseNavigationState: DEFAULT_NAVIGATION_STATE,
    resolveAutoSelection: (state: any) => ({ ...state, details: { type: 'session', sessionId: 'old-last-selected' } }),
    applyViewRoute: async (...args: any[]) => { calls.push(args); return true } }
  function Harness() { useAutomaticNavigation(context); return null }
  root = createRoot(w.document.getElementById('root'))
  await act(async () => root.render(React.createElement(Harness)))
  expect(calls).toEqual([])
  context.isSessionsReady = true
  await act(async () => root.render(React.createElement(Harness)))
  expect(calls).toEqual([])
  context.restoredWorkspaceId = 'workspace-a'
  await act(async () => root.render(React.createElement(Harness)))
  expect(calls).toHaveLength(1)
})
