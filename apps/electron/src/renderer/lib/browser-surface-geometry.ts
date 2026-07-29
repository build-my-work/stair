import type { BrowserSurfaceState } from '../../shared/types'

interface BrowserSurfaceRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

interface BrowserSurfaceClip {
  left: number
  top: number
  right: number
  bottom: number
}

export function calculateBrowserSurfaceGeometry(
  rect: BrowserSurfaceRect,
  clip: BrowserSurfaceClip,
): Pick<BrowserSurfaceState, 'bounds' | 'contentBounds'> {
  const left = Math.max(clip.left, rect.left)
  const top = Math.max(clip.top, rect.top)
  const right = Math.min(clip.right, rect.right)
  const bottom = Math.min(clip.bottom, rect.bottom)

  return {
    bounds: {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    },
    contentBounds: {
      x: rect.left - left,
      y: rect.top - top,
      width: Math.max(0, rect.width),
      height: Math.max(0, rect.height),
    },
  }
}
