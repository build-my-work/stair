import { describe, expect, it } from 'bun:test'
import { buildProductDeepLink } from '../product-deep-link'

describe('buildProductDeepLink', () => {
  it('builds links with the selected product scheme', () => {
    expect(buildProductDeepLink('settings/general', 'stair')).toBe(
      'stair://settings/general',
    )
  })

  it('normalizes a leading slash in the route', () => {
    expect(buildProductDeepLink('/action/new-session?window=focused', 'craftagents')).toBe(
      'craftagents://action/new-session?window=focused',
    )
  })
})
