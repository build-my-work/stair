import {
  MAX_PROJECT_FILE_REFERENCES,
  projectFileReferenceKey,
  type MessageReference,
} from '@craft-agent/core'
import type { SessionDraft } from '@craft-agent/shared/config'

const PROJECT_FILE_REFERENCE_SEND_ERROR =
  /(PROJECT_FILE_REFERENCE_(?:INVALID|TOO_LARGE|PROJECT_MISMATCH|UNAVAILABLE|STALE)|PROJECT_FILE_REFERENCES_TOO_LARGE):\s*([^\n]*)/

interface ProjectFileReferenceSendError {
  code: string
  message: string
  relativePath?: string
}

function hasReference(
  references: readonly MessageReference[],
  reference: MessageReference,
): boolean {
  const key = projectFileReferenceKey(reference)
  return references.some(existing => projectFileReferenceKey(existing) === key)
}

export function getProjectFileReferenceSendError(
  error: unknown,
  references: readonly MessageReference[] = [],
): ProjectFileReferenceSendError | null {
  const raw = error instanceof Error ? error.message : String(error)
  const match = PROJECT_FILE_REFERENCE_SEND_ERROR.exec(raw)
  if (!match) return null
  const message = match[2]?.trim() || 'The Project File reference could not be sent.'
  const invalidReference = references.find(reference =>
    message.endsWith(`: ${reference.relativePath}`))
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
  if (references.length >= MAX_PROJECT_FILE_REFERENCES) {
    throw new Error(`PROJECT_FILE_REFERENCE_LIMIT: maximum ${MAX_PROJECT_FILE_REFERENCES}`)
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
    if (references.length >= MAX_PROJECT_FILE_REFERENCES) break
    references = [...references, reference]
    changed = true
  }
  return changed ? { ...draft, references } : draft
}
