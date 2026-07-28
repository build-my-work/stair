import type { PanelContentRoute } from '../../shared/routes'
import { serializePanelLayoutV1 } from '@/lib/panel-layout-codec'

interface SemanticHistoryKeyInput {
  workspaceSlug: string | null
  panelRoutes: string[]
  focusedPanelIndex: number
  sidebarParam: string
}

interface InitialRestoreGateInput {
  isReady: boolean
  isSessionsReady: boolean
  workspaceId: string | null
  initialRouteRestored: boolean
}

interface PanelLayoutUrlEntry {
  id: string
  route: PanelContentRoute
  proportion: number
  ownerPanelId?: string
}

/**
 * Keep the versioned physical panel layout in the current navigation URL.
 */
export function updatePanelLayoutSearchParam(
  searchParams: URLSearchParams,
  panels: readonly PanelLayoutUrlEntry[],
  focusedPanelId: string | null,
): string | null {
  const layout = serializePanelLayoutV1(panels, focusedPanelId)
  if (layout) {
    searchParams.set('layout', layout)
  } else {
    searchParams.delete('layout')
  }
  return layout
}

/**
 * Builds a semantic history key used to dedupe pushState entries.
 *
 * Includes focused panel index so states with duplicate routes remain distinct
 * when focus moves between panels.
 */
export function buildSemanticHistoryKey({
  workspaceSlug,
  panelRoutes,
  focusedPanelIndex,
  sidebarParam,
}: SemanticHistoryKeyInput): string {
  return JSON.stringify([
    workspaceSlug ?? '',
    panelRoutes,
    focusedPanelIndex,
    sidebarParam,
  ])
}

/**
 * Returns whether initial route restoration is allowed to run.
 */
export function canRunInitialRestore({
  isReady,
  isSessionsReady,
  workspaceId,
  initialRouteRestored,
}: InitialRestoreGateInput): boolean {
  return isReady && isSessionsReady && !!workspaceId && !initialRouteRestored
}
