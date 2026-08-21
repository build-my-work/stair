import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('browser empty state entry', () => {
  it('initializes i18n before rendering the standalone page', () => {
    const source = readFileSync(
      new URL('../browser-empty-state.tsx', import.meta.url),
      'utf8',
    )

    const setupIndex = source.indexOf('setupI18n(')
    const renderIndex = source.indexOf('ReactDOM.createRoot(')

    expect(setupIndex).toBeGreaterThan(-1)
    expect(renderIndex).toBeGreaterThan(setupIndex)
  })
})
