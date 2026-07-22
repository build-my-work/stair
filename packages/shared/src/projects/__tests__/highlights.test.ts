import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { EpubHighlightInput } from '../../learning/types.ts';
import { createProject } from '../storage.ts';
import {
  deleteProjectEpubHighlight,
  deleteProjectEpubHighlightsForSource,
  exportProjectEpubHighlights,
  getProjectHighlightsPath,
  listProjectEpubHighlights,
  saveProjectEpubHighlight,
} from '../highlights.ts';

let tempDir: string;
let workspaceRoot: string;
let projectSlug: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'epub-highlights-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  projectSlug = createProject(workspaceRoot, { name: 'Reading' }).slug;
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function input(overrides: Partial<EpubHighlightInput> = {}): EpubHighlightInput {
  return {
    sourceFilename: 'book.epub',
    cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:4)',
    text: 'A useful passage.',
    chapterId: 'chapter-1',
    chapterTitle: 'Chapter One',
    chapterOrder: 0,
    spineIndex: 1,
    ...overrides,
  };
}

describe('EPUB highlight storage', () => {
  it('returns an empty list before the first highlight is saved', () => {
    expect(listProjectEpubHighlights(workspaceRoot, projectSlug, 'book.epub')).toEqual([]);
  });

  it('persists highlights with a server creation time using an atomic JSON file', () => {
    const saved = saveProjectEpubHighlight(workspaceRoot, projectSlug, input());

    expect(saved.createdAt).toBeGreaterThan(0);
    expect(listProjectEpubHighlights(workspaceRoot, projectSlug, 'book.epub')).toEqual([saved]);
    expect(JSON.parse(readFileSync(getProjectHighlightsPath(workspaceRoot, projectSlug), 'utf8'))).toEqual([saved]);
    expect(existsSync(`${getProjectHighlightsPath(workspaceRoot, projectSlug)}.tmp`)).toBe(false);
  });

  it('upserts the same source and CFI while preserving its creation time', () => {
    const first = saveProjectEpubHighlight(workspaceRoot, projectSlug, input());
    const updated = saveProjectEpubHighlight(workspaceRoot, projectSlug, input({ text: 'Updated text.' }));

    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.text).toBe('Updated text.');
    expect(listProjectEpubHighlights(workspaceRoot, projectSlug, 'book.epub')).toEqual([updated]);
  });

  it('keeps books separate and deletes only the requested highlight', () => {
    saveProjectEpubHighlight(workspaceRoot, projectSlug, input());
    saveProjectEpubHighlight(workspaceRoot, projectSlug, input({
      sourceFilename: 'other.epub',
      cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
    }));

    deleteProjectEpubHighlight(
      workspaceRoot,
      projectSlug,
      'book.epub',
      'epubcfi(/6/2!/4/2,/1:0,/1:4)',
    );

    expect(listProjectEpubHighlights(workspaceRoot, projectSlug, 'book.epub')).toEqual([]);
    expect(listProjectEpubHighlights(workspaceRoot, projectSlug, 'other.epub')).toHaveLength(1);
  });

  it('clears every highlight belonging to a deleted EPUB asset', () => {
    saveProjectEpubHighlight(workspaceRoot, projectSlug, input());
    saveProjectEpubHighlight(workspaceRoot, projectSlug, input({
      cfiRange: 'epubcfi(/6/2!/4/2,/1:5,/1:9)',
    }));
    saveProjectEpubHighlight(workspaceRoot, projectSlug, input({
      sourceFilename: 'other.epub',
      cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
    }));

    deleteProjectEpubHighlightsForSource(workspaceRoot, projectSlug, 'book.epub');

    expect(listProjectEpubHighlights(workspaceRoot, projectSlug, 'book.epub')).toEqual([]);
    expect(listProjectEpubHighlights(workspaceRoot, projectSlug, 'other.epub')).toHaveLength(1);
  });

  it('rejects malformed input before writing', () => {
    expect(() => saveProjectEpubHighlight(workspaceRoot, projectSlug, input({ cfiRange: 'not-a-cfi' })))
      .toThrow('valid EPUB CFI');
    expect(() => saveProjectEpubHighlight(workspaceRoot, projectSlug, input({ chapterOrder: -1 })))
      .toThrow('non-negative integer');
    expect(existsSync(getProjectHighlightsPath(workspaceRoot, projectSlug))).toBe(false);
  });
});

describe('EPUB highlight Markdown export', () => {
  it('groups highlights by chapter order and preserves multiline quotes', () => {
    saveProjectEpubHighlight(workspaceRoot, projectSlug, input({
      cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
      text: 'Later chapter',
      chapterId: 'chapter-2',
      chapterTitle: 'Chapter Two',
      chapterOrder: 1,
      spineIndex: 2,
    }));
    saveProjectEpubHighlight(workspaceRoot, projectSlug, input({ text: 'First line\nSecond line' }));

    const result = exportProjectEpubHighlights(workspaceRoot, projectSlug, 'book.epub');

    expect(result.filename).toBe('book-highlights.md');
    expect(result.markdown).toBe([
      '# book Highlights',
      '',
      '## Chapter One',
      '',
      '> First line',
      '> Second line',
      '',
      '## Chapter Two',
      '',
      '> Later chapter',
      '',
    ].join('\n'));
  });
});
