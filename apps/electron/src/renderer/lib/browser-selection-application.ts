import type { Reference } from '@craft-agent/core'
import type { BrowserApplicationCapabilityRequest } from '@craft-agent/server-core/transport'

import { browserSelectionSourceToReference } from '../../shared/browser-selection'

type SelectionRequest = Extract<
  BrowserApplicationCapabilityRequest,
  {
    action:
      | 'add-selection-note'
      | 'add-selection-to-chat'
      | 'create-chat-from-selection'
  }
>

interface BrowserSelectionApplicationDependencies {
  addDraftReference(
    sessionId: string,
    reference: Reference,
    requestId: string,
  ): boolean | Promise<boolean>
  addSelectionNote?: (
    reference: Reference,
    sessionId: string | null,
    mode: 'current' | 'choose-target',
    requestId: string,
  ) => Promise<string | null>
  createChat?: (
    workspaceId: string,
    projectId: string,
    requestId: string,
  ) => Promise<{ id: string; projectId: string; title: string }>
  openChat?: (sessionId: string) => void | Promise<void>
}

export async function deriveBrowserProjectNoteRequestId(
  browserRequestId: string,
  operationKey: string,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(operationKey),
  )
  const operationDigest = Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
  return `${browserRequestId}:${operationDigest}`
}

export async function handleBrowserSelectionApplicationRequest(
  request: SelectionRequest,
  dependencies: BrowserSelectionApplicationDependencies,
): Promise<
  | { ok: true }
  | { ok: true; noteTargetPath: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: true; sessionId: string; targetTitle: string }
> {
  const reference = browserSelectionSourceToReference(request.projectId, request.source)
  if (!reference) throw new Error('Browser selection is invalid')

  if (request.action === 'add-selection-note') {
    if (!dependencies.addSelectionNote) {
      throw new Error('Browser Add Note handler is unavailable')
    }
    const noteTargetPath = await dependencies.addSelectionNote(
      reference,
      request.sessionId,
      request.mode,
      request.requestId,
    )
    return noteTargetPath
      ? { ok: true, noteTargetPath }
      : { ok: false, reason: 'cancelled' }
  }

  if (request.action === 'add-selection-to-chat') {
    if (!await dependencies.addDraftReference(
      request.sessionId,
      reference,
      request.requestId,
    )) {
      throw new Error('Could not add this reference to the target Chat')
    }
    return { ok: true }
  }

  if (!dependencies.createChat || !dependencies.openChat) {
    throw new Error('Browser New Chat handler is unavailable')
  }

  const child = await dependencies.createChat(
    request.workspaceId,
    request.projectId,
    request.requestId,
  )
  if (child.projectId !== request.projectId) {
    throw new Error('Created Chat belongs to a different Project')
  }
  if (!await dependencies.addDraftReference(child.id, reference, request.requestId)) {
    throw new Error('Could not add this reference to the new Chat')
  }
  await dependencies.openChat(child.id)
  return { ok: true, sessionId: child.id, targetTitle: child.title }
}
