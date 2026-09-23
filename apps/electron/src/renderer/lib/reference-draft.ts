import {
  MAX_REFERENCES_PER_MESSAGE,
  referenceKey,
  referencesFitSerializedLimits,
  type Reference,
} from '@craft-agent/core'
import type {
  DraftAttachmentRef,
  SessionDraft,
} from '@craft-agent/shared/config'

function normalizeDraft(draft: SessionDraft): SessionDraft | null {
  return draft.text.length > 0
    || (draft.attachments?.length ?? 0) > 0
    || (draft.references?.length ?? 0) > 0
    ? draft
    : null
}

function mergeDraftText(authoritative: string, local: string): string {
  if (!authoritative) return local
  if (
    !local
    || local === authoritative
    || authoritative.startsWith(`${local}\n\n`)
  ) {
    return authoritative
  }
  if (local.startsWith(`${authoritative}\n\n`)) return local
  return `${authoritative}\n\n${local}`
}

export function setSessionDraftText(
  existing: SessionDraft | null | undefined,
  text: string,
): SessionDraft | null {
  return normalizeDraft({
    text,
    ...(existing?.attachments?.length ? { attachments: existing.attachments } : {}),
    ...(existing?.references?.length ? { references: existing.references } : {}),
  })
}

export function setSessionDraftAttachments(
  existing: SessionDraft | null | undefined,
  attachments: DraftAttachmentRef[],
): SessionDraft | null {
  return normalizeDraft({
    text: existing?.text ?? '',
    ...(attachments.length ? { attachments } : {}),
    ...(existing?.references?.length ? { references: existing.references } : {}),
  })
}

export function addSessionDraftReference(
  existing: SessionDraft | null | undefined,
  targetProjectId: string,
  reference: Reference,
): SessionDraft | null {
  if (reference.projectId !== targetProjectId) return null
  const references = existing?.references ?? []
  const key = referenceKey(reference)
  if (references.some(candidate => referenceKey(candidate) === key)) {
    return existing ?? { text: '', references: [reference] }
  }
  if (references.length >= MAX_REFERENCES_PER_MESSAGE) return null

  const nextReferences = [...references, reference]
  if (!referencesFitSerializedLimits(nextReferences)) return null

  return {
    text: existing?.text ?? '',
    ...(existing?.attachments?.length ? { attachments: existing.attachments } : {}),
    references: nextReferences,
  }
}

export function setSessionDraftReferences(
  existing: SessionDraft | null | undefined,
  targetProjectId: string,
  values: Reference[],
): SessionDraft | null {
  const references: Reference[] = []
  const seen = new Set<string>()
  for (const reference of values) {
    if (reference.projectId !== targetProjectId) return null
    const key = referenceKey(reference)
    if (!seen.has(key)) {
      seen.add(key)
      references.push(reference)
    }
  }
  if (references.length > MAX_REFERENCES_PER_MESSAGE) return null
  if (!referencesFitSerializedLimits(references)) return null

  return normalizeDraft({
    text: existing?.text ?? '',
    ...(existing?.attachments?.length ? { attachments: existing.attachments } : {}),
    ...(references.length ? { references } : {}),
  })
}

export function mergeAuthoritativeSessionDraftReferences(
  existing: SessionDraft | null | undefined,
  targetProjectId: string,
  confirmedBefore: Reference[],
  authoritative: Reference[],
):
  | { ok: true; draft: SessionDraft | null }
  | { ok: false; reason: 'reference-boundary' } {
  const local = existing?.references ?? []
  const confirmedKeys = new Set(confirmedBefore.map(referenceKey))
  const localKeys = new Set(local.map(referenceKey))
  const removedKeys = new Set(
    [...confirmedKeys].filter(key => !localKeys.has(key)),
  )
  const merged = authoritative.filter(reference => (
    !removedKeys.has(referenceKey(reference))
  ))
  const mergedKeys = new Set(merged.map(referenceKey))
  for (const reference of local) {
    const key = referenceKey(reference)
    if (!confirmedKeys.has(key) && !mergedKeys.has(key)) {
      merged.push(reference)
      mergedKeys.add(key)
    }
  }
  const draft = setSessionDraftReferences(existing, targetProjectId, merged)
  return draft || merged.length === 0
    ? { ok: true, draft }
    : { ok: false, reason: 'reference-boundary' }
}

export type SessionDraftRestoreResult =
  | { ok: true; draft: SessionDraft | null }
  | {
      ok: false
      draft: SessionDraft | null
      reason: 'reference-boundary'
    }

export function restoreSessionDraftContent(
  existing: SessionDraft | null | undefined,
  targetProjectId: string | null | undefined,
  text: string,
  references: Reference[],
  attachments: DraftAttachmentRef[] = [],
): SessionDraftRestoreResult {
  const restoredText = text
    ? (existing?.text ? `${existing.text}\n\n${text}` : text)
    : (existing?.text ?? '')
  const restoredTextDraft = setSessionDraftText(existing, restoredText)
  const restoredContentDraft = attachments.length > 0
    ? setSessionDraftAttachments(
        restoredTextDraft,
        [...(existing?.attachments ?? []), ...attachments],
      )
    : restoredTextDraft
  if (references.length === 0) {
    return { ok: true, draft: restoredContentDraft }
  }
  if (!targetProjectId) {
    return {
      ok: false,
      draft: existing ?? null,
      reason: 'reference-boundary',
    }
  }

  const restoredDraft = setSessionDraftReferences(
    restoredContentDraft,
    targetProjectId,
    [...(existing?.references ?? []), ...references],
  )
  if (!restoredDraft) {
    return {
      ok: false,
      draft: existing ?? null,
      reason: 'reference-boundary',
    }
  }
  return { ok: true, draft: restoredDraft }
}

export function applyQueuedInputRestore(
  existing: SessionDraft | null | undefined,
  confirmedBefore: SessionDraft | null | undefined,
  authoritative: SessionDraft | null,
  targetProjectId: string | null | undefined,
): SessionDraftRestoreResult {
  if (!authoritative) return { ok: true, draft: existing ?? null }

  const local = existing ?? { text: '' }
  const confirmed = confirmedBefore ?? { text: '' }
  let mergedText: string
  if (local.text === confirmed.text) {
    mergedText = authoritative.text
  } else if (!confirmed.text) {
    mergedText = mergeDraftText(authoritative.text, local.text)
  } else {
    const authoritativeSuffix = authoritative.text === confirmed.text
      ? ''
      : authoritative.text.startsWith(`${confirmed.text}\n\n`)
        ? authoritative.text.slice(confirmed.text.length + 2)
        : null
    if (authoritativeSuffix !== null) {
      const localSuffix = local.text.startsWith(`${confirmed.text}\n\n`)
        ? local.text.slice(confirmed.text.length + 2)
        : null
      const localPart = localSuffix ?? local.text
      const mergedSuffix = mergeDraftText(authoritativeSuffix, localPart)
      const parts = localSuffix === null
        ? [mergedSuffix]
        : [confirmed.text, mergedSuffix]
      mergedText = parts.filter(Boolean).join('\n\n')
    } else {
      mergedText = mergeDraftText(authoritative.text, local.text)
    }
  }

  const confirmedAttachmentKeys = new Set(
    (confirmed.attachments ?? []).map(attachment => JSON.stringify(attachment)),
  )
  const localAttachmentKeys = new Set(
    (local.attachments ?? []).map(attachment => JSON.stringify(attachment)),
  )
  const mergedAttachments = (authoritative.attachments ?? []).filter(attachment => {
    const key = JSON.stringify(attachment)
    return !confirmedAttachmentKeys.has(key) || localAttachmentKeys.has(key)
  })
  const attachmentKeys = new Set(
    mergedAttachments.map(attachment => JSON.stringify(attachment)),
  )
  for (const attachment of local.attachments ?? []) {
    const key = JSON.stringify(attachment)
    if (!confirmedAttachmentKeys.has(key) && !attachmentKeys.has(key)) {
      mergedAttachments.push(attachment)
      attachmentKeys.add(key)
    }
  }
  const mergedContent = setSessionDraftAttachments(
    setSessionDraftText(null, mergedText),
    mergedAttachments,
  )
  const hasReferences = (confirmed.references?.length ?? 0) > 0
    || (local.references?.length ?? 0) > 0
    || (authoritative.references?.length ?? 0) > 0
  if (!hasReferences) {
    return { ok: true, draft: mergedContent }
  }
  if (!targetProjectId) {
    return {
      ok: false,
      draft: existing ?? null,
      reason: 'reference-boundary',
    }
  }
  const referenceResult = mergeAuthoritativeSessionDraftReferences(
    {
      text: mergedContent?.text ?? '',
      ...(mergedContent?.attachments?.length
        ? { attachments: mergedContent.attachments }
        : {}),
      ...(local.references?.length ? { references: local.references } : {}),
    },
    targetProjectId,
    confirmed.references ?? [],
    authoritative.references ?? [],
  )
  return referenceResult.ok
    ? referenceResult
    : { ok: false, draft: existing ?? null, reason: referenceResult.reason }
}

export function mergeHydratedSessionDrafts(
  current: ReadonlyMap<string, SessionDraft>,
  persisted: Record<string, SessionDraft>,
  mutatedSessionIds: ReadonlySet<string>,
): { drafts: Map<string, SessionDraft>; hydratedSessionIds: string[] } {
  const drafts = new Map(current)
  const hydratedSessionIds: string[] = []

  for (const [sessionId, draft] of Object.entries(persisted)) {
    if (mutatedSessionIds.has(sessionId) || drafts.has(sessionId)) continue
    drafts.set(sessionId, draft)
    hydratedSessionIds.push(sessionId)
  }

  return { drafts, hydratedSessionIds }
}

export function removeSessionDraftReference(
  existing: SessionDraft | null | undefined,
  reference: Reference,
): SessionDraft | null {
  if (!existing?.references?.length) return existing ?? null
  const key = referenceKey(reference)
  const references = existing.references.filter(
    candidate => referenceKey(candidate) !== key,
  )
  return normalizeDraft({
    text: existing.text,
    ...(existing.attachments?.length ? { attachments: existing.attachments } : {}),
    ...(references.length ? { references } : {}),
  })
}
