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

  it('awaits pending card images inside flush so close and switch keep in-flight images', () => {
    const source = readFileSync(
      new URL('../../components/project-files/drawnix-document-controller.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain('waitForPendingCardImages')
    expect(source.indexOf('waitForPendingCardImages'))
      .toBeLessThan(source.indexOf('while (this.pendingChange || this.savePromise || this.dirty)'))
    expect(source).toContain('lastSavedContent')
    expect(source).toContain("imageWait === 'timeout'")
  })

  it('keeps controllerRef until close flush finishes and surfaces image wait timeout', () => {
    const canvas = readFileSync(
      new URL('../../components/project-files/ProjectFileDrawnixCanvas.tsx', import.meta.url),
      'utf8',
    )
    expect(canvas).toContain('controllerRef.current = null')
    expect(canvas.indexOf('.flush()')).toBeLessThan(canvas.lastIndexOf('controllerRef.current = null'))
    expect(canvas).toContain('drawnixImageWaitTimeout')
    expect(canvas).toContain('tRef')
    expect(canvas).not.toMatch(/sourceFingerprint,\s*t\s*\]/)
  })

  it('awaits in-flight autosave before comparing lastSavedContent during flush', () => {
    const source = readFileSync(
      new URL('../../components/project-files/drawnix-document-controller.ts', import.meta.url),
      'utf8',
    )
    const waitIdx = source.indexOf('waitForPendingCardImages')
    const awaitSaveIdx = source.indexOf('if (this.savePromise) await this.savePromise')
    const compareIdx = source.indexOf('!== this.lastSavedContent')
    expect(waitIdx).toBeGreaterThan(-1)
    expect(awaitSaveIdx).toBeGreaterThan(waitIdx)
    expect(compareIdx).toBeGreaterThan(awaitSaveIdx)
  })


  it('routes Cmd/Ctrl+S to Stair flush at the panel root so host chrome never opens Save As', () => {
    const page = readFileSync(new URL('../ProjectFilePage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('flushOpenProjectFile')
    expect(page).toContain('handleDrawnixSaveShortcut')
    expect(page).toContain('onKeyDownCapture={handleDrawnixSaveShortcut}')

    const canvas = readFileSync(
      new URL('../../components/project-files/ProjectFileDrawnixCanvas.tsx', import.meta.url),
      'utf8',
    )
    expect(canvas).toContain('onKeyDownCapture={blockNativeFileShortcut}')
    expect(canvas).toContain("event.key.toLowerCase() === 's'")
  })
})
