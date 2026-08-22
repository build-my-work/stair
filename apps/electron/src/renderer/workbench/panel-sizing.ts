import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
} from '@/components/app-shell/panel-constants'

export function getDefaultWorkbenchPanelRatio(panelLayoutWidth: number): number {
  return Number.isFinite(panelLayoutWidth) && panelLayoutWidth > 0
    ? PANEL_DEFAULT_WIDTH / panelLayoutWidth
    : 1
}

export function getWorkbenchPanelWidth(
  widthRatio: number,
  panelLayoutWidth: number,
): number {
  if (
    !Number.isFinite(widthRatio)
    || widthRatio <= 0
    || !Number.isFinite(panelLayoutWidth)
    || panelLayoutWidth <= 0
  ) return PANEL_DEFAULT_WIDTH
  return Math.max(PANEL_MIN_WIDTH, widthRatio * panelLayoutWidth)
}

export function getWorkbenchPanelRatio(
  width: number,
  panelLayoutWidth: number,
): number {
  if (!Number.isFinite(panelLayoutWidth) || panelLayoutWidth <= 0) return 1
  const validWidth = Number.isFinite(width) ? width : PANEL_DEFAULT_WIDTH
  return Math.max(PANEL_MIN_WIDTH, validWidth) / panelLayoutWidth
}
