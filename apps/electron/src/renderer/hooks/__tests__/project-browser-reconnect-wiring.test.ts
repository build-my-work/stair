import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const source = readFileSync(new URL('../useProjects.ts', import.meta.url), 'utf8')

describe('Project Browser reconnect reconciliation', () => {
  it('refreshes the authoritative Project list after every reconnect', () => {
    const reconnectIndex = source.indexOf('window.electronAPI.onReconnected(() => {')
    const refreshIndex = source.indexOf('void refresh().catch(() => {})', reconnectIndex)

    expect(reconnectIndex).toBeGreaterThan(-1)
    expect(refreshIndex).toBeGreaterThan(reconnectIndex)
  })

  it('does not let a stale Workspace request or broadcast clear the active Project list', () => {
    expect(source).toContain('activeWorkspaceIdRef.current !== workspaceId')
    expect(source).toContain('activeWorkspaceIdRef.current !== wsId')
  })
})
