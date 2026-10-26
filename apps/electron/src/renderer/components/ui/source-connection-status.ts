import type { SourceConnectionStatus } from '../../../shared/types'

const KNOWN_STATUSES: ReadonlySet<string> = new Set<SourceConnectionStatus>([
  'connected', 'needs_auth', 'failed', 'untested', 'local_disabled',
])

/**
 * `source_test` (session-tools-core) persists its own vocabulary — 'connected' | 'disconnected' |
 * 'error' | 'unknown' — into the same `connectionStatus` field. Without mapping, a source whose
 * test failed looked healthy in the sources list (no status entry for 'error') while its detail
 * page showed it broken. Map those values onto the app's states so every surface agrees.
 */
export function normalizeStoredStatus(stored: string): SourceConnectionStatus {
  if (KNOWN_STATUSES.has(stored)) return stored as SourceConnectionStatus
  if (stored === 'error' || stored === 'disconnected') return 'failed'
  return 'untested'
}

/**
 * Derive connection status from source config
 * This is a convenience function to determine status from existing fields
 *
 * @param source - The source config
 * @param localMcpEnabled - Whether local MCP servers are enabled (default: true)
 */
export function deriveConnectionStatus(source: {
  config: {
    isAuthenticated?: boolean
    connectionStatus?: SourceConnectionStatus
    type?: string
    mcp?: { authType?: string; transport?: string }
    api?: { authType?: string }
  }
}, localMcpEnabled = true): SourceConnectionStatus {
  // Check if this is a stdio source and local MCP is disabled
  const mcp = source.config.mcp
  if (mcp?.transport === 'stdio' && !localMcpEnabled) {
    return 'local_disabled'
  }

  // If explicit status is set, use it — in the app's vocabulary (see normalizeStoredStatus)
  if (source.config.connectionStatus) {
    return normalizeStoredStatus(source.config.connectionStatus)
  }

  // Derive from auth state
  const api = source.config.api
  const authType = mcp?.authType ?? api?.authType
  const isAuthenticated = authType === 'none' || authType === undefined
    ? true
    // eslint-disable-next-line craft-sources/no-inline-source-auth-check -- Connection status ignores enabled; no-auth sources are handled above.
    : source.config.isAuthenticated === true

  // No stored status: local and no-auth sources count as connected
  return isAuthenticated ? 'connected' : 'needs_auth'
}
