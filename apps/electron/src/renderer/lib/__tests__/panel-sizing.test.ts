import { describe, expect, it } from 'bun:test'
import type { PanelContentRoute } from '../../../shared/routes'
import {
  DEFAULT_PANEL_MIN_WIDTH_PX,
  DEFAULT_PANEL_WIDTH_PX,
  EPUB_PANEL_DEFAULT_WIDTH_PX,
  EPUB_PANEL_MIN_WIDTH_PX,
  getDefaultPanelWidthRatio,
  getPanelSizePolicy,
  getPanelWidthPx,
  getPanelWidthRatio,
} from '../panel-sizing'

const navigationRoute: PanelContentRoute = {
  kind: 'navigation',
  viewRoute: 'allSessions/session/s1',
}

const epubRoute: PanelContentRoute = {
  kind: 'projectFile',
  projectId: 'project-1',
  relativePath: 'Books/Operating Systems.EPUB',
  contextRoute: 'allSessions/session/s1',
}

describe('panel sizing', () => {
  it('uses independent defaults and minimums for ordinary and EPUB panels', () => {
    expect(getPanelSizePolicy(navigationRoute)).toEqual({
      minWidthPx: DEFAULT_PANEL_MIN_WIDTH_PX,
      defaultWidthPx: DEFAULT_PANEL_WIDTH_PX,
    })
    expect(getPanelSizePolicy(epubRoute)).toEqual({
      minWidthPx: EPUB_PANEL_MIN_WIDTH_PX,
      defaultWidthPx: EPUB_PANEL_DEFAULT_WIDTH_PX,
    })
    expect(getDefaultPanelWidthRatio(navigationRoute, 1_200))
      .toBe(DEFAULT_PANEL_WIDTH_PX / 1_200)
    expect(getDefaultPanelWidthRatio(epubRoute, 1_200))
      .toBe(EPUB_PANEL_DEFAULT_WIDTH_PX / 1_200)
  })

  it('scales each width with the viewport without changing its ratio', () => {
    const chatRatio = 0.6
    const epubRatio = 0.7

    expect(getPanelWidthPx(navigationRoute, chatRatio, 1_000)).toBe(600)
    expect(getPanelWidthPx(navigationRoute, chatRatio, 1_200)).toBe(720)
    expect(getPanelWidthPx(epubRoute, epubRatio, 1_000)).toBe(700)
    expect(getPanelWidthPx(epubRoute, epubRatio, 1_200)).toBe(840)
  })

  it('stops shrinking at the route-specific minimum width', () => {
    expect(getPanelWidthPx(navigationRoute, 0.1, 1_200))
      .toBe(DEFAULT_PANEL_MIN_WIDTH_PX)
    expect(getPanelWidthPx(epubRoute, 0.1, 1_200))
      .toBe(EPUB_PANEL_MIN_WIDTH_PX)
  })

  it('allows independent ratios to overflow instead of normalizing them', () => {
    const viewportWidth = 1_200
    const ratios = [0.47, 0.7]
    const totalWidth = (
      getPanelWidthPx(navigationRoute, ratios[0], viewportWidth)
      + getPanelWidthPx(epubRoute, ratios[1], viewportWidth)
    )

    expect(ratios[0] + ratios[1]).toBeGreaterThan(1)
    expect(totalWidth).toBeGreaterThan(viewportWidth)
  })

  it('converts a dragged pixel width to one viewport-relative ratio', () => {
    expect(getPanelWidthRatio(navigationRoute, 900, 1_200)).toBe(0.75)
    expect(getPanelWidthRatio(navigationRoute, 100, 1_200))
      .toBe(DEFAULT_PANEL_MIN_WIDTH_PX / 1_200)
    expect(getPanelWidthRatio(epubRoute, 100, 1_200))
      .toBe(EPUB_PANEL_MIN_WIDTH_PX / 1_200)
  })
})
