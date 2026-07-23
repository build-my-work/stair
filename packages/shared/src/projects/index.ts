/**
 * Projects Module
 *
 * Public exports for project management.
 */

export type {
  ProjectConfig,
  CreateProjectInput,
  LoadedProject,
  ProjectPromptContext,
  Artifact,
  SaveProjectArtifactInput,
} from './types.ts';

export {
  // Path utilities
  ensureProjectsDir,
  getWorkspaceProjectsPath,
  getProjectPath,
  getProjectMemoryPath,
  MEMORY_FILENAME,
  // Config operations
  loadProjectConfig,
  saveProjectConfig,
  // Memory operations
  loadProjectMemory,
  // Load operations
  loadProject,
  loadProjectById,
  loadWorkspaceProjects,
  // Create/update/delete
  generateProjectSlug,
  createProject,
  updateProject,
  deleteProject,
  projectExists,
} from './storage.ts';

export {
  deleteProjectWorkingFileEpubHighlight,
  exportProjectWorkingFileEpubHighlights,
  getProjectHighlightsPath,
  HIGHLIGHTS_FILENAME,
  listProjectWorkingFileEpubHighlights,
  saveProjectWorkingFileEpubHighlight,
} from './highlights.ts';
export type { EpubHighlightsExport } from './highlights.ts';

export {
  ARTIFACTS_DIRECTORY,
  deleteProjectArtifact,
  getProjectArtifact,
  getProjectArtifactPath,
  getProjectArtifactsPath,
  listProjectArtifacts,
  saveProjectArtifact,
} from './artifacts.ts';
