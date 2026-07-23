import type { FileReference } from '@craft-agent/core/types';

/**
 * Project Types
 *
 * Projects are workspace-scoped collections that group sessions, working directory,
 * and shared context for a body of work. Modeled after Codex/Cowork Projects.
 *
 * File structure:
 * {workspaceRootPath}/projects/{projectSlug}/
 *   ├── config.json   - Project settings
 *   └── MEMORY.md     - Durable project knowledge
 */

/**
 * One Kanban column in a project's custom board layout.
 *
 * When a project defines `kanbanColumns`, that array is the *full ordered set*
 * of board columns for the single-project view. Each column carries a stable
 * `id` (reused as the persisted `kanbanColumn` placement value on sessions) and
 * a user-authored `name` (not translated, like the project name itself).
 */
export interface KanbanColumnDef {
  /** Stable slug, generated once and never reused after delete. The built-in seed reuses 'todo' | 'in-progress' | 'done' so existing placement survives the first customization. */
  id: string;
  /** User-facing label, shown verbatim (no i18n — user-authored). */
  name: string;
  /** Status auto-applied when a card is dropped here (per-project; replaces the global drop-status atom in project views). */
  dropStatusId?: string;
  /** Optional header accent (hex, e.g. "#6366f1"). */
  color?: string;
}

/**
 * Main project configuration (stored in config.json)
 */
export interface ProjectConfig {
  id: string;
  slug: string;
  name: string;
  /** Short description shown in lists/detail header */
  description?: string;
  /** Absolute path bound to this project; new sessions inherit it when not overridden */
  workingDirectory?: string;
  /** Free-form text injected into the system prompt as project context */
  details?: string;
  /** Optional color theme ID for project-branded UI */
  colorTheme?: string;
  /** Optional accent color (hex, e.g. "#6366f1") shown on bound sessions in the SessionList */
  color?: string;
  createdAt: number;
  updatedAt: number;
  /** Set when project is archived (hidden from sidebar but kept on disk) */
  archivedAt?: number;
  /** Per-project Kanban columns. Absent → the board uses the default 3 columns. */
  kanbanColumns?: KanbanColumnDef[];
}

/**
 * Project creation input (without auto-generated fields)
 */
export interface CreateProjectInput {
  name: string;
  description?: string;
  workingDirectory?: string;
  details?: string;
  colorTheme?: string;
  color?: string;
}

/**
 * Fully loaded project (config + folder paths)
 */
export interface LoadedProject {
  config: ProjectConfig;
  /** Absolute path to project folder */
  folderPath: string;
  /** Absolute path to workspace folder */
  workspaceRootPath: string;
  /** Workspace this project belongs to (derived from basename of workspaceRootPath) */
  workspaceId: string;
}

/**
 * Project context shape used for system-prompt injection.
 * Decoupled from ProjectConfig so prompt builders can be tested in isolation.
 */
export interface ProjectPromptContext {
  name: string;
  description?: string;
  details?: string;
  /** Absolute path to MEMORY.md, so the agent knows where to persist learnings. */
  memoryPath: string;
  /** MEMORY.md content, already capped by loadProjectMemory. */
  memoryContent?: string;
}

/** A versioned Markdown artifact persisted in Craft Project data. */
export interface Artifact {
  version: 1;
  id: string;
  projectId: string;
  sourceSessionId?: string;
  title: string;
  markdown: string;
  templateId?: string;
  references: FileReference[];
  createdAt: number;
  updatedAt: number;
}

export interface SaveProjectArtifactInput {
  id?: string;
  sourceSessionId?: string;
  title: string;
  markdown: string;
  templateId?: string;
  references: FileReference[];
}
