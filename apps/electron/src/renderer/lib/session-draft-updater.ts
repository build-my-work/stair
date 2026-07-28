import type { MessageReference } from '@craft-agent/core'
import type { SessionDraft } from '@craft-agent/shared/config'

export const DRAFT_LOCKED = 'DRAFT_LOCKED'

export class DraftLockedError extends Error {
  readonly code = DRAFT_LOCKED

  constructor(sessionId: string) {
    super(`${DRAFT_LOCKED}: session draft is locked while a message is being sent`)
    this.name = 'DraftLockedError'
  }
}

type PersistDraft = (sessionId: string, draft: SessionDraft) => Promise<void>
type DraftReferencesListener = (references: MessageReference[]) => void

function cloneDraft(draft: SessionDraft): SessionDraft {
  return structuredClone(draft)
}

function isSessionDraftEmpty(draft: SessionDraft): boolean {
  return draft.text.length === 0
    && (!draft.attachments || draft.attachments.length === 0)
    && (!draft.references || draft.references.length === 0)
}

function referencesRevision(references: MessageReference[] | undefined): string {
  return JSON.stringify(references ?? [])
}

/**
 * Owns all in-memory mutations for composer drafts.
 *
 * Sending takes an immutable snapshot and locks the whole session draft before
 * attachment processing starts. Successful acknowledgement clears and
 * immediately persists the draft; failure restores the captured snapshot.
 */
export class SessionDraftUpdater {
  private readonly sendSnapshots = new Map<string, SessionDraft>()
  private readonly referenceListenersBySession = new Map<
    string,
    Set<DraftReferencesListener>
  >()

  constructor(
    private readonly drafts: Map<string, SessionDraft>,
    private readonly persistDraft: PersistDraft,
  ) {}

  replaceAll(drafts: Record<string, SessionDraft>): void {
    const lockedSessionId = this.sendSnapshots.keys().next().value
    if (lockedSessionId) {
      throw new DraftLockedError(lockedSessionId)
    }
    const affectedSessionIds = new Set([
      ...this.drafts.keys(),
      ...Object.keys(drafts),
    ])
    const previousReferenceRevisions = new Map(
      [...affectedSessionIds].map(sessionId => [
        sessionId,
        this.getReferencesRevision(sessionId),
      ]),
    )
    this.drafts.clear()
    for (const [sessionId, draft] of Object.entries(drafts)) {
      this.drafts.set(sessionId, cloneDraft(draft))
    }
    for (const sessionId of affectedSessionIds) {
      this.notifyReferencesIfChanged(
        sessionId,
        previousReferenceRevisions.get(sessionId) ?? referencesRevision(undefined),
      )
    }
  }

  clearUnlocked(): void {
    for (const sessionId of this.drafts.keys()) {
      if (!this.sendSnapshots.has(sessionId)) {
        const previousReferenceRevision = this.getReferencesRevision(sessionId)
        this.drafts.delete(sessionId)
        this.notifyReferencesIfChanged(sessionId, previousReferenceRevision)
      }
    }
  }

  get(sessionId: string): SessionDraft | undefined {
    const draft = this.drafts.get(sessionId)
    return draft ? cloneDraft(draft) : undefined
  }

  getReferences(sessionId: string): MessageReference[] {
    return structuredClone(this.drafts.get(sessionId)?.references ?? [])
  }

  subscribeReferences(
    sessionId: string,
    listener: DraftReferencesListener,
  ): () => void {
    const listeners = this.referenceListenersBySession.get(sessionId) ?? new Set()
    listeners.add(listener)
    this.referenceListenersBySession.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.referenceListenersBySession.delete(sessionId)
      }
    }
  }

  update(
    sessionId: string,
    mutation: (current: SessionDraft) => SessionDraft,
  ): SessionDraft {
    this.assertUnlocked(sessionId)
    const previousReferenceRevision = this.getReferencesRevision(sessionId)
    const current = cloneDraft(this.drafts.get(sessionId) ?? { text: '' })
    const next = cloneDraft(mutation(current))
    if (isSessionDraftEmpty(next)) {
      this.drafts.delete(sessionId)
    } else {
      this.drafts.set(sessionId, next)
    }
    this.notifyReferencesIfChanged(sessionId, previousReferenceRevision)
    return cloneDraft(next)
  }

  beginSend(sessionId: string): SessionDraft {
    this.assertUnlocked(sessionId)
    const snapshot = cloneDraft(this.drafts.get(sessionId) ?? { text: '' })
    this.sendSnapshots.set(sessionId, snapshot)
    return cloneDraft(snapshot)
  }

  async finishSend(sessionId: string): Promise<void> {
    this.requireLock(sessionId)
    const previousReferenceRevision = this.getReferencesRevision(sessionId)
    this.drafts.delete(sessionId)
    this.notifyReferencesIfChanged(sessionId, previousReferenceRevision)
    try {
      await this.persistDraft(sessionId, { text: '' })
    } finally {
      this.sendSnapshots.delete(sessionId)
    }
  }

  abortSend(sessionId: string): void {
    const snapshot = this.requireLock(sessionId)
    const previousReferenceRevision = this.getReferencesRevision(sessionId)
    try {
      if (isSessionDraftEmpty(snapshot)) {
        this.drafts.delete(sessionId)
      } else {
        this.drafts.set(sessionId, cloneDraft(snapshot))
      }
      this.notifyReferencesIfChanged(sessionId, previousReferenceRevision)
    } finally {
      this.sendSnapshots.delete(sessionId)
    }
  }

  isLocked(sessionId: string): boolean {
    return this.sendSnapshots.has(sessionId)
  }

  private assertUnlocked(sessionId: string): void {
    if (this.sendSnapshots.has(sessionId)) {
      throw new DraftLockedError(sessionId)
    }
  }

  private requireLock(sessionId: string): SessionDraft {
    const snapshot = this.sendSnapshots.get(sessionId)
    if (!snapshot) {
      throw new Error('INVALID_DRAFT_SEND_SESSION')
    }
    return snapshot
  }

  private getReferencesRevision(sessionId: string): string {
    return referencesRevision(this.drafts.get(sessionId)?.references)
  }

  private notifyReferencesIfChanged(
    sessionId: string,
    previousRevision: string,
  ): void {
    if (previousRevision === this.getReferencesRevision(sessionId)) return

    const references = this.drafts.get(sessionId)?.references ?? []
    const listeners = this.referenceListenersBySession.get(sessionId) ?? []
    for (const listener of listeners) {
      listener(structuredClone(references))
    }
  }
}
