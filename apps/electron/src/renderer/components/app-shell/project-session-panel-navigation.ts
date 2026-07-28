import type { createStore } from 'jotai'
import {
  focusedPanelIdAtom,
  panelStackAtom,
  parseSessionIdFromRoute,
} from '@/atoms/panel-stack'
import { isProjectFileRoute } from '@/lib/project-file-route'
import { routes } from '@/lib/navigate'

type JotaiStore = ReturnType<typeof createStore>

/**
 * Focus an already-open project session without creating another panel.
 *
 * Session panels can have been opened through a generic Sessions route before
 * the user enters the owning Project. Rebase that physical panel (and any file
 * companion it owns) onto the Project route so the focused navigation context
 * agrees with the sidebar entry the user clicked.
 */
export function focusExistingProjectSessionPanel(
  store: JotaiStore,
  projectSlug: string,
  sessionId: string,
): boolean {
  const stack = store.get(panelStackAtom)
  const projectRoute = routes.view.projectSession(projectSlug, sessionId)
  const matchingPanel = stack.find(
    entry => (
      entry.route.kind === 'navigation'
      && entry.route.viewRoute === projectRoute
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
      && entry.route.viewRoute !== projectRoute
    ) {
      routeChanged = true
      return {
        ...entry,
        route: { kind: 'navigation' as const, viewRoute: projectRoute },
      }
    }

    if (!isProjectFileRoute(entry.route)) return entry

    if (
      entry.ownerPanelId !== matchingPanel.id
      || entry.route.contextRoute === projectRoute
    ) {
      return entry
    }

    routeChanged = true
    return {
      ...entry,
      route: {
        ...entry.route,
        contextRoute: projectRoute,
      },
    }
  })

  if (routeChanged) {
    store.set(panelStackAtom, canonicalStack)
  }
  store.set(focusedPanelIdAtom, matchingPanel.id)
  return true
}
