import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  PdfHighlightV1,
  PdfStateMutation,
  SourceFingerprint,
} from '@craft-agent/core/types'
import { createProject, getProjectPath } from '@craft-agent/shared/projects'

import {
  MAX_PDF_STATE_BYTES,
  PdfStateStore,
  type PdfStateIdentity,
  writePdfStateFile,
} from './pdf-state'

let root = ''
let identity: PdfStateIdentity
let projectSlug = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pdf-state-'))
  const project = createProject(root, { name: 'Reader' })
  projectSlug = project.slug
  identity = {
    projectId: project.id,
    relativePath: 'papers/os.pdf',
    sourceFingerprint: `sha256:${'a'.repeat(64)}` as SourceFingerprint,
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function highlight(
  id: string,
  style: PdfHighlightV1['style'] = { type: 'wavy', color: 'red' },
): Extract<PdfStateMutation, { type: 'upsert-highlight' }> {
  return {
    type: 'upsert-highlight',
    highlight: {
      id,
      quote: `quote ${id}`,
      contextBefore: 'before',
      contextAfter: 'after',
      startPage: 2,
      endPage: 2,
      rects: [{
        pageNumber: 2,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.04,
      }],
      style,
    },
  }
}

function persistedStatePath(): string {
  const directory = join(getProjectPath(root, projectSlug), 'pdf-state', 'v1')
  const filename = readdirSync(directory).find(entry => entry.endsWith('.json'))
  if (!filename) throw new Error('Expected persisted PDF state')
  return join(directory, filename)
}

describe('PdfStateStore', () => {
  it('persists progress and both supported mark styles', async () => {
    const store = new PdfStateStore(() => 100)
    expect(await store.get(root, identity)).toBeNull()

    await store.apply(root, identity, {
      type: 'set-progress',
      progress: { pageNumber: 3, pageOffsetRatio: 0.25, percentage: 0.5 },
    })
    await store.apply(root, identity, highlight('highlight'))
    await store.apply(
      root,
      identity,
      highlight('reference', { type: 'solid', color: 'blue' }),
    )

    expect(await store.get(root, identity)).toMatchObject({
      revision: 3,
      progress: {
        pageNumber: 3,
        pageOffsetRatio: 0.25,
        percentage: 0.5,
        updatedAt: 100,
      },
      highlights: [
        { id: 'highlight', style: { type: 'wavy', color: 'red' } },
        { id: 'reference', style: { type: 'solid', color: 'blue' } },
      ],
    })
  })

  it('normalizes mutations before persisting them', async () => {
    const store = new PdfStateStore(() => 100)
    await store.apply(root, identity, {
      ...highlight('h1'),
      injected: 'drop-me',
      highlight: {
        ...highlight('h1').highlight,
        injected: 'drop-me',
        rects: [{
          ...highlight('h1').highlight.rects[0],
          injected: 'drop-me',
        }],
      },
    } as unknown as PdfStateMutation)

    const state = await store.get(root, identity)
    expect(state).not.toHaveProperty('injected')
    expect(state?.highlights[0]).not.toHaveProperty('injected')
    expect(state?.highlights[0]?.rects[0]).not.toHaveProperty('injected')
  })

  it('serializes concurrent mutations and keeps no-ops revision-free', async () => {
    let time = 0
    const store = new PdfStateStore(() => ++time)
    await Promise.all([
      store.apply(root, identity, {
        type: 'set-progress',
        progress: { pageNumber: 4, pageOffsetRatio: 0.5 },
      }),
      ...Array.from({ length: 20 }, (_, index) =>
        store.apply(root, identity, highlight(`h${index}`))),
    ])

    expect((await store.get(root, identity))?.revision).toBe(21)
    expect((await store.get(root, identity))?.highlights).toHaveLength(20)
    const same = await store.apply(root, identity, highlight('h0'))
    expect(same).toMatchObject({ revision: 21, applied: false })
    expect(await store.apply(root, identity, {
      type: 'delete-highlight',
      highlightId: 'missing',
    })).toEqual({ revision: 21, applied: false })
  })

  it('isolates state by source fingerprint', async () => {
    const store = new PdfStateStore()
    await store.apply(root, identity, highlight('old'))
    const replacement = {
      ...identity,
      sourceFingerprint: `sha256:${'b'.repeat(64)}` as SourceFingerprint,
    }
    expect(await store.get(root, replacement)).toBeNull()
    await store.apply(root, replacement, highlight('new'))
    expect((await store.get(root, identity))?.highlights[0]?.id).toBe('old')
    expect((await store.get(root, replacement))?.highlights[0]?.id).toBe('new')
  })

  it('rejects malformed progress, rectangles, and styles', async () => {
    const store = new PdfStateStore()
    await expect(store.apply(root, identity, {
      type: 'set-progress',
      progress: { pageNumber: 0, pageOffsetRatio: 0 },
    })).rejects.toThrow('INVALID_PDF_PAGE_NUMBER')
    await expect(store.apply(root, identity, {
      ...highlight('bad-rect'),
      highlight: {
        ...highlight('bad-rect').highlight,
        rects: [{
          ...highlight('bad-rect').highlight.rects[0],
          width: 1,
        }],
      },
    })).rejects.toThrow('INVALID_PDF_RECT')
    await expect(store.apply(root, identity, {
      ...highlight('bad-style'),
      highlight: {
        ...highlight('bad-style').highlight,
        style: { type: 'solid', color: 'red' },
      },
    } as unknown as PdfStateMutation)).rejects.toThrow(
      'INVALID_PDF_HIGHLIGHT_STYLE',
    )
  })

  it('keeps the old state when atomic rename fails', async () => {
    const initialStore = new PdfStateStore(() => 100)
    await initialStore.apply(root, identity, highlight('saved'))

    const failingStore = new PdfStateStore(
      () => 200,
      (directory, path, state) =>
        writePdfStateFile(directory, path, state, async () => {
          throw new Error('simulated rename failure')
        }),
    )
    await expect(failingStore.apply(root, identity, highlight('not-written')))
      .rejects.toThrow('simulated rename failure')
    expect((await initialStore.get(root, identity))?.highlights.map(mark => mark.id))
      .toEqual(['saved'])
  })

  it('rejects corrupt and oversized persisted state', async () => {
    const store = new PdfStateStore(() => 100)
    await store.apply(root, identity, highlight('h1'))
    const path = persistedStatePath()
    const valid = JSON.parse(readFileSync(path, 'utf8'))

    for (const corrupt of [
      { ...valid, progress: null },
      { ...valid, updatedAt: Number.NaN },
      { ...valid, highlights: [{ ...valid.highlights[0], rects: [] }] },
      { ...valid, highlights: [valid.highlights[0], valid.highlights[0]] },
    ]) {
      writeFileSync(path, `${JSON.stringify(corrupt)}\n`)
      await expect(store.get(root, identity)).rejects.toThrow('INVALID_PDF_STATE')
    }

    writeFileSync(path, 'x'.repeat(MAX_PDF_STATE_BYTES + 1))
    await expect(store.get(root, identity)).rejects.toThrow('INVALID_PDF_STATE')
  })
})
