import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createRequire } from 'node:module'
import React, { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PdfDocumentStateV1, PdfStateMutation } from '@craft-agent/shared/project-files'
import { flushOpenProjectFile } from '../project-file-document-registry'
import { createPdfPageLayout, findPdfPageAtOffset, pdfPageScrollTop } from '../project-file-pdf-layout'

const domino = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createWindow(html: string): Window & typeof globalThis
}
const fingerprint = `sha256:${'a'.repeat(64)}` as const
const frames = new Map<number, FrameRequestCallback>()
const observers = new Set<() => void>()
const scrollEvents = new Set<HTMLElement>()
const writes: PdfStateMutation[] = []
let frameId = 0
let width = 800
let height = 500
let root: Root | null = null
let state: PdfDocumentStateV1

beforeAll(() => {
  const browserWindow = domino.createWindow('<html><body></body></html>')
  Object.assign(globalThis, {
    window: browserWindow, document: browserWindow.document,
    navigator: browserWindow.navigator, HTMLElement: browserWindow.HTMLElement,
    Node: browserWindow.Node, Event: browserWindow.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback)
      return frameId
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class {
      constructor(private callback: () => void) {}
      observe() { observers.add(this.callback) }
      disconnect() { observers.delete(this.callback) }
    },
  })
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, get: () => height },
  })
  HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1100 }) as DOMRect
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
    const top = typeof options === 'number' ? y ?? 0 : options?.top ?? 0
    if (this.scrollTop === top) return
    this.scrollTop = top
    scrollEvents.add(this)
  }
  window.getSelection = () => ({ removeAllRanges() {} }) as Selection
  // Mount the real reader and mutation coordinator. Only PDF decoding/canvas and
  // the native geometry/event loop are supplied by this DOM adapter.
  mock.module('react-pdf', () => ({
    pdfjs: { GlobalWorkerOptions: {} },
    Document: ({ children, onLoadSuccess, ...props }: {
      children: ReactNode
      onLoadSuccess(pdf: unknown): Promise<void>
      className?: string
      file?: unknown
    }) => {
      React.useEffect(() => {
        void onLoadSuccess({
          numPages: 240,
          getPage: async () => ({ getViewport: () => ({ width: 100, height: 140 }) }),
          getPageLabels: async () => null,
          getOutline: async () => [],
        })
      }, [onLoadSuccess])
      // react-pdf Document forwards className, but not a style prop.
      return React.createElement('div', { className: props.className }, children)
    },
    Page: ({ pageNumber }: { pageNumber: number }) => (
      React.createElement('span', { 'data-rendered-page': pageNumber }, `Page ${pageNumber}`)
    ),
  }))
  mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
  mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
  mock.module(new URL('../../../context/ThemeContext.tsx', import.meta.url).pathname, () => ({
    useTheme: () => ({ isDark: false }),
  }))
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  frames.clear()
  observers.clear()
  scrollEvents.clear()
  writes.length = 0
  width = 800
  height = 500
})

async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(turn)
      const pendingScroll = [...scrollEvents]
      scrollEvents.clear()
      for (const element of pendingScroll) element.dispatchEvent(new Event('scroll'))
    })
  }
  await flushOpenProjectFile('project-1', 'long.pdf')
}

async function openReader() {
  state = {
    version: 1, projectId: 'project-1', relativePath: 'long.pdf',
    sourceFingerprint: fingerprint, revision: 1, highlights: [], updatedAt: 1,
    progress: { pageNumber: 98, pageOffsetRatio: 0.25, percentage: 97.25 / 240, updatedAt: 1 },
  }
  Object.assign(window, { electronAPI: {
    getPdfDocumentState: async () => state,
    applyPdfStateMutation: async ({ mutation }: { mutation: PdfStateMutation }) => {
      writes.push(mutation)
      state = { ...state, revision: state.revision + 1 }
      if (mutation.type === 'set-progress') state.progress = { ...mutation.progress, updatedAt: 2 }
      return { revision: state.revision }
    },
  } })
  document.body.innerHTML = '<div id="root"></div>'
  const { ProjectFilePdfReader } = await import('../ProjectFilePdfReader')
  const props = {
    projectId: 'project-1', relativePath: 'long.pdf', sourceFingerprint: fingerprint,
    metadata: { name: 'long.pdf' }, bytes: new Uint8Array([1]),
  } as React.ComponentProps<typeof ProjectFilePdfReader>
  root = createRoot(document.getElementById('root')!)
  const render = async (revealRevision = 0, pageNumber?: number) => {
    await act(async () => root!.render(React.createElement(ProjectFilePdfReader, {
      ...props, revealRevision,
      ...(pageNumber ? { initialLocator: {
        type: 'pdf-text-quote' as const, exact: 'reference', startPage: pageNumber, endPage: pageNumber,
        anchor: { pageNumber, x: 0, y: 0.1, width: 0.5, height: 0.05 },
      } } : {}),
    })))
    await settle()
  }
  await render()
  return { scroll: document.querySelector('section > div') as HTMLDivElement, render }
}

async function resize(nextWidth: number, nextHeight = 500, resetScroll = false) {
  await act(async () => {
    width = nextWidth
    height = nextHeight
    const scroll = document.querySelector('section > div') as HTMLElement
    if (resetScroll) scroll.scrollTop = 0
    // Browsers can emit a clamp/anchor scroll before ResizeObserver/React catch up.
    scroll.dispatchEvent(new Event('scroll'))
    for (const callback of [...observers]) callback()
  })
  await settle()
}

function position(scroll: HTMLElement) {
  const pageWidth = Number.parseFloat((document.querySelector('[data-pdf-page-number]') as HTMLElement).style.width)
  return findPdfPageAtOffset(createPdfPageLayout(Array(240).fill(1.4), pageWidth), scroll.scrollTop)
}

describe('mounted PDF reader resizing', () => {
  it('preserves an in-progress text selection when drag auto-scroll moves the viewport', async () => {
    const { scroll } = await openReader()
    const getSelection = window.getSelection
    let selectedText = 'Page 98'
    window.getSelection = () => ({
      removeAllRanges() { selectedText = '' },
      toString() { return selectedText },
    }) as Selection
    try {
      await act(async () => {
        scroll.scrollTop += 200
        scroll.dispatchEvent(new Event('scroll'))
      })
      expect(window.getSelection()?.toString()).toBe('Page 98')
      await settle()
      expect(state.progress?.pageNumber).toBe(98)
      expect(state.progress?.pageOffsetRatio).toBeGreaterThan(0.25)
    } finally {
      window.getSelection = getSelection
    }
  })

  it('matches rendered page spacing to virtual offsets at the app root font size of 15px', async () => {
    const { scroll } = await openReader()
    const page = document.querySelector('[data-pdf-page-number]') as HTMLElement
    const documentElement = page.parentElement!
    // Tailwind gap-4/py-4 are 1rem, which is 15px in this app. Fixed pixel
    // spacing must win so the error cannot accumulate over a long document.
    const gap = Number.parseFloat(documentElement.style.gap)
      || (documentElement.classList.contains('gap-4') ? 15 : 0)
    const padding = Number.parseFloat(scroll.style.paddingBlock)
      || (scroll.classList.contains('py-4') ? 15 : 0)
    const pageHeight = Number.parseFloat(page.style.height)
    const renderedAnchor = padding + 97 * (pageHeight + gap) + 0.25 * pageHeight
    expect(scroll.scrollTop + 24).toBeCloseTo(renderedAnchor)
  })

  it('waits for the initially hidden reader before consuming saved progress', async () => {
    width = 0
    height = 0
    const { scroll } = await openReader()
    expect(writes).toEqual([])
    await resize(800)
    expect(position(scroll)?.pageNumber).toBe(98)
    expect(position(scroll)?.pageOffsetRatio).toBeCloseTo(0.25)
    expect(state.progress).toMatchObject({ pageNumber: 98, pageOffsetRatio: 0.25 })
  })

  it('keeps the current page and in-page offset across zoom without persisting a transient page', async () => {
    const { scroll } = await openReader()
    expect(position(scroll)?.pageNumber).toBe(98)
    expect(position(scroll)?.pageOffsetRatio).toBeCloseTo(0.25)
    writes.length = 0
    await resize(560)
    expect(position(scroll)?.pageNumber).toBe(98)
    expect(position(scroll)?.pageOffsetRatio).toBeCloseTo(0.25)
    expect(writes.every(mutation => mutation.type !== 'set-progress' || mutation.progress.pageNumber === 98)).toBe(true)
    expect(Array.from(document.querySelectorAll('[data-rendered-page]'), element => element.getAttribute('data-rendered-page')))
      .toEqual(['96', '97', '98', '99', '100'])

    // A real scroll immediately before resizing must win over the saved page 98.
    await act(async () => {
      scroll.scrollTop = pdfPageScrollTop(createPdfPageLayout(Array(240).fill(1.4), 528)[104], 0.4)
      scroll.dispatchEvent(new Event('scroll'))
    })
    await resize(960)
    expect(position(scroll)?.pageNumber).toBe(105)
    expect(position(scroll)?.pageOffsetRatio).toBeCloseTo(0.4)
    expect(state.progress).toMatchObject({ pageNumber: 105, pageOffsetRatio: 0.4 })
  })

  it('retains progress through repeated hidden/show cycles, including the same width', async () => {
    const { scroll } = await openReader()
    for (const nextWidth of [800, 560, 800]) {
      await resize(0, 0, true)
      expect(state.progress).toMatchObject({ pageNumber: 98, pageOffsetRatio: 0.25 })
      await resize(nextWidth)
      expect(position(scroll)?.pageNumber).toBe(98)
      expect(position(scroll)?.pageOffsetRatio).toBeCloseTo(0.25)
    }
  })

  it('persists the last user scroll across a height-only resize with no follow-up scroll', async () => {
    const { scroll } = await openReader()
    await act(async () => {
      scroll.scrollTop = pdfPageScrollTop(createPdfPageLayout(Array(240).fill(1.4), 768)[104], 0.4)
      scroll.dispatchEvent(new Event('scroll'))
    })
    // The new layout has the same page width and pixel offset, so restoring it
    // does not emit another scroll event to rescue the cancelled progress write.
    await resize(800, 650)
    expect(position(scroll)?.pageNumber).toBe(105)
    expect(state.progress).toMatchObject({ pageNumber: 105, pageOffsetRatio: 0.4 })
  })

  it('honors a new reference reveal while preserving that location on later resizes', async () => {
    const { scroll, render } = await openReader()
    await render(1, 33)
    expect(position(scroll)?.pageNumber).toBe(33)
    await resize(560)
    expect(position(scroll)?.pageNumber).toBe(33)
    expect(position(scroll)?.pageOffsetRatio).toBeCloseTo(0.1)
    await render(2, 17)
    expect(position(scroll)?.pageNumber).toBe(17)
    expect(state.progress).toMatchObject({ pageNumber: 17, pageOffsetRatio: 0.1 })
  })
})
