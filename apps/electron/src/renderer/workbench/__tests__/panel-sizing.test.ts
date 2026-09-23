import { describe, expect, it } from 'bun:test'
import {
  getDefaultWorkbenchPanelRatio,
  getWorkbenchPanelRatio,
  getWorkbenchPanelWidth,
} from '../panel-sizing'

describe('Workbench Panel sizing', () => {
  it('resolves independent ratios against the stable shell width', () => {
    expect(getDefaultWorkbenchPanelRatio(1120, 'session')).toBe(0.5)
    expect(getDefaultWorkbenchPanelRatio(1120, 'project-file')).toBe(0.75)
    expect(getWorkbenchPanelWidth(0.5, 1120)).toBe(560)
    expect(getWorkbenchPanelWidth(0.25, 1120)).toBe(440)
    expect(getWorkbenchPanelRatio(700, 1400)).toBe(0.5)
  })

  it('uses a readable default when the shell has not been measured', () => {
    expect(getDefaultWorkbenchPanelRatio(0, 'session')).toBe(1)
    expect(getDefaultWorkbenchPanelRatio(0, 'project-file')).toBe(1)
    expect(getWorkbenchPanelWidth(Number.NaN, 0)).toBe(560)
    expect(getWorkbenchPanelRatio(560, 0)).toBe(1)
  })
})
