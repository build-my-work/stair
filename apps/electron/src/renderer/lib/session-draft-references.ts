import {
  isProjectFileReferenceV1,
  MAX_MESSAGE_REFERENCES,
  messageReferenceKey,
  type MessageReference,
} from '@craft-agent/core'
import type { SessionDraft } from '@craft-agent/shared/config'

const MESSAGE_REFERENCE_SEND_ERROR =
  /(MESSAGE_REFERENCE_INVALID|PROJECT_FILE_REFERENCE_(?:INVALID|TOO_LARGE|PROJECT_MISMATCH|UNAVAILABLE|STALE)|WEB_SELECTION_REFERENCE_(?:INVALID|TOO_LARGE)|PROJECT_FILE_REFERENCES_TOO_LARGE|MESSAGE_REFERENCES_TOO_LARGE):\s*([^\n]*)/

interface MessageReferenceSendError {
  code: string
  message: string
  relativePath?: string
}

function hasReference(
  references: readonly MessageReference[],
  reference: MessageReference,
): boolean {
  const key = messageReferenceKey(reference)
  return references.some(existing => messageReferenceKey(existing) === key)
}

export function getProjectFileReferenceSendError(
  error: unknown,
  references: readonly MessageReference[] = [],
): MessageReferenceSendError | null {
  const raw = error instanceof Error ? error.message : String(error)
  const match = MESSAGE_REFERENCE_SEND_ERROR.exec(raw)
  if (!match) return null
  const message = match[2]?.trim() || 'The reference could not be sent.'
  const invalidReference = references.find((
    reference,
  ): reference is Extract<MessageReference, { kind: 'project-file' }> => (
    isProjectFileReferenceV1(reference)
    && message.endsWith(`: ${reference.relativePath}`)
  ))
  return {
    code: match[1],
    message,
    ...(invalidReference
      ? { relativePath: invalidReference.relativePath }
      : {}),
  }
}

export function addDraftReference(
  draft: SessionDraft,
  reference: MessageReference,
): SessionDraft {
  const references = draft.references ?? []
  if (hasReference(references, reference)) {
    return draft
  }
  if (references.length >= MAX_MESSAGE_REFERENCES) {
    throw new Error(`MESSAGE_REFERENCE_LIMIT: maximum ${MAX_MESSAGE_REFERENCES}`)
  }
  return {
    ...draft,
    references: [...references, reference],
  }
}

export function mergeDraftReferences(
  draft: SessionDraft,
  incoming: readonly MessageReference[],
): SessionDraft {
  let references = draft.references ?? []
  let changed = false
  for (const reference of incoming) {
    if (hasReference(references, reference)) continue
    if (references.length >= MAX_MESSAGE_REFERENCES) break
    references = [...references, reference]
    changed = true
  }
  return changed ? { ...draft, references } : draft
}
