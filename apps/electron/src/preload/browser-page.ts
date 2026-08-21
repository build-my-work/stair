/**
 * Sandboxed preload for untrusted browser pages.
 *
 * Captures bounded text selections created by real user gestures without
 * exposing an API into the page's main world.
 */

import { ipcRenderer } from 'electron'
import {
  BROWSER_PAGE_SELECTION_CHANNEL,
  BROWSER_SELECTION_LIMITS,
  normalizeBrowserSelectionText,
  type BrowserSelectionCapturePayload,
} from '../shared/browser-selection'

const SELECTION_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'a',
  'A',
])

let captureToken = 0
let selectionVisible = false

function isSupportedMainFrame(): boolean {
  return window.top === window
    && (location.protocol === 'http:' || location.protocol === 'https:')
}

function elementForNode(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement
}

function isEditableNode(node: Node | null): boolean {
  const element = elementForNode(node)
  if (!element) return false
  return Boolean(element.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  ))
}

function clearSelectionCapture(): void {
  captureToken += 1
  if (!selectionVisible) return
  selectionVisible = false
  ipcRenderer.send(BROWSER_PAGE_SELECTION_CHANNEL, null)
}

function textBeforeBoundary(range: Range, limit: number): string {
  const root = document.body
  const boundary = range.startContainer
  if (
    !root
    || boundary.nodeType !== Node.TEXT_NODE
    || !root.contains(boundary)
  ) {
    return ''
  }

  const chunks = [(boundary.nodeValue ?? '').slice(0, range.startOffset)]
  let length = chunks[0].length
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  walker.currentNode = boundary
  while (length < limit) {
    const previous = walker.previousNode()
    if (!previous) break
    const value = previous.nodeValue ?? ''
    chunks.unshift(value)
    length += value.length
  }
  return normalizeBrowserSelectionText(chunks.join('')).slice(-limit)
}

function textAfterBoundary(range: Range, limit: number): string {
  const root = document.body
  const boundary = range.endContainer
  if (
    !root
    || boundary.nodeType !== Node.TEXT_NODE
    || !root.contains(boundary)
  ) {
    return ''
  }

  const chunks = [(boundary.nodeValue ?? '').slice(range.endOffset)]
  let length = chunks[0].length
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  walker.currentNode = boundary
  while (length < limit) {
    const next = walker.nextNode()
    if (!next) break
    const value = next.nodeValue ?? ''
    chunks.push(value)
    length += value.length
  }
  return normalizeBrowserSelectionText(chunks.join('')).slice(0, limit)
}

function captureSelection(expectedToken: number): void {
  if (expectedToken !== captureToken || !isSupportedMainFrame()) return

  const selection = window.getSelection()
  if (
    !selection
    || selection.isCollapsed
    || selection.rangeCount !== 1
    || isEditableNode(selection.anchorNode)
    || isEditableNode(selection.focusNode)
  ) {
    clearSelectionCapture()
    return
  }

  const range = selection.getRangeAt(0)
  if (isEditableNode(range.commonAncestorContainer)) {
    clearSelectionCapture()
    return
  }

  const rawQuote = normalizeBrowserSelectionText(selection.toString())
  if (!rawQuote) {
    clearSelectionCapture()
    return
  }

  const rects = Array.from(range.getClientRects())
    .filter(rect => rect.width > 0 && rect.height > 0)
  const focusAtStart = selection.focusNode === range.startContainer
    && selection.focusOffset === range.startOffset
  const focusRect = rects[focusAtStart ? 0 : rects.length - 1]
    ?? range.getBoundingClientRect()
  if (
    !Number.isFinite(focusRect.x)
    || !Number.isFinite(focusRect.y)
    || focusRect.width <= 0
    || focusRect.height <= 0
  ) {
    clearSelectionCapture()
    return
  }

  const truncated = rawQuote.length > BROWSER_SELECTION_LIMITS.quote
  const prefix = textBeforeBoundary(
    range,
    BROWSER_SELECTION_LIMITS.context,
  ) || undefined
  let suffix: string | undefined
  if (!truncated) {
    suffix = textAfterBoundary(
      range,
      BROWSER_SELECTION_LIMITS.context,
    ) || undefined
  }
  const payload: BrowserSelectionCapturePayload = {
    quote: rawQuote.slice(0, BROWSER_SELECTION_LIMITS.quote),
    prefix,
    suffix,
    rect: {
      x: focusRect.x,
      y: focusRect.y,
      width: focusRect.width,
      height: focusRect.height,
    },
  }

  selectionVisible = true
  ipcRenderer.send(BROWSER_PAGE_SELECTION_CHANNEL, payload)
}

function scheduleCapture(): void {
  const token = ++captureToken
  requestAnimationFrame(() => captureSelection(token))
}

if (isSupportedMainFrame()) {
  window.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted || !event.isPrimary) return
    clearSelectionCapture()
  }, true)

  window.addEventListener('pointerup', (event) => {
    if (
      !event.isTrusted
      || !event.isPrimary
      || isEditableNode(event.target as Node | null)
    ) {
      return
    }
    scheduleCapture()
  }, true)

  window.addEventListener('keyup', (event) => {
    if (
      !event.isTrusted
      || !SELECTION_KEYS.has(event.key)
      || isEditableNode(event.target as Node | null)
    ) {
      return
    }
    scheduleCapture()
  }, true)

  window.addEventListener('scroll', clearSelectionCapture, true)
  window.addEventListener('resize', clearSelectionCapture, true)
  window.addEventListener('pagehide', clearSelectionCapture, true)
}
