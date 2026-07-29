import type {
  EpubTocNode,
  ProjectFileIdentity,
  SourceFingerprint,
} from '@craft-agent/core/types'

export type { EpubTocNode } from '@craft-agent/core/types'

export const EPUB_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'img-src blob: data:',
  'media-src blob: data:',
  'font-src blob: data:',
  "style-src 'unsafe-inline' blob:",
].join('; ')

interface EpubNavigationItem {
  label?: string
  href?: string
  subitems?: EpubNavigationItem[]
}

interface NormalizedEpubHref {
  document: string
  fragment: string
}

interface EpubSerializeSection {
  output: string
}

type EpubReaderTheme = 'light' | 'dark'

interface EpubClientRect {
  left: number
  top: number
  width: number
  height: number
}

export interface EpubSelectionViewportRect {
  x: number
  y: number
  width: number
  height: number
}

export function getEpubSelectionViewportRect(
  rangeRects: EpubClientRect[],
  iframeRect: EpubClientRect,
  iframeClientSize: { width: number; height: number },
): EpubSelectionViewportRect | null {
  const values = [
    iframeRect.left,
    iframeRect.top,
    iframeRect.width,
    iframeRect.height,
    iframeClientSize.width,
    iframeClientSize.height,
  ]
  if (
    values.some(value => !Number.isFinite(value))
    || iframeRect.width <= 0
    || iframeRect.height <= 0
    || iframeClientSize.width <= 0
    || iframeClientSize.height <= 0
  ) {
    return null
  }

  const validRects = rangeRects.flatMap(rect => {
    if (
      ![rect.left, rect.top, rect.width, rect.height]
        .every(value => Number.isFinite(value))
      || rect.width <= 0
      || rect.height <= 0
    ) {
      return []
    }

    const left = Math.max(0, rect.left)
    const top = Math.max(0, rect.top)
    const right = Math.min(iframeClientSize.width, rect.left + rect.width)
    const bottom = Math.min(iframeClientSize.height, rect.top + rect.height)
    if (right <= left || bottom <= top) return []

    return [{ left, top, width: right - left, height: bottom - top }]
  })
  if (validRects.length === 0) return null

  const scaleX = iframeRect.width / iframeClientSize.width
  const scaleY = iframeRect.height / iframeClientSize.height
  const left = iframeRect.left
    + Math.min(...validRects.map(rect => rect.left)) * scaleX
  const top = iframeRect.top
    + Math.min(...validRects.map(rect => rect.top)) * scaleY
  const right = iframeRect.left
    + Math.max(...validRects.map(rect => rect.left + rect.width)) * scaleX
  const bottom = iframeRect.top
    + Math.max(...validRects.map(rect => rect.top + rect.height)) * scaleY

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }
}

export function createProjectFileEpubViewerKey(
  identity: ProjectFileIdentity,
  sourceFingerprint: SourceFingerprint,
): string {
  return `${identity.projectId}\0${identity.relativePath}\0${sourceFingerprint}`
}

export function getEpubRenditionOptions(fixedLayout: boolean) {
  return {
    width: '100%',
    height: '100%',
    manager: 'continuous',
    flow: 'scrolled',
    layout: fixedLayout ? 'pre-paginated' : 'reflowable',
    spread: 'none',
    allowScriptedContent: false,
    allowPopups: false,
  }
}

export function isFixedLayoutEpub(
  metadataLayout: string | undefined,
  displayFixedLayout: string | undefined,
): boolean {
  return metadataLayout === 'pre-paginated' || displayFixedLayout === 'true'
}

export function mapEpubNavigation(
  items: EpubNavigationItem[],
  parentOrderPath: number[] = [],
): EpubTocNode[] {
  return items.map((item, index) => {
    const orderPath = [...parentOrderPath, index]
    return {
      key: `toc:${orderPath.join('.')}`,
      title: item.label?.trim() || 'Untitled chapter',
      ...(item.href ? { href: item.href } : {}),
      orderPath,
      children: mapEpubNavigation(item.subitems ?? [], orderPath),
    }
  })
}

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizeDocumentPath(value: string): string {
  const slashes = safelyDecode(value.trim()).replaceAll('\\', '/')
  const withoutQuery = slashes.split('?', 1)[0] ?? ''
  const segments: string[] = []
  for (const segment of withoutQuery.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

export function normalizeEpubHref(value: string | undefined): NormalizedEpubHref {
  if (!value) return { document: '', fragment: '' }
  const hashIndex = value.indexOf('#')
  const document = hashIndex >= 0 ? value.slice(0, hashIndex) : value
  const fragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : ''
  return {
    document: normalizeDocumentPath(document),
    fragment: safelyDecode(fragment.trim()),
  }
}

function documentsMatch(left: string, right: string): boolean {
  if (!left || !right) return false
  return left === right
    || left.endsWith(`/${right}`)
    || right.endsWith(`/${left}`)
}

interface FlatTocNode {
  node: EpubTocNode
  depth: number
  order: number
}

function flattenToc(
  nodes: EpubTocNode[],
  depth = 0,
  result: FlatTocNode[] = [],
): FlatTocNode[] {
  for (const node of nodes) {
    result.push({ node, depth, order: result.length })
    flattenToc(node.children, depth + 1, result)
  }
  return result
}

function deepestTocNode(matches: FlatTocNode[]): EpubTocNode | null {
  if (matches.length === 0) return null
  return [...matches].sort(
    (left, right) => right.depth - left.depth || left.order - right.order,
  )[0]?.node ?? null
}

export function findCurrentEpubTocNode(
  toc: EpubTocNode[],
  locationHref: string | undefined,
): EpubTocNode | null {
  const location = normalizeEpubHref(locationHref)
  if (!location.document) return null
  const candidates = flattenToc(toc).filter(({ node }) => {
    const href = normalizeEpubHref(node.href)
    return documentsMatch(href.document, location.document)
  })

  const exact = candidates.filter(({ node }) => {
    const href = normalizeEpubHref(node.href)
    return href.fragment === location.fragment
  })
  return deepestTocNode(exact) ?? deepestTocNode(candidates)
}

const SCRIPT_ELEMENT = /<(?:[\w.-]+:)?script\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?script\s*>/gi
const SCRIPT_TAG = /<(?:[\w.-]+:)?script\b[^>]*\/?>/gi
const BASE_TAG = /<(?:[\w.-]+:)?base\b[^>]*\/?>/gi
const META_TAG = /<(?:[\w.-]+:)?meta\b[^>]*\/?>/gi
const HEAD_START_TAG = /<(?:[\w.-]+:)?head\b[^>]*>/i
const HTML_START_TAG = /<(?:[\w.-]+:)?html\b[^>]*>/i

function metaHttpEquiv(tag: string): string | null {
  const match = /\bhttp-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/i.exec(tag)
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim().toLowerCase() || null
}

/**
 * This is deliberately a narrow pre-write hardening step, not a general HTML
 * sanitizer. The iframe sandbox and CSP remain the primary containment layers.
 */
export function hardenEpubSerializedHtml(serialized: string): string {
  const withoutExecutableElements = serialized
    .replace(SCRIPT_ELEMENT, '')
    .replace(SCRIPT_TAG, '')
    .replace(BASE_TAG, '')
    .replace(META_TAG, tag => {
      const httpEquiv = metaHttpEquiv(tag)
      return httpEquiv === 'refresh' || httpEquiv === 'content-security-policy'
        ? ''
        : tag
    })

  const csp =
    `<meta http-equiv="Content-Security-Policy" content="${EPUB_DOCUMENT_CSP}">`
  if (HEAD_START_TAG.test(withoutExecutableElements)) {
    return withoutExecutableElements.replace(HEAD_START_TAG, tag => `${tag}${csp}`)
  }
  if (HTML_START_TAG.test(withoutExecutableElements)) {
    return withoutExecutableElements.replace(HTML_START_TAG, tag => `${tag}<head>${csp}</head>`)
  }
  return `${csp}${withoutExecutableElements}`
}

export function createEpubSerializeHook(): (
  serialized: string,
  section: EpubSerializeSection,
) => void {
  return (serialized, section) => {
    section.output = hardenEpubSerializedHtml(serialized)
  }
}

export function shouldBlockEpubLink(
  href: string | null | undefined,
  target?: string | null,
): boolean {
  const normalizedTarget = target?.trim().toLowerCase()
  if (normalizedTarget && normalizedTarget !== '_self') return true

  const value = href?.trim()
  if (!value || value.startsWith('#')) return false
  if (value.startsWith('//')) return true

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  return scheme !== undefined && scheme !== 'epubcfi'
}

export function getEpubReaderTheme(theme: EpubReaderTheme) {
  const dark = theme === 'dark'
  return {
    'html, body': {
      'background-color': dark ? '#151821' : '#f8fafc',
    },
    body: {
      color: dark ? '#e5e7eb' : '#20242b',
      'background-color': dark ? '#151821' : '#f8fafc',
      'font-family': 'Charter, "Iowan Old Style", "Songti SC", STSong, serif',
      'font-size': '16px',
      'line-height': '1.72',
      margin: '0 auto',
      'max-width': '720px',
      padding: '30px clamp(22px, 6vw, 48px)',
    },
    a: {
      color: dark ? '#b7a8e6' : '#624f8f',
    },
    'code, pre': {
      'font-family': '"JetBrains Mono", ui-monospace, monospace',
    },
    'img, svg, video': {
      'max-width': '100%',
      height: 'auto',
    },
  }
}

export function createIdempotentEpubCleanup(
  cleanups: Array<() => void>,
): () => void {
  let cleaned = false
  return () => {
    if (cleaned) return
    cleaned = true
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // Resource cleanup must continue even when one third-party disposer fails.
      }
    }
  }
}

interface EpubRenditionSize {
  width: number
  height: number
}

function normalizeEpubRenditionSize(
  width: number,
  height: number,
): EpubRenditionSize | null {
  const normalized = {
    width: Math.floor(width),
    height: Math.floor(height),
  }
  return (
    Number.isFinite(normalized.width)
    && Number.isFinite(normalized.height)
    && normalized.width > 0
    && normalized.height > 0
  )
    ? normalized
    : null
}

function isSameEpubRenditionSize(
  left: EpubRenditionSize | null,
  right: EpubRenditionSize | null,
): boolean {
  return (
    left !== null
    && right !== null
    && left.width === right.width
    && left.height === right.height
  )
}

/**
 * Coalesces continuous panel changes into one trailing epub.js resize and
 * skips dimensions already applied at integer-pixel precision.
 */
export function createEpubResizeScheduler(
  resize: (width: number, height: number) => void,
  initialSize?: { width: number; height: number },
  delayMs = 150,
): {
  schedule: (width: number, height: number) => void
  cancel: () => void
} {
  let lastSize = initialSize
    ? normalizeEpubRenditionSize(initialSize.width, initialSize.height)
    : null
  let pendingSize: EpubRenditionSize | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancelPending = () => {
    if (timer) clearTimeout(timer)
    timer = null
    pendingSize = null
  }

  return {
    schedule(width, height) {
      const nextSize = normalizeEpubRenditionSize(width, height)
      if (!nextSize) {
        cancelPending()
        return
      }
      if (isSameEpubRenditionSize(nextSize, pendingSize)) return

      cancelPending()
      if (isSameEpubRenditionSize(nextSize, lastSize)) return

      pendingSize = nextSize
      timer = setTimeout(() => {
        const size = pendingSize
        timer = null
        pendingSize = null
        if (!size || isSameEpubRenditionSize(size, lastSize)) return
        lastSize = size
        resize(size.width, size.height)
      }, delayMs)
    },
    cancel: cancelPending,
  }
}
