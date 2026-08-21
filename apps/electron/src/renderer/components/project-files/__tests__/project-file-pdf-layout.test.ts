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
} from '../project-file-pdf-layout'

describe('PDF virtual page layout', () => {
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
