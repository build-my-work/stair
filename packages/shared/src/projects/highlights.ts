import { existsSync, lstatSync, statSync } from 'fs';
import { basename, extname, isAbsolute, join, posix, win32 } from 'path';

import type {
  WorkingFileEpubHighlight,
  WorkingFileEpubHighlightInput,
} from '../learning/types.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { getProjectPath, projectExists } from './storage.ts';

export const HIGHLIGHTS_FILENAME = 'highlights.json';
const MAX_HIGHLIGHTS = 10_000;
const MAX_HIGHLIGHTS_FILE_BYTES = 20 * 1024 * 1024;
const MAX_HIGHLIGHT_TEXT_LENGTH = 256 * 1024;
const MAX_CFI_LENGTH = 32 * 1024;
const MAX_CHAPTER_FIELD_LENGTH = 16 * 1024;
const MAX_SOURCE_PATH_LENGTH = 4_096;

export interface EpubHighlightsExport {
  filename: string;
  markdown: string;
}

export function getProjectHighlightsPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getProjectPath(workspaceRootPath, projectSlug), HIGHLIGHTS_FILENAME);
}

export function listProjectWorkingFileEpubHighlights(
  workspaceRootPath: string,
  projectSlug: string,
  sourcePath: string,
  sourceFingerprint: string,
): WorkingFileEpubHighlight[] {
  assertProjectExists(workspaceRootPath, projectSlug);
  const path = normalizeSourcePath(sourcePath);
  const fingerprint = normalizeFingerprint(sourceFingerprint);
  return loadAllHighlights(workspaceRootPath, projectSlug)
    .filter((highlight) => (
      highlight.sourcePath === path
      && highlight.sourceFingerprint === fingerprint
    ))
    .sort(compareHighlights);
}

export function saveProjectWorkingFileEpubHighlight(
  workspaceRootPath: string,
  projectSlug: string,
  input: WorkingFileEpubHighlightInput,
): WorkingFileEpubHighlight {
  assertProjectExists(workspaceRootPath, projectSlug);
  const normalized = normalizeWorkingFileInput(input);
  return saveNormalizedHighlight(workspaceRootPath, projectSlug, normalized);
}

export function deleteProjectWorkingFileEpubHighlight(
  workspaceRootPath: string,
  projectSlug: string,
  sourcePath: string,
  sourceFingerprint: string,
  cfiRange: string,
): void {
  assertProjectExists(workspaceRootPath, projectSlug);
  const path = normalizeSourcePath(sourcePath);
  const fingerprint = normalizeFingerprint(sourceFingerprint);
  const cfi = normalizeCfiRange(cfiRange);
  deleteMatchingHighlights(workspaceRootPath, projectSlug, (highlight) => (
    highlight.sourcePath === path
    && highlight.sourceFingerprint === fingerprint
    && highlight.cfiRange === cfi
  ));
}

export function exportProjectWorkingFileEpubHighlights(
  workspaceRootPath: string,
  projectSlug: string,
  sourcePath: string,
  sourceFingerprint: string,
): EpubHighlightsExport {
  const source = normalizeSourcePath(sourcePath);
  const highlights = listProjectWorkingFileEpubHighlights(
    workspaceRootPath,
    projectSlug,
    source,
    sourceFingerprint,
  );
  return exportHighlights(source, highlights);
}

function exportHighlights(source: string, highlights: WorkingFileEpubHighlight[]): EpubHighlightsExport {
  const extension = extname(source);
  const title = basename(source, extension).trim() || 'EPUB';
  const lines = [`# ${title} Highlights`];

  let activeChapterKey: string | null = null;
  for (const highlight of highlights) {
    const chapterKey = `${highlight.chapterOrder}:${highlight.chapterId}`;
    if (chapterKey !== activeChapterKey) {
      lines.push('', `## ${highlight.chapterTitle.replace(/\s+/g, ' ')}`);
      activeChapterKey = chapterKey;
    }
    lines.push('', formatBlockquote(highlight.text));
  }

  return {
    filename: `${title}-highlights.md`,
    markdown: `${lines.join('\n')}\n`,
  };
}

function loadAllHighlights(workspaceRootPath: string, projectSlug: string): WorkingFileEpubHighlight[] {
  const path = getProjectHighlightsPath(workspaceRootPath, projectSlug);
  if (!existsSync(path)) return [];
  const file = lstatSync(path);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error(`Invalid ${HIGHLIGHTS_FILENAME}: expected a regular file`);
  }
  if (statSync(path).size > MAX_HIGHLIGHTS_FILE_BYTES) {
    throw new Error(`${HIGHLIGHTS_FILENAME} is too large`);
  }
  const value = readJsonFileSync<unknown>(path);
  if (!Array.isArray(value)) throw new Error(`Invalid ${HIGHLIGHTS_FILENAME}: expected an array`);
  if (value.length > MAX_HIGHLIGHTS) throw new Error(`Too many ${HIGHLIGHTS_FILENAME} entries`);
  return value.map((item, index) => normalizePersistedHighlight(item, index));
}

function writeAllHighlights(
  workspaceRootPath: string,
  projectSlug: string,
  highlights: WorkingFileEpubHighlight[],
): void {
  if (highlights.length > MAX_HIGHLIGHTS) throw new Error(`Too many ${HIGHLIGHTS_FILENAME} entries`);
  const serialized = `${JSON.stringify(highlights, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_HIGHLIGHTS_FILE_BYTES) {
    throw new Error(`${HIGHLIGHTS_FILENAME} is too large`);
  }
  atomicWriteFileSync(getProjectHighlightsPath(workspaceRootPath, projectSlug), serialized);
}

function saveNormalizedHighlight(
  workspaceRootPath: string,
  projectSlug: string,
  input: WorkingFileEpubHighlightInput,
): WorkingFileEpubHighlight {
  const highlights = loadAllHighlights(workspaceRootPath, projectSlug);
  const index = highlights.findIndex((highlight) => isSameHighlight(highlight, input));
  const highlight: WorkingFileEpubHighlight = {
    ...input,
    createdAt: index >= 0 ? highlights[index]!.createdAt : Date.now(),
  };

  if (index >= 0) highlights[index] = highlight;
  else highlights.push(highlight);
  writeAllHighlights(workspaceRootPath, projectSlug, highlights);
  return highlight;
}

function isSameHighlight(
  highlight: WorkingFileEpubHighlight,
  input: WorkingFileEpubHighlightInput,
): boolean {
  return highlight.sourcePath === input.sourcePath
    && highlight.sourceFingerprint === input.sourceFingerprint
    && highlight.cfiRange === input.cfiRange;
}

function deleteMatchingHighlights(
  workspaceRootPath: string,
  projectSlug: string,
  matches: (highlight: WorkingFileEpubHighlight) => boolean,
): void {
  const highlights = loadAllHighlights(workspaceRootPath, projectSlug);
  const remaining = highlights.filter((highlight) => !matches(highlight));
  if (remaining.length !== highlights.length) {
    writeAllHighlights(workspaceRootPath, projectSlug, remaining);
  }
}

function normalizePersistedHighlight(value: unknown, index: number): WorkingFileEpubHighlight {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid ${HIGHLIGHTS_FILENAME} entry at index ${index}`);
  }
  const record = value as Partial<WorkingFileEpubHighlight>;
  const input = normalizeWorkingFileInput(record as WorkingFileEpubHighlightInput);
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt < 0) {
    throw new Error(`Invalid ${HIGHLIGHTS_FILENAME} createdAt at index ${index}`);
  }
  return { ...input, createdAt: record.createdAt };
}

function normalizeWorkingFileInput(
  input: WorkingFileEpubHighlightInput,
): WorkingFileEpubHighlightInput {
  if (!input || typeof input !== 'object') throw new Error('Highlight input is required');
  return {
    sourcePath: normalizeSourcePath(input.sourcePath),
    sourceFingerprint: normalizeFingerprint(input.sourceFingerprint),
    cfiRange: normalizeCfiRange(input.cfiRange),
    text: requireText(input.text, 'text', MAX_HIGHLIGHT_TEXT_LENGTH),
    chapterId: requireText(input.chapterId, 'chapterId', MAX_CHAPTER_FIELD_LENGTH),
    chapterTitle: requireText(input.chapterTitle, 'chapterTitle', MAX_CHAPTER_FIELD_LENGTH),
    chapterOrder: requireIndex(input.chapterOrder, 'chapterOrder'),
    spineIndex: requireIndex(input.spineIndex, 'spineIndex'),
  };
}

function normalizeSourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('sourcePath must be a non-empty relative path');
  }
  if (value.length > MAX_SOURCE_PATH_LENGTH) throw new Error('sourcePath is too long');
  if (value.includes('\0') || value.includes('\\') || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error('sourcePath must be a normalized relative path');
  }
  const path = posix.normalize(value);
  if (path === '..' || path.startsWith('../') || path.startsWith('/') || path === '.') {
    throw new Error('sourcePath must be a normalized relative path');
  }
  if (!/\.epub$/i.test(path)) throw new Error('sourcePath must identify an EPUB file');
  return path;
}

function normalizeFingerprint(value: unknown): string {
  const fingerprint = requireText(value, 'sourceFingerprint');
  if (!/^sha256:[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('sourceFingerprint must be a SHA-256 fingerprint');
  }
  return fingerprint.toLowerCase();
}

function normalizeCfiRange(value: unknown): string {
  const cfiRange = requireText(value, 'cfiRange', MAX_CFI_LENGTH);
  if (!cfiRange.startsWith('epubcfi(') || !cfiRange.endsWith(')')) {
    throw new Error('cfiRange must be a valid EPUB CFI range');
  }
  return cfiRange;
}

function requireText(value: unknown, field: string, maxLength = MAX_CHAPTER_FIELD_LENGTH): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`${field} is too long`);
  return value.trim();
}

function requireIndex(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function assertProjectExists(workspaceRootPath: string, projectSlug: string): void {
  if (!projectExists(workspaceRootPath, projectSlug)) {
    throw new Error(`Project not found: ${projectSlug}`);
  }
}

function compareHighlights(left: WorkingFileEpubHighlight, right: WorkingFileEpubHighlight): number {
  return left.chapterOrder - right.chapterOrder
    || left.chapterId.localeCompare(right.chapterId)
    || left.createdAt - right.createdAt
    || left.cfiRange.localeCompare(right.cfiRange);
}

function formatBlockquote(text: string): string {
  return text.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}
