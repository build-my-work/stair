import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

// Source guard: this package has no effect-capable React DOM harness, while the
// behavior itself is covered by the pending-plan persistence test.
const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf8')

describe('plan approval draft references', () => {
  it('consumes references together with draft text for normal approval', () => {
    expect(source).toContain('references: [...referencesValue]')
    expect(source).toContain('onReferencesChange?.([])')
    expect(source).toContain(
      'onSubmit(text, undefined, undefined, draftSnapshot.references)',
    )
  })

  it('persists and replays the same references across Accept & Compact', () => {
    expect(source).toContain('draftReferencesSnapshot: draftSnapshot.references')
    // The reload path is the shared pending-plan dispatcher: the snapshot is
    // persisted before /compact and replayed through its submit.
    expect(source).toContain(
      '}), undefined, undefined, pending.draftReferencesSnapshot)',
    )
  })
})
