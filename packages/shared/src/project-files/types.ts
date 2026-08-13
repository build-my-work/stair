export const MAX_PROJECT_FILE_PATH_BYTES = 2_048
export const MAX_PROJECT_FILE_TEXT_BYTES = 8 * 1024 * 1024
export const MAX_EDITABLE_PROJECT_FILE_BYTES = 1024 * 1024

export type ProjectFileFingerprint = `sha256:${string}`

export interface ProjectFileRequest {
  projectId: string
  relativePath: string
}

export interface ProjectDirectoryEntriesRequest {
  projectId: string
  relativePath?: string
}

export interface ProjectDirectoryEntry {
  name: string
  relativePath: string
  type: 'directory' | 'file'
  byteLength?: number
  lastModifiedMs?: number
}

export interface ProjectDirectoryEntriesResult {
  entries: ProjectDirectoryEntry[]
  truncated: boolean
}

export interface ProjectFileMetadata {
  projectId: string
  relativePath: string
  name: string
  mimeType: string
  byteLength: number
  lastModifiedMs: number
}

export interface ProjectFileTextResponse {
  metadata: ProjectFileMetadata
  text: string
  sourceFingerprint: ProjectFileFingerprint
}

export interface SaveProjectTextFileRequest extends ProjectFileRequest {
  expectedFingerprint: ProjectFileFingerprint
  content: string
}

export interface SaveProjectTextFileResponse {
  metadata: ProjectFileMetadata
  sourceFingerprint: ProjectFileFingerprint
}

/**
 * Project File 在状态、路由和 RPC 中只允许一种身份表示。
 * 路径必须非空、相对 Project 根、使用 POSIX 分隔符，且不包含 `.`/`..` 段。
 */
export function isCanonicalProjectRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || new TextEncoder().encode(value).byteLength > MAX_PROJECT_FILE_PATH_BYTES
  ) {
    return false
  }

  const segments = value.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

export function isProjectFileFingerprint(value: unknown): value is ProjectFileFingerprint {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}
