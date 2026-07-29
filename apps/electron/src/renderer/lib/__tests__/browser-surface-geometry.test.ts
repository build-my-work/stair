import { describe, expect, it } from 'bun:test'
import { calculateBrowserSurfaceGeometry } from '../browser-surface-geometry'

describe('browser surface geometry', () => {
  it('uses the full surface size when it is not clipped', () => {
    expect(calculateBrowserSurfaceGeometry(
      {
        left: 100,
        top: 80,
        right: 900,
        bottom: 680,
        width: 800,
        height: 600,
      },
      {
        left: 0,
        top: 0,
        right: 1_200,
        bottom: 800,
      },
    )).toEqual({
      bounds: {
        x: 100,
        y: 80,
        width: 800,
        height: 600,
      },
      contentBounds: {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      },
    })
  })

  it('clips the native root without resizing its page content', () => {
    expect(calculateBrowserSurfaceGeometry(
      {
        left: -200,
        top: 80,
        right: 600,
        bottom: 680,
        width: 800,
        height: 600,
      },
      {
        left: 40,
        top: 0,
        right: 1_200,
        bottom: 800,
      },
    )).toEqual({
      bounds: {
        x: 40,
        y: 80,
        width: 560,
        height: 600,
      },
      contentBounds: {
        x: -240,
        y: 0,
        width: 800,
        height: 600,
      },
    })
  })

  it('keeps the same page width when only the visible right edge changes', () => {
    const first = calculateBrowserSurfaceGeometry(
      {
        left: 700,
        top: 80,
        right: 1_500,
        bottom: 680,
        width: 800,
        height: 600,
      },
      {
        left: 40,
        top: 0,
        right: 1_200,
        bottom: 800,
      },
    )
    const second = calculateBrowserSurfaceGeometry(
      {
        left: 850,
        top: 80,
        right: 1_650,
        bottom: 680,
        width: 800,
        height: 600,
      },
      {
        left: 40,
        top: 0,
        right: 1_200,
        bottom: 800,
      },
    )

    expect(first.bounds.width).toBe(500)
    expect(second.bounds.width).toBe(350)
    expect(first.contentBounds.width).toBe(800)
    expect(second.contentBounds.width).toBe(800)
  })
})
