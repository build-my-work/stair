import { Buffer } from 'node:buffer'

import {
  MAX_PROJECT_FILE_REFERENCES,
  isProjectFileReferenceV1,
  type MessageReference,
  type ProjectFileReferenceV1,
} from '@craft-agent/core/types'

import {
  readProjectFileBinaryWithinRoot,
  resolveProjectWorkingDirectory,
} from '../handlers/rpc/project-files'

export const MAX_REFERENCES_PER_MESSAGE = MAX_PROJECT_FILE_REFERENCES
export const MAX_PROJECT_FILE_REFERENCE_BYTES = 16 * 1024
export const MAX_MESSAGE_REFERENCES_BYTES = 128 * 1024

type ReferenceErrorCode =
  | 'PROJECT_FILE_REFERENCE_INVALID'
  | 'PROJECT_FILE_REFERENCE_TOO_LARGE'
  | 'PROJECT_FILE_REFERENCES_TOO_LARGE'
  | 'PROJECT_FILE_REFERENCE_PROJECT_MISMATCH'
  | 'PROJECT_FILE_REFERENCE_UNAVAILABLE'
  | 'PROJECT_FILE_REFERENCE_STALE'

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

/**
 * Copy only the fields owned by ProjectFileReferenceV1. This provides one
 * deterministic JSON representation for byte accounting, persistence and
 * model input without retaining arbitrary wire properties.
 */
function normalizeReference(value: unknown): ProjectFileReferenceV1 {
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

/**
 * Runtime validation for untrusted RPC data. Limits are measured on the
 * normalized JSON UTF-8 bytes, not JavaScript character count.
 */
export function normalizeProjectFileReferences(
  value: unknown,
): MessageReference[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw referenceError(
      'PROJECT_FILE_REFERENCE_INVALID',
      'Message references must be an array',
    )
  }
  if (value.length > MAX_REFERENCES_PER_MESSAGE) {
    throw referenceError(
      'PROJECT_FILE_REFERENCE_TOO_LARGE',
      `A message can contain at most ${MAX_REFERENCES_PER_MESSAGE} references`,
    )
  }

  const references = value.map(normalizeReference)
  for (const reference of references) {
    if (
      Buffer.byteLength(JSON.stringify(reference), 'utf8')
      > MAX_PROJECT_FILE_REFERENCE_BYTES
    ) {
      throw referenceError(
        'PROJECT_FILE_REFERENCE_TOO_LARGE',
        `A Project File reference exceeds ${MAX_PROJECT_FILE_REFERENCE_BYTES} bytes`,
      )
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(references), 'utf8')
    > MAX_MESSAGE_REFERENCES_BYTES
  ) {
    throw referenceError(
      'PROJECT_FILE_REFERENCES_TOO_LARGE',
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
export async function validateProjectFileReferencesForSend(
  context: ProjectFileReferenceSendContext,
  value: unknown,
): Promise<MessageReference[] | undefined> {
  const references = normalizeProjectFileReferences(value)
  if (!references?.length) return references

  if (
    !context.sessionProjectId
    || references.some(reference => reference.projectId !== context.sessionProjectId)
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
  for (const reference of references) {
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

/**
 * Build the provider-independent user-turn model input. The original message
 * and structured references remain separate in Session JSONL.
 */
export function formatMessageWithProjectFileReferences(
  message: string,
  references: MessageReference[] | undefined,
): string {
  if (!references?.length) return message

  const data = escapeJsonForUntrustedMarkup(JSON.stringify(references))
  const prefix = message ? `${message}\n\n` : ''
  return `${prefix}<project_file_reference_data trust="untrusted">\n${data}\n</project_file_reference_data>`
}
