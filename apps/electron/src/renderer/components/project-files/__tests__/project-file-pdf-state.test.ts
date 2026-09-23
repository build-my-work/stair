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
  for (const firstWriteFails of [false, true]) {
    it(`keeps the newest reading position when an older write ${firstWriteFails ? 'fails' : 'succeeds'}`, async () => {
      let started!: () => void
      let release!: () => void
      const writeStarted = new Promise<void>(resolve => { started = resolve })
      const writeBlocked = new Promise<void>(resolve => { release = resolve })
      let attempts = 0
      let persisted: PdfStateMutation | undefined
      const coordinator = createPdfStateMutationCoordinator({
        initialRevision: 0,
        applyMutation: async mutation => {
          if (++attempts === 1) {
            started()
            await writeBlocked
            if (firstWriteFails) throw new Error('offline')
          }
          persisted = mutation
          return { revision: attempts, applied: true }
        },
        getState: async () => null,
        onStateRefresh: () => undefined,
        scheduleTimer: () => 1,
        cancelTimer: () => undefined,
      })
      coordinator.scheduleProgress({ pageNumber: 2, pageOffsetRatio: 0.25 })
      const closing = coordinator.flush()
      const outcome = Promise.allSettled([closing])
      await writeStarted
      coordinator.scheduleProgress({ pageNumber: 4, pageOffsetRatio: 0.5 })
      release()
      expect((await outcome)[0]!.status).toBe(firstWriteFails ? 'rejected' : 'fulfilled')
      await coordinator.flush()
      expect(persisted).toEqual({
        type: 'set-progress',
        progress: { pageNumber: 4, pageOffsetRatio: 0.5 },
      })
      await coordinator.dispose()
    })
  }

  it('allows retry after disposal cannot save reading progress', async () => {
    let fail = true
    let persisted: PdfStateMutation | undefined
    const coordinator = createPdfStateMutationCoordinator({
      initialRevision: 0,
      applyMutation: async mutation => {
        if (fail) throw new Error('offline')
        persisted = mutation
        return { revision: 1, applied: true }
      },
      getState: async () => null,
      onStateRefresh: () => undefined,
      scheduleTimer: () => 1,
      cancelTimer: () => undefined,
    })
    coordinator.scheduleProgress({ pageNumber: 4, pageOffsetRatio: 0.5 })
    await expect(coordinator.dispose()).rejects.toThrow('offline')
    fail = false
    await coordinator.flush()
    expect(persisted).toEqual({ type: 'set-progress', progress: { pageNumber: 4, pageOffsetRatio: 0.5 } })
    await coordinator.dispose()
  })

  it('reports a failed mutation queued while close is waiting for progress', async () => {
    let releaseProgress!: () => void
    const progressWrite = new Promise<void>(resolve => { releaseProgress = resolve })
    const coordinator = createPdfStateMutationCoordinator({
      initialRevision: 0,
      applyMutation: async mutation => {
        if (mutation.type !== 'set-progress') throw new Error('delete failed')
        await progressWrite
        return { revision: 1, applied: true }
      },
      getState: async () => null,
      onStateRefresh: () => undefined,
      scheduleTimer: () => 1,
      cancelTimer: () => undefined,
    })
    coordinator.scheduleProgress({ pageNumber: 4, pageOffsetRatio: 0.5 })
    const closing = coordinator.flush()
    const deleting = coordinator.mutate({ type: 'delete-highlight', highlightId: 'existing' })
    const outcomes = Promise.allSettled([closing, deleting])
    releaseProgress()

    expect(await outcomes).toEqual([
      { status: 'rejected', reason: new Error('delete failed') },
      { status: 'rejected', reason: new Error('delete failed') },
    ])
    await coordinator.flush()
    await coordinator.dispose()
  })

  it('vetoes a close waiting for a failed highlight mutation, then allows close after rollback', async () => {
    const existing = createOptimisticPdfHighlight(selection(), 'existing')
    let highlights = [existing]
    let failWrite!: (error: Error) => void
    const write = new Promise<never>((_resolve, reject) => { failWrite = reject })
    const coordinator = createPdfStateMutationCoordinator({
      initialRevision: 0,
      applyMutation: () => write,
      getState: async () => null,
      onStateRefresh: () => undefined,
    })
    const deleting = deletePdfHighlightOptimistically({
      highlight: existing,
      mutate: mutation => coordinator.mutate(mutation),
      updateHighlights: update => { highlights = update(highlights) },
    })
    const closing = coordinator.flush()
    const outcomes = Promise.allSettled([deleting, closing])
    failWrite(new Error('delete failed'))

    expect(await outcomes).toEqual([
      { status: 'rejected', reason: new Error('delete failed') },
      { status: 'rejected', reason: new Error('delete failed') },
    ])
    expect(highlights).toEqual([existing])
    await expect(coordinator.flush()).resolves.toBeUndefined()
    await coordinator.dispose()
  })

  it('retries an unsaved reading position when a vetoed close is attempted again', async () => {
    let attempts = 0
    const persisted: PdfStateMutation[] = []
    const coordinator = createPdfStateMutationCoordinator({
      initialRevision: 0,
      applyMutation: async mutation => {
        if (++attempts === 1) throw new Error('offline')
        persisted.push(mutation)
        return { revision: 1, applied: true }
      },
      getState: async () => null,
      onStateRefresh: () => undefined,
      scheduleTimer: () => 1,
      cancelTimer: () => undefined,
    })

    coordinator.scheduleProgress({ pageNumber: 4, pageOffsetRatio: 0.5 })
    await expect(coordinator.flush()).rejects.toThrow('offline')
    await coordinator.flush()
    expect(persisted).toEqual([{
      type: 'set-progress',
      progress: { pageNumber: 4, pageOffsetRatio: 0.5 },
    }])
    await coordinator.dispose()
  })

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
