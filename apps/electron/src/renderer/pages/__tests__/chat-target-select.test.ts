import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const pageSources = [
  new URL('../ProjectFilePage.tsx', import.meta.url),
].map(url => readFileSync(url, 'utf8'))
const selectSource = readFileSync(
  new URL('../../components/ui/select.tsx', import.meta.url),
  'utf8',
)

describe('Chat target select', () => {
  it('uses the positioned app select instead of the native macOS select', () => {
    for (const source of pageSources) {
      expect(source).toContain('<SelectContent position="popper" side="bottom"')
      expect(source).not.toContain('<select')
    }
  })

  it('allows the positioned menu viewport to grow beyond the trigger height', () => {
    expect(selectSource).toContain('min-h-[var(--radix-select-trigger-height)]')
    expect(selectSource).not.toContain('"h-[var(--radix-select-trigger-height)]')
  })
})
