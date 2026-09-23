import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const source = readFileSync(new URL('../BrowserTabStrip.tsx', import.meta.url), 'utf8')

describe('BrowserTabStrip Project isolation', () => {
  it('shows no Browser entries while there is no active Project', () => {
    expect(source).toContain('if (!activeProjectId) return []')
  })

  it('ignores an older Project list after the effect has been replaced', () => {
    const listEffectIndex = source.indexOf('browserPaneApi.list(activeProjectId)')
    const resultIndex = source.indexOf('.then((items) => {', listEffectIndex)
    const guardIndex = source.indexOf('if (cancelled) return', resultIndex)
    const cleanupIndex = source.indexOf('cancelled = true', guardIndex)

    expect(listEffectIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeGreaterThan(resultIndex)
    expect(cleanupIndex).toBeGreaterThan(guardIndex)
  })
})
