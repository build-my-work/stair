/**
 * BrowserTabStrip
 *
 * Rendered in the TopBar, shows compact badges for all active browser instances.
 * Each badge opens a shared action menu.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  type ReactElement,
} from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
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
} from '@/atoms/browser-pane'
import {
  focusedPanelIdAtom,
  focusedPanelRouteAtom,
  getPanelOwnerPanelId,
  openOrFocusBrowserPanelAtom,
  panelStackAtom,
} from '@/atoms/panel-stack'
import { useAppShellContext } from '@/context/AppShellContext'
import { BrowserTabBadge } from './BrowserTabBadge'
import type { BrowserInstanceInfo } from '../../../shared/types'
import { getHostname } from './utils'
import { navigate, routes } from '@/lib/navigate'

const DEFAULT_MAX_VISIBLE_BADGES = 3

interface BrowserTabStripProps {
  activeSessionId?: string | null
  instancesOverride?: BrowserInstanceInfo[]
  maxVisibleBadges?: number
  compact?: boolean
}

export function BrowserTabStrip({
  activeSessionId,
  instancesOverride,
  maxVisibleBadges = DEFAULT_MAX_VISIBLE_BADGES,
  compact = false,
}: BrowserTabStripProps): ReactElement | null {
  // Filter the badge strip to the workspace currently in focus. Remote-connected
  // workspaces have a different `remoteWorkspaceId` (what the remote agent
  // stamps onto its tabs) than the local `activeWorkspaceId` (what locally-
  // opened manual tabs use), so we accept either.
  const { activeWorkspaceId, workspaces } = useAppShellContext()
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const remoteWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId ?? null
  const allInstances = useAtomValue(browserInstancesAtom)
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  const focusedPanelRoute = useAtomValue(focusedPanelRouteAtom)
  const openBrowserPanel = useSetAtom(openOrFocusBrowserPanelAtom)
  const instances = useMemo(
    () => filterInstancesForWorkspace(allInstances, activeWorkspaceId, remoteWorkspaceId),
    [allInstances, activeWorkspaceId, remoteWorkspaceId],
  )
  const [activeInstanceId, setActiveInstanceId] = useAtom(activeBrowserInstanceIdAtom)
  const effectiveInstances = instancesOverride ?? instances

  const orderedInstances = useMemo(() => {
    const items = [...effectiveInstances]

    // Global list: keep all browser resources visible.
    // Optional ordering preference: session-local resources first.
    if (activeSessionId) {
      items.sort((a, b) => {
        const aInActiveSession = a.boundSessionId === activeSessionId ? 0 : 1
        const bInActiveSession = b.boundSessionId === activeSessionId ? 0 : 1
        if (aInActiveSession !== bInActiveSession) return aInActiveSession - bInActiveSession
        return a.id.localeCompare(b.id)
      })
    } else {
      items.sort((a, b) => a.id.localeCompare(b.id))
    }

    return items
  }, [effectiveInstances, activeSessionId])

  useEffect(() => {
    if (orderedInstances.length === 0) {
      setActiveInstanceId(null)
      return
    }
    if (!activeInstanceId || !orderedInstances.some((item) => item.id === activeInstanceId)) {
      setActiveInstanceId(orderedInstances[0].id)
    }
  }, [orderedInstances, activeInstanceId, setActiveInstanceId])

  const showBrowserPanel = useCallback((instance: BrowserInstanceInfo) => {
    setActiveInstanceId(instance.id)
    if (instancesOverride) return

    const ownerPanelId = focusedPanelId
      ? getPanelOwnerPanelId(panelStack, focusedPanelId) ?? undefined
      : undefined
    openBrowserPanel({
      browserId: instance.id,
      contextRoute: focusedPanelRoute ?? routes.view.allSessions(),
      ownerPanelId,
    })
  }, [
    focusedPanelId,
    focusedPanelRoute,
    instancesOverride,
    openBrowserPanel,
    panelStack,
    setActiveInstanceId,
  ])

  const openOwningSession = useCallback((instance: BrowserInstanceInfo) => {
    const sessionId = instance.boundSessionId ?? instance.ownerSessionId
    if (!sessionId) return
    navigate(routes.view.allSessions(sessionId))
  }, [])

  const terminateBrowser = useCallback((instance: BrowserInstanceInfo) => {
    if (instancesOverride) return
    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi) {
      console.warn('[BrowserTabStrip] browserPane API unavailable for terminate action')
      return
    }
    void browserPaneApi.destroy(instance.id).catch((error) => {
      console.warn(`[BrowserTabStrip] Failed to terminate browser ${instance.id}:`, error)
    })
  }, [instancesOverride])

  const renderBrowserActions = useCallback((instance: BrowserInstanceInfo) => {
    const canUseLiveBrowserActions = !instancesOverride
    const targetSessionId = instance.boundSessionId ?? instance.ownerSessionId
    const canOpenSession = !!targetSessionId
    const openSessionLabel = instance.agentControlActive
      ? 'Open Session Using this Window'
      : 'Open Session Which Used this Window'

    return (
      <>
        <StyledDropdownMenuItem
          disabled={!canUseLiveBrowserActions}
          onSelect={() => showBrowserPanel(instance)}
        >
          <Icons.Monitor className="h-3.5 w-3.5" />
          Show Browser Panel
        </StyledDropdownMenuItem>

        <StyledDropdownMenuItem
          disabled={!canOpenSession}
          onSelect={() => openOwningSession(instance)}
        >
          <Icons.PanelRightOpen className="h-3.5 w-3.5" />
          {openSessionLabel}
        </StyledDropdownMenuItem>

        <StyledDropdownMenuSeparator />

        <StyledDropdownMenuItem
          variant="destructive"
          disabled={!canUseLiveBrowserActions}
          onSelect={() => terminateBrowser(instance)}
        >
          <Icons.XCircle className="h-3.5 w-3.5" />
          Terminate Browser
        </StyledDropdownMenuItem>
      </>
    )
  }, [instancesOverride, openOwningSession, showBrowserPanel, terminateBrowser])

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
              style={compact ? { maxWidth: 80 } : undefined}
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
