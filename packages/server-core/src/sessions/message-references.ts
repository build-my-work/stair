import {
  isReference,
  MAX_REFERENCES_SERIALIZED_BYTES,
  MAX_REFERENCES_PER_MESSAGE,
  MAX_REFERENCE_SERIALIZED_BYTES,
  referenceSerializedByteLength,
  referenceKey,
  type Reference,
} from '@craft-agent/core'
import { classifyProjectFile } from '@craft-agent/shared/project-files'

import {
  readProjectFileBinaryWithinRoot,
  readProjectTextFileWithinRoot,
  resolveProjectWorkingDirectory,
} from '../handlers/rpc/project-files'

interface ReferenceSession {
  id: string
  workspaceId: string
  projectId: string
  messages?: Array<{
    id: string
    role: string
    content: string
  }>
}

type ReferenceTarget = Pick<ReferenceSession, 'id' | 'workspaceId' | 'projectId'>

export function normalizeReferencesForSession(
  values: unknown,
  target: ReferenceTarget,
): Reference[] {
  if (!Array.isArray(values) || values.length > MAX_REFERENCES_PER_MESSAGE) {
    throw new Error('MESSAGE_REFERENCE_INVALID: Invalid reference list')
  }

  const references: Reference[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  for (const value of values) {
    if (!isReference(value)) {
      throw new Error('MESSAGE_REFERENCE_INVALID: Invalid reference')
    }
    if (value.projectId !== target.projectId) {
      throw new Error('MESSAGE_REFERENCE_PROJECT_MISMATCH: Reference belongs to another Project')
    }
    const key = referenceKey(value)
    if (!seen.has(key)) {
      const bytes = referenceSerializedByteLength(value)
      if (bytes > MAX_REFERENCE_SERIALIZED_BYTES) {
        throw new Error('MESSAGE_REFERENCE_TOO_LARGE: Reference exceeds the size limit')
      }
      totalBytes += bytes
      if (totalBytes > MAX_REFERENCES_SERIALIZED_BYTES) {
        throw new Error('MESSAGE_REFERENCE_TOO_LARGE: Reference list exceeds the size limit')
      }
      seen.add(key)
      references.push(value)
    }
  }
  return references
}

export function validateReferencesForSession(
  values: unknown,
  target: ReferenceTarget,
  resolveSession: (sessionId: string) => ReferenceSession | null,
): Reference[] {
  const references = normalizeReferencesForSession(values, target)
  for (const reference of references) {
    if (reference.kind === 'chat-message') {
      const source = resolveSession(reference.sessionId)
      if (!source) {
        throw new Error('MESSAGE_REFERENCE_SOURCE_INVALID: Chat selection source is unavailable')
      }
      if (source.workspaceId !== target.workspaceId) {
        throw new Error('MESSAGE_REFERENCE_WORKSPACE_MISMATCH: Chat source belongs to another Workspace')
      }
      if (source.projectId !== target.projectId) {
        throw new Error('MESSAGE_REFERENCE_PROJECT_MISMATCH: Chat source belongs to another Project')
      }
      const message = source.messages?.find(candidate => (
        candidate.id === reference.messageId && candidate.role === reference.role
      ))
      if (!message) {
        throw new Error('MESSAGE_REFERENCE_SOURCE_INVALID: Chat selection source is unavailable')
      }
    }
  }
  return references
}

export async function validateProjectFileReferencesForSend(
  references: Reference[],
  workspaceRootPath: string,
): Promise<void> {
  const roots = new Map<string, Promise<string>>()
  for (const reference of references) {
    if (reference.kind !== 'project-file') continue
    try {
      let root = roots.get(reference.projectId)
      if (!root) {
        root = resolveProjectWorkingDirectory(workspaceRootPath, reference.projectId)
        roots.set(reference.projectId, root)
      }
      const rootPath = await root
      const kind = classifyProjectFile(reference.relativePath)
      let sourceFingerprint: string
      if (kind === 'epub' || kind === 'pdf') {
        sourceFingerprint = (await readProjectFileBinaryWithinRoot(rootPath, reference)).sourceFingerprint
      } else if (kind === 'markdown' || kind === 'json' || kind === 'code' || kind === 'text') {
        sourceFingerprint = (await readProjectTextFileWithinRoot(rootPath, reference)).sourceFingerprint
      } else {
        throw new Error('MESSAGE_REFERENCE_SOURCE_INVALID: Project File reference is unsupported')
      }
      if (sourceFingerprint !== reference.sourceFingerprint) {
        throw new Error('MESSAGE_REFERENCE_SOURCE_CHANGED: Project File changed after selection')
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('MESSAGE_REFERENCE_')) throw error
      throw new Error('MESSAGE_REFERENCE_SOURCE_INVALID: Project File source is unavailable')
    }
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

const REFERENCE_DATA_OPEN = '<stair_reference_data trust="untrusted">'
const REFERENCE_DATA_CLOSE = '</stair_reference_data>'

export function formatReferencesForModel(message: string, references: Reference[]): string {
  if (references.length === 0) return message
  const context = [
    REFERENCE_DATA_OPEN,
    escapeXml(JSON.stringify(references, null, 2)),
    REFERENCE_DATA_CLOSE,
  ].join('\n')
  return message ? `${message}\n\n${context}` : context
}

export function stripReferencesFromModelInput(message: string): string {
  const suffix = `\n${REFERENCE_DATA_CLOSE}`
  if (!message.endsWith(suffix)) return message

  const blockStart = message.lastIndexOf(`\n\n${REFERENCE_DATA_OPEN}\n`)
  if (blockStart >= 0) return message.slice(0, blockStart)
  return message.startsWith(`${REFERENCE_DATA_OPEN}\n`) ? '' : message
}
