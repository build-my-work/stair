import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  EpubDocumentStateV1,
  EpubHighlightV1,
  EpubStateMutation,
  ProjectFileIdentity,
  SourceFingerprint,
} from '@craft-agent/core/types'
import {
  isCanonicalProjectRelativePath,
  isSourceFingerprint,
  MAX_PROJECT_FILE_REFERENCE_CFI_CHARS,
  MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
  MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS,
  MAX_PROJECT_FILE_REFERENCE_TOC_DEPTH,
} from '@craft-agent/core/types'
import { getProjectPath, loadProjectById } from '@craft-agent/shared/projects'

export const MAX_EPUB_CFI_LENGTH = MAX_PROJECT_FILE_REFERENCE_CFI_CHARS
export const MAX_EPUB_QUOTE_CHARS = MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS
export const MAX_EPUB_CONTEXT_CHARS = MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS
export const MAX_EPUB_TOC_PATH_DEPTH = MAX_PROJECT_FILE_REFERENCE_TOC_DEPTH
export const MAX_EPUB_HIGHLIGHTS_PER_DOCUMENT = 1_000
export const MAX_EPUB_STATE_BYTES = 4 * 1024 * 1024

export interface EpubStateIdentity extends ProjectFileIdentity {
  sourceFingerprint: SourceFingerprint
}

interface EpubStateMutationResult {
  revision: number
  applied: boolean
  canonicalHighlight?: EpubHighlightV1
}

type Clock = () => number
type StateWriter = (
  directory: string,
  path: string,
  state: EpubDocumentStateV1,
) => Promise<void>
type RenameFile = typeof rename

function assertBoundedText(value: unknown, max: number, field: string): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== 'string' || value.length > max)) {
    throw new Error(`INVALID_EPUB_${field.toUpperCase()}`)
  }
}

function assertTimestamp(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('INVALID_EPUB_TIMESTAMP')
  }
}

function assertProgress(
  progress: unknown,
  stored: boolean,
): asserts progress is NonNullable<EpubDocumentStateV1['progress']> {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    throw new Error('INVALID_EPUB_PROGRESS')
  }
  const candidate = progress as Record<string, unknown>
  assertBoundedText(candidate.cfi, MAX_EPUB_CFI_LENGTH, 'cfi')
  if (!candidate.cfi) throw new Error('INVALID_EPUB_CFI')
  if (candidate.chapterKey !== undefined && typeof candidate.chapterKey !== 'string') {
    throw new Error('INVALID_EPUB_PROGRESS')
  }
  if (
    candidate.percentage !== undefined
    && (typeof candidate.percentage !== 'number'
      || !Number.isFinite(candidate.percentage)
      || candidate.percentage < 0
      || candidate.percentage > 1)
  ) {
    throw new Error('INVALID_EPUB_PROGRESS')
  }
  if (stored) assertTimestamp(candidate.updatedAt)
}

function assertHighlight(
  highlight: unknown,
  stored: boolean,
): asserts highlight is EpubHighlightV1 {
  if (!highlight || typeof highlight !== 'object' || Array.isArray(highlight)) {
    throw new Error('INVALID_EPUB_HIGHLIGHT')
  }
  const candidate = highlight as Record<string, unknown>
  if (!candidate.id || typeof candidate.id !== 'string') {
    throw new Error('INVALID_EPUB_HIGHLIGHT_ID')
  }
  assertBoundedText(candidate.cfiRange, MAX_EPUB_CFI_LENGTH, 'cfi')
  if (!candidate.cfiRange) throw new Error('INVALID_EPUB_CFI')
  assertBoundedText(candidate.quote, MAX_EPUB_QUOTE_CHARS, 'quote')
  if (candidate.quote === undefined) throw new Error('INVALID_EPUB_QUOTE')
  assertBoundedText(candidate.contextBefore, MAX_EPUB_CONTEXT_CHARS, 'context')
  assertBoundedText(candidate.contextAfter, MAX_EPUB_CONTEXT_CHARS, 'context')
  if (candidate.chapterKey !== undefined && typeof candidate.chapterKey !== 'string') {
    throw new Error('INVALID_EPUB_HIGHLIGHT')
  }
  if (candidate.chapterTitle !== undefined && typeof candidate.chapterTitle !== 'string') {
    throw new Error('INVALID_EPUB_HIGHLIGHT')
  }
  if (
    candidate.spineIndex !== undefined
    && (!Number.isSafeInteger(candidate.spineIndex) || (candidate.spineIndex as number) < 0)
  ) {
    throw new Error('INVALID_EPUB_HIGHLIGHT')
  }
  if (!Array.isArray(candidate.tocPath) || candidate.tocPath.length > MAX_EPUB_TOC_PATH_DEPTH) {
    throw new Error('INVALID_EPUB_TOC_PATH')
  }
  if (
    !candidate.style
    || typeof candidate.style !== 'object'
    || Array.isArray(candidate.style)
    || (candidate.style as Record<string, unknown>).type !== 'wavy'
    || (candidate.style as Record<string, unknown>).color !== 'red'
  ) {
    throw new Error('INVALID_EPUB_HIGHLIGHT_STYLE')
  }
  for (const entry of candidate.tocPath) {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || typeof entry.key !== 'string'
      || !entry.key
      || typeof entry.title !== 'string'
      || !entry.title
      || (entry.href !== undefined && typeof entry.href !== 'string')
      || !Array.isArray(entry.orderPath)
      || !entry.orderPath.every(
        (index: unknown) => Number.isSafeInteger(index) && (index as number) >= 0,
      )
    ) {
      throw new Error('INVALID_EPUB_TOC_PATH')
    }
  }
  if (stored) {
    assertTimestamp(candidate.createdAt)
    assertTimestamp(candidate.updatedAt)
  }
}

export function normalizeEpubStateMutation(
  mutation: unknown,
): EpubStateMutation {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
    throw new Error('INVALID_EPUB_MUTATION')
  }
  const candidate = mutation as Record<string, unknown>
  switch (candidate.type) {
    case 'set-progress': {
      const progress = candidate.progress
      assertProgress(progress, false)
      return {
        type: 'set-progress',
        progress: {
          cfi: progress.cfi,
          ...(progress.chapterKey !== undefined ? { chapterKey: progress.chapterKey } : {}),
          ...(progress.percentage !== undefined ? { percentage: progress.percentage } : {}),
        },
      }
    }
    case 'upsert-highlight': {
      const highlight = candidate.highlight
      assertHighlight(highlight, false)
      return {
        type: 'upsert-highlight',
        highlight: {
          id: highlight.id,
          cfiRange: highlight.cfiRange,
          quote: highlight.quote,
          ...(highlight.contextBefore !== undefined
            ? { contextBefore: highlight.contextBefore }
            : {}),
          ...(highlight.contextAfter !== undefined
            ? { contextAfter: highlight.contextAfter }
            : {}),
          ...(highlight.chapterKey !== undefined
            ? { chapterKey: highlight.chapterKey }
            : {}),
          ...(highlight.chapterTitle !== undefined
            ? { chapterTitle: highlight.chapterTitle }
            : {}),
          tocPath: highlight.tocPath.map(entry => ({
            key: entry.key,
            title: entry.title,
            orderPath: [...entry.orderPath],
            ...(entry.href !== undefined ? { href: entry.href } : {}),
          })),
          ...(highlight.spineIndex !== undefined
            ? { spineIndex: highlight.spineIndex }
            : {}),
          style: { type: 'wavy', color: 'red' },
        },
      }
    }
    case 'delete-highlight':
      if (typeof candidate.highlightId !== 'string' || !candidate.highlightId) {
        throw new Error('INVALID_EPUB_HIGHLIGHT_ID')
      }
      return {
        type: 'delete-highlight',
        highlightId: candidate.highlightId,
      }
    default:
      throw new Error('INVALID_EPUB_MUTATION')
  }
}

function stateKey(relativePath: string, sourceFingerprint: SourceFingerprint): string {
  return createHash('sha256')
    .update(relativePath)
    .update('\0')
    .update(sourceFingerprint)
    .digest('hex')
}

function statePath(
  workspaceRootPath: string,
  identity: EpubStateIdentity,
): { directory: string; path: string } {
  if (!isCanonicalProjectRelativePath(identity.relativePath)) {
    throw new Error('INVALID_PROJECT_FILE_PATH')
  }
  if (!isSourceFingerprint(identity.sourceFingerprint)) {
    throw new Error('INVALID_SOURCE_FINGERPRINT')
  }
  const project = loadProjectById(workspaceRootPath, identity.projectId)
  if (!project) throw new Error('PROJECT_NOT_FOUND')
  const directory = join(getProjectPath(workspaceRootPath, project.config.slug), 'epub-state', 'v1')
  return {
    directory,
    path: join(directory, `${stateKey(identity.relativePath, identity.sourceFingerprint)}.json`),
  }
}

function isStoredState(value: unknown, identity: EpubStateIdentity): value is EpubDocumentStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  if (
    state.version !== 1
    || state.projectId !== identity.projectId
    || state.relativePath !== identity.relativePath
    || state.sourceFingerprint !== identity.sourceFingerprint
    || !Number.isSafeInteger(state.revision)
    || (state.revision as number) < 0
    || !Array.isArray(state.highlights)
    || state.highlights.length > MAX_EPUB_HIGHLIGHTS_PER_DOCUMENT
  ) {
    return false
  }
  try {
    assertTimestamp(state.updatedAt)
    if (state.progress !== undefined) assertProgress(state.progress, true)
    const ids = new Set<string>()
    for (const highlight of state.highlights) {
      assertHighlight(highlight, true)
      if (ids.has(highlight.id)) return false
      ids.add(highlight.id)
    }
    return true
  } catch {
    return false
  }
}

function sameProgress(
  current: EpubDocumentStateV1['progress'],
  next: Extract<EpubStateMutation, { type: 'set-progress' }>['progress'],
): boolean {
  return current?.cfi === next.cfi
    && current.chapterKey === next.chapterKey
    && current.percentage === next.percentage
}

function sameHighlight(
  current: EpubHighlightV1,
  next: Omit<EpubHighlightV1, 'createdAt' | 'updatedAt'>,
): boolean {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...stored } = current
  return JSON.stringify(stored) === JSON.stringify(next)
}

async function readStateFile(
  path: string,
  identity: EpubStateIdentity,
): Promise<EpubDocumentStateV1 | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_EPUB_STATE_BYTES) {
    throw new Error('INVALID_EPUB_STATE')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('INVALID_EPUB_STATE')
  }
  if (!isStoredState(parsed, identity)) throw new Error('INVALID_EPUB_STATE')
  return parsed
}

export async function writeEpubStateFile(
  directory: string,
  path: string,
  state: EpubDocumentStateV1,
  renameFile: RenameFile = rename,
): Promise<void> {
  const serialized = `${JSON.stringify(state, null, 2)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EPUB_STATE_BYTES) {
    throw new Error('EPUB_STATE_TOO_LARGE')
  }

  await mkdir(directory, { recursive: true })
  const temporaryPath = join(directory, `.${state.revision}-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameFile(temporaryPath, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

export class EpubStateStore {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(
    private readonly now: Clock = Date.now,
    private readonly writeState: StateWriter = writeEpubStateFile,
  ) {}

  async get(
    workspaceRootPath: string,
    identity: EpubStateIdentity,
  ): Promise<EpubDocumentStateV1 | null> {
    const resolved = statePath(workspaceRootPath, identity)
    return readStateFile(resolved.path, identity)
  }

  async apply(
    workspaceRootPath: string,
    identity: EpubStateIdentity,
    mutation: EpubStateMutation,
  ): Promise<EpubStateMutationResult> {
    mutation = normalizeEpubStateMutation(mutation)
    const resolved = statePath(workspaceRootPath, identity)
    return this.withLock(resolved.path, async () => {
      const stored = await readStateFile(resolved.path, identity)
      const now = this.now()
      const state: EpubDocumentStateV1 = stored ?? {
        version: 1,
        ...identity,
        revision: 0,
        highlights: [],
        updatedAt: now,
      }

      if (mutation.type === 'set-progress') {
        if (sameProgress(state.progress, mutation.progress)) {
          return { revision: state.revision, applied: false }
        }
        state.progress = { ...mutation.progress, updatedAt: now }
      } else if (mutation.type === 'upsert-highlight') {
        const index = state.highlights.findIndex(item => item.id === mutation.highlight.id)
        const current = index >= 0 ? state.highlights[index] : undefined
        if (current && sameHighlight(current, mutation.highlight)) {
          return { revision: state.revision, applied: false, canonicalHighlight: current }
        }
        const canonicalHighlight: EpubHighlightV1 = {
          ...mutation.highlight,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        }
        if (index >= 0) state.highlights[index] = canonicalHighlight
        else state.highlights.push(canonicalHighlight)
        if (state.highlights.length > MAX_EPUB_HIGHLIGHTS_PER_DOCUMENT) {
          throw new Error('EPUB_HIGHLIGHT_LIMIT_EXCEEDED')
        }
      } else {
        const index = state.highlights.findIndex(item => item.id === mutation.highlightId)
        if (index < 0) return { revision: state.revision, applied: false }
        state.highlights.splice(index, 1)
      }

      state.revision += 1
      state.updatedAt = now
      await this.writeState(resolved.directory, resolved.path, state)
      return {
        revision: state.revision,
        applied: true,
        ...(mutation.type === 'upsert-highlight'
          ? { canonicalHighlight: state.highlights.find(item => item.id === mutation.highlight.id) }
          : {}),
      }
    })
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = (this.tails.get(key) ?? Promise.resolve()).catch(() => {})
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

export const epubStateStore = new EpubStateStore()
