import type { WebSelectionReference } from '@craft-agent/core/types'

export const BROWSER_SELECTION_LIMITS = {
  url: 8_192,
  title: 512,
  quote: 8_000,
  context: 64,
} as const

export const BROWSER_PAGE_SELECTION_CHANNEL = 'browser-page:selection'
export const BROWSER_OVERLAY_ASK_CHANNEL = 'browser-overlay:ask-selection'

interface BrowserSelectionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserSelectionCapturePayload {
  quote: string
  prefix?: string
  suffix?: string
  rect: BrowserSelectionRect
}

export interface BrowserSelectionAskPayload {
  eventId: string
  target: 'main' | 'sideChat'
  instanceId: string
  reference: WebSelectionReference
  boundSessionId: string | null
  /** Session explicitly associated with selections from this browser. */
  selectionSessionId: string | null
  workspaceId: string | null
}

export interface BrowserSelectionRevealResult {
  ok: boolean
  instanceId?: string
  found?: boolean
  reason?: 'invalid_reference' | 'navigation_failed' | 'unsupported_url' | 'selection_not_found'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function boundedContext(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\r\n?/g, '\n').replaceAll('\u00a0', ' ').trim()
  if (!normalized) return undefined
  return normalized.slice(-BROWSER_SELECTION_LIMITS.context)
}

export function normalizeBrowserSelectionText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    .replaceAll('\u00a0', ' ')
    .trim()
}

export function sanitizeBrowserSelectionCapture(
  value: unknown,
): BrowserSelectionCapturePayload | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<BrowserSelectionCapturePayload>
  const quote = normalizeBrowserSelectionText(candidate.quote)
  if (!quote) return null

  const rect = candidate.rect
  if (
    !rect
    || !isFiniteNumber(rect.x)
    || !isFiniteNumber(rect.y)
    || !isFiniteNumber(rect.width)
    || !isFiniteNumber(rect.height)
    || rect.width <= 0
    || rect.height <= 0
  ) {
    return null
  }

  const wasTruncated = quote.length > BROWSER_SELECTION_LIMITS.quote
  return {
    quote: quote.slice(0, BROWSER_SELECTION_LIMITS.quote),
    prefix: boundedContext(candidate.prefix),
    // A suffix captured after the original selection is not adjacent to a
    // truncated quote, so omit it rather than persisting a false locator.
    suffix: wasTruncated ? undefined : boundedContext(candidate.suffix),
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
  }
}

export function createWebSelectionReference(
  capture: BrowserSelectionCapturePayload,
  rawUrl: string,
  rawTitle: string,
): WebSelectionReference | null {
  const url = rawUrl.trim()
  if (!url || url.length > BROWSER_SELECTION_LIMITS.url) return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const title = rawTitle.trim().slice(0, BROWSER_SELECTION_LIMITS.title)
    || parsed.hostname.slice(0, BROWSER_SELECTION_LIMITS.title)
  if (!title) return null

  return {
    kind: 'web-selection',
    url,
    title,
    quote: capture.quote,
    locator: {
      type: 'text-quote',
      exact: capture.quote,
      ...(capture.prefix ? { prefix: capture.prefix } : {}),
      ...(capture.suffix ? { suffix: capture.suffix } : {}),
    },
  }
}

export function sanitizeWebSelectionReference(
  value: unknown,
): WebSelectionReference | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<WebSelectionReference>
  if (candidate.kind !== 'web-selection') return null
  if (!candidate.locator || candidate.locator.type !== 'text-quote') return null

  const url = typeof candidate.url === 'string' ? candidate.url.trim() : ''
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
  const quote = normalizeBrowserSelectionText(candidate.quote)
  const exact = normalizeBrowserSelectionText(candidate.locator.exact)
  if (
    !url
    || url !== candidate.url
    || url.length > BROWSER_SELECTION_LIMITS.url
    || !title
    || title.length > BROWSER_SELECTION_LIMITS.title
    || !quote
    || quote.length > BROWSER_SELECTION_LIMITS.quote
    || quote !== exact
  ) {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const prefix = boundedContext(candidate.locator.prefix)
  const suffix = boundedContext(candidate.locator.suffix)
  if (
    (candidate.locator.prefix !== undefined && prefix !== candidate.locator.prefix.trim())
    || (candidate.locator.suffix !== undefined && suffix !== candidate.locator.suffix.trim())
  ) {
    return null
  }

  return {
    kind: 'web-selection',
    url,
    title,
    quote,
    locator: {
      type: 'text-quote',
      exact,
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
    },
  }
}

export function calculateBrowserSelectionOverlayBounds(
  rect: BrowserSelectionRect,
  pageWidth: number,
  pageHeight: number,
  toolbarHeight: number,
  zoomFactor = 1,
) {
  const width = 176
  const height = 42
  const gap = 8
  const margin = 8
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const scaledRect = {
    x: rect.x * zoom,
    y: rect.y * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom,
  }

  const maxX = Math.max(margin, pageWidth - width - margin)
  const x = Math.min(
    maxX,
    Math.max(margin, scaledRect.x + scaledRect.width / 2 - width / 2),
  )

  const above = scaledRect.y - height - gap
  const below = scaledRect.y + scaledRect.height + gap
  const preferredY = above >= margin ? above : below
  const maxY = Math.max(margin, pageHeight - height - margin)
  const pageY = Math.min(maxY, Math.max(margin, preferredY))

  return {
    x: Math.round(x),
    y: Math.round(toolbarHeight + pageY),
    width,
    height,
  }
}

export function buildWebSelectionRevealExpression(reference: WebSelectionReference): string {
  const serialized = JSON.stringify({
    exact: reference.locator.exact,
    prefix: reference.locator.prefix ?? '',
    suffix: reference.locator.suffix ?? '',
  })

  return `(() => {
    const locator = ${serialized};
    if (!document.body || typeof window.find !== 'function') return false;

    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();

    const bodyStart = document.createRange();
    bodyStart.selectNodeContents(document.body);
    bodyStart.collapse(true);
    selection.addRange(bodyStart);

    let bestRange = null;
    let bestScore = -1;
    let firstKey = null;
    for (let index = 0; index < 100; index += 1) {
      if (!window.find(locator.exact, false, false, true, false, false, false)) break;
      if (selection.rangeCount === 0) break;
      const range = selection.getRangeAt(0).cloneRange();
      const key = [
        range.startContainer,
        range.startOffset,
        range.endContainer,
        range.endOffset,
      ];
      if (
        firstKey
        && firstKey[0] === key[0]
        && firstKey[1] === key[1]
        && firstKey[2] === key[2]
        && firstKey[3] === key[3]
      ) {
        break;
      }
      if (!firstKey) firstKey = key;

      let score = 0;
      try {
        if (locator.prefix) {
          const before = document.createRange();
          before.selectNodeContents(document.body);
          before.setEnd(range.startContainer, range.startOffset);
          if (before.toString().slice(-locator.prefix.length) === locator.prefix) score += 1;
        }
        if (locator.suffix) {
          const after = document.createRange();
          after.selectNodeContents(document.body);
          after.setStart(range.endContainer, range.endOffset);
          if (after.toString().slice(0, locator.suffix.length) === locator.suffix) score += 1;
        }
      } catch {}

      if (score > bestScore) {
        bestScore = score;
        bestRange = range;
      }
      const wantedScore = Number(Boolean(locator.prefix)) + Number(Boolean(locator.suffix));
      if (score === wantedScore) break;

      selection.removeAllRanges();
      const next = range.cloneRange();
      next.collapse(false);
      selection.addRange(next);
    }

    if (!bestRange) {
      selection.removeAllRanges();
      return false;
    }

    selection.removeAllRanges();
    selection.addRange(bestRange);
    const element = bestRange.startContainer.nodeType === Node.ELEMENT_NODE
      ? bestRange.startContainer
      : bestRange.startContainer.parentElement;
    element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });

    try {
      if (globalThis.CSS?.highlights && typeof globalThis.Highlight === 'function') {
        const name = 'craft-web-selection';
        CSS.highlights.set(name, new Highlight(bestRange));
        let style = document.getElementById('__craft_web_selection_style__');
        if (!style) {
          style = document.createElement('style');
          style.id = '__craft_web_selection_style__';
          style.textContent = '::highlight(craft-web-selection) { background: rgba(250, 204, 21, 0.55); color: inherit; }';
          document.documentElement.appendChild(style);
        }
        selection.removeAllRanges();
        window.setTimeout(() => CSS.highlights.delete(name), 6000);
      }
    } catch {}
    return true;
  })()`
}
