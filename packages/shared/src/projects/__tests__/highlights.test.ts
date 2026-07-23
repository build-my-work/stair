import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { WorkingFileEpubHighlightInput } from '../../learning/types.ts';
import { createProject } from '../storage.ts';
import {
  deleteProjectWorkingFileEpubHighlight,
  exportProjectWorkingFileEpubHighlights,
  getProjectHighlightsPath,
  listProjectWorkingFileEpubHighlights,
  saveProjectWorkingFileEpubHighlight,
} from '../highlights.ts';

let tempDir: string;
let workspaceRoot: string;
let projectSlug: string;
const FINGERPRINT_V1 = `sha256:${'a'.repeat(64)}`;
const FINGERPRINT_V2 = `sha256:${'b'.repeat(64)}`;
const FINGERPRINT_ARCHIVE = `sha256:${'c'.repeat(64)}`;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'epub-highlights-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  projectSlug = createProject(workspaceRoot, { name: 'Reading' }).slug;
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function input(
  overrides: Partial<WorkingFileEpubHighlightInput> = {},
): WorkingFileEpubHighlightInput {
  return {
    sourcePath: 'books/operating-systems.epub',
    sourceFingerprint: FINGERPRINT_V1,
    cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:4)',
    text: 'A useful passage.',
    chapterId: 'chapter-1',
    chapterTitle: 'Chapter One',
    chapterOrder: 0,
    spineIndex: 1,
    ...overrides,
  };
}

describe('working-file EPUB highlight storage', () => {
  it('persists highlights atomically and upserts while preserving creation time', () => {
    const first = saveProjectWorkingFileEpubHighlight(workspaceRoot, projectSlug, input());
    const updated = saveProjectWorkingFileEpubHighlight(
      workspaceRoot,
      projectSlug,
      input({ text: 'Updated text.' }),
    );

    expect(updated.createdAt).toBe(first.createdAt);
    expect(listProjectWorkingFileEpubHighlights(
      workspaceRoot,
      projectSlug,
      input().sourcePath,
      FINGERPRINT_V1,
    )).toEqual([updated]);
    expect(JSON.parse(readFileSync(getProjectHighlightsPath(workspaceRoot, projectSlug), 'utf8')))
      .toEqual([updated]);
    expect(existsSync(`${getProjectHighlightsPath(workspaceRoot, projectSlug)}.tmp`)).toBe(false);
  });

  it('keeps duplicate basenames in different folders strictly separate', () => {
    const first = saveProjectWorkingFileEpubHighlight(workspaceRoot, projectSlug, input());
    saveProjectWorkingFileEpubHighlight(
      workspaceRoot,
      projectSlug,
      input({
        sourcePath: 'archive/operating-systems.epub',
        sourceFingerprint: FINGERPRINT_ARCHIVE,
      }),
    );

    expect(listProjectWorkingFileEpubHighlights(
      workspaceRoot,
      projectSlug,
      'books/operating-systems.epub',
      FINGERPRINT_V1,
    )).toEqual([first]);
  });

  it('uses the fingerprint to isolate highlights after a file is replaced in place', () => {
    saveProjectWorkingFileEpubHighlight(workspaceRoot, projectSlug, input());
    const current = saveProjectWorkingFileEpubHighlight(
      workspaceRoot,
      projectSlug,
      input({ sourceFingerprint: FINGERPRINT_V2, text: 'New edition.' }),
    );

    expect(listProjectWorkingFileEpubHighlights(
      workspaceRoot,
      projectSlug,
      input().sourcePath,
      FINGERPRINT_V2,
    )).toEqual([current]);
  });

  it('deletes only the exact path, fingerprint, and CFI', () => {
    saveProjectWorkingFileEpubHighlight(workspaceRoot, projectSlug, input());
    saveProjectWorkingFileEpubHighlight(
      workspaceRoot,
      projectSlug,
      input({ sourceFingerprint: FINGERPRINT_V2, text: 'Second edition.' }),
    );

    deleteProjectWorkingFileEpubHighlight(
      workspaceRoot,
      projectSlug,
      input().sourcePath,
      FINGERPRINT_V1,
      input().cfiRange,
    );

    expect(listProjectWorkingFileEpubHighlights(
      workspaceRoot,
      projectSlug,
      input().sourcePath,
      FINGERPRINT_V1,
    )).toEqual([]);
    expect(listProjectWorkingFileEpubHighlights(
      workspaceRoot,
      projectSlug,
      input().sourcePath,
      FINGERPRINT_V2,
    )).toHaveLength(1);
  });

  it('rejects legacy asset records instead of treating them as working files', () => {
    const path = getProjectHighlightsPath(workspaceRoot, projectSlug);
    writeFileSync(path, `${JSON.stringify([{
      sourceFilename: 'book.epub',
      cfiRange: input().cfiRange,
      text: input().text,
      chapterId: input().chapterId,
      chapterTitle: input().chapterTitle,
      chapterOrder: 0,
      spineIndex: 1,
      createdAt: 123,
    }], null, 2)}\n`);

    expect(() => listProjectWorkingFileEpubHighlights(
      workspaceRoot,
      projectSlug,
      input().sourcePath,
      FINGERPRINT_V1,
    )).toThrow('sourcePath');
  });

  it('rejects malformed input and oversized persisted files', () => {
    expect(() => saveProjectWorkingFileEpubHighlight(
      workspaceRoot,
      projectSlug,
      input({ sourcePath: '../operating-systems.epub' }),
    )).toThrow('relative');
    expect(() => saveProjectWorkingFileEpubHighlight(
      workspaceRoot,
      projectSlug,
      input({ cfiRange: 'not-a-cfi' }),
    )).toThrow('valid EPUB CFI');

    const path = getProjectHighlightsPath(workspaceRoot, projectSlug);
    writeFileSync(path, '[]');
    truncateSync(path, 21 * 1024 * 1024);
    expect(() => listProjectWorkingFileEpubHighlights(
      workspaceRoot,
      projectSlug,
      input().sourcePath,
      FINGERPRINT_V1,
    )).toThrow(/too large/i);
  });
});

describe('working-file EPUB highlight Markdown export', () => {
  it('groups highlights by chapter and preserves multiline quotes', () => {
    saveProjectWorkingFileEpubHighlight(
      workspaceRoot,
      projectSlug,
      input({
        cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
        text: 'Later chapter',
        chapterId: 'chapter-2',
        chapterTitle: 'Chapter Two',
        chapterOrder: 1,
        spineIndex: 2,
      }),
    );
    saveProjectWorkingFileEpubHighlight(
      workspaceRoot,
      projectSlug,
      input({ text: 'First line\nSecond line' }),
    );

    const result = exportProjectWorkingFileEpubHighlights(
      workspaceRoot,
      projectSlug,
      input().sourcePath,
      FINGERPRINT_V1,
    );

    expect(result.filename).toBe('operating-systems-highlights.md');
    expect(result.markdown).toContain('> First line\n> Second line');
    expect(result.markdown).toContain('## Chapter Two\n\n> Later chapter');
  });
});
