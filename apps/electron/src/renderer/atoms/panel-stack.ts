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
  type SerializedPanelLayoutV1,
} from '@/lib/panel-layout-codec'
import {
  buildNavigationPanelRoute,
  buildProjectFileRoute,
  getPanelContextRoute,
  isProjectFileRoute,
} from '@/lib/project-file-route'

let nextPanelId = 0
function generatePanelId(): string {
  return `panel-${++nextPanelId}-${Date.now()}`
}

export interface PanelStackEntry {
  id: string
  route: PanelContentRoute
  proportion: number
  /** Physical navigation panel that owns a reusable Project File companion. */
  ownerPanelId?: string
  /** Explicit Session that receives references from this Project File panel. */
  chatTargetSessionId?: string
}

export const panelStackAtom = atom<PanelStackEntry[]>([])
export const focusedPanelIdAtom = atom<string | null>(null)
export const projectFileOpenIntentsAtom = atom<Map<string, ProjectFileOpenIntent>>(new Map())

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
 * A Project File panel keeps its own content route while exposing the
 * navigation context from which it was opened.
 */
export const focusedPanelRouteAtom = atom((get) => {
  const route = get(focusedPanelContentRouteAtom)
  return route ? getPanelContextRoute(route) : null
})

function toPanelContentRoute(route: ViewRoute | PanelContentRoute): PanelContentRoute {
  return typeof route === 'string' ? buildNavigationPanelRoute(route) : route
}

function createEntry(
  input: ViewRoute | PanelContentRoute,
  proportion: number,
  id?: string,
  ownerPanelId?: string,
  chatTargetSessionId?: string,
): PanelStackEntry {
  const route = toPanelContentRoute(input)
  return {
    id: id ?? generatePanelId(),
    route,
    proportion,
    ...(ownerPanelId ? { ownerPanelId } : {}),
    ...(isProjectFileRoute(route) && chatTargetSessionId
      ? { chatTargetSessionId }
      : {}),
  }
}

function normalizeProportions(stack: PanelStackEntry[]): PanelStackEntry[] {
  if (stack.length === 0) return stack
  const total = stack.reduce((sum, panel) => sum + panel.proportion, 0)
  if (total <= 0) {
    const equal = 1 / stack.length
    return stack.map(panel => ({ ...panel, proportion: equal }))
  }
  return stack.map(panel => ({ ...panel, proportion: panel.proportion / total }))
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
 * Session ids rendered by navigation panels. Project File panels are views of
 * files, not duplicate visible chats, even when their context is a Session.
 */
export const visibleSessionIdsAtom = atom((get) => {
  const ids = new Set<string>()
  for (const entry of get(panelStackAtom)) {
    if (isProjectFileRoute(entry.route)) continue
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
    const validOwnerId = isProjectFileRoute(contentRoute)
      && ownerPanelId
      && stack.some(
        entry => entry.id === ownerPanelId && entry.route.kind === 'navigation',
      )
      ? ownerPanelId
      : undefined
    // The persisted layout requires every physical panel to have a positive
    // proportion. Give a newly inserted panel the current average share before
    // normalizing; using zero makes the whole layout impossible to serialize.
    const currentTotal = stack.reduce(
      (total, entry) => total + entry.proportion,
      0,
    )
    const newProportion = stack.length > 0 && currentTotal > 0
      ? currentTotal / stack.length
      : 1
    const newEntry = createEntry(
      contentRoute,
      newProportion,
      undefined,
      validOwnerId,
    )
    const newStack = [
      ...stack.slice(0, insertAt),
      newEntry,
      ...stack.slice(insertAt),
    ]

    set(panelStackAtom, normalizeProportions(newStack))
    set(focusedPanelIdAtom, newEntry.id)
    return newEntry.id
  },
)

/**
 * Resolve the physical owner of a panel.
 *
 * Owner is an explicit runtime instance relationship. It is never inferred
 * from route equality or panel position.
 */
export function getProjectFileOwnerPanelId(
  stack: PanelStackEntry[],
  panelId: string,
): string | null {
  const panel = stack.find(entry => entry.id === panelId)
  if (!panel) return null
  if (!isProjectFileRoute(panel.route)) return panel.id
  if (!panel.ownerPanelId) return null

  const owner = stack.find(entry => entry.id === panel.ownerPanelId)
  return owner?.route.kind === 'navigation' ? owner.id : null
}

export const setProjectFileChatTargetAtom = atom(
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
      || !isProjectFileRoute(panel.route)
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
    const explicitOwner = input.ownerPanelId
      ? stack.find(
          entry => entry.id === input.ownerPanelId && entry.route.kind === 'navigation',
        )
      : undefined
    const focusedOwnerId = focusedPanel
      ? getProjectFileOwnerPanelId(stack, focusedPanel.id)
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
    if (panelId && input.intent) {
      set(projectFileOpenIntentsAtom, current => {
        const next = new Map(current)
        next.set(panelId, input.intent!)
        return next
      })
    }
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

    set(panelStackAtom, normalizeProportions(remaining))
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
 * Compact Project File Back behavior differs from the desktop close button.
 */
export const backFromProjectFilePanelAtom = atom(
  null,
  (get, set, panelId: string) => {
    const stack = get(panelStackAtom)
    const panel = stack.find(entry => entry.id === panelId)
    if (!panel || !isProjectFileRoute(panel.route)) return

    const ownerId = getProjectFileOwnerPanelId(stack, panelId)
    if (ownerId) {
      set(closePanelAtom, panelId)
      set(focusedPanelIdAtom, ownerId)
      return
    }

    const replacement = createEntry(
      buildNavigationPanelRoute(panel.route.contextRoute),
      panel.proportion,
      panel.id,
    )
    set(panelStackAtom, stack.map(entry => (
      entry.id === panelId ? replacement : entry
    )))
    set(focusedPanelIdAtom, panelId)
  },
)

/**
 * Restore a validated V1 snapshot in one atom transaction.
 */
export const restorePanelLayoutAtom = atom(
  null,
  (_get, set, layout: SerializedPanelLayoutV1) => {
    const idByKey = new Map(
      layout.entries.map(entry => [entry.key, generatePanelId()]),
    )
    const restored = layout.entries.map(entry => createEntry(
      entry.route,
      entry.proportion,
      idByKey.get(entry.key),
      entry.ownerKey ? idByKey.get(entry.ownerKey) : undefined,
      entry.chatTargetSessionId,
    ))

    set(panelStackAtom, normalizeProportions(restored))
    set(focusedPanelIdAtom, idByKey.get(layout.focusedKey) ?? null)
  },
)

export const resizePanelsAtom = atom(
  null,
  (get, set, {
    leftIndex,
    rightIndex,
    leftProportion,
    rightProportion,
  }: {
    leftIndex: number
    rightIndex: number
    leftProportion: number
    rightProportion: number
  }) => {
    const stack = get(panelStackAtom)
    if (leftIndex < 0 || rightIndex >= stack.length) return
    set(panelStackAtom, stack.map((panel, index) => {
      if (index === leftIndex) {
        return { ...panel, proportion: leftProportion }
      }
      if (index === rightIndex) {
        return { ...panel, proportion: rightProportion }
      }
      return panel
    }))
  },
)

export const updateFocusedPanelRouteAtom = atom(
  null,
  (get, set, route: ViewRoute) => {
    const stack = get(panelStackAtom)
    const contentRoute = buildNavigationPanelRoute(route)

    if (stack.length === 0) {
      const newEntry = createEntry(contentRoute, 1)
      set(panelStackAtom, [newEntry])
      set(focusedPanelIdAtom, newEntry.id)
      return
    }

    const focusedId = get(focusedPanelIdAtom)
    const focused = stack.find(panel => panel.id === focusedId) ?? stack[0]
    const updated = stack.map(panel =>
      panel.id === focused.id
        ? createEntry(contentRoute, panel.proportion, panel.id)
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
