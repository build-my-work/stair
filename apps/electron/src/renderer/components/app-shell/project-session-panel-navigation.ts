import type { createStore } from 'jotai'
import {
  focusedPanelIdAtom,
  panelStackAtom,
  parseSessionIdFromRoute,
} from '@/atoms/panel-stack'
import { isCompanionPanelRoute } from '@/lib/project-file-route'
import { routes } from '@/lib/navigate'
import type { ViewRoute } from '../../../shared/routes'

type JotaiStore = ReturnType<typeof createStore>

/**
 * Focus an already-open Session without creating another panel.
 *
 * Session panels can have been opened through a generic Sessions route before
 * the caller enters another navigation context. Rebase that physical panel and
 * its companion panels onto the requested canonical route.
 */
export function focusExistingSessionPanel(
  store: JotaiStore,
  canonicalRoute: ViewRoute,
  sessionId: string,
): boolean {
  const stack = store.get(panelStackAtom)
  const matchingPanel = stack.find(
    entry => (
      entry.route.kind === 'navigation'
      && entry.route.viewRoute === canonicalRoute
      && parseSessionIdFromRoute(entry.route) === sessionId
    ),
  ) ?? stack.find(
    entry => (
      entry.route.kind === 'navigation'
      && parseSessionIdFromRoute(entry.route) === sessionId
    ),
  )

  if (!matchingPanel) return false

  let routeChanged = false
  const canonicalStack = stack.map((entry) => {
    if (
      entry.id === matchingPanel.id
      && entry.route.kind === 'navigation'
      && entry.route.viewRoute !== canonicalRoute
    ) {
      routeChanged = true
      return {
        ...entry,
        route: { kind: 'navigation' as const, viewRoute: canonicalRoute },
      }
    }

    if (!isCompanionPanelRoute(entry.route)) return entry

    if (
      entry.ownerPanelId !== matchingPanel.id
      || entry.route.contextRoute === canonicalRoute
    ) {
      return entry
    }

    routeChanged = true
    return {
      ...entry,
      route: {
        ...entry.route,
        contextRoute: canonicalRoute,
      },
    }
  })

  if (routeChanged) {
    store.set(panelStackAtom, canonicalStack)
  }
  store.set(focusedPanelIdAtom, matchingPanel.id)
  return true
}

export function focusExistingProjectSessionPanel(
  store: JotaiStore,
  projectSlug: string,
  sessionId: string,
): boolean {
  return focusExistingSessionPanel(
    store,
    routes.view.projectSession(projectSlug, sessionId),
    sessionId,
  )
}
