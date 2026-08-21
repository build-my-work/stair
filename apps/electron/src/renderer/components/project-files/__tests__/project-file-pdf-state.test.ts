import { describe, expect, it } from 'bun:test'
import type {
  PdfDocumentStateV1,
  PdfHighlightV1,
  PdfStateMutation,
} from '@craft-agent/shared/project-files'

import {
  buildPdfHighlightsMarkdown,
  buildPdfProjectFileReference,
  createOptimisticPdfHighlight,
  createPdfSelectionSnapshot,
  createPdfStateMutationCoordinator,
  deletePdfHighlightOptimistically,
  getPdfHighlightsSuggestedFilename,
  normalizePdfSelectionRects,
  persistOptimisticPdfHighlight,
} from '../project-file-pdf-state'

const fingerprint = `sha256:${'a'.repeat(64)}` as const

function selection() {
  return createPdfSelectionSnapshot({
    quote: '  selected\n PDF   text  ',
    contextBefore: '  before   text ',
    contextAfter: ' after   text ',
    rects: [{
      pageNumber: 2,
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.04,
    }],
  })
}

describe('PDF selection geometry', () => {
  it('clips, normalizes, and merges adjacent text fragments by page', () => {
    expect(normalizePdfSelectionRects([
      { left: 20, top: 30, width: 30, height: 10 },
      { left: 51, top: 30, width: 20, height: 10 },
      { left: 15, top: 135, width: 40, height: 10 },
    ], [
      { pageNumber: 1, left: 10, top: 20, width: 100, height: 100 },
      { pageNumber: 2, left: 10, top: 130, width: 100, height: 100 },
    ])).toEqual([
      { pageNumber: 1, x: 0.1, y: 0.1, width: 0.51, height: 0.1 },
      { pageNumber: 2, x: 0.05, y: 0.05, width: 0.4, height: 0.1 },
    ])
  })

  it('normalizes selection text and builds an anchored PDF reference', () => {
    const snapshot = selection()
    expect(snapshot).toMatchObject({
      quote: 'selected PDF text',
      contextBefore: 'before text',
      contextAfter: 'after text',
      startPage: 2,
      endPage: 2,
    })
    expect(buildPdfProjectFileReference({
      identity: { projectId: 'project-1', relativePath: 'paper.pdf' },
      sourceFingerprint: fingerprint,
      fileName: 'paper.pdf',
      selection: snapshot,
    })).toMatchObject({
      quote: 'selected PDF text',
      locator: {
        type: 'pdf-text-quote',
        exact: 'selected PDF text',
        startPage: 2,
        endPage: 2,
        anchor: snapshot.rects[0],
      },
    })
  })
})

describe('PDF highlight export', () => {
  it('按印刷页码分组并生成安全文件名', () => {
    const first = createOptimisticPdfHighlight(selection(), 'first', { now: 1 })
    const second = createOptimisticPdfHighlight({
      ...selection(),
      quote: 'later quote',
      startPage: 3,
      endPage: 3,
      rects: [{ pageNumber: 3, x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
    }, 'second', { now: 2 })

    expect(buildPdfHighlightsMarkdown({
      fileName: 'paper.pdf',
      pageLabels: ['i', '1', '2'],
      highlights: [second, first],
    })).toBe([
      '# paper\\.pdf',
      '',
      '## Page 1',
      '',
      '> selected PDF text',
      '',
      '## Page 2',
      '',
      '> later quote',
      '',
    ].join('\n'))
    expect(getPdfHighlightsSuggestedFilename('notes / final.pdf'))
      .toBe('notes - final-highlights.md')
  })
})

describe('PDF optimistic state', () => {
  it('adds a highlight optimistically and replaces it with the canonical value', async () => {
    const optimistic = createOptimisticPdfHighlight(selection(), 'h1', { now: 10 })
    let highlights: PdfHighlightV1[] = []
    const canonical = { ...optimistic, createdAt: 20, updatedAt: 20 }
    await persistOptimisticPdfHighlight({
      highlight: optimistic,
      updateHighlights: update => {
        highlights = update(highlights)
      },
      mutate: async () => ({
        revision: 1,
        applied: true,
        canonicalHighlight: canonical,
      }),
    })
    expect(highlights).toEqual([canonical])
  })

  it('rolls optimistic add and delete back when persistence fails', async () => {
    const highlight = createOptimisticPdfHighlight(selection(), 'h1')
    let highlights: PdfHighlightV1[] = []
    await expect(persistOptimisticPdfHighlight({
      highlight,
      updateHighlights: update => {
        highlights = update(highlights)
      },
      mutate: async () => {
        throw new Error('write failed')
      },
    })).rejects.toThrow('write failed')
    expect(highlights).toEqual([])

    highlights = [highlight]
    await expect(deletePdfHighlightOptimistically({
      highlight,
      updateHighlights: update => {
        highlights = update(highlights)
      },
      mutate: async () => {
        throw new Error('delete failed')
      },
    })).rejects.toThrow('delete failed')
    expect(highlights).toEqual([highlight])
  })

  it('flushes the last reading position before disposal', async () => {
    const mutations: PdfStateMutation[] = []
    const state: PdfDocumentStateV1 = {
      version: 1,
      projectId: 'project-1',
      relativePath: 'paper.pdf',
      sourceFingerprint: fingerprint,
      revision: 0,
      highlights: [],
      updatedAt: 0,
    }
    const coordinator = createPdfStateMutationCoordinator({
      initialRevision: 0,
      applyMutation: async mutation => {
        mutations.push(mutation)
        return { revision: mutations.length, applied: true }
      },
      getState: async () => state,
      onStateRefresh: () => {},
      scheduleTimer: () => 1,
      cancelTimer: () => {},
    })
    coordinator.scheduleProgress({
      pageNumber: 4,
      pageOffsetRatio: 0.25,
      percentage: 0.5,
    })
    await coordinator.dispose()
    expect(mutations).toEqual([{
      type: 'set-progress',
      progress: {
        pageNumber: 4,
        pageOffsetRatio: 0.25,
        percentage: 0.5,
      },
    }])
  })

  it('stops accepting progress as soon as disposal begins', async () => {
    let scheduledTimers = 0
    let releaseWrite!: () => void
    const writeBlocked = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    const coordinator = createPdfStateMutationCoordinator({
      initialRevision: 0,
      applyMutation: async () => {
        await writeBlocked
        return { revision: 1, applied: true }
      },
      getState: async () => null,
      onStateRefresh: () => undefined,
      scheduleTimer: () => ++scheduledTimers,
      cancelTimer: () => undefined,
    })
    coordinator.scheduleProgress({ pageNumber: 4, pageOffsetRatio: 0.25 })
    const disposing = coordinator.dispose()
    coordinator.scheduleProgress({ pageNumber: 5, pageOffsetRatio: 0.5 })

    expect(scheduledTimers).toBe(1)
    releaseWrite()
    await disposing
  })

  it('flushes pending progress without disposing the coordinator', async () => {
    const mutations: PdfStateMutation[] = []
    const coordinator = createPdfStateMutationCoordinator({
      initialRevision: 0,
      applyMutation: async mutation => {
        mutations.push(mutation)
        return { revision: mutations.length, applied: true }
      },
      getState: async () => null,
      onStateRefresh: () => undefined,
      scheduleTimer: () => 1,
      cancelTimer: () => undefined,
    })
    coordinator.scheduleProgress({ pageNumber: 2, pageOffsetRatio: 0.4 })
    await coordinator.flush()
    await expect(coordinator.mutate({
      type: 'delete-highlight',
      highlightId: 'still-active',
    })).resolves.toMatchObject({ revision: 2 })
    expect(mutations.map(mutation => mutation.type)).toEqual([
      'set-progress',
      'delete-highlight',
    ])
    await coordinator.dispose()
  })
})
