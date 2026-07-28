import type {
  ProjectFileOpenIntent,
  SourceFingerprint,
} from '@craft-agent/core'
import type { PanelStackEntry } from '@/atoms/panel-stack'
import { parseSessionIdFromRoute } from '@/atoms/panel-stack'
import type { SessionMeta } from '@/atoms/sessions'

export function resolveProjectFileOpenIntent(
  intent: ProjectFileOpenIntent | undefined,
  sourceFingerprint: SourceFingerprint,
): {
  locator?: ProjectFileOpenIntent['locator']
  stale: boolean
} {
  if (!intent) return { stale: false }
  if (intent.expectedFingerprint !== sourceFingerprint) return { stale: true }
  return {
    locator: intent.locator,
    stale: false,
  }
}

export function getProjectFileOwnerSessionId(
  panelStack: PanelStackEntry[],
  projectFilePanelId: string,
  sessions: Map<string, SessionMeta>,
  projectId: string,
): string | null {
  const filePanel = panelStack.find(panel => panel.id === projectFilePanelId)
  if (!filePanel?.ownerPanelId) return null
  const owner = panelStack.find(panel => panel.id === filePanel.ownerPanelId)
  if (!owner || owner.route.kind !== 'navigation') return null
  const sessionId = parseSessionIdFromRoute(owner.route)
  if (!sessionId) return null
  const session = sessions.get(sessionId)
  if (
    !session
    || session.projectId !== projectId
    || session.isArchived
    || session.hidden
  ) {
    return null
  }
  return sessionId
}

export function listProjectReferenceTargets(
  sessions: Map<string, SessionMeta>,
  projectId: string,
): SessionMeta[] {
  return [...sessions.values()]
    .filter(session => (
      session.projectId === projectId
      && !session.isArchived
      && !session.hidden
    ))
    .sort((left, right) => (
      (right.lastMessageAt ?? right.createdAt ?? 0)
      - (left.lastMessageAt ?? left.createdAt ?? 0)
    ))
}
