import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadProjectById } from '@craft-agent/shared/projects'

import type { ISessionManager } from '../handlers/session-manager-interface'

interface WorkspaceRoot {
  rootPath: string
}

interface LoadedProjectRoot {
  config: {
    id: string
    slug: string
    workingDirectory?: string
  }
}

export interface SessionProjectWorkingDirectory {
  workspaceId: string
  workspaceRootPath: string
  projectId: string
  projectSlug: string
  workingDirectory: string
}

export type SessionProject = Omit<SessionProjectWorkingDirectory, 'workingDirectory'>

interface ResolvedSessionProjectContext {
  workspaceId: string
  workspaceRootPath: string
  project: LoadedProjectRoot
}

export function assertRequestingWorkspace(
  requestingWorkspaceId: string | null,
  sessionWorkspaceId: string,
): void {
  if (!requestingWorkspaceId) throw new Error('Workspace context is required')
  if (requestingWorkspaceId !== sessionWorkspaceId) {
    throw new Error('Session does not belong to the requesting workspace')
  }
}

export async function resolveSessionProject(
  sessionManager: Pick<ISessionManager, 'getSession'>,
  sessionId: string,
  resolveWorkspace: (workspaceId: string) => WorkspaceRoot | null | undefined = getWorkspaceByNameOrId,
  resolveProject: (workspaceRootPath: string, projectId: string) => LoadedProjectRoot | null = loadProjectById,
): Promise<SessionProject> {
  const context = await resolveSessionProjectContext(
    sessionManager,
    sessionId,
    resolveWorkspace,
    resolveProject,
  )
  return toSessionProject(context)
}

async function resolveSessionProjectContext(
  sessionManager: Pick<ISessionManager, 'getSession'>,
  sessionId: string,
  resolveWorkspace: (workspaceId: string) => WorkspaceRoot | null | undefined,
  resolveProject: (workspaceRootPath: string, projectId: string) => LoadedProjectRoot | null,
): Promise<ResolvedSessionProjectContext> {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Session id is required')
  const session = await sessionManager.getSession(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  if (!session.projectId) throw new Error(`Session ${sessionId} is not bound to a Project`)

  const workspace = resolveWorkspace(session.workspaceId)
  if (!workspace) throw new Error(`Workspace not found: ${session.workspaceId}`)
  const project = resolveProject(workspace.rootPath, session.projectId)
  if (!project) throw new Error(`Project not found: ${session.projectId}`)
  if (project.config.id !== session.projectId) throw new Error('Resolved Project id does not match the Session')
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(project.config.slug)) {
    throw new Error('Invalid Project slug')
  }

  return {
    workspaceId: session.workspaceId,
    workspaceRootPath: workspace.rootPath,
    project,
  }
}

export async function resolveSessionProjectWorkingDirectory(
  sessionManager: Pick<ISessionManager, 'getSession'>,
  sessionId: string,
  resolveWorkspace: (workspaceId: string) => WorkspaceRoot | null | undefined = getWorkspaceByNameOrId,
  resolveProject: (workspaceRootPath: string, projectId: string) => LoadedProjectRoot | null = loadProjectById,
): Promise<SessionProjectWorkingDirectory> {
  const context = await resolveSessionProjectContext(
    sessionManager,
    sessionId,
    resolveWorkspace,
    resolveProject,
  )
  const { workingDirectory } = context.project.config
  if (!workingDirectory) {
    throw new Error(`Project ${context.project.config.slug} has no working directory`)
  }

  return {
    ...toSessionProject(context),
    workingDirectory,
  }
}

function toSessionProject(context: ResolvedSessionProjectContext): SessionProject {
  return {
    workspaceId: context.workspaceId,
    workspaceRootPath: context.workspaceRootPath,
    projectId: context.project.config.id,
    projectSlug: context.project.config.slug,
  }
}
