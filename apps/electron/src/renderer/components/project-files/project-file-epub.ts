import type {
  EpubTocNode,
} from '@craft-agent/shared/project-files'

export type { EpubTocNode } from '@craft-agent/shared/project-files'

export const EPUB_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'img-src data:',
  'media-src data:',
  'font-src data:',
  "style-src 'unsafe-inline' data:",
].join('; ')

export const EPUB_RESOURCE_REPLACEMENTS = 'blobUrl' as const

export const EPUB_INLINE_NAV_MIN_WIDTH_PX = 840

export function getEpubNavigationLayout(
  readerWidth: number,
): 'overlay' | 'inline' {
  return readerWidth < EPUB_INLINE_NAV_MIN_WIDTH_PX ? 'overlay' : 'inline'
}

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

interface EpubLoadedResource {
  dataUrl: string
  text?: string
}

type EpubResourceLoader = (
  url: string,
  includeText: boolean,
) => Promise<EpubLoadedResource>

type EpubReaderTheme = 'light' | 'dark'

interface EpubSelectionLifecycleContents {
  document: Pick<
    Document,
    'addEventListener' | 'removeEventListener' | 'getSelection'
  >
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

export function attachEpubContentsSelectionLifecycle(
  contents: EpubSelectionLifecycleContents,
  dismiss: () => void,
): () => void {
  let pointerSelectionActive = false
  const dismissOnPointerDown = () => {
    pointerSelectionActive = true
    dismiss()
  }
  const finishPointerSelection = () => {
    pointerSelectionActive = false
  }
  const dismissCollapsedSelection = () => {
    if (
      !pointerSelectionActive
      && contents.document.getSelection()?.isCollapsed
    ) {
      dismiss()
    }
  }
  const dismissOnEscape = (event: Event) => {
    if ((event as KeyboardEvent).key === 'Escape') dismiss()
  }
  const dismissOnScroll = () => dismiss()

  contents.document.addEventListener('pointerdown', dismissOnPointerDown, true)
  contents.document.addEventListener('pointerup', finishPointerSelection, true)
  contents.document.addEventListener('pointercancel', finishPointerSelection, true)
  contents.document.addEventListener('selectionchange', dismissCollapsedSelection)
  contents.document.addEventListener('keydown', dismissOnEscape, true)
  contents.window.addEventListener('scroll', dismissOnScroll, { passive: true })

  return () => {
    contents.document.removeEventListener('pointerdown', dismissOnPointerDown, true)
    contents.document.removeEventListener('pointerup', finishPointerSelection, true)
    contents.document.removeEventListener('pointercancel', finishPointerSelection, true)
    contents.document.removeEventListener('selectionchange', dismissCollapsedSelection)
    contents.document.removeEventListener('keydown', dismissOnEscape, true)
    contents.window.removeEventListener('scroll', dismissOnScroll)
  }
}

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
const LINK_TAG = /<(?:[\w.-]+:)?link\b[^>]*\/?>/gi
const HEAD_START_TAG = /<(?:[\w.-]+:)?head\b[^>]*>/i
const HTML_START_TAG = /<(?:[\w.-]+:)?html\b[^>]*>/i
const BLOB_URL = /blob:[^\s"'()<>]+/g

function htmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`,
    'i',
  ).exec(tag)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

function inlineDataStylesheet(tag: string): string {
  const rel = htmlAttribute(tag, 'rel')?.trim().toLowerCase()
  const href = htmlAttribute(tag, 'href')
  if (rel !== 'stylesheet' || !href) return tag

  const match = /^data:text\/css(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(href)
  if (!match) return tag
  try {
    const css = match[1]
      ? atob(match[2] ?? '')
      : decodeURIComponent(match[2] ?? '')
    return stylesheetElement(tag, css)
  } catch {
    return ''
  }
}

function escapeStyleElementText(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style')
}

function stylesheetElement(tag: string, css: string): string {
  const media = htmlAttribute(tag, 'media')
  const mediaAttribute = media
    ? ` media="${media.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`
    : ''
  return `<style${mediaAttribute}>${escapeStyleElementText(css)}</style>`
}

async function replaceMatches(
  value: string,
  pattern: RegExp,
  replace: (match: string) => Promise<string>,
): Promise<string> {
  const matches = [...value.matchAll(pattern)]
  if (matches.length === 0) return value
  const replacements = await Promise.all(matches.map(match => replace(match[0])))
  let result = ''
  let cursor = 0
  for (const [index, match] of matches.entries()) {
    result += value.slice(cursor, match.index) + replacements[index]
    cursor = (match.index ?? 0) + match[0].length
  }
  return result + value.slice(cursor)
}

async function readBlobResource(
  url: string,
  includeText: boolean,
): Promise<EpubLoadedResource> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`EPUB resource returned ${response.status}`)
  const blob = await response.blob()
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('EPUB resource could not be encoded'))
    }, { once: true })
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('EPUB resource could not be read'))
    }, { once: true })
    reader.readAsDataURL(blob)
  })
  return {
    dataUrl,
    ...(includeText ? { text: await blob.text() } : {}),
  }
}

async function materializeEpubSectionResources(
  serialized: string,
  load: EpubResourceLoader,
): Promise<string> {
  const withInlineStyles = await replaceMatches(
    serialized,
    new RegExp(LINK_TAG.source, LINK_TAG.flags),
    async (tag) => {
      const rel = htmlAttribute(tag, 'rel')?.trim().toLowerCase()
      const href = htmlAttribute(tag, 'href')
      if (rel !== 'stylesheet' || !href?.startsWith('blob:')) return tag
      try {
        const resource = await load(href, true)
        return resource.text === undefined
          ? tag.replace(href, resource.dataUrl)
          : stylesheetElement(tag, resource.text)
      } catch {
        return ''
      }
    },
  )
  const urls = [...new Set(withInlineStyles.match(BLOB_URL) ?? [])]
  const replacements = await Promise.all(urls.map(async (url) => {
    try {
      return [url, (await load(url, false)).dataUrl] as const
    } catch {
      return [url, 'data:,'] as const
    }
  }))
  return replacements.reduce(
    (result, [url, replacement]) => result.replaceAll(url, replacement),
    withInlineStyles,
  )
}

function metaHttpEquiv(tag: string): string | null {
  return htmlAttribute(tag, 'http-equiv')?.trim().toLowerCase() || null
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
    .replace(LINK_TAG, inlineDataStylesheet)
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

export function createEpubSerializeHook(
  resourceLoader: EpubResourceLoader = readBlobResource,
): (
  serialized: string,
  section: EpubSerializeSection,
) => Promise<void> {
  return async (_serialized, section) => {
    const cache = new Map<string, Promise<EpubLoadedResource>>()
    const load = (url: string, includeText: boolean) => {
      const key = `${includeText ? 'text' : 'binary'}\0${url}`
      const cached = cache.get(key)
      if (cached) return cached
      const pending = resourceLoader(url, includeText)
      cache.set(key, pending)
      return pending
    }
    const materialized = await materializeEpubSectionResources(section.output, load)
    section.output = hardenEpubSerializedHtml(materialized)
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
