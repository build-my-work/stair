import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { createProject } from '../storage.ts';
import {
  deleteProjectArtifact,
  getProjectArtifact,
  getProjectArtifactPath,
  getProjectArtifactsPath,
  listProjectArtifacts,
  saveProjectArtifact,
} from '../artifacts.ts';

let tempDir: string;
let workspaceRoot: string;
let projectSlug: string;
let projectId: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'project-artifacts-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  const project = createProject(workspaceRoot, { name: 'Operating Systems' });
  projectSlug = project.slug;
  projectId = project.id;
});

afterEach(() => {
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('project artifacts', () => {
  it('creates, lists, reads, and atomically updates a Markdown artifact', () => {
    const created = saveProjectArtifact(workspaceRoot, projectSlug, {
      title: 'Virtual memory notes',
      markdown: '# Virtual memory\n\nPaging isolates address spaces.',
      sourceSessionId: 'session-main',
      references: [{
        projectId,
        path: '操作系统导论（异步图书） .epub',
        quote: 'The address space is an abstraction.',
        locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:4)' },
      }],
    });

    expect(created.version).toBe(1);
    expect(created.id).toMatch(/^artifact_[a-z0-9-]+$/);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(getProjectArtifact(workspaceRoot, projectSlug, created.id)).toEqual(created);
    expect(listProjectArtifacts(workspaceRoot, projectSlug)).toEqual([created]);

    const updated = saveProjectArtifact(workspaceRoot, projectSlug, {
      id: created.id,
      title: 'Virtual memory notes — revised',
      markdown: `${created.markdown}\n\n## TLB`,
      references: created.references,
    });

    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    expect(updated.sourceSessionId).toBe(created.sourceSessionId);
    expect(readFileSync(getProjectArtifactPath(workspaceRoot, projectSlug, created.id), 'utf8'))
      .toContain('Virtual memory notes — revised');
    expect(existsSync(`${getProjectArtifactPath(workspaceRoot, projectSlug, created.id)}.tmp`)).toBe(false);
  });

  it('keeps persisted file references project-relative and validates locators', () => {
    const base = {
      title: 'References',
      markdown: '# References',
      references: [],
    };

    expect(() => saveProjectArtifact(workspaceRoot, projectSlug, {
      ...base,
      references: [{
        projectId,
        path: '../secret.epub',
        locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/2)' },
      }],
    })).toThrow(/relative|traversal/i);

    expect(() => saveProjectArtifact(workspaceRoot, projectSlug, {
      ...base,
      references: [{
        projectId: 'another-project',
        path: 'book.pdf',
        locator: { type: 'pdf-page', page: 1 },
      }],
    })).toThrow(/project/i);

    expect(() => saveProjectArtifact(workspaceRoot, projectSlug, {
      ...base,
      references: [{
        projectId,
        path: 'notes.md',
        locator: { type: 'text-range', startLine: 9, endLine: 2 },
      }],
    })).toThrow(/line/i);
  });

  it('rejects caller-controlled paths and deletes only the selected artifact', () => {
    const first = saveProjectArtifact(workspaceRoot, projectSlug, {
      title: 'First', markdown: '# First', references: [],
    });
    const second = saveProjectArtifact(workspaceRoot, projectSlug, {
      title: 'Second', markdown: '# Second', references: [],
    });

    expect(isAbsolute(first.id)).toBe(false);
    expect(() => getProjectArtifact(workspaceRoot, projectSlug, '../config')).toThrow(/artifact id/i);

    deleteProjectArtifact(workspaceRoot, projectSlug, first.id);

    expect(getProjectArtifact(workspaceRoot, projectSlug, first.id)).toBeNull();
    expect(getProjectArtifact(workspaceRoot, projectSlug, second.id)).toEqual(second);
  });

  it('refuses to write through a symlinked Artifact directory', () => {
    const outsideDirectory = join(tempDir, 'outside-artifacts');
    mkdirSync(outsideDirectory);
    symlinkSync(outsideDirectory, getProjectArtifactsPath(workspaceRoot, projectSlug), 'dir');

    expect(() => saveProjectArtifact(workspaceRoot, projectSlug, {
      title: 'Escaping note',
      markdown: '# Must stay inside the Project',
      references: [],
    })).toThrow(/symbolic link|storage directory/i);
    expect(readFileSync(join(workspaceRoot, 'projects', projectSlug, 'config.json'), 'utf8'))
      .toContain(projectId);
    expect(existsSync(join(outsideDirectory, 'artifact.json'))).toBe(false);
  });

  it('does not follow a pre-created predictable temporary-file symlink', () => {
    const artifactId = 'artifact_12345678';
    const artifactPath = getProjectArtifactPath(workspaceRoot, projectSlug, artifactId);
    const outsideFile = join(tempDir, 'outside.txt');
    mkdirSync(getProjectArtifactsPath(workspaceRoot, projectSlug));
    writeFileSync(outsideFile, 'sentinel');
    symlinkSync(outsideFile, `${artifactPath}.tmp`);

    const saved = saveProjectArtifact(workspaceRoot, projectSlug, {
      id: artifactId,
      title: 'Safe note',
      markdown: '# Safe',
      references: [],
    });

    expect(saved.id).toBe(artifactId);
    expect(readFileSync(outsideFile, 'utf8')).toBe('sentinel');
    expect(getProjectArtifact(workspaceRoot, projectSlug, artifactId)?.title).toBe('Safe note');
  });

  it('rejects mismatched identities and oversized persisted files before parsing', () => {
    const firstId = 'artifact_aaaaaaaa';
    const secondId = 'artifact_bbbbbbbb';
    const created = saveProjectArtifact(workspaceRoot, projectSlug, {
      id: firstId,
      title: 'Identity',
      markdown: '# Identity',
      references: [],
    });
    const path = getProjectArtifactPath(workspaceRoot, projectSlug, firstId);
    writeFileSync(path, JSON.stringify({ ...created, id: secondId }));
    expect(() => getProjectArtifact(workspaceRoot, projectSlug, firstId)).toThrow(/filename/i);

    writeFileSync(path, '{}');
    truncateSync(path, 17 * 1024 * 1024);
    expect(() => getProjectArtifact(workspaceRoot, projectSlug, firstId)).toThrow(/too large/i);
  });
});
