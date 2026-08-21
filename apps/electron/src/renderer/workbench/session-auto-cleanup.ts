import type { SessionMeta } from '@/atoms/sessions'
import type { SessionDraft } from '@craft-agent/shared/config'

export function sessionDraftHasContent(
  draft: SessionDraft | null | undefined,
): boolean {
  return !!draft && (draft.text.length > 0 || (draft.attachments?.length ?? 0) > 0)
}

export function findEmptySessionsLeavingWorkbench(
  previousVisibleSessionIds: ReadonlySet<string>,
  currentVisibleSessionIds: ReadonlySet<string>,
  sessionMetaMap: ReadonlyMap<string, SessionMeta>,
  hasSessionDraft: (sessionId: string) => boolean,
  workspaceId: string,
): string[] {
  const sessionIds: string[] = []

  for (const sessionId of previousVisibleSessionIds) {
    if (currentVisibleSessionIds.has(sessionId)) continue

    const meta = sessionMetaMap.get(sessionId)
    if (
      !meta
      || meta.workspaceId !== workspaceId
      || !!meta.name
      || (meta.messageCount ?? 0) > 0
      || !!meta.lastFinalMessageId
      || !!meta.lastMessageRole
      || !!meta.preview
      || !!meta.isProcessing
      || hasSessionDraft(sessionId)
    ) {
      continue
    }

    sessionIds.push(sessionId)
  }

  return sessionIds
}
