import type { PDFDocumentProxy } from 'pdfjs-dist'

export const MAX_PDF_READER_PAGES = 1_000
export const PDF_INLINE_NAV_MIN_WIDTH_PX = 760

const PDF_PAGE_GAP_PX = 16
const PDF_SCROLL_PADDING_PX = 16
const PDF_REVEAL_OFFSET_PX = 24
const PDF_RENDER_RADIUS = 2

export interface PdfPageLayout {
  pageNumber: number
  top: number
  height: number
}

export function getPdfNavigationLayout(
  readerWidth: number,
): 'overlay' | 'inline' {
  return readerWidth < PDF_INLINE_NAV_MIN_WIDTH_PX ? 'overlay' : 'inline'
}

export function getPdfPageDisplayLabel(
  pageNumber: number,
  pageLabels: string[] | null,
): string {
  return pageLabels?.[pageNumber - 1]?.trim() || String(pageNumber)
}

export async function loadPdfPageAspectRatios(
  pdf: Pick<PDFDocumentProxy, 'getPage' | 'numPages'>,
): Promise<number[]> {
  if (
    !Number.isSafeInteger(pdf.numPages)
    || pdf.numPages < 1
    || pdf.numPages > MAX_PDF_READER_PAGES
  ) {
    throw new Error(
      `PDFs must contain between 1 and ${MAX_PDF_READER_PAGES} pages.`,
    )
  }

  const ratios: number[] = []
  for (let firstPage = 1; firstPage <= pdf.numPages; firstPage += 16) {
    const lastPage = Math.min(pdf.numPages, firstPage + 15)
    const batch = await Promise.all(Array.from(
      { length: lastPage - firstPage + 1 },
      async (_, index) => {
        const page = await pdf.getPage(firstPage + index)
        const viewport = page.getViewport({ scale: 1 })
        const ratio = viewport.height / viewport.width
        if (!Number.isFinite(ratio) || ratio <= 0) {
          throw new Error('PDF page dimensions are invalid.')
        }
        return ratio
      },
    ))
    ratios.push(...batch)
  }
  return ratios
}

export function createPdfPageLayout(
  aspectRatios: number[],
  pageWidth: number,
): PdfPageLayout[] {
  let top = PDF_SCROLL_PADDING_PX
  return aspectRatios.map((aspectRatio, index) => {
    const height = pageWidth * aspectRatio
    const page = { pageNumber: index + 1, top, height }
    top += height + PDF_PAGE_GAP_PX
    return page
  })
}

export function findPdfPageAtOffset(
  pages: PdfPageLayout[],
  scrollTop: number,
): { pageNumber: number; pageOffsetRatio: number } | null {
  if (pages.length === 0) return null
  const offset = Math.max(0, scrollTop + PDF_REVEAL_OFFSET_PX)
  let low = 0
  let high = pages.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (pages[middle].top <= offset) low = middle
    else high = middle - 1
  }

  let page = pages[low]
  const next = pages[low + 1]
  const pageBottom = page.top + page.height
  if (
    next
    && offset > pageBottom
    && next.top - offset < offset - pageBottom
  ) {
    page = next
  }
  return {
    pageNumber: page.pageNumber,
    pageOffsetRatio: Math.min(1, Math.max(0, (offset - page.top) / page.height)),
  }
}

export function pdfPageScrollTop(
  page: PdfPageLayout,
  pageOffsetRatio: number,
): number {
  const ratio = Math.min(1, Math.max(0, pageOffsetRatio))
  return Math.max(0, page.top + page.height * ratio - PDF_REVEAL_OFFSET_PX)
}

export function pdfPageRenderWindow(
  currentPage: number,
  numPages: number,
): { start: number; end: number } {
  const windowSize = PDF_RENDER_RADIUS * 2 + 1
  const start = Math.max(
    1,
    Math.min(currentPage - PDF_RENDER_RADIUS, numPages - windowSize + 1),
  )
  return {
    start,
    end: Math.min(numPages, start + windowSize - 1),
  }
}
