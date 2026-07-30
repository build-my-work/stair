export const PROJECT_NOTE_TARGET_EXTENSIONS = ['md', 'markdown', 'txt'] as const

const PROJECT_NOTE_TARGET_EXTENSION_SET = new Set<string>(
  PROJECT_NOTE_TARGET_EXTENSIONS,
)

export function isProjectNoteTargetPath(value: string): boolean {
  const fileName = value.split(/[\\/]/).pop() ?? ''
  const extensionIndex = fileName.lastIndexOf('.')
  if (extensionIndex <= 0) return false

  const stem = fileName.slice(0, extensionIndex)
  if (/^\.+$/.test(stem)) return false

  return PROJECT_NOTE_TARGET_EXTENSION_SET.has(
    fileName.slice(extensionIndex + 1).toLowerCase(),
  )
}
