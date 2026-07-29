import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { Globe } from 'lucide-react'
import { toast } from 'sonner'
import {
  panelStackAtom,
  pushPanelAtom,
  setCompanionChatTargetAtom,
} from '@/atoms/panel-stack'
import { browserInstancesMapAtom } from '@/atoms/browser-pane'
import { projectsAtom } from '@/atoms/projects'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { Panel } from '@/components/app-shell/Panel'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ChatTargetMenu } from '@/components/app-shell/ChatTargetMenu'
import { focusExistingSessionPanel } from '@/components/app-shell/project-session-panel-navigation'
import { useAppShellContext } from '@/context/AppShellContext'
import {
  getBrowserChatTargetSessionId,
  getBrowserReferenceProjectId,
  listBrowserReferenceTargets,
} from '@/lib/browser-reference-target'
import type { BrowserPanelRoute } from '@/lib/project-file-route'
import { routes } from '../../shared/routes'
import type {
  BrowserSelectionActionPayload,
  BrowserSurfaceState,
} from '../../shared/types'
import { getSessionTitle } from '@/utils/session'

interface BrowserPageProps {
  route: BrowserPanelRoute
  panelId: string
}

const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="menu"]',
  '[data-radix-popper-content-wrapper]',
  '[data-radix-portal] [data-state="open"]',
].join(',')

function rectanglesOverlap(left: DOMRect, right: DOMRect): boolean {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top
}

function isSurfaceOccluded(surface: HTMLElement): boolean {
  const surfaceRect = surface.getBoundingClientRect()
  const overlays = document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)

  for (const overlay of Array.from(overlays)) {
    if (surface.contains(overlay)) continue
    const style = getComputedStyle(overlay)
    if (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.pointerEvents === 'none'
    ) {
      continue
    }
    const rect = overlay.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0 && rectanglesOverlap(surfaceRect, rect)) {
      return true
    }
  }
  return false
}

function getVisibleSurfaceBounds(
  surface: HTMLElement,
): BrowserSurfaceState['bounds'] {
  const rect = surface.getBoundingClientRect()
  let left = Math.max(0, rect.left)
  let top = Math.max(0, rect.top)
  let right = Math.min(window.innerWidth, rect.right)
  let bottom = Math.min(window.innerHeight, rect.bottom)

  for (
    let ancestor = surface.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor)
    const ancestorRect = ancestor.getBoundingClientRect()
    if (style.overflowX !== 'visible') {
      left = Math.max(left, ancestorRect.left)
      right = Math.min(right, ancestorRect.right)
    }
    if (style.overflowY !== 'visible') {
      top = Math.max(top, ancestorRect.top)
      bottom = Math.min(bottom, ancestorRect.bottom)
    }
  }

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

export default function BrowserPage({
  route,
  panelId,
}: BrowserPageProps): ReactElement {
  const {
    activeWorkspaceId,
    onAddDraftReference,
    onCreateSession,
    rightSidebarButton,
    workspaces,
  } = useAppShellContext()
  const hostRef = useRef<HTMLDivElement>(null)
  const leaseIdRef = useRef<string | null>(null)
  const frameRef = useRef<number | null>(null)
  const lastSelectionEventIdRef = useRef<string | null>(null)
  const panelStack = useAtomValue(panelStackAtom)
  const browserInstances = useAtomValue(browserInstancesMapAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const projects = useAtomValue(projectsAtom)
  const setChatTarget = useSetAtom(setCompanionChatTargetAtom)
  const store = useStore()
  const [attachError, setAttachError] = useState<string | null>(null)
  const [isAttached, setIsAttached] = useState(false)
  const order = panelStack.findIndex(entry => entry.id === panelId)
  const browser = browserInstances.get(route.browserId)
  const remoteWorkspaceId = workspaces.find(
    workspace => workspace.id === activeWorkspaceId,
  )?.remoteServer?.remoteWorkspaceId
  const workspaceIds = [
    activeWorkspaceId,
    remoteWorkspaceId,
  ].filter((id): id is string => Boolean(id))
  const hasWorkspaceScope = workspaceIds.length > 0
  const chatTargetSessionId = hasWorkspaceScope
    ? getBrowserChatTargetSessionId(
        panelStack,
        panelId,
        sessionMetaMap,
        workspaceIds,
      )
    : null
  const preferredProjectId = hasWorkspaceScope
    ? getBrowserReferenceProjectId(
        panelStack,
        panelId,
        sessionMetaMap,
        workspaceIds,
      )
    : undefined
  const chatTargets = hasWorkspaceScope
    ? listBrowserReferenceTargets(
        sessionMetaMap,
        workspaceIds,
        preferredProjectId,
      ).map(session => ({
        id: session.id,
        title: getSessionTitle(session),
      }))
    : []

  const selectChatTarget = useCallback((sessionId: string) => {
    setChatTarget({ panelId, sessionId })
  }, [panelId, setChatTarget])

  const focusSession = useCallback((
    sessionId: string,
    projectId?: string,
  ) => {
    const effectiveProjectId =
      projectId ?? sessionMetaMap.get(sessionId)?.projectId
    const project = effectiveProjectId
      ? projects.find(item => item.config.id === effectiveProjectId)
      : undefined
    const canonicalRoute = project
      ? routes.view.projectSession(project.config.slug, sessionId)
      : routes.view.allSessions(sessionId)

    if (focusExistingSessionPanel(store, canonicalRoute, sessionId)) return

    const browserPanelIndex = panelStack.findIndex(
      entry => entry.id === panelId,
    )
    store.set(pushPanelAtom, {
      route: canonicalRoute,
      afterIndex: browserPanelIndex >= 0 ? browserPanelIndex : undefined,
    })
  }, [panelId, panelStack, projects, sessionMetaMap, store])

  const attachReferenceToSession = useCallback((
    sessionId: string,
    reference: BrowserSelectionActionPayload['reference'],
    projectId?: string,
  ) => {
    if (!onAddDraftReference(sessionId, reference)) return false
    toast.success('Browser selection added to the chat draft')
    focusSession(sessionId, projectId)
    return true
  }, [focusSession, onAddDraftReference])

  const createSessionWithReference = useCallback(async (
    reference: BrowserSelectionActionPayload['reference'],
    projectId?: string,
  ) => {
    if (!activeWorkspaceId) return null
    const session = await onCreateSession(activeWorkspaceId, {
      ...(projectId ? { projectId } : {}),
    })
    return attachReferenceToSession(session.id, reference, projectId)
      ? session.id
      : null
  }, [
    activeWorkspaceId,
    attachReferenceToSession,
    onCreateSession,
  ])

  const handleSelectionAction = useCallback(async (
    payload: BrowserSelectionActionPayload,
  ) => {
    if (
      payload.browserId !== route.browserId
      || payload.eventId === lastSelectionEventIdRef.current
    ) {
      return
    }
    lastSelectionEventIdRef.current = payload.eventId

    try {
      if (payload.action === 'add-chat' && chatTargetSessionId) {
        if (!attachReferenceToSession(
          chatTargetSessionId,
          payload.reference,
        )) {
          throw new Error('The target chat draft is currently locked.')
        }
        return
      }

      const sessionId = await createSessionWithReference(
        payload.reference,
        preferredProjectId,
      )
      if (!sessionId) {
        throw new Error('The new chat could not accept this reference.')
      }
      selectChatTarget(sessionId)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'The browser selection could not be added.',
      )
    }
  }, [
    attachReferenceToSession,
    chatTargetSessionId,
    createSessionWithReference,
    preferredProjectId,
    route.browserId,
    selectChatTarget,
  ])

  useEffect(() => {
    return window.electronAPI.browserPane.onSelectionAction((payload) => {
      void handleSelectionAction(payload)
    })
  }, [handleSelectionAction])

  const measure = useCallback((): BrowserSurfaceState | null => {
    const host = hostRef.current
    if (!host) return null
    const bounds = getVisibleSurfaceBounds(host)
    const visible = (
      document.visibilityState === 'visible'
      && bounds.width > 0
      && bounds.height > 0
      && !isSurfaceOccluded(host)
    )
    return {
      bounds,
      visible,
      order: order < 0 ? 0 : order,
    }
  }, [order])

  const flushSurface = useCallback(() => {
    frameRef.current = null
    const state = measure()
    if (!state) return
    const leaseId = leaseIdRef.current
    if (!leaseId) return
    void window.electronAPI.browserPane
      .updateSurface(route.browserId, leaseId, state)
      .catch((error) => {
        console.warn('[BrowserPage] Failed to update native surface:', error)
      })
  }, [measure, route.browserId])

  const scheduleSurface = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(flushSurface)
  }, [flushSurface])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    setIsAttached(false)
    const resizeObserver = new ResizeObserver(scheduleSurface)
    resizeObserver.observe(host)

    const intersectionObserver = new IntersectionObserver(scheduleSurface, {
      threshold: [0, 1],
    })
    intersectionObserver.observe(host)

    const mutationObserver = new MutationObserver(scheduleSurface)
    mutationObserver.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'style', 'data-state', 'aria-hidden'],
    })

    window.addEventListener('resize', scheduleSurface)
    window.addEventListener('scroll', scheduleSurface, true)
    document.addEventListener('visibilitychange', scheduleSurface)

    const initialState = measure()
    if (initialState) {
      void window.electronAPI.browserPane
        .attachSurface(route.browserId, initialState)
        .then((leaseId) => {
          if (disposed) {
            return window.electronAPI.browserPane.detachSurface(
              route.browserId,
              leaseId,
            )
          }
          leaseIdRef.current = leaseId
          setAttachError(null)
          setIsAttached(true)
          scheduleSurface()
        })
        .catch((error) => {
          if (!disposed) {
            setAttachError(
              error instanceof Error ? error.message : String(error),
            )
          }
        })
    }

    return () => {
      disposed = true
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', scheduleSurface)
      window.removeEventListener('scroll', scheduleSurface, true)
      document.removeEventListener('visibilitychange', scheduleSurface)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      const leaseId = leaseIdRef.current
      leaseIdRef.current = null
      if (leaseId) {
        void window.electronAPI.browserPane.detachSurface(
          route.browserId,
          leaseId,
        )
      }
    }
  }, [measure, route.browserId, scheduleSurface])

  return (
    <Panel
      variant="grow"
      className="bg-background"
      data-content-panel-id={panelId}
    >
      <PanelHeader
        title={browser?.title || 'Browser'}
        actions={(
          <ChatTargetMenu
            targetSessionId={chatTargetSessionId}
            targets={chatTargets}
            onChange={selectChatTarget}
            align="end"
          />
        )}
        rightSidebarButton={rightSidebarButton}
      />
      <div
        ref={hostRef}
        className="relative min-h-0 w-full flex-1 bg-background"
      >
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <div className="flex max-w-sm flex-col items-center gap-2 px-6 text-center text-xs">
            {!isAttached && (
              <>
                <Globe className="h-5 w-5" />
                <span>
                  {attachError
                    ? `Browser surface unavailable: ${attachError}`
                    : 'Connecting browser…'}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </Panel>
  )
}
