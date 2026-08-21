import { describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Root } from 'react-dom/client'
import { resolveRendererRoot } from '../renderer-root'

describe('resolveRendererRoot', () => {
  it('reuses the same React Root across renderer entry HMR executions', () => {
    const rootElement = {} as HTMLElement
    const mountedRoot = { render: mock(() => {}) } as unknown as Root
    const hotData: { reactRoot?: Root } = {}
    const firstCreateRoot = mock(() => mountedRoot)

    const firstResolution = resolveRendererRoot(rootElement, hotData, firstCreateRoot)
    const secondCreateRoot = mock(() => ({ render: mock(() => {}) } as unknown as Root))
    const secondResolution = resolveRendererRoot(rootElement, hotData, secondCreateRoot)

    expect(firstResolution).toEqual({ reactRoot: mountedRoot, shouldRender: true })
    expect(secondResolution).toEqual({ reactRoot: mountedRoot, shouldRender: false })
    expect(firstCreateRoot).toHaveBeenCalledTimes(1)
    expect(secondCreateRoot).not.toHaveBeenCalled()
  })

  it('creates an independent root when HMR data is unavailable', () => {
    const rootElement = {} as HTMLElement
    const firstRoot = { render: mock(() => {}) } as unknown as Root
    const secondRoot = { render: mock(() => {}) } as unknown as Root

    expect(resolveRendererRoot(rootElement, undefined, mock(() => firstRoot))).toEqual({
      reactRoot: firstRoot,
      shouldRender: true,
    })
    expect(resolveRendererRoot(rootElement, undefined, mock(() => secondRoot))).toEqual({
      reactRoot: secondRoot,
      shouldRender: true,
    })
  })

  it('keeps main.tsx as a valid React Refresh boundary', () => {
    const mainSource = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')

    expect(mainSource).toContain('export function CrashFallback()')
    expect(mainSource).toContain('export function Root()')
  })
})
