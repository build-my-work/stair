import {
  MAX_PROJECT_FILE_REFERENCE_CFI_CHARS,
  MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
  MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS,
  type EpubDocumentStateV1,
  type EpubHighlightV1,
  type EpubProgressV1,
  type EpubStateMutation,
  type EpubTocPathEntryV1,
  type ProjectFileIdentity,
  type ProjectFileReferenceV1,
  type SourceFingerprint,
} from '@craft-agent/core/types'
import type { ApplyEpubStateMutationResponse } from '@craft-agent/shared/protocol'

import type { EpubTocNode } from './project-file-epub'

export const EPUB_PROGRESS_DEBOUNCE_MS = 1_000

export type EpubSelectionSnapshot = Omit<
  EpubHighlightV1,
  'id' | 'style' | 'createdAt' | 'updatedAt'
>

function copyEpubSelectionFields(
  selection: EpubSelectionSnapshot,
): EpubSelectionSnapshot {
  return {
    cfiRange: selection.cfiRange,
    quote: selection.quote,
    ...(selection.contextBefore
      ? { contextBefore: selection.contextBefore }
      : {}),
    ...(selection.contextAfter
      ? { contextAfter: selection.contextAfter }
      : {}),
    ...(selection.chapterKey ? { chapterKey: selection.chapterKey } : {}),
    ...(selection.chapterTitle ? { chapterTitle: selection.chapterTitle } : {}),
    tocPath: selection.tocPath,
    ...(selection.spineIndex !== undefined
      ? { spineIndex: selection.spineIndex }
      : {}),
  }
}

export interface EpubInitialLocatorLatch {
  viewerKey: string
  cfiRange?: string
  generation: number
  cleared: boolean
}

/**
 * Keep a consumed open intent from rebuilding the Reader when Page clears it,
 * while still allowing a later intent (including the same CFI) to navigate.
 */
export function updateEpubInitialLocatorLatch(
  current: EpubInitialLocatorLatch | null,
  viewerKey: string,
  cfiRange: string | undefined,
): EpubInitialLocatorLatch {
  if (!current || current.viewerKey !== viewerKey) {
    return {
      viewerKey,
      ...(cfiRange ? { cfiRange } : {}),
      generation: 0,
      cleared: cfiRange === undefined,
    }
  }

  if (cfiRange === undefined) {
    return current.cleared ? current : { ...current, cleared: true }
  }
  if (!current.cleared && current.cfiRange === cfiRange) return current
  return {
    viewerKey,
    cfiRange,
    generation: current.generation + 1,
    cleared: false,
  }
}

export function normalizeEpubSelectionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function createEpubSelectionSnapshot(input: {
  cfiRange: string
  quote: string
  contextBefore?: string
  contextAfter?: string
  chapter?: EpubTocNode | null
  tocPath?: EpubTocPathEntryV1[]
  spineIndex?: number
}): EpubSelectionSnapshot {
  const cfiRange = input.cfiRange.trim()
  const quote = normalizeEpubSelectionText(input.quote)
  if (!cfiRange || cfiRange.length > MAX_PROJECT_FILE_REFERENCE_CFI_CHARS) {
    throw new Error('This selection cannot be located reliably.')
  }
  if (!quote) throw new Error('Select some text first.')
  if (quote.length > MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS) {
    throw new Error('The selection is too long. Select 4,000 characters or fewer.')
  }

  const contextBefore = normalizeEpubSelectionText(input.contextBefore ?? '')
    .slice(-MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS)
  const contextAfter = normalizeEpubSelectionText(input.contextAfter ?? '')
    .slice(0, MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS)

  return {
    cfiRange,
    quote,
    ...(contextBefore ? { contextBefore } : {}),
    ...(contextAfter ? { contextAfter } : {}),
    ...(input.chapter?.key ? { chapterKey: input.chapter.key } : {}),
    ...(input.chapter?.title ? { chapterTitle: input.chapter.title } : {}),
    tocPath: input.tocPath ?? [],
    ...(Number.isSafeInteger(input.spineIndex)
      ? { spineIndex: input.spineIndex }
      : {}),
  }
}

export function findEpubTocPath(
  nodes: EpubTocNode[],
  key: string | undefined,
): EpubTocPathEntryV1[] {
  if (!key) return []

  const visit = (
    candidates: EpubTocNode[],
    ancestors: EpubTocPathEntryV1[],
  ): EpubTocPathEntryV1[] | null => {
    for (const node of candidates) {
      const entry: EpubTocPathEntryV1 = {
        key: node.key,
        title: node.title,
        orderPath: [...node.orderPath],
        ...(node.href ? { href: node.href } : {}),
      }
      const path = [...ancestors, entry]
      if (node.key === key) return path
      const childPath = visit(node.children, path)
      if (childPath) return childPath
    }
    return null
  }

  return visit(nodes, []) ?? []
}

export function buildProjectFileReferenceFromSelection(input: {
  identity: ProjectFileIdentity
  sourceFingerprint: SourceFingerprint
  fileName: string
  selection: EpubSelectionSnapshot
}): ProjectFileReferenceV1 {
  const normalizedSelection = copyEpubSelectionFields(input.selection)
  const {
    cfiRange,
    spineIndex: _spineIndex,
    ...selection
  } = normalizedSelection
  return {
    version: 1,
    kind: 'project-file',
    ...input.identity,
    sourceFingerprint: input.sourceFingerprint,
    fileName: input.fileName,
    ...selection,
    locator: {
      type: 'epub-cfi',
      cfiRange,
    },
  }
}

export function createOptimisticEpubHighlight(
  selection: EpubSelectionSnapshot,
  id: string,
  now = Date.now(),
): EpubHighlightV1 {
  return {
    id,
    ...copyEpubSelectionFields(selection),
    style: { type: 'wavy', color: 'red' },
    createdAt: now,
    updatedAt: now,
  }
}

function upsertEpubHighlight(
  highlights: EpubHighlightV1[],
  highlight: EpubHighlightV1,
): EpubHighlightV1[] {
  const index = highlights.findIndex(candidate => candidate.id === highlight.id)
  if (index === -1) return [...highlights, highlight]
  const next = [...highlights]
  next[index] = highlight
  return next
}

function removeEpubHighlight(
  highlights: EpubHighlightV1[],
  highlightId: string,
): EpubHighlightV1[] {
  return highlights.filter(highlight => highlight.id !== highlightId)
}

export async function displayEpubHighlightLocation(
  rendition: {
    book: {
      spine: {
        get(target: string): { index?: number } | undefined
      }
    }
    display(target?: string): Promise<unknown>
    display(target?: number): Promise<unknown>
  },
  cfiRange: string,
): Promise<void> {
  const section = rendition.book.spine.get(cfiRange)
  if (typeof section?.index === 'number' && Number.isInteger(section.index)) {
    await rendition.display(section.index)
  }
  await rendition.display(cfiRange)
}

type UpdateHighlights = (
  update: (highlights: EpubHighlightV1[]) => EpubHighlightV1[],
) => void

function toEpubHighlightMutation(
  highlight: EpubHighlightV1,
): Extract<
  EpubStateMutation,
  { type: 'upsert-highlight' }
>['highlight'] {
  return {
    id: highlight.id,
    ...copyEpubSelectionFields(highlight),
    style: highlight.style,
  }
}

export async function persistOptimisticEpubHighlight(input: {
  highlight: EpubHighlightV1
  mutate: (mutation: EpubStateMutation) => Promise<ApplyEpubStateMutationResponse>
  updateHighlights: UpdateHighlights
}): Promise<ApplyEpubStateMutationResponse> {
  input.updateHighlights(current => upsertEpubHighlight(current, input.highlight))
  try {
    const response = await input.mutate({
      type: 'upsert-highlight',
      highlight: toEpubHighlightMutation(input.highlight),
    })
    if (response.canonicalHighlight) {
      input.updateHighlights(current =>
        upsertEpubHighlight(current, response.canonicalHighlight!))
    }
    return response
  } catch (error) {
    input.updateHighlights(current =>
      removeEpubHighlight(current, input.highlight.id))
    throw error
  }
}

export async function deleteEpubHighlightOptimistically(input: {
  highlight: EpubHighlightV1
  mutate: (mutation: EpubStateMutation) => Promise<ApplyEpubStateMutationResponse>
  updateHighlights: UpdateHighlights
}): Promise<ApplyEpubStateMutationResponse> {
  input.updateHighlights(current =>
    removeEpubHighlight(current, input.highlight.id))
  try {
    return await input.mutate({
      type: 'delete-highlight',
      highlightId: input.highlight.id,
    })
  } catch (error) {
    input.updateHighlights(current =>
      upsertEpubHighlight(current, input.highlight))
    throw error
  }
}

interface EpubStateMutationCoordinatorOptions {
  initialRevision: number
  debounceMs?: number
  applyMutation: (
    mutation: EpubStateMutation,
  ) => Promise<ApplyEpubStateMutationResponse>
  getState: () => Promise<EpubDocumentStateV1 | null>
  onStateRefresh: (state: EpubDocumentStateV1) => void
  onBackgroundError?: (
    error: unknown,
    operation: 'set-progress' | 'refresh',
  ) => void
  scheduleTimer?: (callback: () => void, delayMs: number) => unknown
  cancelTimer?: (timer: unknown) => void
}

export function createEpubStateMutationCoordinator(
  options: EpubStateMutationCoordinatorOptions,
) {
  const scheduleTimer = options.scheduleTimer
    ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelTimer = options.cancelTimer
    ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const debounceMs = options.debounceMs ?? EPUB_PROGRESS_DEBOUNCE_MS

  let revision = options.initialRevision
  let pendingProgress: Omit<EpubProgressV1, 'updatedAt'> | undefined
  let progressTimer: unknown
  let queue: Promise<unknown> = Promise.resolve()
  let disposed = false
  let disposePromise: Promise<void> | null = null

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const refreshNow = async (): Promise<EpubDocumentStateV1 | null> => {
    const state = await options.getState()
    if (state && state.revision >= revision) {
      revision = state.revision
      if (!disposed) options.onStateRefresh(state)
    }
    return state
  }

  const applyNow = async (
    mutation: EpubStateMutation,
  ): Promise<ApplyEpubStateMutationResponse> => {
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

  const flushProgress = (): Promise<
    ApplyEpubStateMutationResponse | undefined
  > => {
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
    scheduleProgress(progress: Omit<EpubProgressV1, 'updatedAt'>) {
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

    mutate(mutation: EpubStateMutation) {
      if (disposed) {
        return Promise.reject(new Error('EPUB state coordinator is disposed'))
      }
      return enqueue(() => applyNow(mutation))
    },

    refresh() {
      if (disposed) return Promise.resolve(null)
      return enqueue(() => refreshNow())
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
        : queue.then(() => undefined)
      disposed = true
      disposePromise = pendingFlush.then(() => undefined)
      return disposePromise
    },
  }
}

export function getEpubHighlightsSuggestedFilename(
  bookTitle: string | undefined,
  fileName: string,
): string {
  const fallback = fileName.replace(/\.epub$/i, '') || 'epub'
  const safeTitle = (bookTitle?.trim() || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[.\s-]+$/g, '')
    .slice(0, 120)
  return `${safeTitle || 'epub'}-highlights.md`
}

export const EPUB_HIGHLIGHT_REGISTRY_NAME = 'craft-epub-red-wavy'
export const EPUB_HIGHLIGHT_STYLE_TEXT = `
::highlight(${EPUB_HIGHLIGHT_REGISTRY_NAME}) {
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-color: #ef4444;
  text-decoration-thickness: 1.35px;
  text-underline-offset: 0.12em;
  text-decoration-skip-ink: none;
}
`.trim()

interface CssHighlightRegistryAdapter {
  set(name: string, highlight: unknown): void
  delete(name: string): boolean
}

interface CssHighlightWindow extends Window {
  CSS: typeof CSS & {
    highlights?: CssHighlightRegistryAdapter
  }
  Highlight?: new (...ranges: Range[]) => unknown
}

export interface EpubCssHighlightContents {
  document: Document
  window: Window
  sectionIndex: number
  range(cfiRange: string): Range
}

export function createEpubCssHighlightManager() {
  interface ContentState {
    contents: EpubCssHighlightContents
    styleElement: HTMLStyleElement
  }

  const contentStates = new Map<Document, ContentState>()
  let currentHighlights: EpubHighlightV1[] = []

  const registryFor = (
    contents: EpubCssHighlightContents,
  ): {
    registry: CssHighlightRegistryAdapter
    HighlightConstructor: new (...ranges: Range[]) => unknown
  } | null => {
    const contentWindow = contents.window as CssHighlightWindow
    const registry = contentWindow.CSS?.highlights
    const HighlightConstructor = contentWindow.Highlight
    if (!registry || !HighlightConstructor) return null
    return { registry, HighlightConstructor }
  }

  const refreshContents = (contents: EpubCssHighlightContents) => {
    const cssHighlights = registryFor(contents)
    if (!cssHighlights) return

    const ranges: Range[] = []
    for (const highlight of currentHighlights) {
      if (
        highlight.spineIndex !== undefined
        && highlight.spineIndex !== contents.sectionIndex
      ) {
        continue
      }
      try {
        ranges.push(contents.range(highlight.cfiRange))
      } catch {
        // A CFI from another spine item or a stale malformed CFI is skipped.
      }
    }

    if (ranges.length === 0) {
      cssHighlights.registry.delete(EPUB_HIGHLIGHT_REGISTRY_NAME)
      return
    }
    cssHighlights.registry.set(
      EPUB_HIGHLIGHT_REGISTRY_NAME,
      new cssHighlights.HighlightConstructor(...ranges),
    )
  }

  return {
    registerContents(contents: EpubCssHighlightContents) {
      const existing = contentStates.get(contents.document)
      if (existing) return () => undefined

      const styleElement = contents.document.createElement('style')
      styleElement.dataset.craftEpubHighlights = 'true'
      styleElement.textContent = EPUB_HIGHLIGHT_STYLE_TEXT
      const styleHost =
        contents.document.head ?? contents.document.documentElement
      styleHost.appendChild(styleElement)
      contentStates.set(contents.document, { contents, styleElement })
      refreshContents(contents)

      return () => {
        const state = contentStates.get(contents.document)
        if (!state) return
        registryFor(contents)?.registry.delete(EPUB_HIGHLIGHT_REGISTRY_NAME)
        state.styleElement.remove()
        contentStates.delete(contents.document)
      }
    },

    sync(highlights: EpubHighlightV1[]) {
      currentHighlights = highlights
      for (const state of contentStates.values()) {
        refreshContents(state.contents)
      }
    },

    destroy() {
      for (const state of contentStates.values()) {
        registryFor(state.contents)?.registry.delete(
          EPUB_HIGHLIGHT_REGISTRY_NAME,
        )
        state.styleElement.remove()
      }
      contentStates.clear()
      currentHighlights = []
    },
  }
}
