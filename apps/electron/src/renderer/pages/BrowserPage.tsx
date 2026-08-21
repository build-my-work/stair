import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { browserInstancesMapAtom } from '@/atoms/browser-pane'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { useAppShellContext } from '@/context/AppShellContext'
import { calculateBrowserSurfaceGeometry } from '@/lib/browser-surface-geometry'
import {
  openSessionFromBrowserAtom,
  setBrowserChatTargetAtom,
} from '@/workbench/workbench-commands'
import {
  workbenchPanelsAtom,
  type BrowserWorkbenchPanel,
} from '@/workbench/workbench-state'
import { browserSelectionSourceToReference } from '../../shared/browser-selection'
import type {
  BrowserSelectionActionPayload,
  BrowserSurfaceState,
} from '../../shared/types'

interface BrowserPageProps {
  panel: BrowserWorkbenchPanel
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
  for (const overlay of Array.from(document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR))) {
    if (surface.contains(overlay)) continue
    const style = getComputedStyle(overlay)
    if (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.pointerEvents === 'none'
    ) continue
    const rect = overlay.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0 && rectanglesOverlap(surfaceRect, rect)) {
      return true
    }
  }
  return false
}

function getVisibleSurfaceGeometry(
  surface: HTMLElement,
): Pick<BrowserSurfaceState, 'bounds' | 'contentBounds'> {
  const rect = surface.getBoundingClientRect()
  const clip = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  }
  for (
    let ancestor = surface.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor)
    const ancestorRect = ancestor.getBoundingClientRect()
    if (style.overflowX !== 'visible') {
      clip.left = Math.max(clip.left, ancestorRect.left)
      clip.right = Math.min(clip.right, ancestorRect.right)
    }
    if (style.overflowY !== 'visible') {
      clip.top = Math.max(clip.top, ancestorRect.top)
      clip.bottom = Math.min(clip.bottom, ancestorRect.bottom)
    }
  }
  return calculateBrowserSurfaceGeometry(rect, clip)
}

export default function BrowserPage({ panel }: BrowserPageProps) {
  const { t } = useTranslation()
  const {
    activeWorkspaceId,
    onAddDraftReference,
    onAddSelectionNote,
    onCreateSession,
    onDeleteSession,
    onReferencesChange,
    rightSidebarButton,
  } = useAppShellContext()
  const hostRef = useRef<HTMLDivElement>(null)
  const leaseIdRef = useRef<string | null>(null)
  const frameRef = useRef<number | null>(null)
  const lastSurfaceStateRef = useRef<string | null>(null)
  const lastSelectionEventIdRef = useRef<string | null>(null)
  const panels = useAtomValue(workbenchPanelsAtom)
  const browserInstances = useAtomValue(browserInstancesMapAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const setChatTarget = useSetAtom(setBrowserChatTargetAtom)
  const openSessionFromBrowser = useSetAtom(openSessionFromBrowserAtom)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [isAttached, setIsAttached] = useState(false)
  const order = panels.findIndex(candidate => candidate.id === panel.id)
  const orderRef = useRef(order)
  orderRef.current = order
  const browser = panel.runtimeId
    ? browserInstances.get(panel.runtimeId)
    : undefined
  const projectSessions = useMemo(() => (
    [...sessionMetaMap.values()]
      .filter(session => (
        session.workspaceId === activeWorkspaceId
        && session.projectId === panel.projectId
        && !session.hidden
        && !session.isArchived
      ))
      .sort((left, right) => (
        (right.lastMessageAt ?? right.createdAt ?? 0)
        - (left.lastMessageAt ?? left.createdAt ?? 0)
      ))
  ), [activeWorkspaceId, panel.projectId, sessionMetaMap])
  const targetSession = panel.chatTargetSessionId
    ? sessionMetaMap.get(panel.chatTargetSessionId)
    : undefined
  const validTargetSessionId = targetSession?.workspaceId === activeWorkspaceId
    && targetSession.projectId === panel.projectId
    && !targetSession.hidden
    && !targetSession.isArchived
    ? targetSession.id
    : null

  const handleSelectionAction = useCallback(async (
    payload: BrowserSelectionActionPayload,
  ) => {
    if (
      !panel.runtimeId
      || payload.browserId !== panel.runtimeId
      || payload.eventId === lastSelectionEventIdRef.current
    ) return
    lastSelectionEventIdRef.current = payload.eventId

    const reference = browserSelectionSourceToReference(panel.projectId, payload.source)
    if (!reference) {
      toast.error(t('reference.couldNotAdd'))
      return
    }

    try {
      if (payload.action === 'add-note' || payload.action === 'add-note-to') {
        if (!validTargetSessionId) throw new Error(t('reference.chooseChatTarget'))
        if (!onAddSelectionNote) throw new Error(t('reference.addNoteUnavailable'))
        const accepted = await onAddSelectionNote(
          validTargetSessionId,
          reference,
          payload.action === 'add-note-to' ? 'choose-target' : 'current',
        )
        if (!accepted) {
          await window.electronAPI.browserPane.revealSelection(reference, panel.runtimeId)
        }
        return
      }

      if (payload.action === 'add-chat') {
        if (!validTargetSessionId) throw new Error(t('reference.chooseChatTarget'))
        if (!onAddDraftReference(validTargetSessionId, reference)) {
          throw new Error(t('reference.couldNotAdd'))
        }
        toast.success(t('reference.addedToChat'))
        return
      }

      if (!activeWorkspaceId) throw new Error(t('reference.noWorkspace'))
      const source = {
        panelId: panel.id,
        projectId: panel.projectId,
        runtimeId: panel.runtimeId,
      }
      let child: Awaited<ReturnType<typeof onCreateSession>> | null = null
      try {
        child = await onCreateSession(activeWorkspaceId, { projectId: panel.projectId })
        if (!onAddDraftReference(child.id, reference)) {
          throw new Error(t('reference.couldNotAdd'))
        }
        if (!openSessionFromBrowser({
          sessionId: child.id,
          sessionProjectId: child.projectId ?? panel.projectId,
          source,
        })) throw new Error(t('reference.couldNotOpenNewChat'))
        toast.success(t('reference.addedToNewChat'))
      } catch (error) {
        if (child) {
          onReferencesChange(child.id, [])
          await onDeleteSession(child.id, true).catch(() => false)
        }
        throw error
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('reference.couldNotAdd'))
    }
  }, [
    activeWorkspaceId,
    onAddDraftReference,
    onAddSelectionNote,
    onCreateSession,
    onDeleteSession,
    onReferencesChange,
    openSessionFromBrowser,
    panel.id,
    panel.projectId,
    panel.runtimeId,
    t,
    validTargetSessionId,
  ])

  useEffect(() => window.electronAPI.browserPane.onSelectionAction(payload => {
    void handleSelectionAction(payload)
  }), [handleSelectionAction])

  const measure = useCallback((): BrowserSurfaceState | null => {
    const host = hostRef.current
    if (!host) return null
    const geometry = getVisibleSurfaceGeometry(host)
    return {
      ...geometry,
      visible: document.visibilityState === 'visible'
        && geometry.bounds.width > 0
        && geometry.bounds.height > 0
        && !isSurfaceOccluded(host),
      order: orderRef.current < 0 ? 0 : orderRef.current,
    }
  }, [])

  const flushSurface = useCallback(() => {
    frameRef.current = null
    const state = measure()
    const leaseId = leaseIdRef.current
    if (!state || !leaseId || !panel.runtimeId) return
    const signature = JSON.stringify(state)
    if (signature === lastSurfaceStateRef.current) return
    lastSurfaceStateRef.current = signature
    void window.electronAPI.browserPane
      .updateSurface(panel.runtimeId, leaseId, state)
      .catch(error => {
        if (lastSurfaceStateRef.current === signature) lastSurfaceStateRef.current = null
        console.warn('[BrowserPage] Failed to update native surface:', error)
      })
  }, [measure, panel.runtimeId])

  const scheduleSurface = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(flushSurface)
  }, [flushSurface])

  useEffect(() => {
    scheduleSurface()
  }, [order, scheduleSurface])

  useEffect(() => {
    const host = hostRef.current
    const runtimeId = panel.runtimeId
    if (!host || !runtimeId) {
      setIsAttached(false)
      return
    }

    let disposed = false
    setIsAttached(false)
    const resizeObserver = new ResizeObserver(scheduleSurface)
    resizeObserver.observe(host)
    const intersectionObserver = new IntersectionObserver(scheduleSurface, { threshold: [0, 1] })
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
      const initialSignature = JSON.stringify(initialState)
      lastSurfaceStateRef.current = initialSignature
      void window.electronAPI.browserPane.attachSurface(runtimeId, initialState)
        .then(leaseId => {
          if (disposed) {
            return window.electronAPI.browserPane.detachSurface(runtimeId, leaseId)
          }
          leaseIdRef.current = leaseId
          setAttachError(null)
          setIsAttached(true)
          scheduleSurface()
        })
        .catch(error => {
          if (!disposed) {
            if (lastSurfaceStateRef.current === initialSignature) {
              lastSurfaceStateRef.current = null
            }
            setAttachError(error instanceof Error ? error.message : String(error))
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
      lastSurfaceStateRef.current = null
      const leaseId = leaseIdRef.current
      leaseIdRef.current = null
      if (leaseId) void window.electronAPI.browserPane.detachSurface(runtimeId, leaseId)
    }
  }, [measure, panel.runtimeId, scheduleSurface])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={browser?.title || panel.title || 'Browser'}
        actions={(
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="hidden @xl/panel:inline">{t('reference.chatTarget')}</span>
            <select
              value={validTargetSessionId ?? ''}
              aria-label={t('reference.chatTarget')}
              className="h-7 max-w-40 rounded border border-border/55 bg-background px-2 text-xs text-foreground outline-none"
              onChange={event => {
                const sessionId = event.target.value || null
                const session = sessionId ? sessionMetaMap.get(sessionId) : undefined
                setChatTarget({
                  panelId: panel.id,
                  projectId: panel.projectId,
                  sessionId,
                  sessionProjectId: session?.projectId ?? panel.projectId,
                })
              }}
            >
              <option value="">{t('reference.chooseChat')}</option>
              {projectSessions.map(session => (
                <option key={session.id} value={session.id}>
                  {session.name || session.preview || t('chat.titlePlaceholder')}
                </option>
              ))}
            </select>
          </label>
        )}
        rightSidebarButton={rightSidebarButton}
      />
      <div ref={hostRef} className="relative min-h-0 w-full flex-1 bg-background">
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          {!isAttached && (
            <div className="flex max-w-sm flex-col items-center gap-2 px-6 text-center text-xs">
              <Globe className="h-5 w-5" />
              <span>{panel.runtimeId
                ? attachError || t('common.loading')
                : t('reference.couldNotOpenSelection')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
