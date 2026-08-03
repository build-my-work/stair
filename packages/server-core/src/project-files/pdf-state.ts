import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  PdfDocumentStateV1,
  PdfHighlightV1,
  PdfPageRectV1,
  PdfStateMutation,
  ProjectFileIdentity,
  SourceFingerprint,
} from '@craft-agent/core/types'
import {
  isCanonicalProjectRelativePath,
  isSourceFingerprint,
  MAX_PDF_RECTS_PER_HIGHLIGHT,
  MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
  MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS,
} from '@craft-agent/core/types'
import { getProjectPath, loadProjectById } from '@craft-agent/shared/projects'

export const MAX_PDF_HIGHLIGHTS_PER_DOCUMENT = 1_000
export const MAX_PDF_STATE_BYTES = 4 * 1024 * 1024

export interface PdfStateIdentity extends ProjectFileIdentity {
  sourceFingerprint: SourceFingerprint
}

interface PdfStateMutationResult {
  revision: number
  applied: boolean
  canonicalHighlight?: PdfHighlightV1
}

type Clock = () => number
type StateWriter = (
  directory: string,
  path: string,
  state: PdfDocumentStateV1,
) => Promise<void>
type RenameFile = typeof rename

function assertBoundedText(
  value: unknown,
  max: number,
  field: string,
  required = false,
): asserts value is string | undefined {
  if (value === undefined) {
    if (required) throw new Error(`INVALID_PDF_${field.toUpperCase()}`)
    return
  }
  if (
    typeof value !== 'string'
    || (required && value.length === 0)
    || value.length > max
    || value.includes('\0')
  ) {
    throw new Error(`INVALID_PDF_${field.toUpperCase()}`)
  }
}

function assertTimestamp(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('INVALID_PDF_TIMESTAMP')
  }
}

function assertUnitRatio(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new Error(`INVALID_PDF_${field.toUpperCase()}`)
  }
}

function assertPageNumber(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('INVALID_PDF_PAGE_NUMBER')
  }
}

function assertProgress(
  progress: unknown,
  stored: boolean,
): asserts progress is NonNullable<PdfDocumentStateV1['progress']> {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    throw new Error('INVALID_PDF_PROGRESS')
  }
  const candidate = progress as Record<string, unknown>
  assertPageNumber(candidate.pageNumber)
  assertUnitRatio(candidate.pageOffsetRatio, 'page_offset_ratio')
  if (candidate.percentage !== undefined) {
    assertUnitRatio(candidate.percentage, 'percentage')
  }
  if (stored) assertTimestamp(candidate.updatedAt)
}

function assertRect(value: unknown): asserts value is PdfPageRectV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_PDF_RECT')
  }
  const candidate = value as Record<string, unknown>
  assertPageNumber(candidate.pageNumber)
  assertUnitRatio(candidate.x, 'rect')
  assertUnitRatio(candidate.y, 'rect')
  assertUnitRatio(candidate.width, 'rect')
  assertUnitRatio(candidate.height, 'rect')
  if (
    candidate.width === 0
    || candidate.height === 0
    || (candidate.x as number) + (candidate.width as number) > 1.000001
    || (candidate.y as number) + (candidate.height as number) > 1.000001
  ) {
    throw new Error('INVALID_PDF_RECT')
  }
}

function assertHighlight(
  highlight: unknown,
  stored: boolean,
): asserts highlight is PdfHighlightV1 {
  if (!highlight || typeof highlight !== 'object' || Array.isArray(highlight)) {
    throw new Error('INVALID_PDF_HIGHLIGHT')
  }
  const candidate = highlight as Record<string, unknown>
  assertBoundedText(candidate.id, 256, 'highlight_id', true)
  assertBoundedText(
    candidate.quote,
    MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS,
    'quote',
    true,
  )
  assertBoundedText(
    candidate.contextBefore,
    MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
    'context',
  )
  assertBoundedText(
    candidate.contextAfter,
    MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
    'context',
  )
  assertPageNumber(candidate.startPage)
  assertPageNumber(candidate.endPage)
  if ((candidate.endPage as number) < (candidate.startPage as number)) {
    throw new Error('INVALID_PDF_PAGE_RANGE')
  }
  if (
    !Array.isArray(candidate.rects)
    || candidate.rects.length === 0
    || candidate.rects.length > MAX_PDF_RECTS_PER_HIGHLIGHT
  ) {
    throw new Error('INVALID_PDF_RECTS')
  }
  for (const rect of candidate.rects) {
    assertRect(rect)
    if (
      rect.pageNumber < (candidate.startPage as number)
      || rect.pageNumber > (candidate.endPage as number)
    ) {
      throw new Error('INVALID_PDF_RECT_PAGE')
    }
  }
  const style = candidate.style
  if (!style || typeof style !== 'object' || Array.isArray(style)) {
    throw new Error('INVALID_PDF_HIGHLIGHT_STYLE')
  }
  const styleRecord = style as Record<string, unknown>
  const validStyle =
    (styleRecord.type === 'wavy' && styleRecord.color === 'red')
    || (styleRecord.type === 'solid' && styleRecord.color === 'blue')
  if (!validStyle) {
    throw new Error('INVALID_PDF_HIGHLIGHT_STYLE')
  }
  if (stored) {
    assertTimestamp(candidate.createdAt)
    assertTimestamp(candidate.updatedAt)
  }
}

export function normalizePdfStateMutation(mutation: unknown): PdfStateMutation {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
    throw new Error('INVALID_PDF_MUTATION')
  }
  const candidate = mutation as Record<string, unknown>
  switch (candidate.type) {
    case 'set-progress': {
      const progress = candidate.progress
      assertProgress(progress, false)
      return {
        type: 'set-progress',
        progress: {
          pageNumber: progress.pageNumber,
          pageOffsetRatio: progress.pageOffsetRatio,
          ...(progress.percentage === undefined
            ? {}
            : { percentage: progress.percentage }),
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
          quote: highlight.quote,
          ...(highlight.contextBefore === undefined
            ? {}
            : { contextBefore: highlight.contextBefore }),
          ...(highlight.contextAfter === undefined
            ? {}
            : { contextAfter: highlight.contextAfter }),
          startPage: highlight.startPage,
          endPage: highlight.endPage,
          rects: highlight.rects.map(rect => ({
            pageNumber: rect.pageNumber,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          })),
          style: highlight.style.type === 'wavy'
            ? { type: 'wavy', color: 'red' }
            : { type: 'solid', color: 'blue' },
        },
      }
    }
    case 'delete-highlight':
      if (typeof candidate.highlightId !== 'string' || !candidate.highlightId) {
        throw new Error('INVALID_PDF_HIGHLIGHT_ID')
      }
      return {
        type: 'delete-highlight',
        highlightId: candidate.highlightId,
      }
    default:
      throw new Error('INVALID_PDF_MUTATION')
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
  identity: PdfStateIdentity,
): { directory: string; path: string } {
  if (!isCanonicalProjectRelativePath(identity.relativePath)) {
    throw new Error('INVALID_PROJECT_FILE_PATH')
  }
  if (!isSourceFingerprint(identity.sourceFingerprint)) {
    throw new Error('INVALID_SOURCE_FINGERPRINT')
  }
  const project = loadProjectById(workspaceRootPath, identity.projectId)
  if (!project) throw new Error('PROJECT_NOT_FOUND')
  const directory = join(
    getProjectPath(workspaceRootPath, project.config.slug),
    'pdf-state',
    'v1',
  )
  return {
    directory,
    path: join(
      directory,
      `${stateKey(identity.relativePath, identity.sourceFingerprint)}.json`,
    ),
  }
}

function isStoredState(
  value: unknown,
  identity: PdfStateIdentity,
): value is PdfDocumentStateV1 {
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
    || state.highlights.length > MAX_PDF_HIGHLIGHTS_PER_DOCUMENT
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
  current: PdfDocumentStateV1['progress'],
  next: Extract<PdfStateMutation, { type: 'set-progress' }>['progress'],
): boolean {
  return current?.pageNumber === next.pageNumber
    && current.pageOffsetRatio === next.pageOffsetRatio
    && current.percentage === next.percentage
}

function sameHighlight(
  current: PdfHighlightV1,
  next: Omit<PdfHighlightV1, 'createdAt' | 'updatedAt'>,
): boolean {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...stored } = current
  return JSON.stringify(stored) === JSON.stringify(next)
}

async function readStateFile(
  path: string,
  identity: PdfStateIdentity,
): Promise<PdfDocumentStateV1 | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_PDF_STATE_BYTES) {
    throw new Error('INVALID_PDF_STATE')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('INVALID_PDF_STATE')
  }
  if (!isStoredState(parsed, identity)) throw new Error('INVALID_PDF_STATE')
  return parsed
}

export async function writePdfStateFile(
  directory: string,
  path: string,
  state: PdfDocumentStateV1,
  renameFile: RenameFile = rename,
): Promise<void> {
  const serialized = `${JSON.stringify(state, null, 2)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PDF_STATE_BYTES) {
    throw new Error('PDF_STATE_TOO_LARGE')
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

export class PdfStateStore {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(
    private readonly now: Clock = Date.now,
    private readonly writeState: StateWriter = writePdfStateFile,
  ) {}

  async get(
    workspaceRootPath: string,
    identity: PdfStateIdentity,
  ): Promise<PdfDocumentStateV1 | null> {
    const resolved = statePath(workspaceRootPath, identity)
    return readStateFile(resolved.path, identity)
  }

  async apply(
    workspaceRootPath: string,
    identity: PdfStateIdentity,
    mutation: PdfStateMutation,
  ): Promise<PdfStateMutationResult> {
    mutation = normalizePdfStateMutation(mutation)
    const resolved = statePath(workspaceRootPath, identity)
    return this.withLock(resolved.path, async () => {
      const stored = await readStateFile(resolved.path, identity)
      const now = this.now()
      const state: PdfDocumentStateV1 = stored ?? {
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
          return {
            revision: state.revision,
            applied: false,
            canonicalHighlight: current,
          }
        }
        const canonicalHighlight: PdfHighlightV1 = {
          ...mutation.highlight,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        }
        if (index >= 0) state.highlights[index] = canonicalHighlight
        else state.highlights.push(canonicalHighlight)
        if (state.highlights.length > MAX_PDF_HIGHLIGHTS_PER_DOCUMENT) {
          throw new Error('PDF_HIGHLIGHT_LIMIT_EXCEEDED')
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
          ? {
              canonicalHighlight: state.highlights.find(
                item => item.id === mutation.highlight.id,
              ),
            }
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

export const pdfStateStore = new PdfStateStore()
