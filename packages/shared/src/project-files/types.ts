import {
  MAX_REFERENCE_CFI_CHARS,
  MAX_REFERENCE_CONTEXT_CHARS,
  MAX_REFERENCE_QUOTE_CHARS,
  MAX_REFERENCE_TOC_DEPTH,
  MAX_REFERENCE_PATH_BYTES,
  type EpubCfiLocatorV1,
  type EpubTocPathEntryV1,
  type PdfPageRectV1,
  type PdfTextQuoteLocatorV1,
  type ProjectFileIdentity,
  type ProjectFileReferenceV1,
  type ProjectFileSelectionLocatorV1,
  type SourceFingerprint,
  type TextQuoteLocatorV1,
} from '@craft-agent/core'

export type {
  EpubCfiLocatorV1,
  EpubTocPathEntryV1,
  PdfPageRectV1,
  PdfTextQuoteLocatorV1,
  ProjectFileIdentity,
  ProjectFileReferenceV1,
  ProjectFileSelectionLocatorV1,
  SourceFingerprint,
  TextQuoteLocatorV1,
} from '@craft-agent/core'

export const MAX_PROJECT_FILE_PATH_BYTES = MAX_REFERENCE_PATH_BYTES
export const MAX_PROJECT_FILE_TEXT_BYTES = 8 * 1024 * 1024
export const MAX_EDITABLE_PROJECT_FILE_BYTES = 1024 * 1024
export const MAX_PROJECT_FILE_BINARY_BYTES = 32 * 1024 * 1024
export const MAX_PROJECT_FILE_REFERENCE_CFI_CHARS = MAX_REFERENCE_CFI_CHARS
export const MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS = MAX_REFERENCE_QUOTE_CHARS
export const MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS = MAX_REFERENCE_CONTEXT_CHARS
export const MAX_PROJECT_FILE_REFERENCE_TOC_DEPTH = MAX_REFERENCE_TOC_DEPTH
export const MAX_PROJECT_FILE_REFERENCE_LABEL_CHARS = 1_024
export const MAX_PDF_RECTS_PER_HIGHLIGHT = 512

export type ProjectFileFingerprint = `sha256:${string}`

export interface ProjectFileRequest {
  projectId: string
  relativePath: string
}

export interface ProjectDirectoryEntriesRequest {
  projectId: string
  relativePath?: string
}

export interface ProjectDirectoryEntry {
  name: string
  relativePath: string
  type: 'directory' | 'file'
  byteLength?: number
  lastModifiedMs?: number
}

export interface ProjectDirectoryEntriesResult {
  entries: ProjectDirectoryEntry[]
  truncated: boolean
}

export interface ProjectFileSearchRequest {
  projectId: string
  query: string
  extensions?: string[]
}

export interface ProjectFileSearchResult {
  name: string
  relativePath: string
}

export interface CreateProjectEntryRequest {
  projectId: string
  parentRelativePath?: string
  name: string
}

export interface ProjectFileMetadata {
  projectId: string
  relativePath: string
  name: string
  mimeType: string
  byteLength: number
  lastModifiedMs: number
}

export interface ProjectFileTextResponse {
  metadata: ProjectFileMetadata
  text: string
  sourceFingerprint: ProjectFileFingerprint
}

export interface ProjectFileBinaryResponse {
  metadata: ProjectFileMetadata
  bytes: Uint8Array
  sourceFingerprint: SourceFingerprint
}

export interface ProjectFileOpenIntent {
  expectedFingerprint: SourceFingerprint
  locator: ProjectFileSelectionLocatorV1
}

/**
 * Project File 选区直接复用 Core 的统一 Reference 协议，Reader、草稿、
 * 消息、Add Note 与 reveal 不再各自维护一套结构。
 */
export type ProjectFileSelectionReferenceV1 = ProjectFileReferenceV1

export interface EpubProjectFileReferenceV1 extends ProjectFileSelectionReferenceV1 {
  tocPath: EpubTocPathEntryV1[]
  locator: EpubCfiLocatorV1
}

export type PdfProjectFileReferenceV1 = Omit<
  ProjectFileSelectionReferenceV1,
  'chapterKey' | 'chapterTitle' | 'tocPath' | 'locator'
> & {
  locator: PdfTextQuoteLocatorV1 & { anchor: PdfPageRectV1 }
}

export interface EpubTocNode extends EpubTocPathEntryV1 {
  children: EpubTocNode[]
}

export interface EpubHighlightV1 {
  id: string
  cfiRange: string
  quote: string
  contextBefore?: string
  contextAfter?: string
  chapterKey?: string
  chapterTitle?: string
  tocPath: EpubTocPathEntryV1[]
  spineIndex?: number
  style: { type: 'wavy'; color: 'red' } | { type: 'solid'; color: 'blue' }
  createdAt: number
  updatedAt: number
}

export interface EpubProgressV1 {
  cfi: string
  chapterKey?: string
  percentage?: number
  updatedAt: number
}

export interface EpubDocumentStateV1 extends ProjectFileIdentity {
  version: 1
  sourceFingerprint: SourceFingerprint
  revision: number
  progress?: EpubProgressV1
  highlights: EpubHighlightV1[]
  updatedAt: number
}

export type EpubStateMutation =
  | { type: 'set-progress'; progress: Omit<EpubProgressV1, 'updatedAt'> }
  | { type: 'upsert-highlight'; highlight: Omit<EpubHighlightV1, 'createdAt' | 'updatedAt'> }
  | { type: 'delete-highlight'; highlightId: string }

export interface PdfHighlightV1 {
  id: string
  quote: string
  contextBefore?: string
  contextAfter?: string
  startPage: number
  endPage: number
  rects: PdfPageRectV1[]
  style: { type: 'wavy'; color: 'red' } | { type: 'solid'; color: 'blue' }
  createdAt: number
  updatedAt: number
}

export interface PdfProgressV1 {
  pageNumber: number
  pageOffsetRatio: number
  percentage?: number
  updatedAt: number
}

export interface PdfDocumentStateV1 extends ProjectFileIdentity {
  version: 1
  sourceFingerprint: SourceFingerprint
  revision: number
  progress?: PdfProgressV1
  highlights: PdfHighlightV1[]
  updatedAt: number
}

export type PdfStateMutation =
  | { type: 'set-progress'; progress: Omit<PdfProgressV1, 'updatedAt'> }
  | { type: 'upsert-highlight'; highlight: Omit<PdfHighlightV1, 'createdAt' | 'updatedAt'> }
  | { type: 'delete-highlight'; highlightId: string }

export interface SaveProjectTextFileRequest extends ProjectFileRequest {
  expectedFingerprint: ProjectFileFingerprint
  content: string
}

export interface SaveProjectTextFileResponse {
  metadata: ProjectFileMetadata
  sourceFingerprint: ProjectFileFingerprint
}

export interface SaveDrawnixProjectFileRequest extends ProjectFileRequest {
  expectedFingerprint: ProjectFileFingerprint
  content: string
}

export interface SaveDrawnixProjectFileResponse {
  metadata: ProjectFileMetadata
  sourceFingerprint: ProjectFileFingerprint
}

/**
 * Project File 在状态、路由和 RPC 中只允许一种身份表示。
 * 路径必须非空、相对 Project 根、使用 POSIX 分隔符，且不包含 `.`/`..` 段。
 */
export function isCanonicalProjectRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || new TextEncoder().encode(value).byteLength > MAX_PROJECT_FILE_PATH_BYTES
  ) {
    return false
  }

  const segments = value.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

export function isProjectFileFingerprint(value: unknown): value is ProjectFileFingerprint {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

export const isSourceFingerprint = isProjectFileFingerprint
