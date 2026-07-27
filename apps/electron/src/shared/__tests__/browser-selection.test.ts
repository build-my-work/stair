import { describe, expect, it } from 'bun:test'

import {
  BROWSER_SELECTION_LIMITS,
  buildWebSelectionRevealExpression,
  calculateBrowserSelectionOverlayBounds,
  createWebSelectionReference,
  sanitizeBrowserSelectionCapture,
  sanitizeWebSelectionReference,
} from '../browser-selection'

describe('browser selection validation', () => {
  it('bounds captured text and omits a stale suffix after quote truncation', () => {
    const capture = sanitizeBrowserSelectionCapture({
      quote: `  ${'q'.repeat(BROWSER_SELECTION_LIMITS.quote + 3)}  `,
      prefix: ' before ',
      suffix: ' after ',
      rect: { x: 10, y: 20, width: 30, height: 12 },
    })

    expect(capture?.quote).toHaveLength(BROWSER_SELECTION_LIMITS.quote)
    expect(capture?.prefix).toBe('before')
    expect(capture?.suffix).toBeUndefined()
  })

  it('rejects captures without finite positive geometry', () => {
    expect(sanitizeBrowserSelectionCapture({
      quote: 'selected',
      rect: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
    })).toBeNull()
  })

  it('creates only HTTP(S) references from authoritative page metadata', () => {
    const capture = sanitizeBrowserSelectionCapture({
      quote: 'system call',
      prefix: 'a ',
      suffix: ' boundary',
      rect: { x: 10, y: 20, width: 30, height: 12 },
    })!

    expect(createWebSelectionReference(
      capture,
      'https://example.com/lesson',
      'Lesson',
    )).toEqual({
      kind: 'web-selection',
      url: 'https://example.com/lesson',
      title: 'Lesson',
      quote: 'system call',
      locator: {
        type: 'text-quote',
        exact: 'system call',
        prefix: 'a',
        suffix: 'boundary',
      },
    })
    expect(createWebSelectionReference(capture, 'file:///tmp/page.html', 'Page')).toBeNull()
  })

  it('rejects persisted references whose quote and exact locator differ', () => {
    expect(sanitizeWebSelectionReference({
      kind: 'web-selection',
      url: 'https://example.com',
      title: 'Example',
      quote: 'one',
      locator: { type: 'text-quote', exact: 'two' },
    })).toBeNull()
  })
})

describe('browser selection presentation', () => {
  it('keeps the native Ask bar inside the page viewport', () => {
    expect(calculateBrowserSelectionOverlayBounds(
      { x: 790, y: 5, width: 20, height: 20 },
      800,
      600,
      48,
    )).toEqual({
      x: 616,
      y: 81,
      width: 176,
      height: 42,
    })
  })

  it('serializes locator text as data in the reveal expression', () => {
    const expression = buildWebSelectionRevealExpression({
      kind: 'web-selection',
      url: 'https://example.com',
      title: 'Example',
      quote: '"; globalThis.injected = true; //',
      locator: {
        type: 'text-quote',
        exact: '"; globalThis.injected = true; //',
      },
    })

    const serializedLocator = expression.match(/const locator = (.+);/)?.[1]
    expect(serializedLocator).toBeDefined()
    expect(JSON.parse(serializedLocator!)).toEqual({
      exact: '"; globalThis.injected = true; //',
      prefix: '',
      suffix: '',
    })
  })
})
