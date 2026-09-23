/**
 * BrowserTabStrip
 *
 * Rendered in the TopBar, shows compact badges for all active browser instances.
 * Each badge opens a shared action menu.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import {
  activeBrowserInstanceIdAtom,
  browserInstancesAtom,
  filterInstancesForWorkspace,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
  removeBrowserInstanceAtom,
} from '@/atoms/browser-pane'
import { useAppShellContext } from '@/context/AppShellContext'
import { BrowserTabBadge } from './BrowserTabBadge'
import type { BrowserInstanceInfo } from '../../../shared/types'
import { getHostname } from './utils'

const DEFAULT_MAX_VISIBLE_BADGES = 3

interface BrowserTabStripProps {
  activeSessionId?: string | null
  activeProjectId?: string | null
  instancesOverride?: BrowserInstanceInfo[]
  maxVisibleBadges?: number
}

export function BrowserTabStrip({
  activeSessionId,
  activeProjectId,
  instancesOverride,
  maxVisibleBadges = DEFAULT_MAX_VISIBLE_BADGES,
}: BrowserTabStripProps) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const allInstances = useAtomValue(browserInstancesAtom)
  const instances = useMemo(() => {
    const workspaceInstances = filterInstancesForWorkspace(
      allInstances,
      activeWorkspaceId,
    )
    if (!activeProjectId) return []
    return workspaceInstances.filter(instance => instance.projectId === activeProjectId)
  }, [allInstances, activeWorkspaceId, activeProjectId])
  const setInstances = useSetAtom(setBrowserInstancesAtom)
  const updateInstance = useSetAtom(updateBrowserInstanceAtom)
  const removeInstance = useSetAtom(removeBrowserInstanceAtom)
  const [activeInstanceId, setActiveInstanceId] = useAtom(activeBrowserInstanceIdAtom)
  const effectiveInstances = instancesOverride ?? instances
  const instancesRef = useRef(effectiveInstances)
  const removeReconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const orderedInstances = useMemo(() => {
    const items = [...effectiveInstances]

    // Keep the active Chat's target windows first, then use a stable ID order.
    items.sort((a, b) => {
      if (activeSessionId) {
        const aInActiveSession = a.targetSessionId === activeSessionId ? 0 : 1
        const bInActiveSession = b.targetSessionId === activeSessionId ? 0 : 1
        if (aInActiveSession !== bInActiveSession) return aInActiveSession - bInActiveSession
      }
      return a.id.localeCompare(b.id)
    })

    return items
  }, [effectiveInstances, activeSessionId])

  useEffect(() => {
    instancesRef.current = effectiveInstances
  }, [effectiveInstances])

  useEffect(() => {
    if (instancesOverride) return
    let cancelled = false

    const browserPaneApi = window.electronAPI?.browserPane
    if (
      !browserPaneApi
      || !activeProjectId
      || !window.electronAPI.isChannelAvailable('browser-pane:list')
    ) {
      setInstances([])
      setActiveInstanceId(null)
      return () => { cancelled = true }
    }

    browserPaneApi.list(activeProjectId)
      .then((items) => {
        if (cancelled) return
        setInstances(items)
        if (items.length === 0) {
          setActiveInstanceId(null)
          return
        }
        setActiveInstanceId((prev) => prev ?? items[0].id)
      })
      .catch((error) => {
        if (cancelled) return
        console.warn('[BrowserTabStrip] Failed to list Browser windows:', error)
        setInstances([])
        setActiveInstanceId(null)
      })
    return () => { cancelled = true }
  }, [activeProjectId, instancesOverride, setInstances, setActiveInstanceId])

  useEffect(() => {
    if (instancesOverride) return
    let cancelled = false

    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi || !window.electronAPI.isChannelAvailable('browser-pane:list')) return

    const cleanupState = browserPaneApi.onStateChanged((info: BrowserInstanceInfo) => {
      if (cancelled) return
      updateInstance(info)
    })

    const cleanupRemoved = browserPaneApi.onRemoved((id: string) => {
      if (cancelled) return
      removeInstance(id)
      setActiveInstanceId((prev) => {
        if (prev !== id) return prev
        const remaining = instancesRef.current.filter((item) => item.id !== id)
        return remaining[0]?.id ?? null
      })

      if (removeReconcileTimerRef.current) {
        clearTimeout(removeReconcileTimerRef.current)
      }

      removeReconcileTimerRef.current = setTimeout(() => {
        removeReconcileTimerRef.current = null
        if (!activeProjectId) return
        void browserPaneApi.list(activeProjectId)
          .then((items) => {
            if (cancelled) return
            setInstances(items)
            setActiveInstanceId((prev) => {
              if (!prev) return items[0]?.id ?? null
              return items.some((item) => item.id === prev) ? prev : (items[0]?.id ?? null)
            })
          })
          .catch((error) => {
            if (cancelled) return
            console.warn('[BrowserTabStrip] Reconcile list failed after remove:', error)
          })
      }, 75)
    })

    const cleanupInteracted = browserPaneApi.onInteracted((id: string) => {
      if (cancelled) return
      setActiveInstanceId(id)
    })

    return () => {
      cancelled = true
      cleanupState()
      cleanupRemoved()
      cleanupInteracted()
      if (removeReconcileTimerRef.current) {
        clearTimeout(removeReconcileTimerRef.current)
        removeReconcileTimerRef.current = null
      }
    }
  }, [activeProjectId, instancesOverride, updateInstance, removeInstance, setActiveInstanceId, setInstances])

  useEffect(() => {
    if (orderedInstances.length === 0) {
      setActiveInstanceId(null)
      return
    }
    if (!activeInstanceId || !orderedInstances.some((item) => item.id === activeInstanceId)) {
      setActiveInstanceId(orderedInstances[0].id)
    }
  }, [orderedInstances, activeInstanceId, setActiveInstanceId])

  const focusBrowserWindow = useCallback((instance: BrowserInstanceInfo) => {
    setActiveInstanceId(instance.id)
    if (instancesOverride) return

    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi) {
      console.warn('[BrowserTabStrip] browserPane API unavailable for focus action')
      return
    }

    if (!instance.projectId) return
    void browserPaneApi.focus(instance.id, instance.projectId).catch((error) => {
      console.warn(`[BrowserTabStrip] Failed to focus browser window ${instance.id}:`, error)
    })
  }, [instancesOverride, setActiveInstanceId])

  const openTargetChat = useCallback((instance: BrowserInstanceInfo) => {
    if (!instance.targetSessionId || instancesOverride) return
    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi) return
    if (!instance.projectId) return
    void browserPaneApi.openTargetChat(instance.id, instance.projectId).catch((error) => {
      console.warn(`[BrowserTabStrip] Failed to open target Chat for ${instance.id}:`, error)
    })
  }, [instancesOverride])

  const toggleBrowserWindow = useCallback((instance: BrowserInstanceInfo) => {
    if (instancesOverride) return
    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi) return
    const action = instance.isVisible ? 'hide' : 'show'
    if (!instance.projectId) return
    const request = action === 'hide'
      ? browserPaneApi.hide(instance.id, instance.projectId)
      : browserPaneApi.focus(instance.id, instance.projectId)
    void request.catch((error) => {
      console.warn(`[BrowserTabStrip] Failed to ${action} browser window ${instance.id}:`, error)
    })
  }, [instancesOverride])

  const terminateBrowserWindow = useCallback((instance: BrowserInstanceInfo) => {
    if (instancesOverride) return
    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi) {
      console.warn('[BrowserTabStrip] browserPane API unavailable for terminate action')
      return
    }
    if (!instance.projectId) return
    // Keep the entry until the main process confirms destruction through REMOVED.
    // Otherwise a failed RPC creates a tombstone for a BrowserWindow that is still alive.
    void browserPaneApi.destroy(instance.id, instance.projectId).catch((error) => {
      console.warn(`[BrowserTabStrip] Failed to terminate browser window ${instance.id}:`, error)
    })
  }, [instancesOverride])

  const renderBrowserActions = useCallback((instance: BrowserInstanceInfo) => {
    const canUseLiveWindowActions = !instancesOverride
    const canOpenTargetChat = !!instance.targetSessionId

    return (
      <>
        <StyledDropdownMenuItem
          disabled={!canUseLiveWindowActions}
          onSelect={() => focusBrowserWindow(instance)}
        >
          <Icons.Monitor className="h-3.5 w-3.5" />
          {t('browser.focusWindow')}
        </StyledDropdownMenuItem>

        <StyledDropdownMenuItem
          disabled={!canUseLiveWindowActions}
          onSelect={() => toggleBrowserWindow(instance)}
        >
          {instance.isVisible
            ? <Icons.EyeOff className="h-3.5 w-3.5" />
            : <Icons.Eye className="h-3.5 w-3.5" />}
          {instance.isVisible ? t('browser.hideWindow') : t('browser.showWindow')}
        </StyledDropdownMenuItem>

        <StyledDropdownMenuItem
          disabled={!canOpenTargetChat}
          onSelect={() => openTargetChat(instance)}
        >
          <Icons.PanelRightOpen className="h-3.5 w-3.5" />
          {t('browser.openTargetChat')}
        </StyledDropdownMenuItem>

        <StyledDropdownMenuSeparator />

        <StyledDropdownMenuItem
          variant="destructive"
          disabled={!canUseLiveWindowActions}
          onSelect={() => terminateBrowserWindow(instance)}
        >
          <Icons.XCircle className="h-3.5 w-3.5" />
          {t('browser.terminateBrowser')}
        </StyledDropdownMenuItem>
      </>
    )
  }, [instancesOverride, focusBrowserWindow, openTargetChat, t, terminateBrowserWindow, toggleBrowserWindow])

  if (orderedInstances.length === 0) return null

  const visibleBadgeCount = Math.max(1, maxVisibleBadges)
  const visible = orderedInstances.slice(0, visibleBadgeCount)
  const overflow = orderedInstances.slice(visibleBadgeCount)

  return (
    <div className="flex items-center gap-1.5">
      {visible.map((instance) => (
        <DropdownMenu key={instance.id}>
          <DropdownMenuTrigger asChild>
            <BrowserTabBadge
              instance={instance}
              isActive={instance.id === activeInstanceId}
            />
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end" minWidth="min-w-56">
            {renderBrowserActions(instance)}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      ))}

      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="h-[26px] px-1.5 rounded-lg text-[11px] text-foreground/50 bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors cursor-pointer titlebar-no-drag"
            >
              +{overflow.length}
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end" minWidth="min-w-64">
            {overflow.map((instance) => {
              const hostname = getHostname(instance.url)
              const displayLabel = instance.title.trim() || hostname || 'Local File'
              return (
                <DropdownMenuSub key={instance.id}>
                  <StyledDropdownMenuSubTrigger>
                    {instance.isLoading ? (
                      <Spinner className="text-[10px]" />
                    ) : (
                      <Icons.Globe className="h-3.5 w-3.5" />
                    )}
                    <span className="truncate">{displayLabel}</span>
                  </StyledDropdownMenuSubTrigger>
                  <StyledDropdownMenuSubContent minWidth="min-w-56">
                    {renderBrowserActions(instance)}
                  </StyledDropdownMenuSubContent>
                </DropdownMenuSub>
              )
            })}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
