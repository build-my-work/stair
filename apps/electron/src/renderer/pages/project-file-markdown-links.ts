import { isCanonicalProjectRelativePath } from '@craft-agent/shared/project-files'
import { classifyExternalUrl } from '@craft-agent/shared/utils/url-safety'

export type ProjectFileMarkdownTarget =
  | { kind: 'project-file'; relativePath: string }
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'blocked'; target: string }

function decodeLinkPath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function resolveProjectFileMarkdownTarget(
  currentRelativePath: string,
  rawTarget: string,
): ProjectFileMarkdownTarget {
  const target = rawTarget.trim()
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('//')) {
    return classifyExternalUrl(target).kind === 'dangerous'
      ? { kind: 'blocked', target }
      : { kind: 'url', url: target }
  }

  if (/^(?:\/|~\/|[a-z]:[\\/]|\\\\)/iu.test(target)) {
    return { kind: 'file', path: decodeLinkPath(target) }
  }

  const linkPath = decodeLinkPath(target.split(/[?#]/u, 1)[0] ?? '')
    .replaceAll('\\', '/')
  if (!linkPath) return { kind: 'blocked', target }

  const segments = currentRelativePath.split('/').slice(0, -1)
  for (const segment of linkPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return { kind: 'blocked', target }
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  const relativePath = segments.join('/')
  return relativePath && isCanonicalProjectRelativePath(relativePath)
    ? { kind: 'project-file', relativePath }
    : { kind: 'blocked', target }
}
