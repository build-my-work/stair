import { isCanonicalProjectRelativePath } from '../project-files'

const PROJECT_NOTE_EXTENSIONS = new Set(['md', 'markdown', 'txt'])

export function isProjectNoteTargetPath(value: unknown): value is string {
  if (!isCanonicalProjectRelativePath(value)) return false
  const fileName = value.split('/').at(-1) ?? ''
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return false
  return PROJECT_NOTE_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase())
}
