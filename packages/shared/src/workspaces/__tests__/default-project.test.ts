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
  loadSession,
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

  it('isolates persisted Sessions with nonexistent or cross-Workspace Project ownership', async () => {
    const { rootPath } = createWorkspace('stair-invalid-persisted-project-');
    const otherWorkspace = createWorkspace('stair-other-project-');
    const otherProject = createProject(otherWorkspace.rootPath, { name: 'Other' });
    const invalidProjectIds = ['proj_missing', otherProject.id];

    for (const projectId of invalidProjectIds) {
      const session = await createSession(rootPath);
      const sessionPath = getSessionFilePath(rootPath, session.id);
      const lines = readFileSync(sessionPath, 'utf8').trimEnd().split('\n');
      const header = JSON.parse(lines[0]!) as Record<string, unknown>;
      header.projectId = projectId;
      lines[0] = JSON.stringify(header);
      writeFileSync(sessionPath, `${lines.join('\n')}\n`);

      expect(loadSession(rootPath, session.id)).toBeNull();
    }

    expect(listSessions(rootPath)).toEqual([]);
  });

  it('backfills a real General Project for the old Workspace shape', () => {
    const { rootPath } = createWorkspace('stair-old-workspace-');
    const configPath = join(rootPath, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    delete config.defaultProjectId;
    writeFileSync(configPath, JSON.stringify(config));
    rmSync(join(rootPath, 'projects'), { recursive: true, force: true });

    const loaded = loadWorkspaceConfig(rootPath);
    const projects = loadWorkspaceProjects(rootPath);

    expect(loaded?.defaultProjectId).toMatch(/^proj_/);
    expect(isValidWorkspace(rootPath)).toBe(true);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.config).toMatchObject({
      id: loaded?.defaultProjectId,
      name: 'General',
      slug: 'general',
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8')).defaultProjectId)
      .toBe(loaded?.defaultProjectId);
  });

  it('loads old Sessions under the default Project instead of hiding or replacing them', async () => {
    const { rootPath, defaultProjectId } = createWorkspace('stair-old-session-');
    const oldSession = await createSession(rootPath);
    const sessionPath = getSessionFilePath(rootPath, oldSession.id);
    const lines = readFileSync(sessionPath, 'utf8').trimEnd().split('\n');
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    delete header.projectId;
    lines[0] = JSON.stringify(header);
    writeFileSync(sessionPath, `${lines.join('\n')}\n`);

    expect(listSessions(rootPath)).toEqual([
      expect.objectContaining({ id: oldSession.id, projectId: defaultProjectId }),
    ]);
    expect(loadSession(rootPath, oldSession.id)?.projectId).toBe(defaultProjectId);

    const latestSession = await getOrCreateLatestSession(rootPath);
    expect(latestSession.id).toBe(oldSession.id);
    expect(latestSession.projectId).toBe(defaultProjectId);
    expect(listSessions(rootPath)).toHaveLength(1);
  });
});
