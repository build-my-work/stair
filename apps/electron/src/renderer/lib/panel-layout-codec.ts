import type { PanelContentRoute } from '../../shared/routes'
import { isCanonicalProjectRelativePath } from '@craft-agent/core'
import { isValidViewRoute } from '../../shared/route-parser'
import { isCompanionPanelRoute } from './project-file-route'

export const PANEL_LAYOUT_VERSION = 1 as const
export const MAX_PANEL_LAYOUT_ENTRIES = 8
export const MAX_ENCODED_PANEL_LAYOUT_BYTES = 64 * 1024
const MAX_CHAT_TARGET_SESSION_ID_LENGTH = 512

export interface SerializedPanelLayoutV1 {
  version: typeof PANEL_LAYOUT_VERSION
  entries: Array<{
    key: string
    route: PanelContentRoute
    proportion: number
    ownerKey?: string
    chatTargetSessionId?: string
  }>
  focusedKey: string
}

interface RuntimePanelLayoutEntry {
  id: string
  route: PanelContentRoute
  proportion: number
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

export function serializePanelLayoutV1(
  entries: readonly RuntimePanelLayoutEntry[],
  focusedPanelId: string | null,
): string | null {
  if (
    entries.length === 0
    || entries.length > MAX_PANEL_LAYOUT_ENTRIES
    || !focusedPanelId
    || entries.some(entry => (
      !Number.isFinite(entry.proportion)
      || entry.proportion <= 0
      || (
        entry.chatTargetSessionId !== undefined
        && (
          !isCompanionPanelRoute(entry.route)
          || entry.chatTargetSessionId.length === 0
          || entry.chatTargetSessionId.length
            > MAX_CHAT_TARGET_SESSION_ID_LENGTH
        )
      )
    ))
  ) {
    return null
  }
  const runtimeTotalProportion = entries.reduce(
    (total, entry) => total + entry.proportion,
    0,
  )
  if (!Number.isFinite(runtimeTotalProportion)) return null

  const keyById = new Map(
    entries.map((entry, index) => [entry.id, `p${index}`]),
  )
  if (keyById.size !== entries.length) return null
  const focusedKey = keyById.get(focusedPanelId)
  if (!focusedKey) return null
  const runtimeEntryById = new Map(entries.map(entry => [entry.id, entry]))

  const layout: SerializedPanelLayoutV1 = {
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
        proportion: entry.proportion,
        ...(ownerKey ? { ownerKey } : {}),
        ...(entry.chatTargetSessionId
          ? { chatTargetSessionId: entry.chatTargetSessionId }
          : {}),
      }
    }),
    focusedKey,
  }
  const encoded = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(layout)),
  )
  return encoded.length <= MAX_ENCODED_PANEL_LAYOUT_BYTES ? encoded : null
}

export function deserializePanelLayoutV1(
  encoded: string,
): SerializedPanelLayoutV1 | null {
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
    || value.version !== PANEL_LAYOUT_VERSION
    || !Array.isArray(value.entries)
    || value.entries.length === 0
    || value.entries.length > MAX_PANEL_LAYOUT_ENTRIES
    || typeof value.focusedKey !== 'string'
  ) {
    return null
  }

  const entries: SerializedPanelLayoutV1['entries'] = []
  const keys = new Set<string>()
  for (const candidate of value.entries) {
    if (
      !isRecord(candidate)
      || !hasOnlyKeys(
        candidate,
        ['key', 'route', 'proportion', 'ownerKey', 'chatTargetSessionId'],
      )
      || typeof candidate.key !== 'string'
      || candidate.key.length === 0
      || candidate.key.length > 64
      || keys.has(candidate.key)
      || typeof candidate.proportion !== 'number'
      || !Number.isFinite(candidate.proportion)
      || candidate.proportion <= 0
      || (
        candidate.ownerKey !== undefined
        && (
          typeof candidate.ownerKey !== 'string'
          || candidate.ownerKey.length === 0
          || candidate.ownerKey.length > 64
        )
      )
      || (
        candidate.chatTargetSessionId !== undefined
        && (
          typeof candidate.chatTargetSessionId !== 'string'
          || candidate.chatTargetSessionId.length === 0
          || candidate.chatTargetSessionId.length
            > MAX_CHAT_TARGET_SESSION_ID_LENGTH
        )
      )
    ) {
      return null
    }

    const route = parsePanelContentRoute(candidate.route)
    if (!route) return null
    if (
      (
        candidate.ownerKey !== undefined
        || candidate.chatTargetSessionId !== undefined
      )
      && !isCompanionPanelRoute(route)
    ) {
      return null
    }

    keys.add(candidate.key)
    entries.push({
      key: candidate.key,
      route,
      proportion: candidate.proportion,
      ...(candidate.ownerKey
        ? { ownerKey: candidate.ownerKey }
        : {}),
      ...(candidate.chatTargetSessionId
        ? { chatTargetSessionId: candidate.chatTargetSessionId }
        : {}),
    })
  }

  if (!keys.has(value.focusedKey)) return null

  const entryByKey = new Map(entries.map(entry => [entry.key, entry]))
  for (const entry of entries) {
    if (!entry.ownerKey) continue
    const owner = entryByKey.get(entry.ownerKey)
    if (!owner || owner.route.kind !== 'navigation') return null
  }

  const totalProportion = entries.reduce(
    (total, entry) => total + entry.proportion,
    0,
  )
  if (!Number.isFinite(totalProportion) || totalProportion <= 0) return null

  return {
    version: PANEL_LAYOUT_VERSION,
    entries,
    focusedKey: value.focusedKey,
  }
}
