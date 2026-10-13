import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createStore } from 'jotai'
import { workbenchAtom } from '../../workbench/workbench-state'
import { DEFAULT_NAVIGATION_STATE } from '../../../shared/types'
import { buildRouteFromNavigationState, buildRightSidebarParam } from '../../../shared/route-parser'

const appShell = readFileSync(new URL('../../components/app-shell/AppShell.tsx', import.meta.url), 'utf8')
const navigation = readFileSync(new URL('../../contexts/NavigationContext.tsx', import.meta.url), 'utf8')
const shellStart = appShell.indexOf('  const workspaceSessionMetas = useMemo(')
const shellEnd = appShell.indexOf('\n\n  // Active sessions', shellStart)
const navigationStart = navigation.indexOf('  const filterSessionsByFilter = useCallback(')
const navigationEnd = navigation.indexOf('\n\n  const getFirstSessionId', navigationStart)
if ([shellStart, shellEnd, navigationStart, navigationEnd].some(index => index < 0)) {
  throw new Error('Production session filtering boundaries changed')
}
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const shellScope = new Function('useMemo', 'context', transpiler.transformSync(`
  const { sessionMetaMap, activeWorkspaceId, remoteWorkspaceId, workbench } = context;
  ${appShell.slice(shellStart, shellEnd)}
  return workspaceSessionMetas;
`))
const navigationScope = new Function('useCallback', 'store', 'workbenchAtom', 'context', transpiler.transformSync(`
  const { sessionMetas, workspaceId, remoteWorkspaceId } = context;
  const labelConfigs = [];
  const matchesLabelFilter = () => false;
  ${navigation.slice(navigationStart, navigationEnd)}
  return filterSessionsByFilter;
`))
const sessions = [
  { id: 'a', projectId: 'project-a', workspaceId: 'workspace-a' },
  { id: 'b', projectId: 'project-b', workspaceId: 'workspace-a' },
  { id: 'remote-b', projectId: 'project-b', workspaceId: 'remote-workspace' },
  { id: 'foreign-b', projectId: 'project-b', workspaceId: 'workspace-other' },
  { id: 'hidden-b', projectId: 'project-b', workspaceId: 'workspace-a', hidden: true },
]

it('W03: restored Project owns the visible session list and its counts', () => {
  const context = {
    sessionMetaMap: new Map(sessions.map(session => [session.id, session])),
    activeWorkspaceId: 'workspace-a', remoteWorkspaceId: 'remote-workspace',
    workbench: { activeProjectId: 'project-b' },
  }
  expect(shellScope((read: () => unknown) => read(), context).map((session: { id: string }) => session.id))
    .toEqual(['b', 'remote-b'])
  context.workbench.activeProjectId = ''
  expect(shellScope((read: () => unknown) => read(), context)).toEqual([])
})

it('W03: automatic selection cannot choose a stored session in another Project', () => {
  const store = createStore()
  store.set(workbenchAtom, { workspaceId: 'workspace-a', activeProjectId: 'project-b', layoutsByProject: {} })
  const filter = navigationScope((read: unknown) => read, store, workbenchAtom, {
    sessionMetas: sessions, workspaceId: 'workspace-a', remoteWorkspaceId: 'remote-workspace',
  })
  expect(filter({ kind: 'allSessions' }).map((session: { id: string }) => session.id))
    .toEqual(['b', 'remote-b'])
  store.set(workbenchAtom, { workspaceId: 'workspace-a', activeProjectId: 'project-a', layoutsByProject: {} })
  expect(filter({ kind: 'allSessions' }).map((session: { id: string }) => session.id))
    .toEqual(['a'])
})

it('W03: Project restoration aligns stale list scope while retaining status, labels, and grouping', () => {
  const start = appShell.indexOf('  // Restoring or switching a Workbench Project')
  const end = appShell.indexOf('\n\n  // Jump to All Sessions', start)
  if (start < 0 || end < 0) throw new Error('Production Project scope effect boundaries changed')
  const effect = new Function('useEffect', 'workbench', 'sessionFilterKey', 'setViewFiltersMap',
    transpiler.transformSync(appShell.slice(start, end)))
  let filters: Record<string, {
    projects: Record<string, string>; statuses: Record<string, string>
    labels: Record<string, string>; groupingMode: string
  }> = {
    allSessions: {
      projects: { 'project-a': 'include' }, statuses: { todo: 'include' },
      labels: { urgent: 'exclude' }, groupingMode: 'date',
    },
  }
  effect((run: () => void) => run(), { activeProjectId: 'project-b' }, 'allSessions',
    (update: (current: typeof filters) => typeof filters) => { filters = update(filters) })
  expect(filters).toEqual({
    allSessions: {
      projects: { 'project-b': 'include' }, statuses: { todo: 'include' },
      labels: { urgent: 'exclude' }, groupingMode: 'date',
    },
  })
})

it('W03: identical routes in different Projects create distinct history entries', () => {
  const start = navigation.indexOf('  const syncSemanticUrl = useCallback(')
  const end = navigation.indexOf('\n\n  const filterSessionsByFilter', start)
  if (start < 0 || end < 0) throw new Error('Production semantic URL boundaries changed')
  const bind = new Function('useCallback', 'store', 'workbenchAtom', 'deps',
    'buildRouteFromNavigationState', 'buildRightSidebarParam', transpiler.transformSync(`
      const { window, history, workspaceSlug, rightSidebarRef, historySeqRef, historyMaxSeqRef,
        nextHistorySeqRef, lastSemanticKeyRef, updateCanGoBackForward, storage } = deps;
      ${navigation.slice(start, end)}
      return syncSemanticUrl;
    `))
  const store = createStore()
  store.set(workbenchAtom, { workspaceId: 'workspace-a', activeProjectId: 'project-a', layoutsByProject: {} })
  const window = { location: { href: 'http://localhost:5193/?ws=workspace-a' } }
  const pushed: string[] = []
  const history = {
    state: {},
    pushState: (_state: unknown, _title: string, url: string) => { pushed.push(url); window.location.href = url },
    replaceState: (_state: unknown, _title: string, url: string) => { window.location.href = url },
  }
  const sync = bind((callback: unknown) => callback, store, workbenchAtom, {
    window, history, workspaceSlug: 'workspace-a', rightSidebarRef: { current: undefined },
    historySeqRef: { current: 0 }, historyMaxSeqRef: { current: 0 }, nextHistorySeqRef: { current: 1 },
    lastSemanticKeyRef: { current: '' }, updateCanGoBackForward: () => {},
    storage: { KEYS: { workspaceUrl: 'workspaceUrl' }, set: () => {} },
  }, buildRouteFromNavigationState, buildRightSidebarParam)
  sync(DEFAULT_NAVIGATION_STATE, false)
  store.set(workbenchAtom, { workspaceId: 'workspace-a', activeProjectId: 'project-b', layoutsByProject: {} })
  sync(DEFAULT_NAVIGATION_STATE, true)
  expect(pushed).toHaveLength(1)
  expect(new URL(pushed[0]!).searchParams.get('project')).toBe('project-b')
})
