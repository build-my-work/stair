import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, listSessions } from '../../sessions/storage.ts';
import { createWorkspaceAtPath } from '../../workspaces/storage.ts';
import {
  createProject,
  deleteProject,
  loadProject,
  loadProjectById,
} from '../index.ts';

const tempDirs: string[] = [];

function createWorkspace(prefix: string) {
  const rootPath = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(rootPath);
  const config = createWorkspaceAtPath(rootPath, 'Workspace');
  return { rootPath, config };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Project deletion lifecycle', () => {
  it('rejects deleting the default Project without mutating it', async () => {
    const { rootPath, config } = createWorkspace('stair-delete-default-');
    const project = loadProjectById(rootPath, config.defaultProjectId)!;

    await expect(deleteProject(rootPath, project.config.slug))
      .rejects.toThrow('DEFAULT_PROJECT');
    expect(loadProject(rootPath, project.config.slug)).not.toBeNull();
  });

  it('rejects deleting a Project that owns Sessions', async () => {
    const { rootPath } = createWorkspace('stair-delete-non-empty-');
    const project = createProject(rootPath, { name: 'Busy' });
    const session = await createSession(rootPath, { projectId: project.id });

    await expect(deleteProject(rootPath, project.slug))
      .rejects.toThrow('PROJECT_NOT_EMPTY');
    expect(loadProject(rootPath, project.slug)).not.toBeNull();
    expect(listSessions(rootPath).some(item => item.id === session.id)).toBe(true);
  });

  it('deletes an empty non-default Project', async () => {
    const { rootPath } = createWorkspace('stair-delete-empty-');
    const project = createProject(rootPath, { name: 'Disposable' });

    await deleteProject(rootPath, project.slug);

    expect(loadProject(rootPath, project.slug)).toBeNull();
  });

  it('serializes Session creation against Project deletion', async () => {
    const { rootPath } = createWorkspace('stair-project-race-');
    const project = createProject(rootPath, { name: 'Contended' });

    const [creation, deletion] = await Promise.allSettled([
      createSession(rootPath, { projectId: project.id }),
      deleteProject(rootPath, project.slug),
    ]);

    const projectStillExists = loadProject(rootPath, project.slug) !== null;
    const projectSessions = listSessions(rootPath)
      .filter(session => session.projectId === project.id);

    if (creation.status === 'fulfilled') {
      expect(deletion.status).toBe('rejected');
      expect(projectStillExists).toBe(true);
      expect(projectSessions).toHaveLength(1);
    } else {
      expect(deletion.status).toBe('fulfilled');
      expect(projectStillExists).toBe(false);
      expect(projectSessions).toHaveLength(0);
    }
  });
});
