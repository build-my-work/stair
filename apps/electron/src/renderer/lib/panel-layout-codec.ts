import type { PanelContentRoute } from '../../shared/routes'
import { isCanonicalProjectRelativePath } from '@craft-agent/core'
import {
  isValidViewRoute,
  parseRouteToNavigationState,
} from '../../shared/route-parser'
import { isCompanionPanelRoute } from './project-file-route'

export const PANEL_LAYOUT_VERSION = 2 as const
export const MAX_PANEL_LAYOUT_ENTRIES = 8
export const MAX_ENCODED_PANEL_LAYOUT_BYTES = 64 * 1024
const MAX_CHAT_TARGET_SESSION_ID_LENGTH = 512

interface SerializedPanelLayoutEntryBase {
  key: string
  route: PanelContentRoute
  ownerKey?: string
  chatTargetSessionId?: string
}

export interface SerializedPanelLayoutV2 {
  version: typeof PANEL_LAYOUT_VERSION
  entries: Array<SerializedPanelLayoutEntryBase & {
    widthRatio: number
  }>
  focusedKey: string
}

interface RuntimePanelLayoutEntry {
  id: string
  route: PanelContentRoute
  widthRatio: number
  ownerPanelId?: string
  chatTargetSessionId?: string
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '')
}

function base64UrlToBytes(encoded: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return null
  const padding = (4 - (encoded.length % 4)) % 4
  try {
    const binary = atob(
      encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding),
    )
    return Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every(key => allowedKeys.includes(key))
}

function parsePanelContentRoute(value: unknown): PanelContentRoute | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null

  if (value.kind === 'navigation') {
    if (
      !hasOnlyKeys(value, ['kind', 'viewRoute'])
      || !isValidViewRoute(value.viewRoute)
    ) {
      return null
    }
    return { kind: 'navigation', viewRoute: value.viewRoute }
  }

  if (value.kind === 'projectFile') {
    if (
      !hasOnlyKeys(
        value,
        ['kind', 'projectId', 'relativePath', 'contextRoute'],
      )
      || typeof value.projectId !== 'string'
      || value.projectId.length === 0
      || value.projectId.length > 512
      || typeof value.relativePath !== 'string'
      || value.relativePath.length > 4096
      || !isCanonicalProjectRelativePath(value.relativePath)
      || !isValidViewRoute(value.contextRoute)
    ) {
      return null
    }
    return {
      kind: 'projectFile',
      projectId: value.projectId,
      relativePath: value.relativePath,
      contextRoute: value.contextRoute,
    }
  }

  if (value.kind === 'browser') {
    if (
      !hasOnlyKeys(value, ['kind', 'browserId', 'contextRoute'])
      || typeof value.browserId !== 'string'
      || value.browserId.length === 0
      || value.browserId.length > 512
      || !isValidViewRoute(value.contextRoute)
    ) {
      return null
    }
    return {
      kind: 'browser',
      browserId: value.browserId,
      contextRoute: value.contextRoute,
    }
  }

  return null
}

function isValidChatTarget(
  route: PanelContentRoute,
  value: unknown,
): value is string | undefined {
  if (value === undefined) return true
  return (
    isCompanionPanelRoute(route)
    && typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CHAT_TARGET_SESSION_ID_LENGTH
  )
}

function isValidSerializedKey(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 64
  )
}

function isValidPanelWidthRatio(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
  )
}

function validateLayoutRelationships(
  entries: readonly SerializedPanelLayoutEntryBase[],
  focusedKey: string,
): boolean {
  const entryByKey = new Map(entries.map(entry => [entry.key, entry]))
  if (entryByKey.size !== entries.length || !entryByKey.has(focusedKey)) {
    return false
  }

  const sessionIds = new Set<string>()
  for (const entry of entries) {
    if (
      entry.ownerKey
      && entryByKey.get(entry.ownerKey)?.route.kind !== 'navigation'
    ) {
      return false
    }

    if (entry.route.kind !== 'navigation') continue
    const navState = parseRouteToNavigationState(entry.route.viewRoute)
    if (
      navState?.navigator !== 'sessions'
      && navState?.navigator !== 'projects'
    ) {
      continue
    }

    const sessionId = navState.details?.sessionId
    if (!sessionId) continue
    if (sessionIds.has(sessionId)) return false
    sessionIds.add(sessionId)
  }

  return true
}

export function serializePanelLayout(
  entries: readonly RuntimePanelLayoutEntry[],
  focusedPanelId: string | null,
): string | null {
  if (
    entries.length === 0
    || entries.length > MAX_PANEL_LAYOUT_ENTRIES
    || !focusedPanelId
    || entries.some(entry => (
      !isValidPanelWidthRatio(entry.widthRatio)
      || !isValidChatTarget(entry.route, entry.chatTargetSessionId)
    ))
  ) {
    return null
  }

  const keyById = new Map(
    entries.map((entry, index) => [entry.id, `p${index}`]),
  )
  if (keyById.size !== entries.length) return null
  const focusedKey = keyById.get(focusedPanelId)
  if (!focusedKey) return null
  const runtimeEntryById = new Map(entries.map(entry => [entry.id, entry]))

  const layout: SerializedPanelLayoutV2 = {
    version: PANEL_LAYOUT_VERSION,
    entries: entries.map((entry, index) => {
      const owner = entry.ownerPanelId
        ? runtimeEntryById.get(entry.ownerPanelId)
        : undefined
      const ownerKey = isCompanionPanelRoute(entry.route)
        && owner?.route.kind === 'navigation'
        ? keyById.get(owner.id)
        : undefined
      return {
        key: `p${index}`,
        route: entry.route,
        widthRatio: entry.widthRatio,
        ...(ownerKey ? { ownerKey } : {}),
        ...(entry.chatTargetSessionId
          ? { chatTargetSessionId: entry.chatTargetSessionId }
          : {}),
      }
    }),
    focusedKey,
  }
  if (!validateLayoutRelationships(layout.entries, focusedKey)) return null
  const encoded = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(layout)),
  )
  return encoded.length <= MAX_ENCODED_PANEL_LAYOUT_BYTES ? encoded : null
}

function parseLayoutV2(
  serializedEntries: unknown[],
  focusedKey: string,
): SerializedPanelLayoutV2 | null {
  const entries: SerializedPanelLayoutV2['entries'] = []
  const keys = new Set<string>()

  for (const candidate of serializedEntries) {
    if (
      !isRecord(candidate)
      || !hasOnlyKeys(
        candidate,
        ['key', 'route', 'widthRatio', 'ownerKey', 'chatTargetSessionId'],
      )
      || !isValidSerializedKey(candidate.key)
      || keys.has(candidate.key)
      || !isValidPanelWidthRatio(candidate.widthRatio)
      || (
        candidate.ownerKey !== undefined
        && !isValidSerializedKey(candidate.ownerKey)
      )
    ) {
      return null
    }

    const route = parsePanelContentRoute(candidate.route)
    if (!route || !isValidChatTarget(route, candidate.chatTargetSessionId)) {
      return null
    }
    if (candidate.ownerKey !== undefined && !isCompanionPanelRoute(route)) {
      return null
    }

    keys.add(candidate.key)
    entries.push({
      key: candidate.key,
      route,
      widthRatio: candidate.widthRatio,
      ...(candidate.ownerKey ? { ownerKey: candidate.ownerKey } : {}),
      ...(candidate.chatTargetSessionId
        ? { chatTargetSessionId: candidate.chatTargetSessionId }
        : {}),
    })
  }

  if (!validateLayoutRelationships(entries, focusedKey)) return null

  return {
    version: PANEL_LAYOUT_VERSION,
    entries,
    focusedKey,
  }
}

export function deserializePanelLayout(
  encoded: string,
): SerializedPanelLayoutV2 | null {
  if (
    encoded.length === 0
    || encoded.length > MAX_ENCODED_PANEL_LAYOUT_BYTES
  ) {
    return null
  }

  const bytes = base64UrlToBytes(encoded)
  if (!bytes) return null

  let value: unknown
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = JSON.parse(json)
  } catch {
    return null
  }

  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['version', 'entries', 'focusedKey'])
    || !Array.isArray(value.entries)
    || value.entries.length === 0
    || value.entries.length > MAX_PANEL_LAYOUT_ENTRIES
    || typeof value.focusedKey !== 'string'
  ) {
    return null
  }

  if (value.version !== PANEL_LAYOUT_VERSION) return null
  return parseLayoutV2(value.entries, value.focusedKey)
}
