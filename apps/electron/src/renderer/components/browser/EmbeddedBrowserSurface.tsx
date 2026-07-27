import * as React from 'react'
import { AlertCircle, Globe2, Loader2, RefreshCw } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'

import {
  browserInstancesMapAtom,
  removeBrowserInstanceAtom,
  updateBrowserInstanceAtom,
} from '@/atoms/browser-pane'
import { Button } from '@/components/ui/button'
import { useAppShellContext } from '@/context/AppShellContext'
import { hasOpenOverlay } from '@/lib/overlay-detection'
import { cn } from '@/lib/utils'

interface EmbeddedBrowserSurfaceProps {
  instanceId: string
  className?: string
  onTitleChange?: (title: string) => void
}

interface BrowserSurfaceBounds {
  x: number
  y: number
  width: number
  height: number
}

function isFullyVisible(element: HTMLElement, rect: DOMRect): boolean {
  const tolerance = 1
  if (
    rect.width < tolerance
    || rect.height < tolerance
    || rect.left < -tolerance
    || rect.top < -tolerance
    || rect.right > window.innerWidth + tolerance
    || rect.bottom > window.innerHeight + tolerance
  ) {
    return false
  }

  let ancestor = element.parentElement
  while (ancestor) {
    const style = window.getComputedStyle(ancestor)
    const clipsX = style.overflowX !== 'visible'
    const clipsY = style.overflowY !== 'visible'
    if (clipsX || clipsY) {
      const ancestorRect = ancestor.getBoundingClientRect()
      if (
        (clipsX && (
          rect.left < ancestorRect.left - tolerance
          || rect.right > ancestorRect.right + tolerance
        ))
        || (clipsY && (
          rect.top < ancestorRect.top - tolerance
          || rect.bottom > ancestorRect.bottom + tolerance
        ))
      ) {
        return false
      }
    }
    ancestor = ancestor.parentElement
  }
  return true
}

function readSurfaceBounds(element: HTMLElement): BrowserSurfaceBounds | null {
  const rect = element.getBoundingClientRect()
  if (!isFullyVisible(element, rect)) return null
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function equalBounds(left: BrowserSurfaceBounds | null, right: BrowserSurfaceBounds): boolean {
  return Boolean(
    left
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height,
  )
}

export function EmbeddedBrowserSurface({
  instanceId,
  className,
  onTitleChange,
}: EmbeddedBrowserSurfaceProps) {
  const { isFocusedPanel } = useAppShellContext()
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  const browserInfo = useAtomValue(browserInstancesMapAtom).get(instanceId)
  const updateBrowserInfo = useSetAtom(updateBrowserInstanceAtom)
  const removeBrowserInfo = useSetAtom(removeBrowserInstanceAtom)
  const titleChangeRef = React.useRef(onTitleChange)
  const [listChecked, setListChecked] = React.useState(Boolean(browserInfo))
  const [attachError, setAttachError] = React.useState<string | null>(null)
  const [attaching, setAttaching] = React.useState(false)
  const [retryNonce, setRetryNonce] = React.useState(0)
  const canAttach = isFocusedPanel !== false
  const browserAvailable = Boolean(browserInfo)

  titleChangeRef.current = onTitleChange

  React.useEffect(() => {
    const api = window.electronAPI.browserPane
    let disposed = false

    void api.list()
      .then((instances) => {
        if (disposed) return
        const instance = instances.find(item => item.id === instanceId)
        if (instance) {
          updateBrowserInfo(instance)
        } else {
          removeBrowserInfo(instanceId)
        }
        setListChecked(true)
      })
      .catch((error) => {
        if (disposed) return
        setListChecked(true)
        setAttachError(error instanceof Error ? error.message : String(error))
      })

    const cleanupState = api.onStateChanged((info) => {
      if (info.id !== instanceId) return
      updateBrowserInfo(info)
      setListChecked(true)
    })
    const cleanupRemoved = api.onRemoved((removedId) => {
      if (removedId !== instanceId) return
      removeBrowserInfo(removedId)
      setListChecked(true)
    })

    return () => {
      disposed = true
      cleanupState()
      cleanupRemoved()
    }
  }, [instanceId, removeBrowserInfo, updateBrowserInfo])

  React.useEffect(() => {
    const title = browserInfo?.title.trim()
    if (title) titleChangeRef.current?.(title)
  }, [browserInfo?.title])

  React.useLayoutEffect(() => {
    const element = surfaceRef.current
    const api = window.electronAPI.browserPane
    if (!element || !browserAvailable || !canAttach) return

    let disposed = false
    let attached = false
    let syncing = false
    let pendingSync = false
    let frameId: number | null = null
    let positionFrameId: number | null = null
    let lastBounds: BrowserSurfaceBounds | null = null
    let blockedAfterError = false
    let lastTrackedRect = ''
    let stableFrames = 0
    let remainingTrackingFrames = 0

    const syncBounds = async () => {
      if (disposed || blockedAfterError) return
      if (syncing) {
        pendingSync = true
        return
      }

      const bounds = hasOpenOverlay() ? null : readSurfaceBounds(element)
      if (!bounds) {
        if (!attached) return
        syncing = true
        attached = false
        lastBounds = null
        try {
          await api.detach(instanceId)
        } catch (error) {
          if (!disposed) {
            blockedAfterError = true
            setAttachError(error instanceof Error ? error.message : String(error))
          }
        } finally {
          syncing = false
        }
        return
      }
      if (attached && equalBounds(lastBounds, bounds)) {
        return
      }

      syncing = true
      pendingSync = false
      setAttaching(!attached)
      try {
        if (attached) {
          await api.updateBounds(instanceId, bounds)
        } else {
          await api.attach(instanceId, bounds)
          attached = true
        }
        lastBounds = bounds
        if (!disposed) setAttachError(null)
      } catch (error) {
        if (!disposed) {
          blockedAfterError = true
          setAttachError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        syncing = false
        if (!disposed) setAttaching(false)
        if (pendingSync && !disposed) scheduleSync()
      }
    }

    const scheduleSync = () => {
      if (disposed || frameId !== null) return
      frameId = requestAnimationFrame(() => {
        frameId = null
        void syncBounds()
      })
    }

    const trackPosition = () => {
      if (disposed || positionFrameId !== null) return
      positionFrameId = requestAnimationFrame(() => {
        positionFrameId = null
        if (disposed) return
        const rect = element.getBoundingClientRect()
        const rectKey = `${rect.left}:${rect.top}:${rect.width}:${rect.height}`
        stableFrames = rectKey === lastTrackedRect ? stableFrames + 1 : 0
        lastTrackedRect = rectKey
        remainingTrackingFrames -= 1
        scheduleSync()
        if (stableFrames < 4 && remainingTrackingFrames > 0) trackPosition()
      })
    }

    const startTracking = () => {
      stableFrames = 0
      remainingTrackingFrames = 120
      trackPosition()
    }

    const observer = new ResizeObserver(startTracking)
    observer.observe(element)
    const panel = element.closest('[data-panel-role="content"]')
    const mutationObserver = new MutationObserver(startTracking)
    if (panel) {
      mutationObserver.observe(panel, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      })
    }
    let appOverlayBlocked = hasOpenOverlay()
    const overlayObserver = new MutationObserver(() => {
      const nextBlocked = hasOpenOverlay()
      if (nextBlocked === appOverlayBlocked) return
      appOverlayBlocked = nextBlocked
      startTracking()
      scheduleSync()
    })
    overlayObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-state',
        'role',
        'data-slot',
        'data-inline-menu',
        'data-ca-island-dialog',
      ],
    })
    window.addEventListener('resize', startTracking)
    window.addEventListener('scroll', startTracking, true)
    window.addEventListener('transitionrun', startTracking, true)
    window.addEventListener('transitionend', startTracking, true)
    window.addEventListener('animationstart', startTracking, true)
    window.addEventListener('animationend', startTracking, true)
    scheduleSync()
    startTracking()

    return () => {
      disposed = true
      observer.disconnect()
      mutationObserver.disconnect()
      overlayObserver.disconnect()
      window.removeEventListener('resize', startTracking)
      window.removeEventListener('scroll', startTracking, true)
      window.removeEventListener('transitionrun', startTracking, true)
      window.removeEventListener('transitionend', startTracking, true)
      window.removeEventListener('animationstart', startTracking, true)
      window.removeEventListener('animationend', startTracking, true)
      if (frameId !== null) cancelAnimationFrame(frameId)
      if (positionFrameId !== null) cancelAnimationFrame(positionFrameId)
      void api.detach(instanceId).catch(() => {})
    }
  }, [browserAvailable, canAttach, instanceId, retryNonce])

  const stateMessage = !canAttach
    ? {
        icon: <Globe2 className="size-7" strokeWidth={1.35} />,
        title: 'Browser paused',
        description: 'Select this panel to continue browsing.',
      }
    : !listChecked
      ? {
          icon: <Loader2 className="size-5 animate-spin" />,
          title: 'Opening browser',
          description: 'Attaching the page to this workspace…',
        }
      : !browserInfo
        ? {
            icon: <Globe2 className="size-7" strokeWidth={1.35} />,
            title: 'Browser unavailable',
            description: 'This browser instance is no longer running. Close this tab and open a new page.',
          }
        : null

  return (
    <div
      ref={surfaceRef}
      aria-label={stateMessage ? undefined : browserInfo?.title || 'Embedded browser'}
      className={cn('h-full min-h-0 w-full bg-background', className)}
    >
      {stateMessage ? (
        <BrowserSurfaceMessage {...stateMessage} />
      ) : (
        <>
          {attaching && (
            <BrowserSurfaceMessage
              icon={<Loader2 className="size-5 animate-spin" />}
              title="Opening browser"
              description="Attaching the page to this workspace…"
            />
          )}
          {attachError && (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div className="max-w-sm">
                <AlertCircle className="mx-auto size-7 text-destructive" />
                <div className="mt-3 text-sm font-medium text-foreground">Couldn’t attach browser</div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{attachError}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4 gap-2"
                  onClick={() => setRetryNonce(value => value + 1)}
                >
                  <RefreshCw className="size-3.5" />
                  Try again
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function BrowserSurfaceMessage({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8 text-center">
      <div className="max-w-xs">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground/65">
          {icon}
        </div>
        <div className="mt-3 text-sm font-medium text-foreground">{title}</div>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
