/**
 * Semantic navigation and Session Workbench coordination.
 *
 * Navigation owns Collection/Filter history. Workbench commands exclusively own
 * Primary/Auxiliary presentation; URLs never serialize the renderer layout.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useSession } from '@/hooks/useSession'
import { useLabels } from '@/hooks/useLabels'
import { matchesLabelFilter } from '@craft-agent/shared/labels'
import {
  parseRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
  buildRightSidebarParam,
  type ParsedRoute,
} from '../../shared/route-parser'
import { routes, type Route, type ViewRoute } from '../../shared/routes'
import { parsePermissionMode } from '@craft-agent/shared/agent/mode-types'
import { NAVIGATE_EVENT, type NavigateOptions } from '../lib/navigate'
import * as storage from '@/lib/local-storage'
import type {
  DeepLinkNavigation,
  Session,
  NavigationState,
  SessionFilter,
  SourceFilter,
  RightSidebarPanel,
  ContentBadge,
} from '../../shared/types'
import {
  isSessionsNavigation,
  isSourcesNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
  isProjectsNavigation,
  DEFAULT_NAVIGATION_STATE,
} from '../../shared/types'
import { sessionMetaMapAtom, updateSessionMetaAtom, type SessionMeta } from '@/atoms/sessions'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import {
  initializeWorkbenchAtom,
  openSessionInNewPanelAtom,
  selectSessionFromNavigatorAtom,
  showSessionInPrimaryAtom,
  switchWorkbenchProjectAtom,
} from '@/workbench/workbench-commands'
import { workbenchAtom } from '@/workbench/workbench-state'
import { flushOpenProjectFilesForProject } from '@/components/project-files/project-file-document-registry'

export { routes }
export type { Route }
export type { NavigationState, SessionFilter }
export {
  isSessionsNavigation,
  isSourcesNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
  isProjectsNavigation,
}

interface NavigationContextValue {
  navigate: (route: Route, options?: NavigateOptions) => void | Promise<void>
  /** Explicit Session presentation path; generic navigate() never creates a Panel. */
  openSessionInNewPanel: (sessionId: string, options?: { afterSessionId?: string }) => boolean
  /** Explicit new-Session Auxiliary path for the New Chat in Panel action. */
  createSessionInNewPanel: (route: Route) => Promise<void>
  isReady: boolean
  navigationState: NavigationState
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
  updateRightSidebar: (panel: RightSidebarPanel | undefined) => void
  toggleRightSidebar: (panel?: RightSidebarPanel) => void
  navigateToSource: (sourceSlug?: string) => void
  navigateToSession: (sessionId: string) => void
}

export const NavigationContext = createContext<NavigationContextValue | null>(null)

interface NavigationProviderProps {
  children: ReactNode
  workspaceId: string | null
  workspaceSlug: string | null
  defaultProjectId: string | null
  onSwitchWorkspaceBySlug?: (slug: string) => void
  onCreateSession: (workspaceId: string, options?: import('../../shared/types').CreateSessionOptions) => Promise<Session>
  onInputChange?: (sessionId: string, value: string) => void
  isReady?: boolean
  isSessionsReady?: boolean
  remoteWorkspaceId?: string | null
}

export function NavigationProvider({
  children,
  workspaceId,
  workspaceSlug,
  defaultProjectId,
  onSwitchWorkspaceBySlug,
  onCreateSession,
  onInputChange,
  isReady = true,
  isSessionsReady = true,
  remoteWorkspaceId,
}: NavigationProviderProps) {
  const { t } = useTranslation()
  const [, setSession] = useSession()
  const store = useStore()
  const initializeWorkbench = useSetAtom(initializeWorkbenchAtom)
  const selectSessionFromNavigator = useSetAtom(selectSessionFromNavigatorAtom)
  const showSessionInPrimary = useSetAtom(showSessionInPrimaryAtom)
  const openSessionPanel = useSetAtom(openSessionInNewPanelAtom)
  const switchWorkbenchProject = useSetAtom(switchWorkbenchProjectAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMetas = useMemo(() => Array.from(sessionMetaMap.values()), [sessionMetaMap])
  const updateSessionMeta = useSetAtom(updateSessionMetaAtom)
  const { labels: labelConfigs } = useLabels(workspaceId)
  const sources = useAtomValue(sourcesAtom)
  const skills = useAtomValue(skillsAtom)

  const [baseNavigationState, setBaseNavigationState] = useState<NavigationState>(DEFAULT_NAVIGATION_STATE)
  const [rightSidebar, setRightSidebar] = useState<RightSidebarPanel | undefined>()
  const rightSidebarRef = useRef<RightSidebarPanel | undefined>(rightSidebar)
  const navigationState = useMemo(
    () => rightSidebar ? { ...baseNavigationState, rightSidebar } : baseNavigationState,
    [baseNavigationState, rightSidebar],
  )

  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const historySeqRef = useRef(0)
  const historyMaxSeqRef = useRef(0)
  const nextHistorySeqRef = useRef(1)
  const lastSemanticKeyRef = useRef('')
  const restoredWorkspaceRef = useRef<string | null>(null)
  const isPopstateSwitchRef = useRef(false)
  const pendingNavigationRef = useRef<{ route: Route; options?: NavigateOptions } | null>(null)
  const suppressAutoSelectRef = useRef(false)

  const updateCanGoBackForward = useCallback(() => {
    setCanGoBack(historySeqRef.current > 0)
    setCanGoForward(historySeqRef.current < historyMaxSeqRef.current)
  }, [])

  const syncSemanticUrl = useCallback((
    state: NavigationState,
    push: boolean,
    sidebar: RightSidebarPanel | undefined = rightSidebarRef.current,
  ) => {
    const route = buildRouteFromNavigationState(state) as ViewRoute
    const sidebarParam = buildRightSidebarParam(sidebar) ?? ''
    const semanticKey = `${workspaceSlug ?? ''}|${route}|${sidebarParam}`
    const url = new URL(window.location.href)
    if (workspaceSlug) url.searchParams.set('ws', workspaceSlug)
    else url.searchParams.delete('ws')
    url.searchParams.set('route', route)
    url.searchParams.delete('panels')
    url.searchParams.delete('fi')
    if (sidebarParam) url.searchParams.set('sidebar', sidebarParam)
    else url.searchParams.delete('sidebar')

    if (push && semanticKey !== lastSemanticKeyRef.current) {
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', url.toString())
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq
      updateCanGoBackForward()
    } else {
      history.replaceState({ ...history.state, seq: historySeqRef.current }, '', url.toString())
    }
    lastSemanticKeyRef.current = semanticKey
    if (workspaceSlug) storage.set(storage.KEYS.workspaceUrl, url.search, workspaceSlug)
  }, [updateCanGoBackForward, workspaceSlug])

  const filterSessionsByFilter = useCallback((filter: SessionFilter): SessionMeta[] => {
    return sessionMetas.filter((session) => {
      if (session.hidden || (workspaceId && session.workspaceId !== workspaceId)) return false
      switch (filter.kind) {
        case 'allSessions':
          return session.isArchived !== true
        case 'flagged':
          return session.isFlagged === true && session.isArchived !== true
        case 'archived':
          return session.isArchived === true
        case 'state':
          return session.sessionStatus === filter.stateId && session.isArchived !== true
        case 'label':
          return session.isArchived !== true && matchesLabelFilter(session, filter, labelConfigs)
        case 'view':
          return session.isArchived !== true
        default:
          return false
      }
    })
  }, [labelConfigs, sessionMetas, workspaceId])

  const getFirstSessionId = useCallback(
    (filter: SessionFilter) => filterSessionsByFilter(filter)[0]?.id ?? null,
    [filterSessionsByFilter],
  )

  const getLastSelectedSessionId = useCallback((filter: SessionFilter): string | null => {
    if (!workspaceId) return null
    const storedId = storage.get<string | null>(storage.KEYS.lastSelectedSessionId, null, workspaceId)
    if (!storedId) return null
    return filterSessionsByFilter(filter).some(session => session.id === storedId) ? storedId : null
  }, [filterSessionsByFilter, workspaceId])

  const getFirstSourceSlug = useCallback((filter?: SourceFilter | null): string | null => {
    if (!filter) return sources[0]?.config.slug ?? null
    return sources.find(source => source.config.type === filter.sourceType)?.config.slug ?? null
  }, [sources])

  const resolveAutoSelection = useCallback((
    state: NavigationState,
    options?: { skipAutoSelect?: boolean },
  ): NavigationState => {
    let nextState = state
    if (isSessionsNavigation(nextState) && nextState.details) {
      const meta = store.get(sessionMetaMapAtom).get(nextState.details.sessionId)
      const matchesWorkspace = !workspaceId
        || meta?.workspaceId === workspaceId
        || (!!remoteWorkspaceId && meta?.workspaceId === remoteWorkspaceId)
      if (!meta || !matchesWorkspace) nextState = { ...nextState, details: null }
    }

    if (
      isSessionsNavigation(nextState)
      && nextState.viewMode !== 'board'
      && !nextState.details
      && !options?.skipAutoSelect
    ) {
      const sessionId = getLastSelectedSessionId(nextState.filter) ?? getFirstSessionId(nextState.filter)
      return sessionId
        ? { ...nextState, details: { type: 'session', sessionId } }
        : nextState
    }

    if (isSourcesNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
      const sourceSlug = getFirstSourceSlug(nextState.filter)
      return sourceSlug
        ? { ...nextState, details: { type: 'source', sourceSlug } }
        : nextState
    }

    if (isSkillsNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
      const skillSlug = skills[0]?.slug
      return skillSlug
        ? { ...nextState, details: { type: 'skill', skillSlug } }
        : nextState
    }
    return nextState
  }, [getFirstSessionId, getFirstSourceSlug, getLastSelectedSessionId, remoteWorkspaceId, skills, store, workspaceId])

  const applyViewRoute = useCallback(async (
    route: ViewRoute,
    options?: { skipAutoSelect?: boolean; pushHistory?: boolean },
  ): Promise<boolean> => {
    const parsedState = parseRouteToNavigationState(route)
    if (!parsedState) return false
    if (workspaceId && defaultProjectId) {
      initializeWorkbench({ workspaceId, defaultProjectId })
    }
    const resolvedState = resolveAutoSelection(parsedState, options)
    if (!isSessionsNavigation(resolvedState) || resolvedState.viewMode === 'board') {
      const activeProjectId = store.get(workbenchAtom).activeProjectId
      if (activeProjectId) {
        try {
          await flushOpenProjectFilesForProject(activeProjectId)
        } catch {
          return false
        }
      }
    }
    if (isSessionsNavigation(resolvedState) && resolvedState.details) {
      const meta = store.get(sessionMetaMapAtom).get(resolvedState.details.sessionId)
      if (!meta || !await selectSessionFromNavigator({
        sessionId: meta.id,
        projectId: meta.projectId,
      })) {
        return false
      }
      if (workspaceId) {
        storage.set(storage.KEYS.lastSelectedSessionId, meta.id, workspaceId)
      }
    }
    setBaseNavigationState(resolvedState)
    syncSemanticUrl(resolvedState, options?.pushHistory ?? true)
    return true
  }, [defaultProjectId, initializeWorkbench, resolveAutoSelection, selectSessionFromNavigator, store, syncSemanticUrl, workspaceId])

  const routeForSession = useCallback((sessionId: string): ViewRoute => {
    if (!isSessionsNavigation(baseNavigationState)) return routes.view.allSessions(sessionId)
    switch (baseNavigationState.filter.kind) {
      case 'flagged':
        return routes.view.flagged(sessionId)
      case 'archived':
        return routes.view.archived(sessionId)
      case 'state':
        return routes.view.state(baseNavigationState.filter.stateId, sessionId)
      case 'label':
        return routes.view.label(baseNavigationState.filter.labelId, sessionId)
      case 'view':
        return routes.view.view(baseNavigationState.filter.viewId, sessionId)
      default:
        return routes.view.allSessions(sessionId)
    }
  }, [baseNavigationState])

  const handleActionNavigation = useCallback(async (
    parsed: ParsedRoute,
    presentation: 'primary' | 'auxiliary' = 'primary',
  ) => {
    if (!workspaceId) return
    switch (parsed.name) {
      case 'new-session': {
        const currentWorkbench = store.get(workbenchAtom)
        const projectId = parsed.params.project ?? currentWorkbench.activeProjectId
        if (!projectId || !await switchWorkbenchProject({ projectId })) {
          toast.error('Could not activate the target Project before creating a Session.')
          return
        }

        const createOptions: import('../../shared/types').CreateSessionOptions = { projectId }
        if (parsed.params.mode) {
          const mode = parsePermissionMode(parsed.params.mode)
          if (mode) createOptions.permissionMode = mode
        }
        if (parsed.params.workdir) createOptions.workingDirectory = parsed.params.workdir
        if (parsed.params.model) createOptions.model = parsed.params.model
        if (parsed.params.systemPrompt) createOptions.systemPromptPreset = parsed.params.systemPrompt
        if (parsed.params.status) createOptions.sessionStatus = parsed.params.status
        if (parsed.params.label) createOptions.labels = [parsed.params.label]

        const session = await onCreateSession(workspaceId, createOptions)
        const committed = session.projectId === projectId && (
          presentation === 'auxiliary'
            ? openSessionPanel({ sessionId: session.id, projectId })
            : showSessionInPrimary({ sessionId: session.id, projectId })
        )
        if (!committed) {
          await window.electronAPI.deleteSession(session.id)
          throw new Error('Workbench Project changed while the Session was being created')
        }

        if (parsed.params.name) {
          await window.electronAPI.sessionCommand(session.id, { type: 'rename', name: parsed.params.name })
        }
        if (parsed.params.status) {
          updateSessionMeta(session.id, { sessionStatus: parsed.params.status })
          await window.electronAPI.sessionCommand(session.id, { type: 'setSessionStatus', state: parsed.params.status })
        }
        if (parsed.params.label) {
          updateSessionMeta(session.id, { labels: [parsed.params.label] })
          await window.electronAPI.sessionCommand(session.id, { type: 'setLabels', labels: [parsed.params.label] })
        }

        let filter: SessionFilter = { kind: 'allSessions' }
        if (parsed.params.status) {
          filter = { kind: 'state', stateId: parsed.params.status }
        } else if (parsed.params.label) {
          filter = { kind: 'label', labelId: parsed.params.label }
        }
        const nextState: NavigationState = {
          navigator: 'sessions',
          filter,
          details: { type: 'session', sessionId: session.id },
        }
        setBaseNavigationState(nextState)
        syncSemanticUrl(nextState, true)

        let badges: ContentBadge[] | undefined
        if (parsed.params.badges) {
          try {
            badges = JSON.parse(parsed.params.badges) as ContentBadge[]
          } catch (error) {
            console.warn('[Navigation] Failed to parse badges param:', error)
          }
        }
        const input = parsed.params.input
        if (input) {
          if (parsed.params.send === 'true') {
            setTimeout(() => {
              window.electronAPI.sendMessage(
                session.id,
                input,
                undefined,
                undefined,
                badges ? { badges } : undefined,
              )
            }, 100)
          } else if (onInputChange) {
            setTimeout(() => onInputChange(session.id, input), 100)
          }
        }
        break
      }
      case 'rename-session':
        if (parsed.id && parsed.params.name) {
          await window.electronAPI.sessionCommand(parsed.id, { type: 'rename', name: parsed.params.name })
        }
        break
      case 'delete-session':
        if (parsed.id) await window.electronAPI.deleteSession(parsed.id)
        break
      case 'flag-session':
        if (parsed.id) await window.electronAPI.sessionCommand(parsed.id, { type: 'flag' })
        break
      case 'unflag-session':
        if (parsed.id) await window.electronAPI.sessionCommand(parsed.id, { type: 'unflag' })
        break
      case 'oauth':
        if (parsed.id) await window.electronAPI.performOAuth({ sourceSlug: parsed.id })
        break
      case 'delete-source':
        if (parsed.id) await window.electronAPI.deleteSource(workspaceId, parsed.id)
        break
      case 'set-mode':
        if (parsed.id && parsed.params.mode) {
          const mode = parsePermissionMode(parsed.params.mode)
          if (mode) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'setPermissionMode', mode })
          }
        }
        break
      case 'copy':
        if (parsed.params.text) await navigator.clipboard.writeText(parsed.params.text)
        break
      default:
        console.warn('[Navigation] Unknown action:', parsed.name)
    }
  }, [onCreateSession, onInputChange, openSessionPanel, showSessionInPrimary, store, switchWorkbenchProject, syncSemanticUrl, updateSessionMeta, workspaceId])

  const navigate = useCallback(async (route: Route, options?: NavigateOptions) => {
    if (!options?.skipAutoSelect) suppressAutoSelectRef.current = false
    if (!isReady || !defaultProjectId) {
      pendingNavigationRef.current = { route, options }
      return
    }
    const parsed = parseRoute(route)
    if (!parsed) {
      console.warn('[Navigation] Invalid route:', route)
      return
    }
    try {
      if (parsed.type === 'action') {
        await handleActionNavigation(parsed)
        return
      }
      if (options?.skipAutoSelect) suppressAutoSelectRef.current = true
      await applyViewRoute(route as ViewRoute, { ...options, pushHistory: true })
    } catch (error) {
      console.error('[Navigation] Failed:', error)
      toast.error('Navigation failed', {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [applyViewRoute, defaultProjectId, handleActionNavigation, isReady])

  const openSessionInNewPanel = useCallback((
    sessionId: string,
    options?: { afterSessionId?: string },
  ): boolean => {
    const meta = store.get(sessionMetaMapAtom).get(sessionId)
    if (!meta) return false
    const opened = openSessionPanel({
      sessionId,
      projectId: meta.projectId,
      afterSessionId: options?.afterSessionId,
    })
    if (!opened) {
      toast.error('Switch to the Session’s Project before opening a new Panel.')
      return false
    }
    void applyViewRoute(routeForSession(sessionId), { pushHistory: true })
    return true
  }, [applyViewRoute, openSessionPanel, routeForSession, store])

  const createSessionInNewPanel = useCallback(async (route: Route) => {
    const parsed = parseRoute(route)
    if (!parsed || parsed.type !== 'action' || parsed.name !== 'new-session') {
      throw new Error('createSessionInNewPanel requires a new-session action route')
    }
    try {
      await handleActionNavigation(parsed, 'auxiliary')
    } catch (error) {
      console.error('[Navigation] Failed to create Session in Panel:', error)
      toast.error('Could not create Session', {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [handleActionNavigation])

  const navigateToSession = useCallback((sessionId: string) => {
    void navigate(routeForSession(sessionId))
  }, [navigate, routeForSession])

  const navigateToSource = useCallback((sourceSlug?: string) => {
    if (isSourcesNavigation(baseNavigationState) && baseNavigationState.filter?.kind === 'type') {
      switch (baseNavigationState.filter.sourceType) {
        case 'api':
          void navigate(routes.view.sourcesApi(sourceSlug))
          return
        case 'mcp':
          void navigate(routes.view.sourcesMcp(sourceSlug))
          return
        case 'local':
          void navigate(routes.view.sourcesLocal(sourceSlug))
          return
      }
    }
    void navigate(routes.view.sources(sourceSlug ? { sourceSlug } : undefined))
  }, [baseNavigationState, navigate])

  const goBack = useCallback(() => history.back(), [])
  const goForward = useCallback(() => history.forward(), [])

  const updateRightSidebar = useCallback((panel: RightSidebarPanel | undefined) => {
    rightSidebarRef.current = panel
    setRightSidebar(panel)
    syncSemanticUrl(baseNavigationState, true, panel)
  }, [baseNavigationState, syncSemanticUrl])

  const toggleRightSidebar = useCallback((panel?: RightSidebarPanel) => {
    updateRightSidebar(panel ?? { type: 'none' })
  }, [updateRightSidebar])

  useEffect(() => {
    rightSidebarRef.current = rightSidebar
  }, [rightSidebar])

  useEffect(() => {
    if (!workspaceId || !defaultProjectId) return
    initializeWorkbench({ workspaceId, defaultProjectId })
  }, [defaultProjectId, initializeWorkbench, workspaceId])

  useEffect(() => {
    if (!isReady || !isSessionsReady || !workspaceId || !workspaceSlug || !defaultProjectId) return
    if (restoredWorkspaceRef.current === workspaceId) return
    initializeWorkbench({ workspaceId, defaultProjectId })

    const firstRestore = restoredWorkspaceRef.current === null
    restoredWorkspaceRef.current = workspaceId
    let params = new URLSearchParams(window.location.search)
    if (params.get('ws') !== workspaceSlug && !isPopstateSwitchRef.current) {
      params = new URLSearchParams(storage.get<string>(storage.KEYS.workspaceUrl, '', workspaceSlug))
    }
    const route = (params.get('route') || routes.view.allSessions()) as ViewRoute
    const sidebarParam = params.get('sidebar') || undefined
    if (sidebarParam) {
      const parsedSidebar = parseRouteToNavigationState(routes.view.allSessions(), sidebarParam)?.rightSidebar
      rightSidebarRef.current = parsedSidebar
      setRightSidebar(parsedSidebar)
    } else {
      rightSidebarRef.current = undefined
      setRightSidebar(undefined)
    }

    const pushHistory = !firstRestore && !isPopstateSwitchRef.current
    isPopstateSwitchRef.current = false
    void (async () => {
      if (!await applyViewRoute(route, { pushHistory })) {
        await applyViewRoute(routes.view.allSessions(), { pushHistory })
      }
      if (firstRestore) {
        history.replaceState({ seq: 0 }, '', window.location.href)
        historySeqRef.current = 0
        historyMaxSeqRef.current = 0
        nextHistorySeqRef.current = 1
        updateCanGoBackForward()
      }
    })()
  }, [
    applyViewRoute,
    defaultProjectId,
    initializeWorkbench,
    isReady,
    isSessionsReady,
    updateCanGoBackForward,
    workspaceId,
    workspaceSlug,
  ])

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      historySeqRef.current = event.state?.seq ?? 0
      updateCanGoBackForward()
      const params = new URLSearchParams(window.location.search)
      const targetWorkspaceSlug = params.get('ws')
      if (targetWorkspaceSlug && targetWorkspaceSlug !== workspaceSlug && onSwitchWorkspaceBySlug) {
        isPopstateSwitchRef.current = true
        onSwitchWorkspaceBySlug(targetWorkspaceSlug)
        return
      }
      if (!isSessionsReady || !defaultProjectId) return
      const sidebarParam = params.get('sidebar') || undefined
      if (sidebarParam) {
        const parsedSidebar = parseRouteToNavigationState(routes.view.allSessions(), sidebarParam)?.rightSidebar
        rightSidebarRef.current = parsedSidebar
        setRightSidebar(parsedSidebar)
      } else {
        rightSidebarRef.current = undefined
        setRightSidebar(undefined)
      }
      const route = (params.get('route') || routes.view.allSessions()) as ViewRoute
      void applyViewRoute(route, { pushHistory: false })
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [applyViewRoute, defaultProjectId, isSessionsReady, onSwitchWorkspaceBySlug, updateCanGoBackForward, workspaceSlug])

  useEffect(() => {
    if (!isReady || !defaultProjectId || !pendingNavigationRef.current) return
    const pending = pendingNavigationRef.current
    pendingNavigationRef.current = null
    void navigate(pending.route, pending.options)
  }, [defaultProjectId, isReady, navigate])

  useEffect(() => {
    if (!workspaceId) return
    return window.electronAPI.onDeepLinkNavigate((deepLink: DeepLinkNavigation) => {
      let route: string | null = null
      if (deepLink.view) {
        route = deepLink.view
      } else if (deepLink.action) {
        route = `action/${deepLink.action}`
        if (deepLink.actionParams?.id) route += `/${deepLink.actionParams.id}`
        const params = { ...deepLink.actionParams }
        delete params.id
        if (Object.keys(params).length > 0) route += `?${new URLSearchParams(params).toString()}`
      }
      if (!route) return
      if (!parseRouteToNavigationState(route) && !route.startsWith('action/')) {
        toast.error(t('toast.invalidLink'), { description: t('toast.invalidLinkDesc') })
        return
      }
      void navigate(route as Route)
    })
  }, [navigate, t, workspaceId])

  useEffect(() => {
    const handleNavigateEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ route: Route; skipAutoSelect?: boolean }>).detail
      if (detail?.route) void navigate(detail.route, { skipAutoSelect: detail.skipAutoSelect })
    }
    window.addEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    return () => window.removeEventListener(NAVIGATE_EVENT, handleNavigateEvent)
  }, [navigate])

  useEffect(() => {
    if (isSessionsNavigation(baseNavigationState) && baseNavigationState.details) {
      const sessionId = baseNavigationState.details.sessionId
      setSession({ selected: sessionId })
    }
  }, [baseNavigationState, setSession])

  useEffect(() => {
    if (suppressAutoSelectRef.current || !isReady || !workspaceId) return
    if (!isSessionsNavigation(baseNavigationState) || baseNavigationState.details) return
    const resolved = resolveAutoSelection(baseNavigationState)
    if (isSessionsNavigation(resolved) && resolved.details) {
      void applyViewRoute(buildRouteFromNavigationState(resolved) as ViewRoute, { pushHistory: false })
    }
  }, [applyViewRoute, baseNavigationState, isReady, resolveAutoSelection, workspaceId])

  return (
    <NavigationContext.Provider
      value={{
        navigate,
        openSessionInNewPanel,
        createSessionInNewPanel,
        isReady,
        navigationState,
        canGoBack,
        canGoForward,
        goBack,
        goForward,
        updateRightSidebar,
        toggleRightSidebar,
        navigateToSource,
        navigateToSession,
      }}
    >
      {children}
    </NavigationContext.Provider>
  )
}

export function useNavigation() {
  const context = useContext(NavigationContext)
  if (!context) throw new Error('useNavigation must be used within NavigationProvider')
  return context
}

export function useNavigationState(): NavigationState {
  return useNavigation().navigationState
}
