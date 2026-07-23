import { describe, expect, it } from 'bun:test'

import { getPiToolModeCapabilities } from './tool-mode.ts'

describe('Pi tool mode capabilities', () => {
  it('keeps the established default and disabled modes', () => {
    expect(getPiToolModeCapabilities('default')).toEqual({
      builtinTools: 'all',
      webTools: true,
      proxyTools: true,
    })
    expect(getPiToolModeCapabilities('none')).toEqual({
      builtinTools: 'none',
      webTools: false,
      proxyTools: false,
    })
  })

  it('limits Artifact Tutor turns to Read plus registered proxy tools', () => {
    expect(getPiToolModeCapabilities('tutor-artifact')).toEqual({
      builtinTools: 'read-only',
      webTools: false,
      proxyTools: true,
    })
  })
})
