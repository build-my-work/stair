import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  browserInstancesMapAtom,
  removeBrowserInstanceAtom,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
} from '@/atoms/browser-pane'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { useAppShellContext } from '@/context/AppShellContext'
import {
  closeWorkbenchPanelAtom,
  focusWorkbenchPanelAtom,
  markBrowserRuntimeUnavailableAtom,
  presentBrowserAtom,
  updateBrowserDescriptorAtom,
} from '@/workbench/workbench-commands'
import {
  getWorkbenchPanels,
  workbenchAtom,
} from '@/workbench/workbench-state'
import type { BrowserPresentRequest } from '../../../shared/types'

export function BrowserPaneController(): null {
  const { activeWorkspaceId, workspaces } = useAppShellContext()
  const workbench = useAtomValue(workbenchAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const browserInstances = useAtomValue(browserInstancesMapAtom)
  const setInstances = useSetAtom(setBrowserInstancesAtom)
  const updateInstance = useSetAtom(updateBrowserInstanceAtom)
  const removeInstance = useSetAtom(removeBrowserInstanceAtom)
  const updateDescriptor = useSetAtom(updateBrowserDescriptorAtom)
  const markUnavailable = useSetAtom(markBrowserRuntimeUnavailableAtom)
  const presentBrowser = useSetAtom(presentBrowserAtom)
  const focusPanel = useSetAtom(focusWorkbenchPanelAtom)
  const closePanel = useSetAtom(closeWorkbenchPanelAtom)
  const currentRef = useRef({ workbench, sessionMetaMap, browserInstances })
  currentRef.current = { workbench, sessionMetaMap, browserInstances }
  const remoteWorkspaceId = workspaces.find(workspace => (
    workspace.id === activeWorkspaceId
  ))?.remoteServer?.remoteWorkspaceId

  useEffect(() => {
    const api = window.electronAPI?.browserPane
    if (!api) return
    let disposed = false

    void api.list()
      .then(instances => {
        if (disposed) return
        setInstances(instances)
        const liveIds = new Set(instances.map(instance => instance.id))
        for (const layout of Object.values(currentRef.current.workbench.layoutsByProject)) {
          for (const panel of getWorkbenchPanels(layout)) {
            if (panel.kind === 'browser' && panel.runtimeId && !liveIds.has(panel.runtimeId)) {
              markUnavailable(panel.runtimeId)
            }
          }
        }
      })
      .catch(error => console.warn('[BrowserPaneController] Failed to list browsers:', error))

    const cleanups = [
      api.onStateChanged(info => {
        updateInstance(info)
        updateDescriptor({ runtimeId: info.id, url: info.url, title: info.title })
      }),
      api.onRemoved(id => {
        removeInstance(id)
        markUnavailable(id)
      }),
      api.onInteracted(id => {
        const state = currentRef.current.workbench
        const projectId = state.activeProjectId
        const layout = projectId ? state.layoutsByProject[projectId] : undefined
        const panel = layout && getWorkbenchPanels(layout).find(candidate => (
          candidate.kind === 'browser' && candidate.runtimeId === id
        ))
        if (projectId && panel) focusPanel({ projectId, panelId: panel.id })
      }),
      api.onPresentRequested((request: BrowserPresentRequest) => {
        if (
          request.workspaceId
          && request.workspaceId !== activeWorkspaceId
          && request.workspaceId !== remoteWorkspaceId
        ) return
        const state = currentRef.current
        const session = request.sessionId
          ? state.sessionMetaMap.get(request.sessionId)
          : undefined
        if (request.sessionId && !session) return
        const projectId = session?.projectId ?? state.workbench.activeProjectId
        if (!projectId) return
        const info = state.browserInstances.get(request.browserId)
        void presentBrowser({
          projectId,
          runtimeId: request.browserId,
          url: info?.url,
          title: info?.title,
          destroyOnFailure: info?.ownerType === 'manual' && !info.boundSessionId,
        })
      }),
      api.onClosePanelRequested(browserId => {
        const state = currentRef.current.workbench
        const projectId = state.activeProjectId
        const layout = projectId ? state.layoutsByProject[projectId] : undefined
        const panel = layout && getWorkbenchPanels(layout).find(candidate => (
          candidate.kind === 'browser' && candidate.runtimeId === browserId
        ))
        if (projectId && panel) {
          void closePanel({ projectId, panelId: panel.id })
        }
      }),
    ]

    return () => {
      disposed = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [
    activeWorkspaceId,
    closePanel,
    focusPanel,
    markUnavailable,
    presentBrowser,
    remoteWorkspaceId,
    removeInstance,
    setInstances,
    updateDescriptor,
    updateInstance,
  ])

  return null
}
