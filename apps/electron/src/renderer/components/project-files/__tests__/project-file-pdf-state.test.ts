import { describe, expect, it } from 'bun:test'
import type {
  PdfDocumentStateV1,
  PdfHighlightV1,
  PdfStateMutation,
} from '@craft-agent/core/types'

import {
  buildPdfHighlightsMarkdown,
  buildPdfProjectFileReference,
  createOptimisticPdfHighlight,
  createPdfSelectionSnapshot,
  createPdfStateMutationCoordinator,
  deletePdfHighlightOptimistically,
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
})

describe('PDF highlight export', () => {
  it('groups ordered highlights by page label', () => {
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
  })
})
