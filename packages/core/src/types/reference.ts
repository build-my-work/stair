export const MAX_REFERENCES_PER_MESSAGE = 32;
export const MAX_REFERENCE_QUOTE_CHARS = 4_000;
export const MAX_REFERENCE_CONTEXT_CHARS = 1_000;
export const MAX_REFERENCE_CFI_CHARS = 4_096;
export const MAX_REFERENCE_TOC_DEPTH = 32;
export const MAX_REFERENCE_TOC_ORDER_DEPTH = 32;
export const MAX_REFERENCE_PATH_BYTES = 2_048;
export const MAX_REFERENCE_URL_CHARS = 8_192;
export const MAX_REFERENCE_TITLE_CHARS = 512;
export const MAX_REFERENCE_SERIALIZED_BYTES = 16 * 1_024;
export const MAX_REFERENCES_SERIALIZED_BYTES = 128 * 1_024;

export type SourceFingerprint = `sha256:${string}`;

export interface ProjectFileIdentity {
  projectId: string;
  relativePath: string;
}

export interface EpubTocPathEntryV1 {
  key: string;
  title: string;
  orderPath: number[];
  href?: string;
}

export interface EpubCfiLocatorV1 {
  type: 'epub-cfi';
  cfiRange: string;
}

export interface TextQuoteLocatorV1 {
  type: 'text-quote';
  exact: string;
  prefix?: string;
  suffix?: string;
  start: number;
  end: number;
}

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
  anchor?: PdfPageRectV1;
}

export interface WebTextQuoteLocatorV1 {
  type: 'web-text-quote';
  exact: string;
  prefix?: string;
  suffix?: string;
}

export type ProjectFileSelectionLocatorV1 =
  | EpubCfiLocatorV1
  | TextQuoteLocatorV1
  | PdfTextQuoteLocatorV1;

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
  tocPath?: EpubTocPathEntryV1[];
  locator: ProjectFileSelectionLocatorV1;
}

export interface ChatMessageReferenceV1 {
  version: 1;
  kind: 'chat-message';
  projectId: string;
  sessionId: string;
  messageId: string;
  role: 'user' | 'assistant' | 'plan';
  quote: string;
  locator: TextQuoteLocatorV1;
}

export interface WebSelectionReferenceV1 {
  version: 1;
  kind: 'web-selection';
  projectId: string;
  url: string;
  title: string;
  quote: string;
  locator: WebTextQuoteLocatorV1;
}

export type Reference =
  | ProjectFileReferenceV1
  | ChatMessageReferenceV1
  | WebSelectionReferenceV1;

function isBoundedText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && value.length <= max
    && !value.includes('\0');
}

function isCanonicalProjectRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let pathBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) pathBytes += 1;
    else if (code <= 0x7ff) pathBytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      pathBytes += 4;
      index += 1;
    } else pathBytes += 3;
    if (pathBytes > MAX_REFERENCE_PATH_BYTES) return false;
  }
  return !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isSourceFingerprint(value: unknown): value is SourceFingerprint {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isTextQuoteLocator(value: unknown, quote: string): value is TextQuoteLocatorV1 {
  if (!value || typeof value !== 'object') return false;
  const locator = value as TextQuoteLocatorV1;
  return locator.type === 'text-quote'
    && locator.exact === quote
    && Number.isSafeInteger(locator.start)
    && Number.isSafeInteger(locator.end)
    && locator.start >= 0
    && locator.end > locator.start
    && locator.end - locator.start === quote.length
    && (locator.prefix === undefined || isBoundedText(locator.prefix, MAX_REFERENCE_CONTEXT_CHARS, true))
    && (locator.suffix === undefined || isBoundedText(locator.suffix, MAX_REFERENCE_CONTEXT_CHARS, true));
}

function isPdfRect(value: unknown): value is PdfPageRectV1 {
  if (!value || typeof value !== 'object') return false;
  const rect = value as PdfPageRectV1;
  return Number.isSafeInteger(rect.pageNumber)
    && rect.pageNumber >= 1
    && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.x >= 0
    && rect.y >= 0
    && rect.width > 0
    && rect.height > 0
    && rect.x + rect.width <= 1.001
    && rect.y + rect.height <= 1.001;
}

function isProjectFileLocator(value: unknown, quote: string): value is ProjectFileSelectionLocatorV1 {
  if (!value || typeof value !== 'object') return false;
  const locator = value as ProjectFileSelectionLocatorV1;
  if (locator.type === 'text-quote') return isTextQuoteLocator(locator, quote);
  if (locator.type === 'epub-cfi') {
    return isBoundedText(locator.cfiRange, MAX_REFERENCE_CFI_CHARS);
  }
  if (locator.type !== 'pdf-text-quote') return false;
  return locator.exact === quote
    && Number.isSafeInteger(locator.startPage)
    && Number.isSafeInteger(locator.endPage)
    && locator.startPage >= 1
    && locator.endPage >= locator.startPage
    && (locator.anchor === undefined || isPdfRect(locator.anchor))
    && (locator.prefix === undefined || isBoundedText(locator.prefix, MAX_REFERENCE_CONTEXT_CHARS, true))
    && (locator.suffix === undefined || isBoundedText(locator.suffix, MAX_REFERENCE_CONTEXT_CHARS, true));
}

function isTocPath(value: unknown): value is EpubTocPathEntryV1[] {
  return Array.isArray(value)
    && value.length <= MAX_REFERENCE_TOC_DEPTH
    && value.every(entry => (
      entry
      && isBoundedText(entry.key, MAX_REFERENCE_CONTEXT_CHARS)
      && isBoundedText(entry.title, MAX_REFERENCE_CONTEXT_CHARS, true)
      && Array.isArray(entry.orderPath)
      && entry.orderPath.length <= MAX_REFERENCE_TOC_ORDER_DEPTH
      && entry.orderPath.every((index: unknown) => (
        typeof index === 'number' && Number.isSafeInteger(index) && index >= 0
      ))
      && (entry.href === undefined || isBoundedText(entry.href, MAX_REFERENCE_CONTEXT_CHARS, true))
    ));
}

export function isProjectFileReference(value: unknown): value is ProjectFileReferenceV1 {
  if (!value || typeof value !== 'object') return false;
  const reference = value as ProjectFileReferenceV1;
  return reference.version === 1
    && reference.kind === 'project-file'
    && isBoundedText(reference.projectId, 256)
    && reference.projectId === reference.projectId.trim()
    && isCanonicalProjectRelativePath(reference.relativePath)
    && isSourceFingerprint(reference.sourceFingerprint)
    && isBoundedText(reference.fileName, 1_024)
    && isBoundedText(reference.quote, MAX_REFERENCE_QUOTE_CHARS)
    && (reference.contextBefore === undefined || isBoundedText(reference.contextBefore, MAX_REFERENCE_CONTEXT_CHARS, true))
    && (reference.contextAfter === undefined || isBoundedText(reference.contextAfter, MAX_REFERENCE_CONTEXT_CHARS, true))
    && (reference.chapterKey === undefined || isBoundedText(reference.chapterKey, 1_024, true))
    && (reference.chapterTitle === undefined || isBoundedText(reference.chapterTitle, 1_024, true))
    && (reference.tocPath === undefined || isTocPath(reference.tocPath))
    && isProjectFileLocator(reference.locator, reference.quote);
}

export function isChatMessageReference(value: unknown): value is ChatMessageReferenceV1 {
  if (!value || typeof value !== 'object') return false;
  const reference = value as ChatMessageReferenceV1;
  return reference.version === 1
    && reference.kind === 'chat-message'
    && isBoundedText(reference.projectId, 256)
    && reference.projectId === reference.projectId.trim()
    && isBoundedText(reference.sessionId, 256)
    && reference.sessionId === reference.sessionId.trim()
    && isBoundedText(reference.messageId, 256)
    && reference.messageId === reference.messageId.trim()
    && ['user', 'assistant', 'plan'].includes(reference.role)
    && isBoundedText(reference.quote, MAX_REFERENCE_QUOTE_CHARS)
    && isTextQuoteLocator(reference.locator, reference.quote);
}

function isHttpUrl(value: unknown): value is string {
  if (!isBoundedText(value, MAX_REFERENCE_URL_CHARS)) return false;
  try {
    const URLConstructor = (globalThis as unknown as {
      URL: new (input: string) => { protocol: string };
    }).URL;
    const protocol = new URLConstructor(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function isWebSelectionReference(value: unknown): value is WebSelectionReferenceV1 {
  if (!value || typeof value !== 'object') return false;
  const reference = value as WebSelectionReferenceV1;
  const locator = reference.locator;
  return reference.version === 1
    && reference.kind === 'web-selection'
    && isBoundedText(reference.projectId, 256)
    && reference.projectId === reference.projectId.trim()
    && isHttpUrl(reference.url)
    && isBoundedText(reference.title, MAX_REFERENCE_TITLE_CHARS)
    && isBoundedText(reference.quote, MAX_REFERENCE_QUOTE_CHARS)
    && Boolean(locator)
    && locator.type === 'web-text-quote'
    && locator.exact === reference.quote
    && (locator.prefix === undefined || isBoundedText(locator.prefix, MAX_REFERENCE_CONTEXT_CHARS, true))
    && (locator.suffix === undefined || isBoundedText(locator.suffix, MAX_REFERENCE_CONTEXT_CHARS, true));
}

export function isReference(value: unknown): value is Reference {
  return isProjectFileReference(value)
    || isChatMessageReference(value)
    || isWebSelectionReference(value);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (
      code >= 0xd800
      && code <= 0xdbff
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function referenceSerializedByteLength(reference: Reference): number {
  return utf8ByteLength(JSON.stringify(reference));
}

export function referencesFitSerializedLimits(references: Reference[]): boolean {
  let totalBytes = 0;
  for (const reference of references) {
    const bytes = referenceSerializedByteLength(reference);
    if (bytes > MAX_REFERENCE_SERIALIZED_BYTES) return false;
    totalBytes += bytes;
    if (totalBytes > MAX_REFERENCES_SERIALIZED_BYTES) return false;
  }
  return true;
}

export function referenceKey(reference: Reference): string {
  if (reference.kind === 'chat-message') {
    return `chat:${reference.sessionId}:${reference.messageId}:${reference.locator.start}:${reference.locator.end}`;
  }
  if (reference.kind === 'web-selection') {
    return `web:${reference.projectId}:${reference.url}:${JSON.stringify(reference.locator)}`;
  }
  return `file:${reference.projectId}:${reference.relativePath}:${reference.sourceFingerprint}:${JSON.stringify(reference.locator)}`;
}

/** Apply only explicit additions, edits and removals to the current references. */
export function mergeReferenceDelta(current: Reference[], base: Reference[], next: Reference[]): Reference[] {
  const baseByKey = new Map(base.map(reference => [referenceKey(reference), reference]));
  const nextKeys = new Set(next.map(referenceKey));
  const changed = new Map(next
    .filter(reference => JSON.stringify(reference) !== JSON.stringify(baseByKey.get(referenceKey(reference))))
    .map(reference => [referenceKey(reference), reference]));
  const merged = current
    .filter(reference => !baseByKey.has(referenceKey(reference)) || nextKeys.has(referenceKey(reference)))
    .map(reference => changed.get(referenceKey(reference)) ?? reference);
  const mergedKeys = new Set(merged.map(referenceKey));
  for (const [key, reference] of changed) {
    if (!mergedKeys.has(key)) {
      merged.push(reference);
      mergedKeys.add(key);
    }
  }
  return merged;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

const REFERENCE_DATA_OPEN = '<stair_reference_data trust="untrusted">';
const REFERENCE_DATA_CLOSE = '</stair_reference_data>';

export function formatReferencesForModel(message: string, references: Reference[]): string {
  if (references.length === 0) return message;
  const context = [
    REFERENCE_DATA_OPEN,
    escapeXml(JSON.stringify(references, null, 2)),
    REFERENCE_DATA_CLOSE,
  ].join('\n');
  return message ? `${message}\n\n${context}` : context;
}

export function stripReferencesFromModelInput(message: string): string {
  const suffix = `\n${REFERENCE_DATA_CLOSE}`;
  if (!message.endsWith(suffix)) return message;

  const blockStart = message.lastIndexOf(`\n\n${REFERENCE_DATA_OPEN}\n`);
  if (blockStart >= 0) return message.slice(0, blockStart);
  return message.startsWith(`${REFERENCE_DATA_OPEN}\n`) ? '' : message;
}
