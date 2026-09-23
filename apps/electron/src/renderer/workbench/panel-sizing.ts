import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDE_DEFAULT_WIDTH,
} from '@/components/app-shell/panel-constants'
import type { WorkbenchPanel } from './workbench-state'

export function getDefaultWorkbenchPanelRatio(
  panelLayoutWidth: number,
  panelKind: WorkbenchPanel['kind'],
): number {
  const defaultWidth = panelKind === 'session'
    ? PANEL_DEFAULT_WIDTH
    : PANEL_WIDE_DEFAULT_WIDTH
  return Number.isFinite(panelLayoutWidth) && panelLayoutWidth > 0
    ? defaultWidth / panelLayoutWidth
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
