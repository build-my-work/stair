/**
 * Panel Stack State
 *
 * Single-lane panel model for side-by-side content panels.
 */

import { atom } from 'jotai'
import type { ProjectFileOpenIntent } from '@craft-agent/core'
import { parseRouteToNavigationState } from '../../shared/route-parser'
import type { PanelContentRoute, ViewRoute } from '../../shared/routes'
import {
  MAX_PANEL_LAYOUT_ENTRIES,
  type SerializedPanelLayoutV2,
} from '@/lib/panel-layout-codec'
import {
  getDefaultPanelWidthRatio,
} from '@/lib/panel-sizing'
import {
  buildNavigationPanelRoute,
  buildBrowserPanelRoute,
  buildProjectFileRoute,
  getPanelContextRoute,
  isBrowserPanelRoute,
  isCompanionPanelRoute,
  isProjectFileRoute,
} from '@/lib/project-file-route'

let nextPanelId = 0
function generatePanelId(): string {
  return `panel-${++nextPanelId}-${Date.now()}`
}

export interface PanelStackEntry {
  id: string
  route: PanelContentRoute
  /** Independent share of the visible PanelStack width. Never normalized. */
  widthRatio: number
  /** Physical navigation panel that owns this companion presentation. */
  ownerPanelId?: string
  /** Explicit Session that receives references from this companion panel. */
  chatTargetSessionId?: string
}

export const panelStackAtom = atom<PanelStackEntry[]>([])
export const focusedPanelIdAtom = atom<string | null>(null)
export const projectFileOpenIntentsAtom = atom<Map<string, ProjectFileOpenIntent>>(new Map())
export const panelViewportWidthAtom = atom(
  typeof document === 'undefined'
    ? 0
    : document.documentElement.clientWidth,
)

export const panelCountAtom = atom((get) => get(panelStackAtom).length)

export const focusedPanelIndexAtom = atom((get) => {
  const stack = get(panelStackAtom)
  const focusedId = get(focusedPanelIdAtom)
  if (!focusedId) return 0
  const idx = stack.findIndex(panel => panel.id === focusedId)
  return idx === -1 ? 0 : idx
})

export const focusedPanelContentRouteAtom = atom((get) => {
  const stack = get(panelStackAtom)
  const idx = get(focusedPanelIndexAtom)
  return stack[idx]?.route ?? null
})

/**
 * Logical navigation context for sidebar and Session selection.
 *
 * A companion panel keeps its own content route while exposing the
 * navigation context from which it was opened.
 */
export const focusedPanelRouteAtom = atom((get) => {
  const route = get(focusedPanelContentRouteAtom)
  return route ? getPanelContextRoute(route) : null
})

function toPanelContentRoute(route: ViewRoute | PanelContentRoute): PanelContentRoute {
  return typeof route === 'string' ? buildNavigationPanelRoute(route) : route
}

interface CreatePanelEntryOptions {
  widthRatio?: number
  panelViewportWidth?: number
  id?: string
  ownerPanelId?: string
  chatTargetSessionId?: string
}

function createEntry(
  input: ViewRoute | PanelContentRoute,
  {
    widthRatio,
    panelViewportWidth,
    id,
    ownerPanelId,
    chatTargetSessionId,
  }: CreatePanelEntryOptions = {},
): PanelStackEntry {
  const route = toPanelContentRoute(input)
  const validWidthRatio = (
    typeof widthRatio === 'number'
    && Number.isFinite(widthRatio)
    && widthRatio > 0
  )
    ? widthRatio
    : getDefaultPanelWidthRatio(route, panelViewportWidth ?? 0)
  return {
    id: id ?? generatePanelId(),
    route,
    widthRatio: validWidthRatio,
    ...(ownerPanelId ? { ownerPanelId } : {}),
    ...(isCompanionPanelRoute(route) && chatTargetSessionId
      ? { chatTargetSessionId }
      : {}),
  }
}

function findNavigationPanel(
  stack: PanelStackEntry[],
  panelId?: string,
): PanelStackEntry | undefined {
  if (!panelId) return undefined
  return stack.find(entry => (
    entry.id === panelId && entry.route.kind === 'navigation'
  ))
}

export function parseSessionIdFromRoute(
  input: ViewRoute | PanelContentRoute,
): string | null {
  const route = toPanelContentRoute(input)
  const navState = parseRouteToNavigationState(getPanelContextRoute(route))
  if (!navState) return null
  if (navState.navigator === 'sessions') return navState.details?.sessionId ?? null
  if (navState.navigator === 'projects') return navState.details?.sessionId ?? null
  return null
}

export const focusedSessionIdAtom = atom((get) => {
  const route = get(focusedPanelRouteAtom)
  if (!route) return null
  return parseSessionIdFromRoute(route)
})

/**
 * Session ids rendered by navigation panels. Companion panels expose a
 * navigation context but do not render duplicate chats.
 */
export const visibleSessionIdsAtom = atom((get) => {
  const ids = new Set<string>()
  for (const entry of get(panelStackAtom)) {
    if (isCompanionPanelRoute(entry.route)) continue
    const id = parseSessionIdFromRoute(entry.route)
    if (id) ids.add(id)
  }
  return ids
})

export const pushPanelAtom = atom(
  null,
  (get, set, { route, afterIndex, ownerPanelId }: {
    route: ViewRoute | PanelContentRoute
    afterIndex?: number
    ownerPanelId?: string
  }) => {
    const stack = get(panelStackAtom)
    if (stack.length >= MAX_PANEL_LAYOUT_ENTRIES) return
    let insertAt = stack.length
    if (afterIndex !== undefined && afterIndex >= 0 && afterIndex < stack.length) {
      insertAt = afterIndex + 1
    }

    const contentRoute = toPanelContentRoute(route)
    const validOwnerId = isCompanionPanelRoute(contentRoute)
      ? findNavigationPanel(stack, ownerPanelId)?.id
      : undefined
    const newEntry = createEntry(contentRoute, {
      panelViewportWidth: get(panelViewportWidthAtom),
      ownerPanelId: validOwnerId,
    })
    const newStack = [
      ...stack.slice(0, insertAt),
      newEntry,
      ...stack.slice(insertAt),
    ]

    set(panelStackAtom, newStack)
    set(focusedPanelIdAtom, newEntry.id)
    return newEntry.id
  },
)

/**
 * Resolve the physical navigation owner of a panel.
 *
 * Owner is an explicit runtime instance relationship. It is never inferred
 * from route equality or panel position.
 */
export function getPanelOwnerPanelId(
  stack: PanelStackEntry[],
  panelId: string,
): string | null {
  const panel = stack.find(entry => entry.id === panelId)
  if (!panel) return null
  if (!isCompanionPanelRoute(panel.route)) return panel.id
  if (!panel.ownerPanelId) return null

  return findNavigationPanel(stack, panel.ownerPanelId)?.id ?? null
}

export const setCompanionChatTargetAtom = atom(
  null,
  (get, set, {
    panelId,
    sessionId,
  }: {
    panelId: string
    sessionId: string
  }) => {
    if (!sessionId) return
    const stack = get(panelStackAtom)
    const panel = stack.find(entry => entry.id === panelId)
    if (
      !panel
      || !isCompanionPanelRoute(panel.route)
      || panel.chatTargetSessionId === sessionId
    ) {
      return
    }
    set(panelStackAtom, stack.map(entry => (
      entry.id === panelId
        ? { ...entry, chatTargetSessionId: sessionId }
        : entry
    )))
  },
)

/**
 * Open one reusable Project File companion per physical navigation owner.
 * Reference navigation may instead focus an already-open matching file.
 */
export const openOrReuseProjectFileAtom = atom(
  null,
  (get, set, input: {
    ownerPanelId?: string
    projectId: string
    relativePath: string
    contextRoute: ViewRoute
    /** Keep reference navigation on an already-open copy of this file. */
    preferExistingFile?: boolean
    intent?: ProjectFileOpenIntent
  }) => {
    const stack = get(panelStackAtom)
    const focusedId = get(focusedPanelIdAtom)
    const focusedPanel = stack.find(entry => entry.id === focusedId)
    const explicitOwner = findNavigationPanel(stack, input.ownerPanelId)
    const focusedOwnerId = focusedPanel
      ? getPanelOwnerPanelId(stack, focusedPanel.id)
      : null
    const focusedOwner = focusedOwnerId
      ? stack.find(entry => entry.id === focusedOwnerId)
      : undefined
    const ownerEntry = explicitOwner ?? focusedOwner
    const nextRoute = buildProjectFileRoute({
      projectId: input.projectId,
      relativePath: input.relativePath,
      contextRoute: input.contextRoute,
    })
    const existingFile = input.preferExistingFile
      ? stack.find(entry => (
          isProjectFileRoute(entry.route)
          && entry.route.projectId === input.projectId
          && entry.route.relativePath === input.relativePath
        ))
      : undefined

    if (existingFile) {
      set(focusedPanelIdAtom, existingFile.id)
      set(projectFileOpenIntentsAtom, current => {
        const next = new Map(current)
        if (input.intent) next.set(existingFile.id, input.intent)
        else next.delete(existingFile.id)
        return next
      })
      return
    }

    const focusedOrphan = focusedPanel
      && isProjectFileRoute(focusedPanel.route)
      && focusedOwnerId === null
      ? focusedPanel
      : undefined
    const existingCompanion = focusedOrphan ?? (
      ownerEntry
        ? stack.find(
            entry => (
              isProjectFileRoute(entry.route)
              && entry.ownerPanelId === ownerEntry.id
            ),
          )
        : undefined
    )

    if (existingCompanion) {
      const keepsChatTarget = (
        isProjectFileRoute(existingCompanion.route)
        && existingCompanion.route.projectId === nextRoute.projectId
        && existingCompanion.route.relativePath === nextRoute.relativePath
      )
      set(panelStackAtom, stack.map(entry =>
        entry.id === existingCompanion.id
          ? {
              ...entry,
              route: nextRoute,
              chatTargetSessionId: keepsChatTarget
                ? existingCompanion.chatTargetSessionId
                : undefined,
              ...(ownerEntry
                ? { ownerPanelId: ownerEntry.id }
                : { ownerPanelId: undefined }),
            }
          : entry
      ))
      set(focusedPanelIdAtom, existingCompanion.id)
      set(projectFileOpenIntentsAtom, current => {
        const next = new Map(current)
        if (input.intent) next.set(existingCompanion.id, input.intent)
        else next.delete(existingCompanion.id)
        return next
      })
      return
    }

    const ownerIndex = ownerEntry
      ? stack.findIndex(entry => entry.id === ownerEntry.id)
      : -1
    const panelId = set(pushPanelAtom, {
      route: nextRoute,
      afterIndex: ownerIndex >= 0 ? ownerIndex : get(focusedPanelIndexAtom),
      ownerPanelId: ownerEntry?.id,
    })
    const intent = input.intent
    if (panelId && intent) {
      set(projectFileOpenIntentsAtom, current => {
        const next = new Map(current)
        next.set(panelId, intent)
        return next
      })
    }
  },
)

/**
 * Present a browser resource as a normal PanelStack companion. A browser
 * resource has exactly one visible panel; presenting it again
 * focuses that panel instead of creating a duplicate native surface.
 */
export const openOrFocusBrowserPanelAtom = atom(
  null,
  (get, set, input: {
    browserId: string
    contextRoute: ViewRoute
    ownerPanelId?: string
  }) => {
    const stack = get(panelStackAtom)
    const requestedOwner = findNavigationPanel(stack, input.ownerPanelId)
    const existing = stack.find(entry => (
      isBrowserPanelRoute(entry.route)
      && entry.route.browserId === input.browserId
    ))
    if (existing) {
      if (!getPanelOwnerPanelId(stack, existing.id) && requestedOwner) {
        set(panelStackAtom, stack.map(entry => (
          entry.id === existing.id
            ? {
                ...entry,
                ownerPanelId: requestedOwner.id,
                route: buildBrowserPanelRoute({
                  browserId: input.browserId,
                  contextRoute: input.contextRoute,
                }),
              }
            : entry
        )))
      }
      set(focusedPanelIdAtom, existing.id)
      return existing.id
    }

    const focused = stack.find(entry => entry.id === get(focusedPanelIdAtom))
    const focusedOwnerId = focused
      ? getPanelOwnerPanelId(stack, focused.id)
      : null
    const owner = requestedOwner ?? (
      focusedOwnerId
        ? stack.find(entry => entry.id === focusedOwnerId)
        : undefined
    )
    const ownerIndex = owner
      ? stack.findIndex(entry => entry.id === owner.id)
      : get(focusedPanelIndexAtom)
    let insertAfterIndex = ownerIndex
    if (owner) {
      for (let index = ownerIndex + 1; index < stack.length; index += 1) {
        if (stack[index].ownerPanelId !== owner.id) break
        insertAfterIndex = index
      }
    }

    return set(pushPanelAtom, {
      route: buildBrowserPanelRoute({
        browserId: input.browserId,
        contextRoute: input.contextRoute,
      }),
      afterIndex: insertAfterIndex,
      ownerPanelId: owner?.id,
    })
  },
)

export const consumeProjectFileOpenIntentAtom = atom(
  null,
  (get, set, panelId: string): ProjectFileOpenIntent | undefined => {
    const intent = get(projectFileOpenIntentsAtom).get(panelId)
    if (!intent) return undefined
    set(projectFileOpenIntentsAtom, current => {
      const next = new Map(current)
      next.delete(panelId)
      return next
    })
    return intent
  },
)

export const closePanelAtom = atom(
  null,
  (get, set, id: string) => {
    const stack = get(panelStackAtom)
    const index = stack.findIndex(panel => panel.id === id)
    if (index === -1) return

    const remaining = stack
      .filter(panel => panel.id !== id)
      .map(entry => (
        entry.ownerPanelId === id
          ? { ...entry, ownerPanelId: undefined }
          : entry
      ))

    set(panelStackAtom, remaining)
    set(projectFileOpenIntentsAtom, current => {
      if (!current.has(id)) return current
      const next = new Map(current)
      next.delete(id)
      return next
    })

    if (get(focusedPanelIdAtom) === id) {
      const nextIndex = Math.min(index, remaining.length - 1)
      set(focusedPanelIdAtom, remaining[nextIndex]?.id ?? null)
    }
  },
)

/**
 * Compact companion Back behavior differs from the desktop close button.
 */
export const backFromCompanionPanelAtom = atom(
  null,
  (get, set, panelId: string) => {
    const stack = get(panelStackAtom)
    const panel = stack.find(entry => entry.id === panelId)
    if (!panel || !isCompanionPanelRoute(panel.route)) return

    const ownerId = getPanelOwnerPanelId(stack, panelId)
    if (ownerId) {
      set(closePanelAtom, panelId)
      set(focusedPanelIdAtom, ownerId)
      return
    }

    const replacement = createEntry(
      buildNavigationPanelRoute(panel.route.contextRoute),
      {
        widthRatio: panel.widthRatio,
        id: panel.id,
      },
    )
    set(panelStackAtom, stack.map(entry => (
      entry.id === panelId ? replacement : entry
    )))
    set(focusedPanelIdAtom, panelId)
  },
)

/**
 * Restore a validated layout snapshot in one atom transaction.
 */
export const restorePanelLayoutAtom = atom(
  null,
  (_get, set, layout: SerializedPanelLayoutV2) => {
    const idByKey = new Map(
      layout.entries.map(entry => [entry.key, generatePanelId()]),
    )
    const restored = layout.entries.map(entry => createEntry(
      entry.route,
      {
        widthRatio: entry.widthRatio,
        id: idByKey.get(entry.key),
        ownerPanelId: entry.ownerKey
          ? idByKey.get(entry.ownerKey)
          : undefined,
        chatTargetSessionId: entry.chatTargetSessionId,
      },
    ))

    set(panelStackAtom, restored)
    set(focusedPanelIdAtom, idByKey.get(layout.focusedKey) ?? null)
  },
)

export const resizePanelAtom = atom(
  null,
  (get, set, {
    panelId,
    widthRatio,
  }: {
    panelId: string
    widthRatio: number
  }) => {
    const stack = get(panelStackAtom)
    const panel = stack.find(entry => entry.id === panelId)
    if (
      !panel
      || !Number.isFinite(widthRatio)
      || widthRatio <= 0
      || widthRatio === panel.widthRatio
    ) {
      return
    }
    set(panelStackAtom, stack.map(entry => (
      entry.id === panelId
        ? { ...entry, widthRatio }
        : entry
    )))
  },
)

export const updateFocusedPanelRouteAtom = atom(
  null,
  (get, set, route: ViewRoute) => {
    const stack = get(panelStackAtom)
    const contentRoute = buildNavigationPanelRoute(route)

    if (stack.length === 0) {
      const newEntry = createEntry(contentRoute, {
        panelViewportWidth: get(panelViewportWidthAtom),
      })
      set(panelStackAtom, [newEntry])
      set(focusedPanelIdAtom, newEntry.id)
      return
    }

    const focusedId = get(focusedPanelIdAtom)
    const focused = stack.find(panel => panel.id === focusedId) ?? stack[0]
    const updated = stack.map(panel =>
      panel.id === focused.id
        ? createEntry(contentRoute, {
            widthRatio: panel.widthRatio,
            id: panel.id,
          })
        : panel
    )

    set(panelStackAtom, updated)
    set(focusedPanelIdAtom, focused.id)
  },
)

export const focusNextPanelAtom = atom(
  null,
  (get, set) => {
    const stack = get(panelStackAtom)
    if (stack.length <= 1) return
    const currentIndex = get(focusedPanelIndexAtom)
    const nextIndex = (currentIndex + 1) % stack.length
    set(focusedPanelIdAtom, stack[nextIndex].id)
  },
)

export const focusPrevPanelAtom = atom(
  null,
  (get, set) => {
    const stack = get(panelStackAtom)
    if (stack.length <= 1) return
    const currentIndex = get(focusedPanelIndexAtom)
    const previousIndex = (currentIndex - 1 + stack.length) % stack.length
    set(focusedPanelIdAtom, stack[previousIndex].id)
  },
)
