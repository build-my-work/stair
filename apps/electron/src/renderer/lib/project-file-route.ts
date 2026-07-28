import type { PanelContentRoute, ViewRoute } from '../../shared/routes'

export type ProjectFileRoute = Extract<PanelContentRoute, { kind: 'projectFile' }>
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

/**
 * Navigation context shown by the sidebar while a file panel is focused.
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
  if (left.kind === 'navigation' && right.kind === 'navigation') {
    return left.viewRoute === right.viewRoute
  }
  if (left.kind === 'projectFile' && right.kind === 'projectFile') {
    return left.projectId === right.projectId
      && left.relativePath === right.relativePath
      && left.contextRoute === right.contextRoute
  }
  return false
}

export function getPanelContentRouteKey(route: PanelContentRoute): string {
  return JSON.stringify(
    route.kind === 'navigation'
      ? ['navigation', route.viewRoute]
      : [
          'projectFile',
          route.projectId,
          route.relativePath,
          route.contextRoute,
        ],
  )
}
