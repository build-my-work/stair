import type { PanelStackEntry } from '@/atoms/panel-stack'
import { parseSessionIdFromRoute } from '@/atoms/panel-stack'
import type { SessionMeta } from '@/atoms/sessions'

function isAvailableWorkspaceSession(
  session: SessionMeta | undefined,
  workspaceIds: string | readonly string[],
): session is SessionMeta {
  const ids = typeof workspaceIds === 'string'
    ? [workspaceIds]
    : workspaceIds
  return Boolean(
    session
    && ids.includes(session.workspaceId)
    && !session.isArchived
    && !session.hidden,
  )
}

export function getBrowserOwnerSessionId(
  panelStack: PanelStackEntry[],
  browserPanelId: string,
  sessions: Map<string, SessionMeta>,
  workspaceIds: string | readonly string[],
): string | null {
  const browserPanel = panelStack.find(panel => panel.id === browserPanelId)
  if (!browserPanel?.ownerPanelId) return null
  const owner = panelStack.find(panel => panel.id === browserPanel.ownerPanelId)
  if (!owner || owner.route.kind !== 'navigation') return null
  const sessionId = parseSessionIdFromRoute(owner.route)
  if (!sessionId) return null
  return isAvailableWorkspaceSession(sessions.get(sessionId), workspaceIds)
    ? sessionId
    : null
}

export function getBrowserChatTargetSessionId(
  panelStack: PanelStackEntry[],
  browserPanelId: string,
  sessions: Map<string, SessionMeta>,
  workspaceIds: string | readonly string[],
): string | null {
  const browserPanel = panelStack.find(panel => panel.id === browserPanelId)
  const explicitTargetId = browserPanel?.route.kind === 'browser'
    ? browserPanel.chatTargetSessionId
    : undefined
  if (
    explicitTargetId
    && isAvailableWorkspaceSession(
      sessions.get(explicitTargetId),
      workspaceIds,
    )
  ) {
    return explicitTargetId
  }
  return getBrowserOwnerSessionId(
    panelStack,
    browserPanelId,
    sessions,
    workspaceIds,
  )
}

export function getBrowserReferenceProjectId(
  panelStack: PanelStackEntry[],
  browserPanelId: string,
  sessions: Map<string, SessionMeta>,
  workspaceIds: string | readonly string[],
): string | undefined {
  const sessionId = getBrowserChatTargetSessionId(
    panelStack,
    browserPanelId,
    sessions,
    workspaceIds,
  )
  return sessionId ? sessions.get(sessionId)?.projectId : undefined
}

export function listBrowserReferenceTargets(
  sessions: Map<string, SessionMeta>,
  workspaceIds: string | readonly string[],
  preferredProjectId?: string,
): SessionMeta[] {
  return [...sessions.values()]
    .filter(session => isAvailableWorkspaceSession(session, workspaceIds))
    .sort((left, right) => {
      const leftPreferred = Boolean(
        preferredProjectId && left.projectId === preferredProjectId,
      )
      const rightPreferred = Boolean(
        preferredProjectId && right.projectId === preferredProjectId,
      )
      if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1
      return (
        (right.lastMessageAt ?? right.createdAt ?? 0)
        - (left.lastMessageAt ?? left.createdAt ?? 0)
      )
    })
}
