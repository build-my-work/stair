import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, loadWorkspaceProjects } from '../../projects/index.ts';
import {
  createSession,
  getOrCreateLatestSession,
  getOrCreateSessionById,
  getSessionFilePath,
  listSessions,
} from '../../sessions/storage.ts';
import {
  createWorkspaceAtPath,
  isValidWorkspace,
  loadWorkspaceConfig,
} from '../storage.ts';

const tempDirs: string[] = [];

function createWorkspace(prefix: string): { rootPath: string; defaultProjectId: string } {
  const rootPath = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(rootPath);
  const config = createWorkspaceAtPath(rootPath, 'Workspace');
  return { rootPath, defaultProjectId: config.defaultProjectId };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace default Project', () => {
  it('creates exactly one real General Project and stores its id', () => {
    const { rootPath, defaultProjectId } = createWorkspace('stair-default-project-');
    const loaded = loadWorkspaceConfig(rootPath);
    const projects = loadWorkspaceProjects(rootPath);

    expect(defaultProjectId).toMatch(/^proj_/);
    expect(loaded?.defaultProjectId).toBe(defaultProjectId);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.config).toMatchObject({
      id: defaultProjectId,
      name: 'General',
      slug: 'general',
    });
  });

  it('assigns every direct storage constructor to the default Project', async () => {
    const { rootPath, defaultProjectId } = createWorkspace('stair-default-session-');

    const generated = await createSession(rootPath);
    const named = await getOrCreateSessionById(rootPath, 'explicit-session-id');

    expect(defaultProjectId).toMatch(/^proj_/);
    expect(generated.projectId).toBe(defaultProjectId);
    expect(named.projectId).toBe(defaultProjectId);
    expect(listSessions(rootPath).map(session => session.projectId)).toEqual([
      defaultProjectId,
      defaultProjectId,
    ]);
  });

  it('keeps an explicit Project when it belongs to the Workspace', async () => {
    const { rootPath } = createWorkspace('stair-explicit-project-');
    const project = createProject(rootPath, { name: 'Research' });

    const session = await createSession(rootPath, { projectId: project.id });

    expect(session.projectId).toBe(project.id);
  });

  it('rejects an explicit Project outside the Workspace before creating files', async () => {
    const { rootPath } = createWorkspace('stair-invalid-project-');

    await expect(createSession(rootPath, { projectId: 'proj_missing' }))
      .rejects.toThrow('Project proj_missing not found');
    expect(listSessions(rootPath)).toHaveLength(0);
  });

  it('does not treat the old Workspace shape as valid data', () => {
    const { rootPath } = createWorkspace('stair-old-workspace-');
    const configPath = join(rootPath, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    delete config.defaultProjectId;
    writeFileSync(configPath, JSON.stringify(config));

    expect(loadWorkspaceConfig(rootPath)).toBeNull();
    expect(isValidWorkspace(rootPath)).toBe(false);
  });

  it('ignores old Sessions without Project ownership and creates a fresh default-Project Session', async () => {
    const { rootPath, defaultProjectId } = createWorkspace('stair-old-session-');
    const oldSession = await createSession(rootPath);
    const sessionPath = getSessionFilePath(rootPath, oldSession.id);
    const lines = readFileSync(sessionPath, 'utf8').trimEnd().split('\n');
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    delete header.projectId;
    lines[0] = JSON.stringify(header);
    writeFileSync(sessionPath, `${lines.join('\n')}\n`);

    expect(listSessions(rootPath)).toEqual([]);

    const freshSession = await getOrCreateLatestSession(rootPath);
    expect(freshSession.id).not.toBe(oldSession.id);
    expect(freshSession.projectId).toBe(defaultProjectId);
  });
});
