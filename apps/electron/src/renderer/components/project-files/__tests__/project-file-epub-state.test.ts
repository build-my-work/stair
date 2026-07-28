import { describe, expect, it } from 'bun:test'
import { EpubCFI } from 'epubjs'
import type {
  EpubDocumentStateV1,
  EpubHighlightV1,
  EpubStateMutation,
  EpubTocNode,
  SourceFingerprint,
} from '@craft-agent/core/types'

import {
  buildEpubHighlightsMarkdown,
  buildEpubHighlightTree,
} from '@/lib/epub-highlights'

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
  updateEpubInitialLocatorLatch,
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

describe('EPUB open intent readiness', () => {
  it('does not rebuild when a consumed locator clears, but accepts the next intent', () => {
    const first = updateEpubInitialLocatorLatch(
      null,
      'viewer',
      'epubcfi(/6/2)',
    )
    const consumed = updateEpubInitialLocatorLatch(
      first,
      'viewer',
      undefined,
    )
    expect(consumed.cfiRange).toBe(first.cfiRange)
    expect(consumed.generation).toBe(first.generation)

    const reopened = updateEpubInitialLocatorLatch(
      consumed,
      'viewer',
      'epubcfi(/6/2)',
    )
    expect(reopened.generation).toBe(first.generation + 1)

    const switched = updateEpubInitialLocatorLatch(
      reopened,
      'other-viewer',
      undefined,
    )
    expect(switched.cfiRange).toBeUndefined()
    expect(switched.generation).toBe(0)
  })
})

describe('EPUB highlight tree and export metadata', () => {
  it('keeps only matched nodes and ancestors, with unmatched marks last', () => {
    const chapterPath = findEpubTocPath(toc, 'toc:0.0')
    const tree = buildEpubHighlightTree(toc, [
      highlight('later', {
        cfiRange: 'b',
        tocPath: chapterPath,
        createdAt: 2,
      }),
      highlight('earlier', {
        cfiRange: 'a',
        tocPath: chapterPath,
        createdAt: 1,
      }),
      highlight('unknown', { spineIndex: 4 }),
    ], (left, right) => left.localeCompare(right))

    expect(tree.nodes).toHaveLength(1)
    expect(tree.nodes[0]!.children).toHaveLength(1)
    expect(tree.nodes[0]!.children[0]!.highlights.map(mark => mark.id))
      .toEqual(['earlier', 'later'])
    expect(tree.unmatched.map(mark => mark.id)).toEqual(['unknown'])
  })

  it('creates a safe suggested filename', () => {
    expect(getEpubHighlightsSuggestedFilename('OS: notes / 2026', 'book.epub'))
      .toBe('OS- notes - 2026-highlights.md')
    expect(getEpubHighlightsSuggestedFilename('', 'book.epub'))
      .toBe('book-highlights.md')
  })

  it('exports deep Unicode TOC nodes with real EpubCFI ordering', () => {
    const deepest = {
      key: 'toc:5',
      title: '重复 章节',
      orderPath: [0, 0, 0, 0, 0, 0],
      children: [],
    }
    const deepToc: EpubTocNode[] = [{
      key: 'toc:0',
      title: '重复 章节',
      orderPath: [0],
      children: [{
        key: 'toc:1',
        title: '二',
        orderPath: [0, 0],
        children: [{
          key: 'toc:2',
          title: '三',
          orderPath: [0, 0, 0],
          children: [{
            key: 'toc:3',
            title: '四',
            orderPath: [0, 0, 0, 0],
            children: [{
              key: 'toc:4',
              title: '五',
              orderPath: [0, 0, 0, 0, 0],
              children: [deepest],
            }],
          }],
        }],
      }],
    }]
    const tocPath = findEpubTocPath(deepToc, deepest.key)
    const cfi = new EpubCFI()
    const output = buildEpubHighlightsMarkdown({
      bookTitle: '书名',
      fileName: 'book.epub',
      toc: deepToc,
      highlights: [
        highlight('later', {
          cfiRange: 'epubcfi(/6/2!/4/2/2:5)',
          quote: '第二条',
          tocPath,
        }),
        highlight('earlier', {
          cfiRange: 'epubcfi(/6/2!/4/2/2:0)',
          quote: '第一条',
          tocPath,
        }),
      ],
      compareCfi: (left, right) => cfi.compare(left, right),
    })

    expect(output).toContain('**重复 章节**')
    expect(output.indexOf('> 第一条')).toBeLessThan(output.indexOf('> 第二条'))
    expect(output.endsWith('\n')).toBe(true)
    expect(output.endsWith('\n\n')).toBe(false)
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
