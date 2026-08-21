export const MAX_PROJECT_FILE_PATH_BYTES = 2_048
export const MAX_PROJECT_FILE_TEXT_BYTES = 8 * 1024 * 1024
export const MAX_EDITABLE_PROJECT_FILE_BYTES = 1024 * 1024
export const MAX_PROJECT_FILE_BINARY_BYTES = 32 * 1024 * 1024
export const MAX_PROJECT_FILE_REFERENCE_CFI_CHARS = 4_096
export const MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS = 4_000
export const MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS = 1_000
export const MAX_PROJECT_FILE_REFERENCE_TOC_DEPTH = 32
export const MAX_PROJECT_FILE_REFERENCE_LABEL_CHARS = 1_024
export const MAX_PDF_RECTS_PER_HIGHLIGHT = 512

export type ProjectFileFingerprint = `sha256:${string}`
export type SourceFingerprint = ProjectFileFingerprint

export interface ProjectFileIdentity {
  projectId: string
  relativePath: string
}

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

export interface EpubCfiLocatorV1 {
  type: 'epub-cfi'
  cfiRange: string
}

export interface PdfPageRectV1 {
  pageNumber: number
  x: number
  y: number
  width: number
  height: number
}

export interface PdfTextQuoteLocatorV1 {
  type: 'pdf-text-quote'
  exact: string
  prefix?: string
  suffix?: string
  startPage: number
  endPage: number
  anchor?: PdfPageRectV1
}

export interface ProjectFileOpenIntent {
  expectedFingerprint: SourceFingerprint
  locator: EpubCfiLocatorV1 | (PdfTextQuoteLocatorV1 & { anchor: PdfPageRectV1 })
}

export type ProjectFileSelectionLocatorV1 =
  | EpubCfiLocatorV1
  | PdfTextQuoteLocatorV1

/**
 * 阶段 4 的稳定阅读定位结构。它只描述来源和选区，不承担聊天草稿或
 * Add Note 的传递职责；后两者在阶段 5 通过统一引用协议接入。
 */
export interface ProjectFileSelectionReferenceV1 extends ProjectFileIdentity {
  version: 1
  kind: 'project-file'
  sourceFingerprint: SourceFingerprint
  fileName: string
  quote: string
  contextBefore?: string
  contextAfter?: string
  chapterKey?: string
  chapterTitle?: string
  tocPath?: EpubTocPathEntryV1[]
  locator: ProjectFileSelectionLocatorV1
}

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

export interface EpubTocPathEntryV1 {
  key: string
  title: string
  orderPath: number[]
  href?: string
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
