import {
  RPC_CHANNELS,
  type Session,
} from '@craft-agent/shared/protocol'
import type {
  BrowserApplicationCapabilityRequest,
  BrowserApplicationCapabilityResponse,
  RpcClient,
} from '@craft-agent/server-core/transport'

export type BrowserApplicationHandler = (
  request: Extract<
    BrowserApplicationCapabilityRequest,
    {
      action:
        | 'open-chat'
        | 'add-selection-note'
        | 'add-selection-to-chat'
        | 'create-chat-from-selection'
    }
  >,
) => Promise<
  | { ok: true }
  | { ok: true; noteTargetPath: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: true; sessionId: string; targetTitle: string }
>

async function loadProjectData(
  client: RpcClient,
  workspaceId: string,
  projectId: string,
): Promise<{ projectExists: boolean; sessions: Session[] }> {
  const [project, sessions] = await Promise.all([
    client.invoke(RPC_CHANNELS.projects.GET_ONE, workspaceId, projectId),
    client.invoke(RPC_CHANNELS.sessions.GET) as Promise<Session[]>,
  ])

  return {
    projectExists: project !== null && project !== undefined,
    sessions,
  }
}

function visibleProjectSessions(sessions: Session[], projectId: string): Session[] {
  return sessions.filter(session => (
    session.projectId === projectId
    && session.hidden !== true
    && session.isArchived !== true
  ))
}

export async function handleBrowserApplicationCapability(
  client: RpcClient,
  request: BrowserApplicationCapabilityRequest,
  handleApplication?: BrowserApplicationHandler | null,
  applicationWorkspaceId?: string | null,
): Promise<BrowserApplicationCapabilityResponse> {
  if (!request || request.v !== 1) {
    throw new Error('Unsupported Browser application capability request')
  }

  if (request.action === 'get-application-readiness') {
    return {
      applicationReady: !!handleApplication && applicationWorkspaceId === request.workspaceId,
    }
  }

  if (request.action === 'list-project-targets') {
    const projects = await client.invoke(
      RPC_CHANNELS.projects.GET,
      request.workspaceId,
    ) as Array<{ config?: { id?: unknown; name?: unknown } }>
    return {
      projectTargets: (Array.isArray(projects) ? projects : []).flatMap(project => {
        const id = project.config?.id
        const name = project.config?.name
        return typeof id === 'string' && typeof name === 'string'
          ? [{ id, title: name }]
          : []
      }),
    }
  }

  if (request.action === 'get-project-context') {
    const data = await loadProjectData(client, request.workspaceId, request.projectId)
    return {
      projectExists: data.projectExists,
      chatTargets: data.sessions.filter(session => (
        session.projectId === request.projectId
        && (
          session.id === request.includeOwnerSessionId
          || (session.hidden !== true && session.isArchived !== true)
        )
      ))
        .map(session => ({
          id: session.id,
          title: session.name?.trim() || session.preview?.trim() || session.id,
          noteTargetPath: session.projectNoteTargetPath ?? null,
        })),
    }
  }

  if (request.action === 'create-chat-from-selection') {
    const project = await client.invoke(
      RPC_CHANNELS.projects.GET_ONE,
      request.workspaceId,
      request.projectId,
    )
    if (project === null || project === undefined) {
      throw new Error('Browser Project is unavailable')
    }
    if (!handleApplication || applicationWorkspaceId !== request.workspaceId) {
      throw new Error('Browser Chat draft handler is unavailable')
    }
    return handleApplication(request)
  }

  if (
    request.action !== 'open-chat'
    && request.action !== 'add-selection-note'
    && request.action !== 'add-selection-to-chat'
  ) {
    throw new Error('Unsupported Browser application capability action')
  }

  if (request.action === 'add-selection-note') {
    const project = await client.invoke(
      RPC_CHANNELS.projects.GET_ONE,
      request.workspaceId,
      request.projectId,
    )
    if (project === null || project === undefined) {
      throw new Error('Browser Project is unavailable')
    }
    if (!handleApplication || applicationWorkspaceId !== request.workspaceId) {
      throw new Error('Browser application handler is unavailable')
    }

    const response = await handleApplication(request)
    if (!response.ok) return response
    if (!('noteTargetPath' in response)) {
      throw new Error('Browser Add Note returned an invalid response')
    }
    return { ...response, sessionId: request.sessionId }
  }

  const data = await loadProjectData(client, request.workspaceId, request.projectId)
  if (!data.projectExists) {
    throw new Error('Browser Project is unavailable')
  }
  const session = visibleProjectSessions(data.sessions, request.projectId)
    .find(candidate => candidate.id === request.sessionId)
  if (!session) throw new Error('Target Chat is not available in this Project')
  if (!handleApplication || applicationWorkspaceId !== request.workspaceId) {
    throw new Error('Browser application handler is unavailable')
  }
  return handleApplication(request)
}
