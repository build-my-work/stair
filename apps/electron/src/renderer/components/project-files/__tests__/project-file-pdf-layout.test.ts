import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

import {
  MAX_PDF_READER_PAGES,
  createPdfPageLayout,
  findPdfPageAtOffset,
  getPdfNavigationLayout,
  getPdfPageDisplayLabel,
  loadPdfPageAspectRatios,
  pdfPageRenderWindow,
  pdfPageScrollTop,
  restorePdfPageWhenVisible,
} from '../project-file-pdf-layout'

describe('PDF virtual page layout', () => {
  it('cancels an obsolete restore when the reader unmounts or its layout changes', () => {
    const originalFrame = globalThis.requestAnimationFrame
    const originalCancel = globalThis.cancelAnimationFrame
    const OriginalObserver = globalThis.ResizeObserver
    let scheduled!: FrameRequestCallback
    let resized!: () => void
    let cancelled = 0
    let disconnected = 0
    let restores = 0
    globalThis.requestAnimationFrame = callback => { scheduled = callback; return 7 }
    globalThis.cancelAnimationFrame = id => { cancelled = id }
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect() { disconnected += 1 }
    } as never
    try {
      const cleanup = restorePdfPageWhenVisible(
        { clientWidth: 400, clientHeight: 600 } as HTMLElement,
        () => { restores += 1; return true },
      )
      cleanup()
      scheduled(0)
      resized()
      expect(restores).toBe(0)
      expect(cancelled).toBe(7)
      expect(disconnected).toBe(1)
    } finally {
      globalThis.requestAnimationFrame = originalFrame
      globalThis.cancelAnimationFrame = originalCancel
      globalThis.ResizeObserver = OriginalObserver
    }
  })

  it('restores after a hidden container becomes visible, even at the same page width', () => {
    const originalFrame = globalThis.requestAnimationFrame
    const originalCancel = globalThis.cancelAnimationFrame
    const OriginalObserver = globalThis.ResizeObserver
    const frames = new Map<number, FrameRequestCallback>()
    let resized: (() => void) | undefined
    let disconnects = 0
    globalThis.requestAnimationFrame = callback => { frames.set(1, callback); return 1 }
    globalThis.cancelAnimationFrame = id => { frames.delete(id) }
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect() { disconnects += 1 }
    } as never
    const root = { clientWidth: 0, clientHeight: 0 }
    let restoredPage = 1
    let attempts = 0
    let cleanup = () => {}
    try {
      cleanup = restorePdfPageWhenVisible(root as HTMLElement, () => {
        attempts += 1
        restoredPage = root.clientHeight > 0 ? 2 : 1
        return true
      })
      const hiddenFrame = frames.get(1)!
      frames.clear()
      hiddenFrame(0)
      expect(attempts).toBe(0)

      root.clientWidth = 200
      root.clientHeight = 400
      resized!()
      const visibleFrame = frames.get(1)!
      frames.clear()
      visibleFrame(1)
      expect(restoredPage).toBe(2)
      expect(attempts).toBe(1)
      expect(disconnects).toBe(1)
      resized!()
      expect(frames.size).toBe(0)
    } finally {
      cleanup()
      globalThis.requestAnimationFrame = originalFrame
      globalThis.cancelAnimationFrame = originalCancel
      globalThis.ResizeObserver = OriginalObserver
    }
  })

  it('switches from overlay to inline navigation at the old 760px boundary', () => {
    expect(getPdfNavigationLayout(759)).toBe('overlay')
    expect(getPdfNavigationLayout(760)).toBe('inline')
  })

  it('uses printed page labels and falls back to physical page numbers', () => {
    expect(getPdfPageDisplayLabel(3, ['i', 'ii', '1'])).toBe('1')
    expect(getPdfPageDisplayLabel(2, ['i', '  '])).toBe('2')
    expect(getPdfPageDisplayLabel(4, null)).toBe('4')
  })

  it('does not consume persisted progress before a non-empty layout is ready', () => {
    const readerSource = readFileSync(
      new URL('../ProjectFilePdfReader.tsx', import.meta.url),
      'utf8',
    )
    expect(readerSource).toMatch(
      /numPages === 0\s*\|\| pageLayout\.length !== numPages/,
    )
  })

  it('loads bounded page dimensions in order', async () => {
    const requested: number[] = []
    const ratios = await loadPdfPageAspectRatios({
      numPages: 18,
      getPage: async (pageNumber: number) => {
        requested.push(pageNumber)
        return {
          getViewport: () => ({ width: 100, height: pageNumber * 10 }),
        }
      },
    } as never)

    expect(requested).toEqual(Array.from({ length: 18 }, (_, index) => index + 1))
    expect(ratios).toEqual(Array.from({ length: 18 }, (_, index) => (index + 1) / 10))
  })

  it('rejects documents whose declared page count can exhaust the renderer', async () => {
    await expect(loadPdfPageAspectRatios({
      numPages: MAX_PDF_READER_PAGES + 1,
      getPage: async () => ({ getViewport: () => ({ width: 1, height: 1 }) }),
    } as never)).rejects.toThrow(`${MAX_PDF_READER_PAGES}`)
  })

  it('keeps stable scroll geometry while rendering only five nearby pages', () => {
    const layout = createPdfPageLayout([1, 2, 1], 100)
    expect(layout).toEqual([
      { pageNumber: 1, top: 16, height: 100 },
      { pageNumber: 2, top: 132, height: 200 },
      { pageNumber: 3, top: 348, height: 100 },
    ])
    expect(findPdfPageAtOffset(layout, 150)).toEqual({
      pageNumber: 2,
      pageOffsetRatio: 0.21,
    })
    expect(pdfPageScrollTop(layout[2], 0.5)).toBe(374)
    expect(pdfPageRenderWindow(1, 240)).toEqual({ start: 1, end: 5 })
    expect(pdfPageRenderWindow(120, 240)).toEqual({ start: 118, end: 122 })
    expect(pdfPageRenderWindow(240, 240)).toEqual({ start: 236, end: 240 })
  })
})
