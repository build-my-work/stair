import {
  isWebSelectionReference,
  MAX_REFERENCE_CONTEXT_CHARS,
  MAX_REFERENCE_QUOTE_CHARS,
  MAX_REFERENCE_TITLE_CHARS,
  MAX_REFERENCE_URL_CHARS,
  type WebSelectionReferenceV1,
  type WebTextQuoteLocatorV1,
} from '@craft-agent/core'
import type { BrowserSelectionSource } from '@craft-agent/shared/protocol'

export type { BrowserSelectionSource } from '@craft-agent/shared/protocol'

export const BROWSER_PAGE_SELECTION_CHANNEL = 'browser-page:selection'
export const BROWSER_OVERLAY_ACTION_CHANNEL = 'browser-overlay:selection-action'
export const BROWSER_SELECTION_LIMITS = {
  url: MAX_REFERENCE_URL_CHARS,
  title: MAX_REFERENCE_TITLE_CHARS,
  quote: MAX_REFERENCE_QUOTE_CHARS,
  context: MAX_REFERENCE_CONTEXT_CHARS,
} as const

const BROWSER_SELECTION_ACTIONS = [
  'add-note',
  'add-note-to',
  'add-chat',
  'new-chat',
] as const

export type BrowserSelectionAction = typeof BROWSER_SELECTION_ACTIONS[number]

export interface BrowserSelectionRect {
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

export function isBrowserSelectionAction(value: unknown): value is BrowserSelectionAction {
  return BROWSER_SELECTION_ACTIONS.some(action => action === value)
}

export function normalizeBrowserSelectionText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').replaceAll('\u00a0', ' ').trim()
}

function boundedContext(value: unknown, side: 'prefix' | 'suffix'): string | undefined {
  const normalized = normalizeBrowserSelectionText(value)
  if (!normalized) return undefined
  return side === 'prefix'
    ? normalized.slice(-MAX_REFERENCE_CONTEXT_CHARS)
    : normalized.slice(0, MAX_REFERENCE_CONTEXT_CHARS)
}

export function sanitizeBrowserSelectionCapture(
  value: unknown,
): BrowserSelectionCapturePayload | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<BrowserSelectionCapturePayload>
  const quote = normalizeBrowserSelectionText(candidate.quote)
  const rect = candidate.rect
  if (
    !quote
    || !rect
    || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0
    || rect.height <= 0
  ) return null

  const truncated = quote.length > MAX_REFERENCE_QUOTE_CHARS
  return {
    quote: quote.slice(0, MAX_REFERENCE_QUOTE_CHARS),
    prefix: boundedContext(candidate.prefix, 'prefix'),
    suffix: truncated ? undefined : boundedContext(candidate.suffix, 'suffix'),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  }
}

export function createBrowserSelectionSource(
  capture: BrowserSelectionCapturePayload,
  rawUrl: string,
  rawTitle: string,
): BrowserSelectionSource | null {
  const url = rawUrl.trim()
  if (!url || url.length > MAX_REFERENCE_URL_CHARS) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const title = normalizeBrowserSelectionText(rawTitle)
    .slice(0, MAX_REFERENCE_TITLE_CHARS) || parsed.hostname
  return {
    url,
    title,
    quote: capture.quote,
    locator: {
      type: 'web-text-quote',
      exact: capture.quote,
      ...(capture.prefix ? { prefix: capture.prefix } : {}),
      ...(capture.suffix ? { suffix: capture.suffix } : {}),
    },
  }
}

export function createWebSelectionReference(
  projectId: string,
  capture: BrowserSelectionCapturePayload,
  rawUrl: string,
  rawTitle: string,
): WebSelectionReferenceV1 | null {
  if (!projectId || projectId !== projectId.trim()) return null
  const source = createBrowserSelectionSource(capture, rawUrl, rawTitle)
  if (!source) return null
  return { version: 1, kind: 'web-selection', projectId, ...source }
}

export function browserSelectionSourceToReference(
  projectId: string,
  source: BrowserSelectionSource,
): WebSelectionReferenceV1 | null {
  const reference = { version: 1, kind: 'web-selection', projectId, ...source } as const
  return isWebSelectionReference(reference) ? reference : null
}

export function sanitizeWebSelectionReference(
  value: unknown,
): WebSelectionReferenceV1 | null {
  return isWebSelectionReference(value) ? value : null
}

export function calculateBrowserSelectionOverlayBounds(
  rect: BrowserSelectionRect,
  pageWidth: number,
  pageHeight: number,
  toolbarHeight: number,
  zoomFactor = 1,
): BrowserSelectionRect {
  const width = 280
  const height = 56
  const gap = 10
  const margin = 8
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const scaled = {
    x: rect.x * zoom,
    y: rect.y * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom,
  }
  const x = Math.min(
    Math.max(margin, pageWidth - width - margin),
    Math.max(margin, scaled.x + scaled.width / 2 - width / 2),
  )
  const above = scaled.y - height - gap
  const preferredY = above >= margin ? above : scaled.y + scaled.height + gap
  const pageY = Math.min(
    Math.max(margin, pageHeight - height - margin),
    Math.max(margin, preferredY),
  )
  return { x: Math.round(x), y: Math.round(toolbarHeight + pageY), width, height }
}

export function buildWebSelectionRevealExpression(
  reference: WebSelectionReferenceV1,
): string {
  const locator = JSON.stringify({
    exact: reference.locator.exact,
    prefix: reference.locator.prefix ?? '',
    suffix: reference.locator.suffix ?? '',
  })
  return `(() => {
    const locator = ${locator};
    if (!document.body || typeof window.find !== 'function') return false;
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    const start = document.createRange();
    start.selectNodeContents(document.body);
    start.collapse(true);
    selection.addRange(start);
    let best = null;
    let bestScore = -1;
    for (let index = 0; index < 100; index += 1) {
      if (!window.find(locator.exact, false, false, true, false, false, false)) break;
      if (selection.rangeCount === 0) break;
      const range = selection.getRangeAt(0).cloneRange();
      let score = 0;
      try {
        if (locator.prefix) {
          const before = document.createRange();
          before.selectNodeContents(document.body);
          before.setEnd(range.startContainer, range.startOffset);
          const text = before.toString().replaceAll('\u00a0', ' ').trimEnd();
          if (text.slice(-locator.prefix.length) === locator.prefix) score += 1;
        }
        if (locator.suffix) {
          const after = document.createRange();
          after.selectNodeContents(document.body);
          after.setStart(range.endContainer, range.endOffset);
          const text = after.toString().replaceAll('\u00a0', ' ').trimStart();
          if (text.slice(0, locator.suffix.length) === locator.suffix) score += 1;
        }
      } catch {}
      if (score > bestScore) { best = range; bestScore = score; }
      selection.removeAllRanges();
      const next = range.cloneRange();
      next.collapse(false);
      selection.addRange(next);
    }
    if (!best) { selection.removeAllRanges(); return false; }
    selection.removeAllRanges();
    selection.addRange(best);
    const element = best.startContainer.nodeType === Node.ELEMENT_NODE
      ? best.startContainer
      : best.startContainer.parentElement;
    element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    return true;
  })()`
}
