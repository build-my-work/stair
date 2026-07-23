import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import type { FileReference } from '@craft-agent/core/types';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import {
  getProjectPath,
  getWorkspaceProjectsPath,
  loadProjectConfig,
} from './storage.ts';
import type { Artifact, SaveProjectArtifactInput } from './types.ts';

export const ARTIFACTS_DIRECTORY = 'artifacts';
const ARTIFACT_ID_PATTERN = /^artifact_[a-z0-9-]{8,80}$/;
const MAX_TITLE_LENGTH = 300;
const MAX_MARKDOWN_LENGTH = 10 * 1024 * 1024;
const MAX_REFERENCES = 1_000;
const MAX_QUOTE_LENGTH = 256 * 1024;
const MAX_TOTAL_QUOTE_LENGTH = 2 * 1024 * 1024;
const MAX_REFERENCE_PATH_LENGTH = 4_096;
const MAX_CFI_LENGTH = 32 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 16 * 1024 * 1024;

export function getProjectArtifactsPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getProjectPath(workspaceRootPath, projectSlug), ARTIFACTS_DIRECTORY);
}

export function getProjectArtifactPath(
  workspaceRootPath: string,
  projectSlug: string,
  artifactId: string,
): string {
  const id = validateArtifactId(artifactId);
  return join(getProjectArtifactsPath(workspaceRootPath, projectSlug), `${id}.json`);
}

export function listProjectArtifacts(workspaceRootPath: string, projectSlug: string): Artifact[] {
  const projectId = projectIdFor(workspaceRootPath, projectSlug);
  const directory = getProjectArtifactsPath(workspaceRootPath, projectSlug);
  if (!existsSync(directory)) return [];
  assertSafeArtifactsDirectory(workspaceRootPath, projectSlug, false);

  const artifacts: Artifact[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const artifactId = entry.name.slice(0, -'.json'.length);
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) continue;
    artifacts.push(readArtifactFile(join(directory, entry.name), projectId, artifactId));
  }
  return artifacts.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
}

export function getProjectArtifact(
  workspaceRootPath: string,
  projectSlug: string,
  artifactId: string,
): Artifact | null {
  const projectId = projectIdFor(workspaceRootPath, projectSlug);
  const path = getProjectArtifactPath(workspaceRootPath, projectSlug, artifactId);
  if (!existsSync(path)) return null;
  assertSafeArtifactsDirectory(workspaceRootPath, projectSlug, false);
  return readArtifactFile(path, projectId, validateArtifactId(artifactId));
}

export function saveProjectArtifact(
  workspaceRootPath: string,
  projectSlug: string,
  input: SaveProjectArtifactInput,
): Artifact {
  const projectId = projectIdFor(workspaceRootPath, projectSlug);
  const id = input.id ? validateArtifactId(input.id) : `artifact_${randomUUID()}`;
  const existing = input.id ? getProjectArtifact(workspaceRootPath, projectSlug, id) : null;
  const sourceSessionId = resolveOptionalIdentifier(
    input.sourceSessionId,
    existing?.sourceSessionId,
    'sourceSessionId',
  );
  const templateId = resolveOptionalIdentifier(input.templateId, existing?.templateId, 'templateId');
  const now = Date.now();
  const artifact: Artifact = {
    version: 1,
    id,
    projectId,
    ...(sourceSessionId ? { sourceSessionId } : {}),
    title: validateText(input.title, 'title', MAX_TITLE_LENGTH),
    markdown: validateMarkdown(input.markdown),
    ...(templateId ? { templateId } : {}),
    references: validateReferences(input.references, projectId),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  assertSafeArtifactsDirectory(workspaceRootPath, projectSlug, true);
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ARTIFACT_FILE_BYTES) {
    throw new Error('Artifact is too large');
  }
  atomicWriteFileSync(getProjectArtifactPath(workspaceRootPath, projectSlug, id), serialized);
  return artifact;
}

export function deleteProjectArtifact(
  workspaceRootPath: string,
  projectSlug: string,
  artifactId: string,
): void {
  assertProject(workspaceRootPath, projectSlug);
  const path = getProjectArtifactPath(workspaceRootPath, projectSlug, artifactId);
  if (existsSync(path)) {
    assertSafeArtifactsDirectory(workspaceRootPath, projectSlug, false);
    unlinkSync(path);
  }
}

function readArtifactFile(path: string, expectedProjectId: string, expectedArtifactId: string): Artifact {
  const file = lstatSync(path);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error(`Invalid artifact file: ${basename(path)}`);
  }
  if (statSync(path).size > MAX_ARTIFACT_FILE_BYTES) {
    throw new Error(`Artifact file is too large: ${basename(path)}`);
  }
  const value = readJsonFileSync<unknown>(path);
  if (!value || typeof value !== 'object') throw new Error(`Invalid artifact file: ${basename(path)}`);
  const record = value as Partial<Artifact>;
  const id = validateArtifactId(record.id);
  if (id !== expectedArtifactId) throw new Error('Artifact id does not match its storage filename');
  if (record.version !== 1) throw new Error(`Unsupported artifact version: ${String(record.version)}`);
  if (record.projectId !== expectedProjectId) throw new Error('Artifact project does not match its storage project');
  if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) {
    throw new Error(`Invalid artifact timestamps: ${id}`);
  }
  return {
    version: 1,
    id,
    projectId: expectedProjectId,
    ...(record.sourceSessionId ? { sourceSessionId: validateOptionalIdentifier(record.sourceSessionId, 'sourceSessionId') } : {}),
    title: validateText(record.title, 'title', MAX_TITLE_LENGTH),
    markdown: validateMarkdown(record.markdown),
    ...(record.templateId ? { templateId: validateOptionalIdentifier(record.templateId, 'templateId') } : {}),
    references: validateReferences(record.references, expectedProjectId),
    createdAt: record.createdAt!,
    updatedAt: record.updatedAt!,
  };
}

function projectIdFor(workspaceRootPath: string, projectSlug: string): string {
  const config = loadProjectConfig(workspaceRootPath, projectSlug);
  if (!config) throw new Error(`Project not found: ${projectSlug}`);
  return config.id;
}

function assertSafeArtifactsDirectory(
  workspaceRootPath: string,
  projectSlug: string,
  create: boolean,
): string {
  const projectsDirectory = getWorkspaceProjectsPath(workspaceRootPath);
  const projectDirectory = getProjectPath(workspaceRootPath, projectSlug);
  const artifactsDirectory = getProjectArtifactsPath(workspaceRootPath, projectSlug);
  const lexicalProject = resolve(projectDirectory);
  const lexicalRelative = relative(resolve(projectsDirectory), lexicalProject);
  if (!lexicalRelative || lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    throw new Error('Invalid Project storage directory');
  }

  for (const [path, label] of [
    [projectsDirectory, 'Projects'],
    [projectDirectory, 'Project'],
  ] as const) {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`${label} storage directory must not be a symbolic link`);
    }
  }

  if (create) mkdirSync(artifactsDirectory, { recursive: true });
  const artifactEntry = lstatSync(artifactsDirectory);
  if (artifactEntry.isSymbolicLink() || !artifactEntry.isDirectory()) {
    throw new Error('Artifact storage directory must not be a symbolic link');
  }

  const realProject = realpathSync(projectDirectory);
  const realArtifacts = realpathSync(artifactsDirectory);
  const canonicalRelative = relative(realProject, realArtifacts);
  if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) {
    throw new Error('Artifact storage directory escapes the Project');
  }
  return artifactsDirectory;
}

function assertProject(workspaceRootPath: string, projectSlug: string): void {
  projectIdFor(workspaceRootPath, projectSlug);
}

function validateArtifactId(value: unknown): string {
  if (typeof value !== 'string' || !ARTIFACT_ID_PATTERN.test(value)) {
    throw new Error('Invalid artifact id');
  }
  return value;
}

function validateText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`${field} is too long`);
  return value.trim();
}

function validateMarkdown(value: unknown): string {
  if (typeof value !== 'string') throw new Error('markdown must be a string');
  if (value.length > MAX_MARKDOWN_LENGTH) throw new Error('markdown is too large');
  return value;
}

function validateOptionalIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value.trim();
}

function resolveOptionalIdentifier(
  value: unknown,
  existingValue: string | undefined,
  field: string,
): string | undefined {
  return value === undefined ? existingValue : validateOptionalIdentifier(value, field);
}

function validateReferences(value: unknown, expectedProjectId: string): FileReference[] {
  if (!Array.isArray(value)) throw new Error('references must be an array');
  if (value.length > MAX_REFERENCES) throw new Error('Too many artifact references');
  let totalQuoteLength = 0;
  return value.map((reference, index) => {
    const validated = validateReference(reference, expectedProjectId, index);
    totalQuoteLength += validated.quote?.length ?? 0;
    if (totalQuoteLength > MAX_TOTAL_QUOTE_LENGTH) {
      throw new Error('Artifact reference quotes are too large');
    }
    return validated;
  });
}

function validateReference(value: unknown, expectedProjectId: string, index: number): FileReference {
  if (!value || typeof value !== 'object') throw new Error(`Invalid reference at index ${index}`);
  const reference = value as Partial<FileReference>;
  if (reference.projectId !== expectedProjectId) throw new Error(`Reference project mismatch at index ${index}`);
  const path = validateProjectRelativePath(reference.path);
  const quote = reference.quote;
  if (quote !== undefined && (typeof quote !== 'string' || quote.length > MAX_QUOTE_LENGTH)) {
    throw new Error(`Invalid reference quote at index ${index}`);
  }
  const locator = validateLocator(reference.locator, index);
  return { projectId: expectedProjectId, path, ...(quote !== undefined ? { quote } : {}), locator };
}

function validateProjectRelativePath(value: unknown): string {
  if (
    typeof value !== 'string'
    || !value
    || value.length > MAX_REFERENCE_PATH_LENGTH
    || value.includes('\0')
  ) {
    throw new Error('Reference path must be a non-empty project-relative path');
  }
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
    throw new Error('Reference path must be project-relative');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Reference path traversal is not allowed');
  }
  return segments.join('/');
}

function validateLocator(value: unknown, index: number): FileReference['locator'] {
  if (!value || typeof value !== 'object') throw new Error(`Invalid reference locator at index ${index}`);
  const locator = value as FileReference['locator'];
  if (locator.type === 'epub-cfi') {
    if (
      typeof locator.cfiRange !== 'string'
      || locator.cfiRange.length > MAX_CFI_LENGTH
      || !locator.cfiRange.startsWith('epubcfi(')
      || !locator.cfiRange.endsWith(')')
    ) {
      throw new Error(`Invalid EPUB CFI locator at index ${index}`);
    }
    return { type: 'epub-cfi', cfiRange: locator.cfiRange };
  }
  if (locator.type === 'pdf-page') {
    if (!Number.isInteger(locator.page) || locator.page < 1) throw new Error(`Invalid PDF page locator at index ${index}`);
    return { type: 'pdf-page', page: locator.page };
  }
  if (locator.type === 'text-range') {
    if (!Number.isInteger(locator.startLine) || !Number.isInteger(locator.endLine)
      || locator.startLine < 1 || locator.endLine < locator.startLine) {
      throw new Error(`Invalid text line locator at index ${index}`);
    }
    return { type: 'text-range', startLine: locator.startLine, endLine: locator.endLine };
  }
  throw new Error(`Unsupported reference locator at index ${index}`);
}
