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
  EpubHighlightV1,
  EpubStateMutation,
  SourceFingerprint,
} from '@craft-agent/shared/project-files'
import { createProject, getProjectPath } from '@craft-agent/shared/projects'

import {
  EpubStateStore,
  MAX_EPUB_CFI_LENGTH,
  MAX_EPUB_STATE_BYTES,
  type EpubStateIdentity,
  writeEpubStateFile,
} from './epub-state'

let root = ''
let identity: EpubStateIdentity
let projectSlug = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'epub-state-'))
  const project = createProject(root, { name: 'Reader' })
  projectSlug = project.slug
  identity = {
    projectId: project.id,
    relativePath: 'books/os.epub',
    sourceFingerprint: `sha256:${'a'.repeat(64)}` as SourceFingerprint,
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function highlight(
  id: string,
  style: EpubHighlightV1['style'] = { type: 'wavy', color: 'red' },
): Extract<EpubStateMutation, { type: 'upsert-highlight' }> {
  return {
    type: 'upsert-highlight',
    highlight: {
      id,
      cfiRange: `epubcfi(/6/4!/4/2[${id}])`,
      quote: `quote ${id}`,
      tocPath: [{ key: 'toc:0', title: 'Chapter', orderPath: [0] }],
      spineIndex: 0,
      style,
    },
  }
}

function persistedStatePath(): string {
  const directory = join(getProjectPath(root, projectSlug), 'reader-state', 'v1', 'epub')
  const filename = readdirSync(directory).find(entry => entry.endsWith('.json'))
  if (!filename) throw new Error('Expected persisted EPUB state')
  return join(directory, filename)
}

describe('EpubStateStore', () => {
  it('returns null before the first mutation and persists progress', async () => {
    const store = new EpubStateStore(() => 100)
    expect(await store.get(root, identity)).toBeNull()

    expect(await store.apply(root, identity, {
      type: 'set-progress',
      progress: { cfi: 'epubcfi(/6/2)', percentage: 0.25 },
    })).toEqual({ revision: 1, applied: true })

    expect(await store.get(root, identity)).toMatchObject({
      revision: 1,
      progress: { cfi: 'epubcfi(/6/2)', percentage: 0.25, updatedAt: 100 },
    })
  })

  it('persists only fields from the current mutation schema', async () => {
    const store = new EpubStateStore(() => 100)
    await store.apply(root, identity, {
      type: 'set-progress',
      progress: {
        cfi: 'epubcfi(/6/2)',
        injected: 'drop-me',
      },
      injected: 'drop-me',
    } as unknown as EpubStateMutation)
    await store.apply(root, identity, {
      ...highlight('h1'),
      highlight: {
        ...highlight('h1').highlight,
        injected: 'drop-me',
        tocPath: [{
          ...highlight('h1').highlight.tocPath[0],
          injected: 'drop-me',
        }],
      },
    } as unknown as EpubStateMutation)

    const state = await store.get(root, identity)
    expect(state).not.toHaveProperty('injected')
    expect(state?.progress).not.toHaveProperty('injected')
    expect(state?.highlights[0]).not.toHaveProperty('injected')
    expect(state?.highlights[0]?.tocPath[0]).not.toHaveProperty('injected')
  })

  it('persists solid reference underlines alongside wavy highlights', async () => {
    const store = new EpubStateStore(() => 100)
    await store.apply(root, identity, highlight('highlight'))
    await store.apply(
      root,
      identity,
      highlight('reference', { type: 'solid', color: 'blue' }),
    )

    expect((await store.get(root, identity))?.highlights.map(mark => mark.style))
      .toEqual([
        { type: 'wavy', color: 'red' },
        { type: 'solid', color: 'blue' },
      ])
  })

  it('does not increment revision for no-op mutations', async () => {
    const store = new EpubStateStore(() => 100)
    await store.apply(root, identity, highlight('h1'))
    expect(await store.apply(root, identity, highlight('h1'))).toMatchObject({
      revision: 1,
      applied: false,
    })
    expect(await store.apply(root, identity, {
      type: 'delete-highlight',
      highlightId: 'missing',
    })).toEqual({ revision: 1, applied: false })
  })

  it('serializes concurrent progress and highlight mutations without lost updates', async () => {
    let time = 0
    const store = new EpubStateStore(() => ++time)
    await Promise.all([
      store.apply(root, identity, {
        type: 'set-progress',
        progress: { cfi: 'epubcfi(/6/8)', percentage: 0.5 },
      }),
      ...Array.from({ length: 20 }, (_, index) =>
        store.apply(root, identity, highlight(`h${index}`))),
    ])

    const state = await store.get(root, identity)
    expect(state?.revision).toBe(21)
    expect(state?.progress?.cfi).toBe('epubcfi(/6/8)')
    expect(state?.highlights).toHaveLength(20)
  })

  it('serializes concurrent upsert and delete mutations in invocation order', async () => {
    let time = 0
    const store = new EpubStateStore(() => ++time)
    await store.apply(root, identity, highlight('h1'))

    await Promise.all([
      store.apply(root, identity, highlight('h2')),
      store.apply(root, identity, { type: 'delete-highlight', highlightId: 'h1' }),
      store.apply(root, identity, highlight('h3')),
      store.apply(root, identity, { type: 'delete-highlight', highlightId: 'h2' }),
    ])

    const state = await store.get(root, identity)
    expect(state?.revision).toBe(5)
    expect(state?.highlights.map(item => item.id)).toEqual(['h3'])
  })

  it('serializes reads behind an in-flight state write', async () => {
    let markWriteStarted!: () => void
    let releaseWrite!: () => void
    const writeStarted = new Promise<void>(resolve => {
      markWriteStarted = resolve
    })
    const writeReleased = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    const store = new EpubStateStore(
      () => 100,
      async (directory, path, state) => {
        markWriteStarted()
        await writeReleased
        await writeEpubStateFile(directory, path, state)
      },
    )

    const applyPromise = store.apply(root, identity, highlight('serialized'))
    await writeStarted
    let readSettled = false
    const readPromise = store.get(root, identity).then(state => {
      readSettled = true
      return state
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const settledBeforeRelease = readSettled
    releaseWrite()
    const [, state] = await Promise.all([applyPromise, readPromise])

    expect(settledBeforeRelease).toBe(false)
    expect(state?.revision).toBe(1)
    expect(state?.highlights[0]?.id).toBe('serialized')
  })

  it('keeps the old complete state when atomic rename fails', async () => {
    const initialStore = new EpubStateStore(() => 100)
    await initialStore.apply(root, identity, {
      type: 'set-progress',
      progress: { cfi: 'epubcfi(/6/2)', percentage: 0.25 },
    })

    const failingStore = new EpubStateStore(
      () => 200,
      (directory, path, state) =>
        writeEpubStateFile(directory, path, state, async () => {
          throw new Error('simulated rename failure')
        }),
    )
    await expect(failingStore.apply(root, identity, highlight('not-written')))
      .rejects.toThrow('simulated rename failure')

    expect(await initialStore.get(root, identity)).toMatchObject({
      revision: 1,
      progress: { cfi: 'epubcfi(/6/2)' },
      highlights: [],
    })
    expect(readdirSync(join(getProjectPath(root, projectSlug), 'reader-state', 'v1', 'epub')))
      .toHaveLength(1)
  })

  it('rejects a mutation before it exceeds the state byte budget', async () => {
    const store = new EpubStateStore(() => 100)
    await store.apply(root, identity, highlight('seed'))
    const state = {
      version: 1 as const,
      ...identity,
      revision: 1,
      highlights: [] as EpubHighlightV1[],
      updatedAt: 100,
    }
    while (true) {
      const mutation = highlight(`large-${state.highlights.length}`)
      const next = {
        ...mutation.highlight,
        cfiRange: 'c'.repeat(MAX_EPUB_CFI_LENGTH),
        quote: 'q'.repeat(4_000),
        contextBefore: 'b'.repeat(1_000),
        contextAfter: 'a'.repeat(1_000),
        createdAt: 100,
        updatedAt: 100,
      }
      if (
        Buffer.byteLength(`${JSON.stringify({
          ...state,
          highlights: [...state.highlights, next],
        }, null, 2)}\n`, 'utf8') > MAX_EPUB_STATE_BYTES
      ) break
      state.highlights.push(next)
    }
    writeFileSync(persistedStatePath(), `${JSON.stringify(state, null, 2)}\n`)
    await expect(store.apply(root, identity, {
      ...highlight('overflow'),
      highlight: {
        ...highlight('overflow').highlight,
        cfiRange: 'c'.repeat(MAX_EPUB_CFI_LENGTH),
        quote: 'q'.repeat(4_000),
        contextBefore: 'b'.repeat(1_000),
        contextAfter: 'a'.repeat(1_000),
      },
    })).rejects.toThrow('EPUB_STATE_TOO_LARGE')
  })

  it('isolates state by source fingerprint', async () => {
    const store = new EpubStateStore()
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

  it('rejects malformed identity and bounded fields', async () => {
    const store = new EpubStateStore()
    await expect(store.apply(root, {
      ...identity,
      relativePath: '../escape.epub',
    }, highlight('bad'))).rejects.toThrow('INVALID_PROJECT_FILE_PATH')
    await expect(store.apply(root, identity, {
      type: 'set-progress',
      progress: { cfi: 'x'.repeat(MAX_EPUB_CFI_LENGTH + 1) },
    })).rejects.toThrow('INVALID_EPUB_CFI')
    await expect(store.apply(root, identity, {
      type: 'set-progress',
      progress: null,
    } as unknown as EpubStateMutation)).rejects.toThrow('INVALID_EPUB_PROGRESS')
    await expect(store.apply(root, identity, {
      type: 'upsert-highlight',
      highlight: {
        ...highlight('bad-shape').highlight,
        tocPath: null,
      },
    } as unknown as EpubStateMutation)).rejects.toThrow('INVALID_EPUB_TOC_PATH')
    await expect(store.apply(root, identity, {
      type: 'upsert-highlight',
      highlight: {
        ...highlight('bad-style').highlight,
        style: null,
      },
    } as unknown as EpubStateMutation)).rejects.toThrow('INVALID_EPUB_HIGHLIGHT_STYLE')
    await expect(store.apply(root, identity, {
      type: 'upsert-highlight',
      highlight: {
        ...highlight('bad-style-pair').highlight,
        style: { type: 'solid', color: 'red' },
      },
    } as unknown as EpubStateMutation)).rejects.toThrow('INVALID_EPUB_HIGHLIGHT_STYLE')

    await expect(store.apply(root, identity, {
      ...highlight('oversized-title'),
      highlight: {
        ...highlight('oversized-title').highlight,
        chapterTitle: 'x'.repeat(1_025),
      },
    })).rejects.toThrow('INVALID_EPUB_CHAPTER_TITLE')
    await expect(store.apply(root, identity, {
      ...highlight('oversized-toc'),
      highlight: {
        ...highlight('oversized-toc').highlight,
        tocPath: [{ key: 'x'.repeat(1_025), title: 'Chapter', orderPath: [0] }],
      },
    })).rejects.toThrow('INVALID_EPUB_TOC_PATH')
  })

  it('quarantines corrupt persisted progress, highlights, timestamps, and oversized state', async () => {
    const store = new EpubStateStore(() => 100)
    await store.apply(root, identity, highlight('h1'))
    const path = persistedStatePath()
    const valid = JSON.parse(readFileSync(path, 'utf8'))

    for (const corrupt of [
      { ...valid, progress: null },
      { ...valid, updatedAt: Number.NaN },
      { ...valid, highlights: [{ ...valid.highlights[0], createdAt: 'yesterday' }] },
      { ...valid, highlights: [{ ...valid.highlights[0], tocPath: null }] },
      { ...valid, highlights: [valid.highlights[0], valid.highlights[0]] },
    ]) {
      writeFileSync(path, `${JSON.stringify(corrupt)}\n`)
      expect(await store.get(root, identity)).toBeNull()
      expect(readdirSync(join(path, '..')).some(entry => entry.includes('.corrupt-'))).toBe(true)
      writeFileSync(path, `${JSON.stringify(valid)}\n`)
    }

    writeFileSync(path, 'x'.repeat(MAX_EPUB_STATE_BYTES + 1))
    expect(await store.get(root, identity)).toBeNull()
    await store.apply(root, identity, highlight('recovered'))
    expect((await store.get(root, identity))?.highlights[0]?.id).toBe('recovered')
  })
})
