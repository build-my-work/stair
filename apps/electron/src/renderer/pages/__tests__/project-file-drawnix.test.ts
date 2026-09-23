import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

describe('Drawnix Project File integration', () => {
  it('renders .drawnix through its document controller instead of the text editor', () => {
    const source = readFileSync(new URL('../ProjectFilePage.tsx', import.meta.url), 'utf8')
    expect(source).toContain("kind === 'drawnix'")
    expect(source).toContain('<ProjectFileDrawnixCanvas')
  })

  it('registers the controller for both Workbench flush and Project-scoped capability access', () => {
    const source = readFileSync(
      new URL('../../components/project-files/ProjectFileDrawnixCanvas.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain('registerOpenProjectFileDocument')
    expect(source).toContain('registerOpenDrawnixBoard')
  })

  it('keeps dynamically sized mind-map text visible on a single line', () => {
    const styles = readFileSync(
      new URL('../../components/project-files/drawnix-project-file.css', import.meta.url),
      'utf8',
    )
    expect(styles).toContain("g[plait-mind_child='true'] .text foreignObject")
    expect(styles).toContain('overflow: visible')
    expect(styles).toContain('white-space: nowrap !important')
  })
})
