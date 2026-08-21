import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const chatDisplaySource = readFileSync(new URL('../ChatDisplay.tsx', import.meta.url), 'utf8')
const turnCardSource = readFileSync(
  new URL('../../../../../../../packages/ui/src/components/chat/TurnCard.tsx', import.meta.url),
  'utf8',
)

describe('chat selection action completion', () => {
  it('returns explicit failure so the selection remains visible', () => {
    expect(chatDisplaySource).toContain('if (!session) return false')
    expect(chatDisplaySource).toContain('if (!reference) return false')
    expect(chatDisplaySource).toContain('return appShellContext.onAddSelectionNote(')
  })

  it('prevents duplicate assistant selection actions while one is pending', () => {
    expect(turnCardSource).toContain('selectionReferenceActionBusyRef.current')
    expect(turnCardSource).toContain(
      'if (!action || !pendingSelection || !messageId || selectionReferenceActionBusyRef.current) return',
    )
  })

  it('clears a failed New Chat reference draft before deleting the child Session', () => {
    const clearIndex = chatDisplaySource.indexOf('appShellContext.onReferencesChange(child.id, [])')
    const deleteIndex = chatDisplaySource.indexOf('await appShellContext.onDeleteSession(child.id, true)')
    expect(clearIndex).toBeGreaterThan(-1)
    expect(clearIndex).toBeLessThan(deleteIndex)
  })
})
