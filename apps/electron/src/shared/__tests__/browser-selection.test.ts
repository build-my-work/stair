import { describe, expect, it } from 'bun:test'
import {
  buildWebSelectionRevealExpression,
  calculateBrowserSelectionOverlayBounds,
  createWebSelectionReference,
  isBrowserSelectionAction,
  sanitizeBrowserSelectionCapture,
} from '../browser-selection'

describe('browser selection', () => {
  it('uses the same compact horizontal action-bar footprint as reader selections', () => {
    expect(calculateBrowserSelectionOverlayBounds(
      { x: 40, y: 80, width: 120, height: 20 },
      900,
      700,
      48,
    )).toEqual({ x: 8, y: 78, width: 340, height: 40 })
  })

  it('exposes the independent-window Chat and Note selection actions', () => {
    expect(isBrowserSelectionAction('add-chat')).toBe(true)
    expect(isBrowserSelectionAction('new-chat')).toBe(true)
    expect(isBrowserSelectionAction('add-note')).toBe(true)
    expect(isBrowserSelectionAction('choose-note-target')).toBe(true)
    expect(isBrowserSelectionAction('add-note-to')).toBe(false)
  })

  it('normalizes bounded selection text and creates a Project-scoped reference', () => {
    const capture = sanitizeBrowserSelectionCapture({
      quote: '  selected\u00a0text  ',
      prefix: ' before ',
      suffix: ' after ',
      rect: { x: 20, y: 30, width: 80, height: 18 },
    })
    expect(capture).toEqual({
      quote: 'selected text',
      prefix: 'before',
      suffix: 'after',
      rect: { x: 20, y: 30, width: 80, height: 18 },
    })

    expect(createWebSelectionReference(
      'project-a',
      capture!,
      'https://example.com/article',
      'Example',
    )).toEqual({
      version: 1,
      kind: 'web-selection',
      projectId: 'project-a',
      url: 'https://example.com/article',
      title: 'Example',
      quote: 'selected text',
      locator: {
        type: 'web-text-quote',
        exact: 'selected text',
        prefix: 'before',
        suffix: 'after',
      },
    })
  })

  it('rejects invalid anchors, non-web URLs, and missing Project scope', () => {
    expect(sanitizeBrowserSelectionCapture({
      quote: 'text',
      rect: { x: 0, y: 0, width: 0, height: 10 },
    })).toBeNull()
    const capture = sanitizeBrowserSelectionCapture({
      quote: 'text',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    })!
    expect(createWebSelectionReference('', capture, 'https://example.com', 'Example')).toBeNull()
    expect(createWebSelectionReference('project-a', capture, 'file:///tmp/private', 'Private')).toBeNull()
  })

  it('builds a deterministic reveal expression from the text quote locator', () => {
    const capture = sanitizeBrowserSelectionCapture({
      quote: 'selected text',
      rect: { x: 1, y: 2, width: 3, height: 4 },
    })!
    const reference = createWebSelectionReference(
      'project-a',
      capture,
      'https://example.com',
      'Example',
    )!
    expect(buildWebSelectionRevealExpression(reference)).toContain('scrollIntoView')
  })

  it('uses trimmed text boundaries to disambiguate repeated quotes', () => {
    const capture = sanitizeBrowserSelectionCapture({
      quote: 'selected text',
      prefix: 'second before ',
      suffix: ' after second',
      rect: { x: 1, y: 2, width: 3, height: 4 },
    })!
    const reference = createWebSelectionReference(
      'project-a',
      capture,
      'https://example.com',
      'Example',
    )!
    const contexts = [
      { before: 'first before ', after: ' after first' },
      { before: 'second before ', after: ' after second' },
    ]
    let matchIndex = 0
    let selectedIndex = -1
    let ranges: any[] = []
    const selection = {
      get rangeCount() { return ranges.length },
      removeAllRanges() { ranges = [] },
      addRange(range: any) {
        ranges = [range]
        if (range.kind === 'match') selectedIndex = range.index
      },
      getRangeAt() { return ranges[0] },
    }
    const createMatch = (index: number): any => ({
      kind: 'match',
      index,
      startContainer: {
        nodeType: 3,
        matchIndex: index,
        parentElement: { scrollIntoView() {} },
      },
      endContainer: { matchIndex: index },
      startOffset: 0,
      endOffset: 0,
      cloneRange: () => createMatch(index),
      collapse() {},
    })
    const pageWindow = {
      getSelection: () => selection,
      find: () => {
        if (matchIndex >= contexts.length) return false
        ranges = [createMatch(matchIndex)]
        matchIndex += 1
        return true
      },
    }
    const pageDocument = {
      body: {},
      createRange: () => {
        let side: 'before' | 'after' | null = null
        let index = 0
        return {
          selectNodeContents() {},
          collapse() {},
          setEnd(container: { matchIndex: number }) {
            side = 'before'
            index = container.matchIndex
          },
          setStart(container: { matchIndex: number }) {
            side = 'after'
            index = container.matchIndex
          },
          toString: () => side ? contexts[index][side] : '',
        }
      },
    }

    const found = Function(
      'window',
      'document',
      'Node',
      `return ${buildWebSelectionRevealExpression(reference)}`,
    )(pageWindow, pageDocument, { ELEMENT_NODE: 1 })

    expect(found).toBe(true)
    expect(selectedIndex).toBe(1)
  })
})
