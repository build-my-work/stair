import { useCallback, useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  activeBrowserInstanceIdAtom,
  removeBrowserInstanceAtom,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
} from '@/atoms/browser-pane'
import {
  closePanelAtom,
  focusedPanelIdAtom,
  focusedPanelRouteAtom,
  openOrFocusBrowserPanelAtom,
  panelStackAtom,
  parseSessionIdFromRoute,
  pushPanelAtom,
  type PanelStackEntry,
} from '@/atoms/panel-stack'
import { projectsAtom } from '@/atoms/projects'
import { sessionMetaMapAtom, type SessionMeta } from '@/atoms/sessions'
import { isBrowserPanelRoute } from '@/lib/project-file-route'
import { routes } from '@/lib/navigate'
import type { ViewRoute } from '../../../shared/routes'
import { useAppShellContext } from '@/context/AppShellContext'
import type { BrowserPresentRequest } from '../../../shared/types'
import type { LoadedProject } from '@craft-agent/shared/projects/types'

export function getStaleBrowserPanelIds(
  panelStack: PanelStackEntry[],
  liveBrowserIds: ReadonlySet<string>,
): string[] {
  return panelStack
    .filter(entry => (
      isBrowserPanelRoute(entry.route)
      && !liveBrowserIds.has(entry.route.browserId)
    ))
    .map(entry => entry.id)
}

export function getBrowserContextRoute(
  sessionId: string | null | undefined,
  sessionMetaMap: Map<string, SessionMeta>,
  projects: LoadedProject[],
  fallback: ViewRoute,
): ViewRoute {
  if (!sessionId) return fallback
  const session = sessionMetaMap.get(sessionId)
  if (session?.isArchived) return routes.view.archived(sessionId)
  if (session?.projectId) {
    const project = projects.find(item => item.config.id === session.projectId)
    if (project) return routes.view.projectSession(project.config.slug, sessionId)
  }
  return routes.view.allSessions(sessionId)
}

export function BrowserPaneController(): null {
  const { activeWorkspaceId, workspaces } = useAppShellContext()
  const remoteWorkspaceId = workspaces
    .find(item => item.id === activeWorkspaceId)
    ?.remoteServer?.remoteWorkspaceId
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  const focusedRoute = useAtomValue(focusedPanelRouteAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const projects = useAtomValue(projectsAtom)
  const setInstances = useSetAtom(setBrowserInstancesAtom)
  const updateInstance = useSetAtom(updateBrowserInstanceAtom)
  const removeInstance = useSetAtom(removeBrowserInstanceAtom)
  const setActiveInstanceId = useSetAtom(activeBrowserInstanceIdAtom)
  const setFocusedPanelId = useSetAtom(focusedPanelIdAtom)
  const closePanel = useSetAtom(closePanelAtom)
  const pushPanel = useSetAtom(pushPanelAtom)
  const openBrowserPanel = useSetAtom(openOrFocusBrowserPanelAtom)
  const liveBrowserIdsRef = useRef<Set<string> | null>(null)
  const currentState = {
    panelStack,
    focusedPanelId,
    focusedRoute,
    sessionMetaMap,
    projects,
  }
  const stateRef = useRef(currentState)
  stateRef.current = currentState

  const closeBrowserPanels = useCallback((browserId: string) => {
    for (const entry of stateRef.current.panelStack) {
      if (
        isBrowserPanelRoute(entry.route)
        && entry.route.browserId === browserId
      ) {
        closePanel(entry.id)
      }
    }
  }, [closePanel])

  useEffect(() => {
    const liveBrowserIds = liveBrowserIdsRef.current
    if (!liveBrowserIds) return
    for (const panelId of getStaleBrowserPanelIds(
      panelStack,
      liveBrowserIds,
    )) {
      closePanel(panelId)
    }
  }, [closePanel, panelStack])

  const presentBrowser = useCallback((request: BrowserPresentRequest) => {
    const state = stateRef.current
    const fallback = state.focusedRoute ?? routes.view.allSessions()
    const contextRoute = getBrowserContextRoute(
      request.sessionId,
      state.sessionMetaMap,
      state.projects,
      fallback,
    )
    let ownerPanelId: string | undefined

    if (request.sessionId) {
      ownerPanelId = state.panelStack.find(entry => (
        entry.route.kind === 'navigation'
        && parseSessionIdFromRoute(entry.route) === request.sessionId
      ))?.id

      if (!ownerPanelId) {
        ownerPanelId = pushPanel({
          route: contextRoute,
          afterIndex: state.panelStack.findIndex(
            entry => entry.id === state.focusedPanelId,
          ),
        })
      }
    }

    openBrowserPanel({
      browserId: request.browserId,
      contextRoute,
      ownerPanelId,
    })
    setActiveInstanceId(request.browserId)
  }, [openBrowserPanel, pushPanel, setActiveInstanceId])

  useEffect(() => {
    const api = window.electronAPI?.browserPane
    if (!api) return
    let disposed = false
    liveBrowserIdsRef.current = null

    void api.list()
      .then((instances) => {
        if (disposed) return
        const liveBrowserIds = new Set(instances.map(item => item.id))
        liveBrowserIdsRef.current = liveBrowserIds
        setInstances(instances)
        for (const panelId of getStaleBrowserPanelIds(
          stateRef.current.panelStack,
          liveBrowserIds,
        )) {
          closePanel(panelId)
        }
      })
      .catch((error) => {
        console.warn('[BrowserPaneController] Failed to list browsers:', error)
      })

    const cleanups = [
      api.onStateChanged((info) => {
        liveBrowserIdsRef.current?.add(info.id)
        updateInstance(info)
      }),
      api.onRemoved((id) => {
        liveBrowserIdsRef.current?.delete(id)
        removeInstance(id)
        closeBrowserPanels(id)
      }),
      api.onInteracted((id) => {
        setActiveInstanceId(id)
        const panel = stateRef.current.panelStack.find(entry => (
          isBrowserPanelRoute(entry.route)
          && entry.route.browserId === id
        ))
        if (panel) setFocusedPanelId(panel.id)
      }),
      api.onPresentRequested((request) => {
        if (
          request.workspaceId
          && request.workspaceId !== activeWorkspaceId
          && request.workspaceId !== remoteWorkspaceId
        ) {
          return
        }
        presentBrowser(request)
      }),
      api.onClosePanelRequested(closeBrowserPanels),
    ]

    return () => {
      disposed = true
      liveBrowserIdsRef.current = null
      for (const cleanup of cleanups) cleanup()
    }
  }, [
    activeWorkspaceId,
    closeBrowserPanels,
    closePanel,
    presentBrowser,
    removeInstance,
    remoteWorkspaceId,
    setActiveInstanceId,
    setFocusedPanelId,
    setInstances,
    updateInstance,
  ])

  return null
}
