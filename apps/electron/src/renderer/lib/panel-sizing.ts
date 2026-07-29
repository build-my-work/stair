import type { PanelContentRoute } from '../../shared/routes'

export const DEFAULT_PANEL_MIN_WIDTH_PX = 440
export const DEFAULT_PANEL_WIDTH_PX = 560
export const EPUB_PANEL_MIN_WIDTH_PX = 640
export const EPUB_PANEL_DEFAULT_WIDTH_PX = 840
export const EPUB_INLINE_NAV_MIN_WIDTH_PX = EPUB_PANEL_DEFAULT_WIDTH_PX

export interface PanelSizePolicy {
  minWidthPx: number
  defaultWidthPx: number
}

export function isEpubPanelRoute(route: PanelContentRoute): boolean {
  return (
    route.kind === 'projectFile'
    && route.relativePath.toLowerCase().endsWith('.epub')
  )
}

export function getPanelSizePolicy(
  route: PanelContentRoute,
): PanelSizePolicy {
  return isEpubPanelRoute(route)
    ? {
        minWidthPx: EPUB_PANEL_MIN_WIDTH_PX,
        defaultWidthPx: EPUB_PANEL_DEFAULT_WIDTH_PX,
      }
    : {
        minWidthPx: DEFAULT_PANEL_MIN_WIDTH_PX,
        defaultWidthPx: DEFAULT_PANEL_WIDTH_PX,
      }
}

export function getPanelWidthPx(
  route: PanelContentRoute,
  widthRatio: number,
  panelViewportWidth: number,
): number {
  const { minWidthPx, defaultWidthPx } = getPanelSizePolicy(route)
  if (
    !Number.isFinite(widthRatio)
    || widthRatio <= 0
    || !Number.isFinite(panelViewportWidth)
    || panelViewportWidth <= 0
  ) {
    return defaultWidthPx
  }
  return Math.max(minWidthPx, panelViewportWidth * widthRatio)
}

export function getPanelWidthRatio(
  route: PanelContentRoute,
  widthPx: number,
  panelViewportWidth: number,
): number {
  if (!Number.isFinite(panelViewportWidth) || panelViewportWidth <= 0) {
    return 1
  }
  const { minWidthPx, defaultWidthPx } = getPanelSizePolicy(route)
  const validWidthPx = Number.isFinite(widthPx) ? widthPx : defaultWidthPx
  return Math.max(minWidthPx, validWidthPx) / panelViewportWidth
}

export function getDefaultPanelWidthRatio(
  route: PanelContentRoute,
  panelViewportWidth: number,
): number {
  return getPanelWidthRatio(
    route,
    getPanelSizePolicy(route).defaultWidthPx,
    panelViewportWidth,
  )
}
