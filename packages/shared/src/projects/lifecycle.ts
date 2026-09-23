import { listSessions } from '../sessions/storage.ts';
import { loadWorkspaceConfig } from '../workspaces/storage.ts';
import {
  loadProject,
  removeProjectDirectory,
  withProjectMutationLock,
} from './storage.ts';
import type { ProjectConfig } from './types.ts';

/** Delete an empty, non-default Project without allowing Session ownership to dangle. */
export async function deleteProject(
  workspaceRootPath: string,
  projectSlug: string,
  beforeDelete?: (project: ProjectConfig) => Promise<void>,
): Promise<boolean> {
  const project = loadProject(workspaceRootPath, projectSlug);
  if (!project) return false;

  return withProjectMutationLock(workspaceRootPath, project.config.id, async () => {
    const current = loadProject(workspaceRootPath, projectSlug);
    if (!current) return false;

    const workspace = loadWorkspaceConfig(workspaceRootPath);
    if (!workspace) {
      throw new Error(`INVALID_WORKSPACE: ${workspaceRootPath}`);
    }
    if (current.config.id === workspace.defaultProjectId) {
      throw new Error('DEFAULT_PROJECT: the default Project cannot be deleted');
    }
    if (listSessions(workspaceRootPath).some(session => session.projectId === current.config.id)) {
      throw new Error('PROJECT_NOT_EMPTY: delete the Project Sessions first');
    }

    await beforeDelete?.(current.config);
    removeProjectDirectory(workspaceRootPath, projectSlug);
    return true;
  });
}
