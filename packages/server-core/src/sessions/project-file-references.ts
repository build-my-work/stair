import { Buffer } from 'node:buffer'

import {
  MAX_MESSAGE_REFERENCES,
  isProjectFileReferenceV1,
  isWebSelectionReferenceV1,
  type MessageReference,
  type ProjectFileReferenceV1,
  type WebSelectionReferenceV1,
} from '@craft-agent/core/types'

import {
  readProjectFileBinaryWithinRoot,
  resolveProjectWorkingDirectory,
} from '../handlers/rpc/project-files'

export const MAX_REFERENCES_PER_MESSAGE = MAX_MESSAGE_REFERENCES
export const MAX_PROJECT_FILE_REFERENCE_BYTES = 16 * 1024
export const MAX_WEB_SELECTION_REFERENCE_BYTES = 16 * 1024
export const MAX_MESSAGE_REFERENCES_BYTES = 128 * 1024

type ReferenceErrorCode =
  | 'MESSAGE_REFERENCE_INVALID'
  | 'PROJECT_FILE_REFERENCE_INVALID'
  | 'PROJECT_FILE_REFERENCE_TOO_LARGE'
  | 'WEB_SELECTION_REFERENCE_INVALID'
  | 'WEB_SELECTION_REFERENCE_TOO_LARGE'
  | 'PROJECT_FILE_REFERENCE_PROJECT_MISMATCH'
  | 'PROJECT_FILE_REFERENCE_UNAVAILABLE'
  | 'PROJECT_FILE_REFERENCE_STALE'
  | 'MESSAGE_REFERENCES_TOO_LARGE'

interface ReferenceSizeLimit {
  maxBytes: number
  errorCode:
    | 'PROJECT_FILE_REFERENCE_TOO_LARGE'
    | 'WEB_SELECTION_REFERENCE_TOO_LARGE'
  description: string
}

function referenceError(
  code: ReferenceErrorCode,
  message: string,
  cause?: unknown,
): Error {
  return new Error(
    `${code}: ${message}`,
    cause === undefined ? undefined : { cause },
  )
}

function getReferenceSizeLimit(
  reference: MessageReference,
): ReferenceSizeLimit {
  switch (reference.kind) {
    case 'project-file':
      return {
        maxBytes: MAX_PROJECT_FILE_REFERENCE_BYTES,
        errorCode: 'PROJECT_FILE_REFERENCE_TOO_LARGE',
        description: 'A Project File reference',
      }
    case 'web-selection':
      return {
        maxBytes: MAX_WEB_SELECTION_REFERENCE_BYTES,
        errorCode: 'WEB_SELECTION_REFERENCE_TOO_LARGE',
        description: 'A web selection reference',
      }
  }
}

/**
 * Copy only the fields owned by ProjectFileReferenceV1. This provides one
 * deterministic JSON representation for byte accounting, persistence and
 * model input without retaining arbitrary wire properties.
 */
function normalizeProjectFileReference(
  value: unknown,
): ProjectFileReferenceV1 {
  if (!isProjectFileReferenceV1(value)) {
    throw referenceError(
      'PROJECT_FILE_REFERENCE_INVALID',
      'Invalid Project File reference',
    )
  }

  const tocPath = value.tocPath.map(entry => ({
    key: entry.key,
    title: entry.title,
    orderPath: [...entry.orderPath],
    ...(entry.href === undefined ? {} : { href: entry.href }),
  }))

  return {
    version: 1,
    kind: 'project-file',
    projectId: value.projectId,
    relativePath: value.relativePath,
    sourceFingerprint: value.sourceFingerprint,
    fileName: value.fileName,
    quote: value.quote,
    ...(value.contextBefore === undefined
      ? {}
      : { contextBefore: value.contextBefore }),
    ...(value.contextAfter === undefined
      ? {}
      : { contextAfter: value.contextAfter }),
    ...(value.chapterKey === undefined ? {} : { chapterKey: value.chapterKey }),
    ...(value.chapterTitle === undefined
      ? {}
      : { chapterTitle: value.chapterTitle }),
    tocPath,
    locator: {
      type: 'epub-cfi',
      cfiRange: value.locator.cfiRange,
    },
  }
}

function normalizeWebSelectionReference(
  value: unknown,
): WebSelectionReferenceV1 {
  if (!isWebSelectionReferenceV1(value)) {
    throw referenceError(
      'WEB_SELECTION_REFERENCE_INVALID',
      'Invalid web selection reference',
    )
  }

  return {
    version: 1,
    kind: 'web-selection',
    url: value.url,
    title: value.title,
    quote: value.quote,
    locator: {
      type: 'text-quote',
      exact: value.locator.exact,
      ...(value.locator.prefix === undefined
        ? {}
        : { prefix: value.locator.prefix }),
      ...(value.locator.suffix === undefined
        ? {}
        : { suffix: value.locator.suffix }),
    },
  }
}

function normalizeReference(value: unknown): MessageReference {
  if (
    value
    && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'web-selection'
  ) {
    return normalizeWebSelectionReference(value)
  }
  return normalizeProjectFileReference(value)
}

/**
 * Runtime validation for untrusted RPC data. Limits are measured on the
 * normalized JSON UTF-8 bytes, not JavaScript character count.
 */
export function normalizeMessageReferences(
  value: unknown,
): MessageReference[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw referenceError(
      'MESSAGE_REFERENCE_INVALID',
      'Message references must be an array',
    )
  }
  if (value.length > MAX_REFERENCES_PER_MESSAGE) {
    throw referenceError(
      'MESSAGE_REFERENCES_TOO_LARGE',
      `A message can contain at most ${MAX_REFERENCES_PER_MESSAGE} references`,
    )
  }

  const references = value.map(normalizeReference)
  for (const reference of references) {
    const limit = getReferenceSizeLimit(reference)
    if (
      Buffer.byteLength(JSON.stringify(reference), 'utf8')
      > limit.maxBytes
    ) {
      throw referenceError(
        limit.errorCode,
        `${limit.description} exceeds ${limit.maxBytes} bytes`,
      )
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(references), 'utf8')
    > MAX_MESSAGE_REFERENCES_BYTES
  ) {
    throw referenceError(
      'MESSAGE_REFERENCES_TOO_LARGE',
      `Message references exceed ${MAX_MESSAGE_REFERENCES_BYTES} bytes`,
    )
  }
  return references
}

interface ProjectFileReferenceSendContext {
  workspaceRootPath: string
  sessionProjectId?: string
}

/**
 * Validate references at the send boundary. Draft persistence intentionally
 * does not call this because a stale file must not block unrelated draft text.
 */
export async function validateMessageReferencesForSend(
  context: ProjectFileReferenceSendContext,
  value: unknown,
): Promise<MessageReference[] | undefined> {
  const references = normalizeMessageReferences(value)
  if (!references?.length) return references

  const projectFileReferences = references.filter(isProjectFileReferenceV1)
  if (projectFileReferences.length === 0) return references

  if (
    !context.sessionProjectId
    || projectFileReferences.some(
      reference => reference.projectId !== context.sessionProjectId,
    )
  ) {
    throw referenceError(
      'PROJECT_FILE_REFERENCE_PROJECT_MISMATCH',
      'Session and Project File references must belong to the same Project',
    )
  }

  let projectRoot: string
  try {
    projectRoot = await resolveProjectWorkingDirectory(
      context.workspaceRootPath,
      context.sessionProjectId,
    )
  } catch (error) {
    throw referenceError(
      'PROJECT_FILE_REFERENCE_UNAVAILABLE',
      'Referenced Project is unavailable',
      error,
    )
  }

  const currentFingerprints = new Map<string, string>()
  for (const reference of projectFileReferences) {
    let currentFingerprint = currentFingerprints.get(reference.relativePath)
    if (!currentFingerprint) {
      try {
        const current = await readProjectFileBinaryWithinRoot(projectRoot, {
          projectId: reference.projectId,
          relativePath: reference.relativePath,
        })
        currentFingerprint = current.sourceFingerprint
        currentFingerprints.set(reference.relativePath, currentFingerprint)
      } catch (error) {
        throw referenceError(
          'PROJECT_FILE_REFERENCE_UNAVAILABLE',
          `Referenced Project File is unavailable: ${reference.relativePath}`,
          error,
        )
      }
    }
    if (currentFingerprint !== reference.sourceFingerprint) {
      throw referenceError(
        'PROJECT_FILE_REFERENCE_STALE',
        `Referenced Project File has changed: ${reference.relativePath}`,
      )
    }
  }

  return references
}

function escapeJsonForUntrustedMarkup(json: string): string {
  return json
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function appendUntrustedReferenceData(
  message: string,
  tag: 'project_file_reference_data' | 'web_selection_reference_data',
  references: readonly MessageReference[],
): string {
  if (references.length === 0) return message
  const data = escapeJsonForUntrustedMarkup(JSON.stringify(references))
  const separator = message ? '\n\n' : ''
  return `${message}${separator}<${tag} trust="untrusted">\n${data}\n</${tag}>`
}

/**
 * Build the provider-independent user-turn model input. The original message
 * and structured references remain separate in Session JSONL.
 */
export function formatMessageWithReferences(
  message: string,
  references: MessageReference[] | undefined,
): string {
  if (!references?.length) return message

  const projectFileReferences = references.filter(isProjectFileReferenceV1)
  const webSelectionReferences = references.filter(isWebSelectionReferenceV1)
  const withProjectFileReferences = appendUntrustedReferenceData(
    message,
    'project_file_reference_data',
    projectFileReferences,
  )
  return appendUntrustedReferenceData(
    withProjectFileReferences,
    'web_selection_reference_data',
    webSelectionReferences,
  )
}
