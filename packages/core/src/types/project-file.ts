/** SHA-256 of the exact bytes returned by the Project File read API. */
export type SourceFingerprint = `sha256:${string}`;

export interface ProjectFileIdentity {
  projectId: string;
  relativePath: string;
}

export interface EpubCfiLocatorV1 {
  type: 'epub-cfi';
  cfiRange: string;
}

/** Rectangle coordinates normalized to the rendered PDF page bounds. */
export interface PdfPageRectV1 {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfTextQuoteLocatorV1 {
  type: 'pdf-text-quote';
  exact: string;
  prefix?: string;
  suffix?: string;
  startPage: number;
  endPage: number;
  /** First selected rectangle, used to reveal a sent reference precisely. */
  anchor?: PdfPageRectV1;
}

export interface ProjectFileOpenIntent {
  expectedFingerprint: SourceFingerprint;
  locator:
    | EpubCfiLocatorV1
    | (PdfTextQuoteLocatorV1 & { anchor: PdfPageRectV1 });
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
  style:
    | {
        type: 'wavy';
        color: 'red';
      }
    | {
        type: 'solid';
        color: 'blue';
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

export interface PdfHighlightV1 {
  id: string;
  quote: string;
  contextBefore?: string;
  contextAfter?: string;
  startPage: number;
  endPage: number;
  rects: PdfPageRectV1[];
  style:
    | {
        type: 'wavy';
        color: 'red';
      }
    | {
        type: 'solid';
        color: 'blue';
      };
  createdAt: number;
  updatedAt: number;
}

export interface PdfProgressV1 {
  pageNumber: number;
  pageOffsetRatio: number;
  percentage?: number;
  updatedAt: number;
}

export interface PdfDocumentStateV1 extends ProjectFileIdentity {
  version: 1;
  sourceFingerprint: SourceFingerprint;
  revision: number;
  progress?: PdfProgressV1;
  highlights: PdfHighlightV1[];
  updatedAt: number;
}

export type PdfStateMutation =
  | {
      type: 'set-progress';
      progress: Omit<PdfProgressV1, 'updatedAt'>;
    }
  | {
      type: 'upsert-highlight';
      highlight: Omit<PdfHighlightV1, 'createdAt' | 'updatedAt'>;
    }
  | {
      type: 'delete-highlight';
      highlightId: string;
    };

export type ProjectFileSelectionLocatorV1 =
  | EpubCfiLocatorV1
  | {
      type: 'text-quote';
      exact: string;
      prefix?: string;
      suffix?: string;
      start?: number;
      end?: number;
    }
  | PdfTextQuoteLocatorV1;

/**
 * A text selection captured from a Project File.
 *
 * This is deliberately broader than ProjectFileReferenceV1: selections can
 * come from EPUB, PDF, Markdown, or other rendered UTF-8 text files, while
 * Message attachments are the narrower EPUB/PDF reference union below.
 */
export interface ProjectFileSelectionReferenceV1 extends ProjectFileIdentity {
  version: 1;
  kind: 'project-file';
  sourceFingerprint: SourceFingerprint;
  fileName: string;
  quote: string;
  contextBefore?: string;
  contextAfter?: string;
  chapterKey?: string;
  chapterTitle?: string;
  tocPath?: EpubTocPathEntryV1[];
  locator: ProjectFileSelectionLocatorV1;
}

export interface EpubProjectFileReferenceV1 extends ProjectFileSelectionReferenceV1 {
  tocPath: EpubTocPathEntryV1[];
  locator: EpubCfiLocatorV1;
}

export type PdfProjectFileReferenceV1 = Omit<
  ProjectFileSelectionReferenceV1,
  'chapterKey' | 'chapterTitle' | 'tocPath' | 'locator'
> & {
  locator: PdfTextQuoteLocatorV1 & { anchor: PdfPageRectV1 };
};

export type ProjectFileReferenceV1 =
  | EpubProjectFileReferenceV1
  | PdfProjectFileReferenceV1;

export interface WebSelectionReferenceV1 {
  version: 1;
  kind: 'web-selection';
  url: string;
  title: string;
  quote: string;
  locator: {
    type: 'text-quote';
    exact: string;
    prefix?: string;
    suffix?: string;
  };
}

export interface ChatMessageSelectionReferenceV1 {
  version: 1;
  kind: 'chat-message';
  sessionId: string;
  messageId: string;
  role: 'user' | 'assistant' | 'plan';
  quote: string;
  locator: {
    type: 'text-quote';
    exact: string;
    prefix?: string;
    suffix?: string;
    start: number;
    end: number;
  };
}

/**
 * The single Add Note source contract.
 *
 * It only represents a selection that already exists in a source. Free-form
 * note input is intentionally not part of this union.
 */
export type SelectionReference =
  | ProjectFileSelectionReferenceV1
  | WebSelectionReferenceV1
  | ChatMessageSelectionReferenceV1;

export type MessageReference =
  | ProjectFileReferenceV1
  | WebSelectionReferenceV1;

export const MAX_PROJECT_FILE_REFERENCES = 32;
export const MAX_MESSAGE_REFERENCES = MAX_PROJECT_FILE_REFERENCES;
export const MAX_PROJECT_FILE_REFERENCE_CHARS = 16 * 1024;
export const MAX_PROJECT_FILE_REFERENCE_CFI_CHARS = 4_096;
export const MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS = 4_000;
export const MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS = 1_000;
export const MAX_PROJECT_FILE_REFERENCE_TOC_DEPTH = 32;
export const MAX_PDF_RECTS_PER_HIGHLIGHT = 512;
export const MAX_WEB_SELECTION_REFERENCE_CHARS = 16 * 1024;
export const MAX_WEB_SELECTION_URL_CHARS = 8_192;
export const MAX_WEB_SELECTION_TITLE_CHARS = 512;
export const MAX_WEB_SELECTION_QUOTE_CHARS = 4_000;
export const MAX_WEB_SELECTION_CONTEXT_CHARS = 128;
export const MAX_CHAT_SELECTION_REFERENCE_CHARS = 16 * 1024;
export const MAX_CHAT_SELECTION_ID_CHARS = 256;
export const MAX_CHAT_SELECTION_QUOTE_CHARS = 4_000;
export const MAX_CHAT_SELECTION_CONTEXT_CHARS = 128;

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

function isValidTocPath(value: unknown): value is EpubTocPathEntryV1[] {
  return Array.isArray(value)
    && value.length <= MAX_PROJECT_FILE_REFERENCE_TOC_DEPTH
    && value.every(entry =>
      Boolean(entry)
      && typeof entry.key === 'string'
      && entry.key.length > 0
      && !entry.key.includes('\0')
      && typeof entry.title === 'string'
      && !entry.title.includes('\0')
      && (entry.href === undefined || typeof entry.href === 'string')
      && Array.isArray(entry.orderPath)
      && entry.orderPath.every(
        (index: unknown) => Number.isSafeInteger(index) && (index as number) >= 0,
      ));
}

function isOptionalSelectionContext(value: unknown, maxLength: number): boolean {
  return value === undefined
    || (
      typeof value === 'string'
      && value.length <= maxLength
      && !value.includes('\0')
    );
}

function isValidTextRange(start: unknown, end: unknown): boolean {
  return Number.isSafeInteger(start)
    && Number.isSafeInteger(end)
    && (start as number) >= 0
    && (end as number) > (start as number);
}

function isPdfPageRect(value: unknown): value is PdfPageRectV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rect = value as PdfPageRectV1;
  const geometry = [rect.x, rect.y, rect.width, rect.height];
  return Number.isSafeInteger(rect.pageNumber)
    && rect.pageNumber >= 1
    && geometry.every(number => typeof number === 'number' && Number.isFinite(number))
    && rect.x >= 0
    && rect.y >= 0
    && rect.width > 0
    && rect.height > 0
    && rect.x + rect.width <= 1.000001
    && rect.y + rect.height <= 1.000001;
}

function isPdfTextQuoteSelectionLocator(
  value: unknown,
  quote: string,
): value is PdfTextQuoteLocatorV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const locator = value as PdfTextQuoteLocatorV1;
  if (
    locator.type !== 'pdf-text-quote'
    || locator.exact !== quote
    || !isOptionalSelectionContext(
      locator.prefix,
      MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
    )
    || !isOptionalSelectionContext(
      locator.suffix,
      MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
    )
    || !Number.isSafeInteger(locator.startPage)
    || !Number.isSafeInteger(locator.endPage)
    || locator.startPage < 1
    || locator.endPage < locator.startPage
  ) {
    return false;
  }
  return locator.anchor === undefined || (
    isPdfPageRect(locator.anchor)
    && locator.anchor.pageNumber >= locator.startPage
    && locator.anchor.pageNumber <= locator.endPage
  );
}

function isTextQuoteSelectionLocator(
  value: unknown,
  quote: string,
): value is Extract<ProjectFileSelectionLocatorV1, { type: 'text-quote' }> {
  if (!value || typeof value !== 'object') return false;
  const locator = value as Extract<ProjectFileSelectionLocatorV1, { type: 'text-quote' }>;
  const hasPositions = locator.start !== undefined || locator.end !== undefined;
  return locator.type === 'text-quote'
    && locator.exact === quote
    && isOptionalSelectionContext(
      locator.prefix,
      MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
    )
    && isOptionalSelectionContext(
      locator.suffix,
      MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
    )
    && (
      !hasPositions
      || isValidTextRange(locator.start, locator.end)
    );
}

export function isProjectFileSelectionReferenceV1(
  value: unknown,
): value is ProjectFileSelectionReferenceV1 {
  if (!value || typeof value !== 'object') return false;
  const reference = value as ProjectFileSelectionReferenceV1;
  const baseIsValid = reference.version === 1
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
    && reference.quote.length > 0
    && reference.quote.length <= MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS
    && !reference.quote.includes('\0')
    && isOptionalSelectionContext(
      reference.contextBefore,
      MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
    )
    && isOptionalSelectionContext(
      reference.contextAfter,
      MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
    )
    && (reference.chapterKey === undefined
      || typeof reference.chapterKey === 'string')
    && (reference.chapterTitle === undefined
      || typeof reference.chapterTitle === 'string')
    && (reference.tocPath === undefined || isValidTocPath(reference.tocPath))
    && JSON.stringify(reference).length <= MAX_PROJECT_FILE_REFERENCE_CHARS;

  if (!baseIsValid || !reference.locator) return false;

  switch (reference.locator.type) {
    case 'epub-cfi':
      return typeof reference.locator.cfiRange === 'string'
        && reference.locator.cfiRange.length > 0
        && reference.locator.cfiRange.length <= MAX_PROJECT_FILE_REFERENCE_CFI_CHARS;
    case 'text-quote':
      return isTextQuoteSelectionLocator(reference.locator, reference.quote);
    case 'pdf-text-quote':
      return isPdfTextQuoteSelectionLocator(reference.locator, reference.quote);
    default:
      return false;
  }
}

export function isEpubProjectFileReferenceV1(
  value: unknown,
): value is EpubProjectFileReferenceV1 {
  if (!isProjectFileSelectionReferenceV1(value)) return false;
  return value.locator.type === 'epub-cfi'
    && isValidTocPath(value.tocPath);
}

export function isPdfProjectFileReferenceV1(
  value: unknown,
): value is PdfProjectFileReferenceV1 {
  if (!isProjectFileSelectionReferenceV1(value)) return false;
  return value.locator.type === 'pdf-text-quote'
    && isPdfPageRect(value.locator.anchor)
    && value.chapterKey === undefined
    && value.chapterTitle === undefined
    && value.tocPath === undefined;
}

export function isProjectFileReferenceV1(
  value: unknown,
): value is ProjectFileReferenceV1 {
  return isEpubProjectFileReferenceV1(value)
    || isPdfProjectFileReferenceV1(value);
}

function isBoundedTrimmedText(
  value: unknown,
  maxLength: number,
): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !value.includes('\0');
}

function isSupportedWebUrl(value: string): boolean {
  const UrlConstructor = (
    globalThis as typeof globalThis & {
      URL?: new (input: string) => { protocol: string };
    }
  ).URL;
  if (!UrlConstructor) return false;
  try {
    const parsed = new UrlConstructor(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isWebSelectionReferenceV1(
  value: unknown,
): value is WebSelectionReferenceV1 {
  if (!value || typeof value !== 'object') return false;
  const reference = value as WebSelectionReferenceV1;
  return reference.version === 1
    && reference.kind === 'web-selection'
    && isBoundedTrimmedText(reference.url, MAX_WEB_SELECTION_URL_CHARS)
    && isSupportedWebUrl(reference.url)
    && isBoundedTrimmedText(reference.title, MAX_WEB_SELECTION_TITLE_CHARS)
    && isBoundedTrimmedText(reference.quote, MAX_WEB_SELECTION_QUOTE_CHARS)
    && reference.locator?.type === 'text-quote'
    && reference.locator.exact === reference.quote
    && (reference.locator.prefix === undefined
      || isBoundedTrimmedText(
        reference.locator.prefix,
        MAX_WEB_SELECTION_CONTEXT_CHARS,
      ))
    && (reference.locator.suffix === undefined
      || isBoundedTrimmedText(
        reference.locator.suffix,
        MAX_WEB_SELECTION_CONTEXT_CHARS,
      ))
    && JSON.stringify(reference).length <= MAX_WEB_SELECTION_REFERENCE_CHARS;
}

export function isChatMessageSelectionReferenceV1(
  value: unknown,
): value is ChatMessageSelectionReferenceV1 {
  if (!value || typeof value !== 'object') return false;
  const reference = value as ChatMessageSelectionReferenceV1;
  return reference.version === 1
    && reference.kind === 'chat-message'
    && isBoundedTrimmedText(reference.sessionId, MAX_CHAT_SELECTION_ID_CHARS)
    && isBoundedTrimmedText(reference.messageId, MAX_CHAT_SELECTION_ID_CHARS)
    && (
      reference.role === 'user'
      || reference.role === 'assistant'
      || reference.role === 'plan'
    )
    && isBoundedTrimmedText(
      reference.quote,
      MAX_CHAT_SELECTION_QUOTE_CHARS,
    )
    && reference.locator?.type === 'text-quote'
    && reference.locator.exact === reference.quote
    && isOptionalSelectionContext(
      reference.locator.prefix,
      MAX_CHAT_SELECTION_CONTEXT_CHARS,
    )
    && isOptionalSelectionContext(
      reference.locator.suffix,
      MAX_CHAT_SELECTION_CONTEXT_CHARS,
    )
    && isValidTextRange(reference.locator.start, reference.locator.end)
    && JSON.stringify(reference).length <= MAX_CHAT_SELECTION_REFERENCE_CHARS;
}

export function isSelectionReference(
  value: unknown,
): value is SelectionReference {
  return isProjectFileSelectionReferenceV1(value)
    || isWebSelectionReferenceV1(value)
    || isChatMessageSelectionReferenceV1(value);
}

export function isMessageReference(value: unknown): value is MessageReference {
  return isProjectFileReferenceV1(value) || isWebSelectionReferenceV1(value);
}

export function projectFileReferenceKey(reference: ProjectFileReferenceV1): string {
  const identity = [
    reference.kind,
    reference.projectId,
    reference.relativePath,
    reference.sourceFingerprint,
  ];
  if (reference.locator.type === 'pdf-text-quote') {
    return JSON.stringify([
      ...identity,
      reference.locator.type,
      reference.locator.exact,
      reference.locator.prefix ?? '',
      reference.locator.suffix ?? '',
      reference.locator.startPage,
      reference.locator.endPage,
      reference.locator.anchor,
    ]);
  }
  return JSON.stringify([
    ...identity,
    reference.locator.type,
    reference.locator.cfiRange,
  ]);
}

export function messageReferenceKey(reference: MessageReference): string {
  if (reference.kind === 'project-file') {
    return projectFileReferenceKey(reference);
  }
  return JSON.stringify([
    reference.kind,
    reference.url,
    reference.locator.type,
    reference.locator.exact,
    reference.locator.prefix ?? '',
    reference.locator.suffix ?? '',
  ]);
}
