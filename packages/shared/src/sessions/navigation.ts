/** Fields that determine whether a session belongs in primary navigation surfaces. */
export interface PrimaryNavigableSessionFields {
  hidden?: boolean
  sideChatForSessionId?: string
}

export interface StandaloneNavigableSessionFields extends PrimaryNavigableSessionFields {
  projectId?: string
}

/**
 * Primary navigation contains ordinary sessions only.
 * Hidden runtime sessions and auxiliary side chats remain addressable by ID,
 * but are opened through their owning feature instead of the left session list.
 */
export function isPrimaryNavigableSession(session: PrimaryNavigableSessionFields): boolean {
  return !session.hidden && !session.sideChatForSessionId
}

/** The standalone Sessions branch excludes sessions owned by a Project. */
export function isStandaloneNavigableSession(
  session: StandaloneNavigableSessionFields,
): boolean {
  return isPrimaryNavigableSession(session) && !session.projectId
}
