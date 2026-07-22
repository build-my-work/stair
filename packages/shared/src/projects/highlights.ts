import { existsSync } from 'fs';
import { basename, extname, join } from 'path';

import type { EpubHighlight, EpubHighlightInput } from '../learning/types.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { getProjectPath, projectExists } from './storage.ts';

export const HIGHLIGHTS_FILENAME = 'highlights.json';

export interface EpubHighlightsExport {
  filename: string;
  markdown: string;
}

export function getProjectHighlightsPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getProjectPath(workspaceRootPath, projectSlug), HIGHLIGHTS_FILENAME);
}

export function listProjectEpubHighlights(
  workspaceRootPath: string,
  projectSlug: string,
  sourceFilename: string,
): EpubHighlight[] {
  assertProjectExists(workspaceRootPath, projectSlug);
  const source = normalizeSourceFilename(sourceFilename);
  return loadAllHighlights(workspaceRootPath, projectSlug)
    .filter((highlight) => highlight.sourceFilename === source)
    .sort(compareHighlights);
}

export function saveProjectEpubHighlight(
  workspaceRootPath: string,
  projectSlug: string,
  input: EpubHighlightInput,
): EpubHighlight {
  assertProjectExists(workspaceRootPath, projectSlug);
  const normalized = normalizeInput(input);
  const highlights = loadAllHighlights(workspaceRootPath, projectSlug);
  const index = highlights.findIndex((highlight) => (
    highlight.sourceFilename === normalized.sourceFilename
    && highlight.cfiRange === normalized.cfiRange
  ));
  const highlight: EpubHighlight = {
    ...normalized,
    createdAt: index >= 0 ? highlights[index]!.createdAt : Date.now(),
  };

  if (index >= 0) highlights[index] = highlight;
  else highlights.push(highlight);
  writeAllHighlights(workspaceRootPath, projectSlug, highlights);
  return highlight;
}

export function deleteProjectEpubHighlight(
  workspaceRootPath: string,
  projectSlug: string,
  sourceFilename: string,
  cfiRange: string,
): void {
  assertProjectExists(workspaceRootPath, projectSlug);
  const source = normalizeSourceFilename(sourceFilename);
  const cfi = normalizeCfiRange(cfiRange);
  const highlights = loadAllHighlights(workspaceRootPath, projectSlug);
  const remaining = highlights.filter((highlight) => (
    highlight.sourceFilename !== source || highlight.cfiRange !== cfi
  ));
  if (remaining.length !== highlights.length) {
    writeAllHighlights(workspaceRootPath, projectSlug, remaining);
  }
}

/** Remove every persisted highlight for a deleted EPUB asset. */
export function deleteProjectEpubHighlightsForSource(
  workspaceRootPath: string,
  projectSlug: string,
  sourceFilename: string,
): void {
  assertProjectExists(workspaceRootPath, projectSlug);
  const source = normalizeSourceFilename(sourceFilename);
  const highlights = loadAllHighlights(workspaceRootPath, projectSlug);
  const remaining = highlights.filter((highlight) => highlight.sourceFilename !== source);
  if (remaining.length !== highlights.length) {
    writeAllHighlights(workspaceRootPath, projectSlug, remaining);
  }
}

export function exportProjectEpubHighlights(
  workspaceRootPath: string,
  projectSlug: string,
  sourceFilename: string,
): EpubHighlightsExport {
  const highlights = listProjectEpubHighlights(workspaceRootPath, projectSlug, sourceFilename);
  const source = normalizeSourceFilename(sourceFilename);
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

function loadAllHighlights(workspaceRootPath: string, projectSlug: string): EpubHighlight[] {
  const path = getProjectHighlightsPath(workspaceRootPath, projectSlug);
  if (!existsSync(path)) return [];
  const value = readJsonFileSync<unknown>(path);
  if (!Array.isArray(value)) throw new Error(`Invalid ${HIGHLIGHTS_FILENAME}: expected an array`);
  return value.map((item, index) => normalizePersistedHighlight(item, index));
}

function writeAllHighlights(
  workspaceRootPath: string,
  projectSlug: string,
  highlights: EpubHighlight[],
): void {
  atomicWriteFileSync(
    getProjectHighlightsPath(workspaceRootPath, projectSlug),
    `${JSON.stringify(highlights, null, 2)}\n`,
  );
}

function normalizePersistedHighlight(value: unknown, index: number): EpubHighlight {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid ${HIGHLIGHTS_FILENAME} entry at index ${index}`);
  }
  const record = value as Partial<EpubHighlight>;
  const input = normalizeInput(record as EpubHighlightInput);
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt < 0) {
    throw new Error(`Invalid ${HIGHLIGHTS_FILENAME} createdAt at index ${index}`);
  }
  return { ...input, createdAt: record.createdAt };
}

function normalizeInput(input: EpubHighlightInput): EpubHighlightInput {
  if (!input || typeof input !== 'object') throw new Error('Highlight input is required');
  return {
    sourceFilename: normalizeSourceFilename(input.sourceFilename),
    cfiRange: normalizeCfiRange(input.cfiRange),
    text: requireText(input.text, 'text'),
    chapterId: requireText(input.chapterId, 'chapterId'),
    chapterTitle: requireText(input.chapterTitle, 'chapterTitle'),
    chapterOrder: requireIndex(input.chapterOrder, 'chapterOrder'),
    spineIndex: requireIndex(input.spineIndex, 'spineIndex'),
  };
}

function normalizeSourceFilename(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('sourceFilename must be a non-empty string');
  }
  const filename = value;
  if (!/\.epub$/i.test(filename)) throw new Error('sourceFilename must identify an EPUB asset');
  if (basename(filename) !== filename) throw new Error('sourceFilename must be a filename, not a path');
  return filename;
}

function normalizeCfiRange(value: unknown): string {
  const cfiRange = requireText(value, 'cfiRange');
  if (!cfiRange.startsWith('epubcfi(') || !cfiRange.endsWith(')')) {
    throw new Error('cfiRange must be a valid EPUB CFI range');
  }
  return cfiRange;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
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

function compareHighlights(left: EpubHighlight, right: EpubHighlight): number {
  return left.chapterOrder - right.chapterOrder
    || left.chapterId.localeCompare(right.chapterId)
    || left.createdAt - right.createdAt
    || left.cfiRange.localeCompare(right.cfiRange);
}

function formatBlockquote(text: string): string {
  return text.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}
