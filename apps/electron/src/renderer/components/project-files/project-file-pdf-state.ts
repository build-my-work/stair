import {
  MAX_PDF_RECTS_PER_HIGHLIGHT,
  MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
  MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS,
  type PdfDocumentStateV1,
  type PdfHighlightV1,
  type PdfPageRectV1,
  type PdfProgressV1,
  type PdfProjectFileReferenceV1,
  type PdfStateMutation,
  type ProjectFileIdentity,
  type SourceFingerprint,
} from '@craft-agent/shared/project-files'
import type { ApplyPdfStateMutationResponse } from '@craft-agent/shared/protocol'

export const PDF_PROGRESS_DEBOUNCE_MS = 1_000

interface ClientRectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface PdfPageBounds extends ClientRectLike {
  pageNumber: number
}

export type PdfSelectionSnapshot = Omit<
  PdfHighlightV1,
  'id' | 'style' | 'createdAt' | 'updatedAt'
>

function roundRatio(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000
}

function mergePdfRects(rects: PdfPageRectV1[]): PdfPageRectV1[] {
  const sorted = [...rects].sort((left, right) => (
    left.pageNumber - right.pageNumber
    || left.y - right.y
    || left.x - right.x
  ))
  const merged: PdfPageRectV1[] = []
  for (const rect of sorted) {
    const previous = merged.at(-1)
    if (!previous || previous.pageNumber !== rect.pageNumber) {
      merged.push(rect)
      continue
    }
    const previousMidpoint = previous.y + previous.height / 2
    const rectMidpoint = rect.y + rect.height / 2
    const sameLine = Math.abs(previousMidpoint - rectMidpoint)
      <= Math.max(previous.height, rect.height) * 0.55
    const horizontalGap = rect.x - (previous.x + previous.width)
    if (!sameLine || horizontalGap > 0.012) {
      merged.push(rect)
      continue
    }
    const right = Math.max(previous.x + previous.width, rect.x + rect.width)
    const bottom = Math.max(previous.y + previous.height, rect.y + rect.height)
    previous.x = roundRatio(Math.min(previous.x, rect.x))
    previous.y = roundRatio(Math.min(previous.y, rect.y))
    previous.width = roundRatio(right - previous.x)
    previous.height = roundRatio(bottom - previous.y)
  }
  return merged
}

export function normalizePdfSelectionRects(
  rangeRects: ClientRectLike[],
  pageBounds: PdfPageBounds[],
): PdfPageRectV1[] {
  const normalized: PdfPageRectV1[] = []
  for (const page of pageBounds) {
    if (
      !Number.isSafeInteger(page.pageNumber)
      || page.pageNumber < 1
      || ![page.left, page.top, page.width, page.height]
        .every(value => Number.isFinite(value))
      || page.width <= 0
      || page.height <= 0
    ) {
      continue
    }
    const pageRight = page.left + page.width
    const pageBottom = page.top + page.height
    for (const rect of rangeRects) {
      if (
        ![rect.left, rect.top, rect.width, rect.height]
          .every(value => Number.isFinite(value))
        || rect.width <= 0
        || rect.height <= 0
      ) {
        continue
      }
      const left = Math.max(page.left, rect.left)
      const top = Math.max(page.top, rect.top)
      const right = Math.min(pageRight, rect.left + rect.width)
      const bottom = Math.min(pageBottom, rect.top + rect.height)
      if (right - left < 0.5 || bottom - top < 0.5) continue
      normalized.push({
        pageNumber: page.pageNumber,
        x: roundRatio((left - page.left) / page.width),
        y: roundRatio((top - page.top) / page.height),
        width: roundRatio((right - left) / page.width),
        height: roundRatio((bottom - top) / page.height),
      })
    }
  }
  const merged = mergePdfRects(normalized)
  if (merged.length > MAX_PDF_RECTS_PER_HIGHLIGHT) {
    throw new Error('This selection is too complex to highlight reliably.')
  }
  return merged
}

export function capturePdfSelectionRects(
  root: HTMLElement,
  range: Range,
): PdfPageRectV1[] {
  const pages = Array.from(
    root.querySelectorAll<HTMLElement>('[data-pdf-page-number]'),
  ).flatMap(page => {
    const pageNumber = Number(page.dataset.pdfPageNumber)
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) return []
    const rect = page.getBoundingClientRect()
    return [{
      pageNumber,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    }]
  })
  return normalizePdfSelectionRects(Array.from(range.getClientRects()), pages)
}

function normalizeSelectionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function copyPdfSelectionFields(
  selection: PdfSelectionSnapshot,
): PdfSelectionSnapshot {
  return {
    quote: selection.quote,
    ...(selection.contextBefore
      ? { contextBefore: selection.contextBefore }
      : {}),
    ...(selection.contextAfter
      ? { contextAfter: selection.contextAfter }
      : {}),
    startPage: selection.startPage,
    endPage: selection.endPage,
    rects: selection.rects.map(rect => ({ ...rect })),
  }
}

export function createPdfSelectionSnapshot(input: {
  quote: string
  contextBefore?: string
  contextAfter?: string
  rects: PdfPageRectV1[]
}): PdfSelectionSnapshot {
  const quote = normalizeSelectionText(input.quote)
  if (!quote) throw new Error('Select some text first.')
  if (quote.length > MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS) {
    throw new Error('The selection is too long. Select 4,000 characters or fewer.')
  }
  if (input.rects.length === 0) {
    throw new Error('This selection cannot be located reliably.')
  }
  if (input.rects.length > MAX_PDF_RECTS_PER_HIGHLIGHT) {
    throw new Error('This selection is too complex to highlight reliably.')
  }
  const rects = input.rects.map(rect => ({ ...rect }))
  const pages = rects.map(rect => rect.pageNumber)
  const contextBefore = normalizeSelectionText(input.contextBefore ?? '')
    .slice(-MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS)
  const contextAfter = normalizeSelectionText(input.contextAfter ?? '')
    .slice(0, MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS)
  return {
    quote,
    ...(contextBefore ? { contextBefore } : {}),
    ...(contextAfter ? { contextAfter } : {}),
    startPage: Math.min(...pages),
    endPage: Math.max(...pages),
    rects,
  }
}

export function buildPdfProjectFileReference(input: {
  identity: ProjectFileIdentity
  sourceFingerprint: SourceFingerprint
  fileName: string
  selection: PdfSelectionSnapshot
}): PdfProjectFileReferenceV1 {
  const selection = copyPdfSelectionFields(input.selection)
  const anchor = selection.rects[0]
  if (!anchor) throw new Error('This selection cannot be located reliably.')
  return {
    version: 1,
    kind: 'project-file',
    ...input.identity,
    sourceFingerprint: input.sourceFingerprint,
    fileName: input.fileName,
    quote: selection.quote,
    ...(selection.contextBefore
      ? { contextBefore: selection.contextBefore }
      : {}),
    ...(selection.contextAfter
      ? { contextAfter: selection.contextAfter }
      : {}),
    locator: {
      type: 'pdf-text-quote',
      exact: selection.quote,
      ...(selection.contextBefore ? { prefix: selection.contextBefore } : {}),
      ...(selection.contextAfter ? { suffix: selection.contextAfter } : {}),
      startPage: selection.startPage,
      endPage: selection.endPage,
      anchor: { ...anchor },
    },
  }
}

export function createOptimisticPdfHighlight(
  selection: PdfSelectionSnapshot,
  id: string,
  options: {
    style?: PdfHighlightV1['style']
    now?: number
  } = {},
): PdfHighlightV1 {
  const now = options.now ?? Date.now()
  return {
    id,
    ...copyPdfSelectionFields(selection),
    style: options.style ?? { type: 'wavy', color: 'red' },
    createdAt: now,
    updatedAt: now,
  }
}

function upsertPdfHighlight(
  highlights: PdfHighlightV1[],
  highlight: PdfHighlightV1,
): PdfHighlightV1[] {
  const index = highlights.findIndex(candidate => candidate.id === highlight.id)
  if (index === -1) return [...highlights, highlight]
  const next = [...highlights]
  next[index] = highlight
  return next
}

function removePdfHighlight(
  highlights: PdfHighlightV1[],
  highlightId: string,
): PdfHighlightV1[] {
  return highlights.filter(highlight => highlight.id !== highlightId)
}

type UpdateHighlights = (
  update: (highlights: PdfHighlightV1[]) => PdfHighlightV1[],
) => void

function toPdfHighlightMutation(
  highlight: PdfHighlightV1,
): Extract<PdfStateMutation, { type: 'upsert-highlight' }>['highlight'] {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...mutation } = highlight
  return {
    ...mutation,
    rects: mutation.rects.map(rect => ({ ...rect })),
  }
}

export async function persistOptimisticPdfHighlight(input: {
  highlight: PdfHighlightV1
  mutate: (mutation: PdfStateMutation) => Promise<ApplyPdfStateMutationResponse>
  updateHighlights: UpdateHighlights
}): Promise<ApplyPdfStateMutationResponse> {
  input.updateHighlights(current => upsertPdfHighlight(current, input.highlight))
  try {
    const response = await input.mutate({
      type: 'upsert-highlight',
      highlight: toPdfHighlightMutation(input.highlight),
    })
    const { canonicalHighlight } = response
    if (canonicalHighlight) {
      input.updateHighlights(current =>
        upsertPdfHighlight(current, canonicalHighlight))
    }
    return response
  } catch (error) {
    input.updateHighlights(current =>
      removePdfHighlight(current, input.highlight.id))
    throw error
  }
}

export async function deletePdfHighlightOptimistically(input: {
  highlight: PdfHighlightV1
  mutate: (mutation: PdfStateMutation) => Promise<ApplyPdfStateMutationResponse>
  updateHighlights: UpdateHighlights
}): Promise<ApplyPdfStateMutationResponse> {
  input.updateHighlights(current =>
    removePdfHighlight(current, input.highlight.id))
  try {
    return await input.mutate({
      type: 'delete-highlight',
      highlightId: input.highlight.id,
    })
  } catch (error) {
    input.updateHighlights(current =>
      upsertPdfHighlight(current, input.highlight))
    throw error
  }
}

interface PdfStateMutationCoordinatorOptions {
  initialRevision: number
  debounceMs?: number
  applyMutation: (
    mutation: PdfStateMutation,
  ) => Promise<ApplyPdfStateMutationResponse>
  getState: () => Promise<PdfDocumentStateV1 | null>
  onStateRefresh: (state: PdfDocumentStateV1) => void
  onBackgroundError?: (
    error: unknown,
    operation: 'set-progress' | 'refresh',
  ) => void
  scheduleTimer?: (callback: () => void, delayMs: number) => unknown
  cancelTimer?: (timer: unknown) => void
}

export function createPdfStateMutationCoordinator(
  options: PdfStateMutationCoordinatorOptions,
) {
  const scheduleTimer = options.scheduleTimer
    ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelTimer = options.cancelTimer
    ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const debounceMs = options.debounceMs ?? PDF_PROGRESS_DEBOUNCE_MS
  let revision = options.initialRevision
  let pendingProgress: Omit<PdfProgressV1, 'updatedAt'> | undefined
  let progressTimer: unknown
  let queue: Promise<unknown> = Promise.resolve()
  let disposed = false
  let disposePromise: Promise<void> | null = null

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }
  const refreshNow = async (): Promise<PdfDocumentStateV1 | null> => {
    const state = await options.getState()
    if (state && state.revision >= revision) {
      revision = state.revision
      if (!disposed) options.onStateRefresh(state)
    }
    return state
  }
  const applyNow = async (
    mutation: PdfStateMutation,
  ): Promise<ApplyPdfStateMutationResponse> => {
    const previousRevision = revision
    const response = await options.applyMutation(mutation)
    revision = Math.max(revision, response.revision)
    if (response.revision > previousRevision + 1) {
      try {
        await refreshNow()
      } catch (error) {
        options.onBackgroundError?.(error, 'refresh')
      }
    }
    return response
  }
  const flushProgress = (): Promise<ApplyPdfStateMutationResponse | undefined> => {
    if (progressTimer !== undefined) {
      cancelTimer(progressTimer)
      progressTimer = undefined
    }
    const progress = pendingProgress
    pendingProgress = undefined
    if (!progress || disposed) return Promise.resolve(undefined)
    return enqueue(() => applyNow({ type: 'set-progress', progress }))
  }

  return {
    scheduleProgress(progress: Omit<PdfProgressV1, 'updatedAt'>) {
      if (disposed) return
      pendingProgress = progress
      if (progressTimer !== undefined) cancelTimer(progressTimer)
      progressTimer = scheduleTimer(() => {
        progressTimer = undefined
        void flushProgress().catch(error => {
          options.onBackgroundError?.(error, 'set-progress')
        })
      }, debounceMs)
    },
    mutate(mutation: PdfStateMutation) {
      if (disposed) throw new Error('PDF state coordinator is disposed')
      return enqueue(() => applyNow(mutation))
    },
    refresh() {
      if (disposed) return Promise.resolve(null)
      return enqueue(refreshNow)
    },
    async flush() {
      if (disposed) {
        await disposePromise
        return
      }
      await flushProgress()
      await queue
    },
    dispose() {
      if (disposePromise) return disposePromise
      if (progressTimer !== undefined) {
        cancelTimer(progressTimer)
        progressTimer = undefined
      }
      const progress = pendingProgress
      pendingProgress = undefined
      const pendingFlush = progress
        ? enqueue(() => applyNow({ type: 'set-progress', progress }))
            .catch(error => {
              options.onBackgroundError?.(error, 'set-progress')
            })
        : queue.then(() => undefined)
      disposed = true
      disposePromise = pendingFlush.then(() => undefined)
      return disposePromise
    },
  }
}

export function comparePdfHighlights(
  left: PdfHighlightV1,
  right: PdfHighlightV1,
): number {
  const leftRect = left.rects[0]
  const rightRect = right.rects[0]
  return (leftRect?.pageNumber ?? left.startPage)
    - (rightRect?.pageNumber ?? right.startPage)
    || (leftRect?.y ?? 0) - (rightRect?.y ?? 0)
    || (leftRect?.x ?? 0) - (rightRect?.x ?? 0)
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id)
}

function quoteMarkdown(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map(line => line ? `> ${line}` : '>')
    .join('\n')
}

function escapeMarkdownTitle(value: string): string {
  return value.replace(/([\\`*_[\]{}()#+\-.!|<>])/g, '\\$1')
}

export function buildPdfHighlightsMarkdown(input: {
  fileName: string
  pageLabels?: string[] | null
  highlights: PdfHighlightV1[]
}): string {
  if (input.highlights.length === 0) return ''
  const byPage = new Map<number, PdfHighlightV1[]>()
  for (const highlight of [...input.highlights].sort(comparePdfHighlights)) {
    const group = byPage.get(highlight.startPage) ?? []
    group.push(highlight)
    byPage.set(highlight.startPage, group)
  }
  const sections = [`# ${escapeMarkdownTitle(input.fileName)}`]
  for (const [pageNumber, highlights] of byPage) {
    const label = input.pageLabels?.[pageNumber - 1]?.trim()
    sections.push(`## Page ${escapeMarkdownTitle(label || String(pageNumber))}`)
    sections.push(...highlights.map(highlight => quoteMarkdown(highlight.quote)))
  }
  return `${sections.join('\n\n').trimEnd()}\n`
}

export function getPdfHighlightsSuggestedFilename(fileName: string): string {
  const fallback = fileName.replace(/\.pdf$/i, '') || 'pdf'
  const safeName = fallback
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[.\s-]+$/g, '')
    .slice(0, 120)
  return `${safeName || 'pdf'}-highlights.md`
}
