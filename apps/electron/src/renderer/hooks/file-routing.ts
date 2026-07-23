/**
 * True when a file link can be handed to the working-directory RPC without
 * weakening its relative-path-only trust boundary.
 */
export function isProjectRelativeFilePath(path: string): boolean {
  const value = path.trim().replaceAll('\\', '/')
  if (!value || value.startsWith('/') || /^[a-zA-Z]:\//.test(value) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
    return false
  }

  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return false
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.length > 0
}
