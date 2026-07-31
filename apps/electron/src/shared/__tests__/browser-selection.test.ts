import { describe, expect, it } from 'bun:test'
import {
  buildWebSelectionRevealExpression,
  calculateBrowserSelectionOverlayBounds,
  createWebSelectionReference,
  isBrowserSelectionAction,
  sanitizeBrowserSelectionCapture,
  sanitizeWebSelectionReference,
} from '../browser-selection'

describe('browser selection', () => {
  it('accepts bounded text selections with a visible anchor', () => {
    expect(sanitizeBrowserSelectionCapture({
      quote: '  selected text  ',
      prefix: ' before ',
      suffix: ' after ',
      rect: { x: 20, y: 30, width: 80, height: 18 },
    })).toEqual({
      quote: 'selected text',
      prefix: 'before',
      suffix: 'after',
      rect: { x: 20, y: 30, width: 80, height: 18 },
    })
  })

  it('rejects empty selections and invalid anchor geometry', () => {
    expect(sanitizeBrowserSelectionCapture({
      quote: '',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    })).toBeNull()
    expect(sanitizeBrowserSelectionCapture({
      quote: 'text',
      rect: { x: 0, y: 0, width: 0, height: 10 },
    })).toBeNull()
  })

  it('creates only HTTP(S) references and preserves no browser runtime state', () => {
    const capture = sanitizeBrowserSelectionCapture({
      quote: 'selected text',
      prefix: 'before',
      suffix: 'after',
      rect: { x: 20, y: 30, width: 80, height: 18 },
    })!
    const reference = createWebSelectionReference(
      capture,
      'https://example.com/article',
      'Example',
    )

    expect(reference).toEqual({
      version: 1,
      kind: 'web-selection',
      url: 'https://example.com/article',
      title: 'Example',
      quote: 'selected text',
      locator: {
        type: 'text-quote',
        exact: 'selected text',
        prefix: 'before',
        suffix: 'after',
      },
    })
    expect(createWebSelectionReference(
      capture,
      'file:///tmp/private.html',
      'Private',
    )).toBeNull()
    expect(Object.keys(reference!)).not.toContain('browserId')
  })

  it('positions the action overlay inside the page viewport', () => {
    expect(calculateBrowserSelectionOverlayBounds(
      { x: 950, y: 2, width: 40, height: 20 },
      1_000,
      700,
      48,
    )).toEqual({
      x: 772,
      y: 80,
      width: 220,
      height: 56,
    })
  })

  it('accepts every browser selection action rendered by the overlay', () => {
    expect(isBrowserSelectionAction('add-note')).toBe(true)
    expect(isBrowserSelectionAction('add-note-to')).toBe(true)
    expect(isBrowserSelectionAction('add-chat')).toBe(true)
    expect(isBrowserSelectionAction('new-chat')).toBe(true)
    expect(isBrowserSelectionAction('unsupported')).toBe(false)
  })

  it('builds a reveal expression only for validated references', () => {
    const reference = sanitizeWebSelectionReference({
      version: 1,
      kind: 'web-selection',
      url: 'https://example.com',
      title: 'Example',
      quote: 'selected text',
      locator: {
        type: 'text-quote',
        exact: 'selected text',
      },
    })
    expect(reference).not.toBeNull()
    expect(buildWebSelectionRevealExpression(reference!))
      .toContain('scrollIntoView')
  })
})
