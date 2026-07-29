import type { PanelContentRoute, ViewRoute } from '../../shared/routes'

export type ProjectFileRoute = Extract<PanelContentRoute, { kind: 'projectFile' }>
export type BrowserPanelRoute = Extract<PanelContentRoute, { kind: 'browser' }>
type NavigationPanelRoute = Extract<PanelContentRoute, { kind: 'navigation' }>

export function buildNavigationPanelRoute(viewRoute: ViewRoute): NavigationPanelRoute {
  return { kind: 'navigation', viewRoute }
}

export function buildProjectFileRoute(input: {
  projectId: string
  relativePath: string
  contextRoute: ViewRoute
}): ProjectFileRoute {
  return {
    kind: 'projectFile',
    projectId: input.projectId,
    relativePath: input.relativePath,
    contextRoute: input.contextRoute,
  }
}

export function isProjectFileRoute(route: PanelContentRoute): route is ProjectFileRoute {
  return route.kind === 'projectFile'
}

export function buildBrowserPanelRoute(input: {
  browserId: string
  contextRoute: ViewRoute
}): BrowserPanelRoute {
  return {
    kind: 'browser',
    browserId: input.browserId,
    contextRoute: input.contextRoute,
  }
}

export function isBrowserPanelRoute(
  route: PanelContentRoute,
): route is BrowserPanelRoute {
  return route.kind === 'browser'
}

export function isCompanionPanelRoute(
  route: PanelContentRoute,
): route is ProjectFileRoute | BrowserPanelRoute {
  return route.kind === 'projectFile' || route.kind === 'browser'
}

/**
 * Navigation context shown by the sidebar while a companion panel is focused.
 * This is deliberately not the physical owner relationship.
 */
export function getPanelContextRoute(route: PanelContentRoute): ViewRoute {
  return route.kind === 'navigation' ? route.viewRoute : route.contextRoute
}

export function panelContentRoutesEqual(
  left: PanelContentRoute,
  right: PanelContentRoute,
): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'navigation':
      return right.kind === 'navigation'
        && left.viewRoute === right.viewRoute
    case 'projectFile':
      return right.kind === 'projectFile'
        && left.projectId === right.projectId
        && left.relativePath === right.relativePath
        && left.contextRoute === right.contextRoute
    case 'browser':
      return right.kind === 'browser'
        && left.browserId === right.browserId
        && left.contextRoute === right.contextRoute
  }
}

export function getPanelContentRouteKey(route: PanelContentRoute): string {
  switch (route.kind) {
    case 'navigation':
      return JSON.stringify(['navigation', route.viewRoute])
    case 'projectFile':
      return JSON.stringify([
        'projectFile',
        route.projectId,
        route.relativePath,
        route.contextRoute,
      ])
    case 'browser':
      return JSON.stringify([
        'browser',
        route.browserId,
        route.contextRoute,
      ])
  }
}
