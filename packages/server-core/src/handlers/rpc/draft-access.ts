import type { SessionDraft } from '@craft-agent/shared/config'

export interface DraftSessionIdentity {
  id: string
  workspaceId: string
}

export function authorizedDraftSessionIds(
  workspaceId: string | null,
  sessions: readonly DraftSessionIdentity[],
): Set<string> {
  if (!workspaceId) {
    throw new Error(
      'DRAFT_WORKSPACE_REQUIRED: Draft access requires an active workspace',
    )
  }
  return new Set(
    sessions
      .filter(session => session.workspaceId === workspaceId)
      .map(session => session.id),
  )
}

export function assertDraftSessionAccess(
  workspaceId: string | null,
  sessions: readonly DraftSessionIdentity[],
  sessionId: unknown,
): asserts sessionId is string {
  if (
    typeof sessionId !== 'string'
    || !sessionId
    || !authorizedDraftSessionIds(workspaceId, sessions).has(sessionId)
  ) {
    throw new Error(
      'DRAFT_SESSION_ACCESS_DENIED: Session is not in the active workspace',
    )
  }
}

export function filterDraftsForWorkspace(
  workspaceId: string | null,
  sessions: readonly DraftSessionIdentity[],
  drafts: Readonly<Record<string, SessionDraft>>,
): Record<string, SessionDraft> {
  const authorizedIds = authorizedDraftSessionIds(workspaceId, sessions)
  return Object.fromEntries(
    Object.entries(drafts).filter(([sessionId]) => authorizedIds.has(sessionId)),
  )
}
