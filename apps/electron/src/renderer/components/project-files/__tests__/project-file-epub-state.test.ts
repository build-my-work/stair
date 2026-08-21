import { describe, expect, it } from 'bun:test'
import type {
  EpubDocumentStateV1,
  EpubHighlightV1,
  EpubStateMutation,
  EpubTocNode,
  SourceFingerprint,
} from '@craft-agent/shared/project-files'

import {
  EPUB_HIGHLIGHT_REGISTRY_NAME,
  EPUB_HIGHLIGHT_STYLE_TEXT,
  EPUB_REFERENCE_UNDERLINE_REGISTRY_NAME,
  buildProjectFileReferenceFromSelection,
  createEpubCssHighlightManager,
  createEpubSelectionSnapshot,
  createEpubStateMutationCoordinator,
  createOptimisticEpubHighlight,
  deleteEpubHighlightOptimistically,
  displayEpubHighlightLocation,
  findEpubTocPath,
  getEpubHighlightsSuggestedFilename,
  persistOptimisticEpubHighlight,
  type EpubCssHighlightContents,
} from '../project-file-epub-state'

const fingerprint = `sha256:${'a'.repeat(64)}` as SourceFingerprint

const toc: EpubTocNode[] = [{
  key: 'toc:0',
  title: 'Part',
  href: 'part.xhtml',
  orderPath: [0],
  children: [{
    key: 'toc:0.0',
    title: 'Chapter',
    href: 'chapter.xhtml',
    orderPath: [0, 0],
    children: [],
  }],
}]

function highlight(
  id: string,
  patch: Partial<EpubHighlightV1> = {},
): EpubHighlightV1 {
  return {
    id,
    cfiRange: `epubcfi(/6/4!/4/${id})`,
    quote: `quote ${id}`,
    tocPath: [],
    spineIndex: 0,
    style: { type: 'wavy', color: 'red' },
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    updatedAt: 1,
    ...patch,
  }
}

function state(
  revision: number,
  highlights: EpubHighlightV1[] = [],
): EpubDocumentStateV1 {
  return {
    version: 1,
    projectId: 'project',
    relativePath: 'book.epub',
    sourceFingerprint: fingerprint,
    revision,
    highlights,
    updatedAt: revision,
  }
}

describe('EPUB selection and references', () => {
  it('生成安全的高亮导出文件名', () => {
    expect(getEpubHighlightsSuggestedFilename('OS: notes / 2026', 'book.epub'))
      .toBe('OS- notes - 2026-highlights.md')
    expect(getEpubHighlightsSuggestedFilename('', 'book.epub'))
      .toBe('book-highlights.md')
  })

  it('captures bounded context and the canonical TOC ancestry', () => {
    const chapter = toc[0]!.children[0]!
    const selection = createEpubSelectionSnapshot({
      cfiRange: ' epubcfi(/6/4!/4/2) ',
      quote: '  selected\n words ',
      contextBefore: `${'x'.repeat(1_050)} before `,
      contextAfter: ` after ${'y'.repeat(1_050)}`,
      chapter,
      tocPath: findEpubTocPath(toc, chapter.key),
      spineIndex: 3,
    })

    expect(selection.quote).toBe('selected words')
    expect(selection.contextBefore!.length).toBe(1_000)
    expect(selection.contextAfter!.length).toBe(1_000)
    expect(selection.tocPath.map(entry => entry.key)).toEqual([
      'toc:0',
      'toc:0.0',
    ])

    const reference = buildProjectFileReferenceFromSelection({
      identity: { projectId: 'project', relativePath: 'book.epub' },
      sourceFingerprint: fingerprint,
      fileName: 'book.epub',
      selection,
    })
    expect(reference.kind).toBe('project-file')
    expect(reference.locator).toEqual({
      type: 'epub-cfi',
      cfiRange: 'epubcfi(/6/4!/4/2)',
    })
    expect(reference.tocPath).toEqual(selection.tocPath)
    expect(reference).not.toHaveProperty('spineIndex')
  })

  it('rejects empty and oversized selections instead of truncating the quote', () => {
    expect(() => createEpubSelectionSnapshot({
      cfiRange: 'epubcfi(/6/4)',
      quote: ' ',
    })).toThrow('Select some text')
    expect(() => createEpubSelectionSnapshot({
      cfiRange: 'epubcfi(/6/4)',
      quote: 'x'.repeat(4_001),
    })).toThrow('4,000')
  })
})

describe('EPUB state mutation coordination', () => {
  it('debounces progress and flushes the latest location during dispose', async () => {
    const timers = new Map<number, { callback: () => void; delay: number }>()
    const mutations: EpubStateMutation[] = []
    let nextTimer = 0
    const coordinator = createEpubStateMutationCoordinator({
      initialRevision: 0,
      applyMutation: async mutation => {
        mutations.push(mutation)
        return { revision: mutations.length, applied: true }
      },
      getState: async () => null,
      onStateRefresh: () => undefined,
      scheduleTimer: (callback, delay) => {
        const timer = ++nextTimer
        timers.set(timer, { callback, delay })
        return timer
      },
      cancelTimer: timer => {
        timers.delete(timer as number)
      },
    })

    coordinator.scheduleProgress({ cfi: 'first' })
    coordinator.scheduleProgress({ cfi: 'latest', percentage: 0.5 })
    expect([...timers.values()].map(timer => timer.delay)).toEqual([1_000])

    await coordinator.dispose()
    expect(timers.size).toBe(0)
    expect(mutations).toEqual([{
      type: 'set-progress',
      progress: { cfi: 'latest', percentage: 0.5 },
    }])
  })

  it('flushes without disposing so Preview replacement can continue safely', async () => {
    const mutations: EpubStateMutation[] = []
    const coordinator = createEpubStateMutationCoordinator({
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

    coordinator.scheduleProgress({ cfi: 'before-replacement' })
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

  it('serializes mutations and reloads full state after a revision gap', async () => {
    const refreshed: EpubDocumentStateV1[] = []
    let getCalls = 0
    const coordinator = createEpubStateMutationCoordinator({
      initialRevision: 1,
      applyMutation: async () => ({ revision: 4, applied: true }),
      getState: async () => {
        getCalls += 1
        return state(4, [highlight('remote')])
      },
      onStateRefresh: next => refreshed.push(next),
    })

    const response = await coordinator.mutate({
      type: 'delete-highlight',
      highlightId: 'missing',
    })
    expect(response.revision).toBe(4)
    expect(getCalls).toBe(1)
    expect(refreshed[0]!.highlights[0]!.id).toBe('remote')
    await coordinator.dispose()
  })

  it('keeps progress and highlight mutations on one ordered queue', async () => {
    let inFlight = 0
    let maximumInFlight = 0
    let revision = 0
    const order: string[] = []
    let runProgress: (() => void) | undefined
    const coordinator = createEpubStateMutationCoordinator({
      initialRevision: 0,
      applyMutation: async mutation => {
        inFlight += 1
        maximumInFlight = Math.max(maximumInFlight, inFlight)
        order.push(mutation.type)
        await Promise.resolve()
        inFlight -= 1
        return { revision: ++revision, applied: true }
      },
      getState: async () => null,
      onStateRefresh: () => undefined,
      scheduleTimer: callback => {
        runProgress = callback
        return 1
      },
      cancelTimer: () => undefined,
    })

    coordinator.scheduleProgress({ cfi: 'progress' })
    runProgress!()
    const mark = coordinator.mutate({
      type: 'delete-highlight',
      highlightId: 'mark',
    })
    await mark

    expect(maximumInFlight).toBe(1)
    expect(order).toEqual(['set-progress', 'delete-highlight'])
    await coordinator.dispose()
  })
})

describe('optimistic EPUB highlight mutations', () => {
  it('creates a solid blue underline for a chat reference', () => {
    const underline = createOptimisticEpubHighlight(
      createEpubSelectionSnapshot({
        cfiRange: 'epubcfi(/6/4!/4/2)',
        quote: 'selected',
      }),
      'reference',
      {
        style: { type: 'solid', color: 'blue' },
        now: 10,
      },
    )

    expect(underline.style).toEqual({ type: 'solid', color: 'blue' })
    expect(underline.createdAt).toBe(10)
    expect(underline.updatedAt).toBe(10)
  })

  it('canonicalizes successful creates and rolls failed creates back', async () => {
    const optimistic = createOptimisticEpubHighlight(
      createEpubSelectionSnapshot({
        cfiRange: 'epubcfi(/6/4!/4/2)',
        quote: 'selected',
      }),
      'local',
      { now: 10 },
    )
    let values: EpubHighlightV1[] = []
    let persistedMutation: EpubStateMutation | undefined
    const update = (
      updater: (current: EpubHighlightV1[]) => EpubHighlightV1[],
    ) => {
      values = updater(values)
    }

    await persistOptimisticEpubHighlight({
      highlight: optimistic,
      mutate: async mutation => {
        persistedMutation = mutation
        return {
          revision: 1,
          applied: true,
          canonicalHighlight: { ...optimistic, createdAt: 20, updatedAt: 20 },
        }
      },
      updateHighlights: update,
    })
    expect(values[0]!.createdAt).toBe(20)
    expect(persistedMutation?.type).toBe('upsert-highlight')
    if (persistedMutation?.type === 'upsert-highlight') {
      expect(persistedMutation.highlight).not.toHaveProperty('createdAt')
      expect(persistedMutation.highlight).not.toHaveProperty('updatedAt')
    }

    await expect(persistOptimisticEpubHighlight({
      highlight: { ...optimistic, id: 'failed' },
      mutate: async () => {
        throw new Error('offline')
      },
      updateHighlights: update,
    })).rejects.toThrow('offline')
    expect(values.map(value => value.id)).toEqual(['local'])
  })

  it('restores a failed optimistic delete', async () => {
    const existing = highlight('saved')
    let values = [existing]
    await expect(deleteEpubHighlightOptimistically({
      highlight: existing,
      mutate: async () => {
        throw new Error('offline')
      },
      updateHighlights: updater => {
        values = updater(values)
      },
    })).rejects.toThrow('offline')
    expect(values).toEqual([existing])
  })

  it('mounts the target spine before jumping to a continuous-flow CFI', async () => {
    const targets: Array<string | number> = []
    await displayEpubHighlightLocation({
      book: {
        spine: {
          get: () => ({ index: 7 }),
        },
      },
      display: async target => {
        if (target !== undefined) targets.push(target)
      },
    }, 'epubcfi(/6/16!/4/2)')
    expect(targets).toEqual([7, 'epubcfi(/6/16!/4/2)'])
  })
})

describe('CSS Custom Highlight restoration', () => {
  it('restores, updates and removes red wavy ranges per loaded spine', () => {
    const registry = new Map<string, unknown>()
    const styles: Array<{
      dataset: Record<string, string>
      textContent: string
      removed: boolean
      remove(): void
    }> = []
    class FakeHighlight {
      readonly ranges: unknown[]

      constructor(...ranges: unknown[]) {
        this.ranges = ranges
      }
    }
    const document = {
      createElement() {
        const style = {
          dataset: {} as Record<string, string>,
          textContent: '',
          removed: false,
          remove() {
            this.removed = true
          },
        }
        styles.push(style)
        return style
      },
      head: {
        appendChild() {
          return undefined
        },
      },
      documentElement: {},
    }
    const contents = {
      document,
      sectionIndex: 0,
      window: {
        CSS: {
          highlights: {
            set: (name: string, value: unknown) => {
              registry.set(name, value)
            },
            delete: (name: string) => registry.delete(name),
          },
        },
        Highlight: FakeHighlight,
      },
      range: (cfiRange: string) => ({ cfiRange }),
    } as unknown as EpubCssHighlightContents

    const manager = createEpubCssHighlightManager()
    const unregister = manager.registerContents(contents)
    const referenceUnderline: EpubHighlightV1 = {
      ...highlight('reference', { spineIndex: 0 }),
      style: { type: 'solid', color: 'blue' },
    }
    manager.sync([
      highlight('shown', { spineIndex: 0 }),
      highlight('other', { spineIndex: 1 }),
      referenceUnderline,
    ])

    expect(styles[0]!.textContent).toContain('text-decoration-style: wavy')
    expect(styles[0]!.textContent).toContain('text-decoration-style: solid')
    expect(EPUB_HIGHLIGHT_STYLE_TEXT).toContain('#ef4444')
    const rendered = registry.get(EPUB_HIGHLIGHT_REGISTRY_NAME) as FakeHighlight
    expect(rendered.ranges).toEqual([{
      cfiRange: 'epubcfi(/6/4!/4/shown)',
    }])
    const renderedReference = registry.get(
      EPUB_REFERENCE_UNDERLINE_REGISTRY_NAME,
    ) as FakeHighlight
    expect(renderedReference.ranges).toEqual([{
      cfiRange: 'epubcfi(/6/4!/4/reference)',
    }])

    manager.sync([])
    expect(registry.has(EPUB_HIGHLIGHT_REGISTRY_NAME)).toBe(false)
    expect(registry.has(EPUB_REFERENCE_UNDERLINE_REGISTRY_NAME)).toBe(false)
    unregister()
    expect(styles[0]!.removed).toBe(true)
    manager.destroy()
  })
})
