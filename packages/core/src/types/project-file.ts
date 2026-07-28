/** SHA-256 of the exact bytes returned by the Project File read API. */
export type SourceFingerprint = `sha256:${string}`;

export interface ProjectFileIdentity {
  projectId: string;
  relativePath: string;
}

export interface ProjectFileOpenIntent {
  expectedFingerprint: SourceFingerprint;
  locator: {
    type: 'epub-cfi';
    cfiRange: string;
  };
}

export interface EpubTocPathEntryV1 {
  key: string;
  title: string;
  orderPath: number[];
  href?: string;
}

export interface EpubTocNode {
  key: string;
  title: string;
  href?: string;
  orderPath: number[];
  children: EpubTocNode[];
}

export interface EpubHighlightV1 {
  id: string;
  cfiRange: string;
  quote: string;
  contextBefore?: string;
  contextAfter?: string;
  chapterKey?: string;
  chapterTitle?: string;
  tocPath: EpubTocPathEntryV1[];
  spineIndex?: number;
  style: {
    type: 'wavy';
    color: 'red';
  };
  createdAt: number;
  updatedAt: number;
}

export interface EpubProgressV1 {
  cfi: string;
  chapterKey?: string;
  percentage?: number;
  updatedAt: number;
}

export interface EpubDocumentStateV1 extends ProjectFileIdentity {
  version: 1;
  sourceFingerprint: SourceFingerprint;
  revision: number;
  progress?: EpubProgressV1;
  highlights: EpubHighlightV1[];
  updatedAt: number;
}

export type EpubStateMutation =
  | {
      type: 'set-progress';
      progress: Omit<EpubProgressV1, 'updatedAt'>;
    }
  | {
      type: 'upsert-highlight';
      highlight: Omit<EpubHighlightV1, 'createdAt' | 'updatedAt'>;
    }
  | {
      type: 'delete-highlight';
      highlightId: string;
    };

export interface ProjectFileReferenceV1 extends ProjectFileIdentity {
  version: 1;
  kind: 'project-file';
  sourceFingerprint: SourceFingerprint;
  fileName: string;
  quote: string;
  contextBefore?: string;
  contextAfter?: string;
  chapterKey?: string;
  chapterTitle?: string;
  tocPath: EpubTocPathEntryV1[];
  locator: {
    type: 'epub-cfi';
    cfiRange: string;
  };
}

export type MessageReference = ProjectFileReferenceV1;

export const MAX_PROJECT_FILE_REFERENCES = 32;
export const MAX_PROJECT_FILE_REFERENCE_CHARS = 16 * 1024;
export const MAX_PROJECT_FILE_REFERENCE_CFI_CHARS = 4_096;
export const MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS = 4_000;
export const MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS = 1_000;
export const MAX_PROJECT_FILE_REFERENCE_TOC_DEPTH = 32;

export function isSourceFingerprint(value: unknown): value is SourceFingerprint {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function isCanonicalProjectRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\0')
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return !value.split('/').some(segment =>
    !segment || segment === '.' || segment === '..' || segment.includes('\\'));
}

export function isProjectFileReferenceV1(value: unknown): value is ProjectFileReferenceV1 {
  if (!value || typeof value !== 'object') return false;
  const reference = value as ProjectFileReferenceV1;
  return reference.version === 1
    && reference.kind === 'project-file'
    && typeof reference.projectId === 'string'
    && reference.projectId.length > 0
    && reference.projectId === reference.projectId.trim()
    && !reference.projectId.includes('\0')
    && isCanonicalProjectRelativePath(reference.relativePath)
    && isSourceFingerprint(reference.sourceFingerprint)
    && typeof reference.fileName === 'string'
    && reference.fileName.length > 0
    && !reference.fileName.includes('\0')
    && typeof reference.quote === 'string'
    && reference.quote.length <= MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS
    && (reference.contextBefore === undefined
      || (typeof reference.contextBefore === 'string'
        && reference.contextBefore.length <= MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS))
    && (reference.contextAfter === undefined
      || (typeof reference.contextAfter === 'string'
        && reference.contextAfter.length <= MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS))
    && (reference.chapterKey === undefined
      || typeof reference.chapterKey === 'string')
    && (reference.chapterTitle === undefined
      || typeof reference.chapterTitle === 'string')
    && Array.isArray(reference.tocPath)
    && reference.tocPath.length <= MAX_PROJECT_FILE_REFERENCE_TOC_DEPTH
    && reference.tocPath.every(entry =>
      Boolean(entry)
      && typeof entry.key === 'string'
      && entry.key.length > 0
      && !entry.key.includes('\0')
      && typeof entry.title === 'string'
      && !entry.title.includes('\0')
      && (entry.href === undefined || typeof entry.href === 'string')
      && Array.isArray(entry.orderPath)
      && entry.orderPath.every(index => Number.isSafeInteger(index) && index >= 0))
    && reference.locator?.type === 'epub-cfi'
    && typeof reference.locator.cfiRange === 'string'
    && reference.locator.cfiRange.length > 0
    && reference.locator.cfiRange.length <= MAX_PROJECT_FILE_REFERENCE_CFI_CHARS
    && JSON.stringify(reference).length <= MAX_PROJECT_FILE_REFERENCE_CHARS;
}

export function projectFileReferenceKey(reference: ProjectFileReferenceV1): string {
  return JSON.stringify([
    reference.kind,
    reference.projectId,
    reference.relativePath,
    reference.sourceFingerprint,
    reference.locator.type,
    reference.locator.cfiRange,
  ]);
}
