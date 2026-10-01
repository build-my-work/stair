import { describe, expect, it } from 'bun:test'
import i18next from 'i18next'
import { buildPlanApprovalMessage, coerceDraftInput } from '../plan-approval'

// The approval builder must produce a valid canonical approval in ANY host:
// the headless server bootstrap never initializes the i18next singleton (the
// Codex approval probe showed `t()` returning undefined there), while the
// Electron main/renderer processes do. Localization is honored when the
// singleton is initialized; the canonical English fallback is used otherwise.

describe('buildPlanApprovalMessage', () => {
  it('produces the canonical approval with an empty draft (headless, uninitialized i18next)', () => {
    // Runs first, before the localization test initializes the singleton.
    expect(buildPlanApprovalMessage()).toBe('Plan approved, please execute.')
    expect(buildPlanApprovalMessage({ draftInput: '' })).toBe('Plan approved, please execute.')
    expect(buildPlanApprovalMessage({ draftInput: '   ' })).toBe('Plan approved, please execute.')
  })

  it('includes additional user context with the canonical label when uninitialized', () => {
    const message = buildPlanApprovalMessage({ draftInput: 'Keep this detail' })
    expect(message).toBe(
      'Plan approved, please execute.\n\n---\n\n**Additional user context**\n\nKeep this detail',
    )
  })

  it('honors localization once i18next is initialized (renderer-configured singleton)', async () => {
    // Mirror what the app's setup does to the same singleton i18next uses.
    await i18next.init({ lng: 'de', resources: { de: { translation: {
      'plan.approved': 'Plan genehmigt, bitte ausführen.',
      'plan.additionalUserContext': 'Zusätzlicher Nutzerkontext',
    } } } })
    expect(buildPlanApprovalMessage()).toBe('Plan genehmigt, bitte ausführen.')
    expect(buildPlanApprovalMessage({ draftInput: 'Detail' })).toBe(
      'Plan genehmigt, bitte ausführen.\n\n---\n\n**Zusätzlicher Nutzerkontext**\n\nDetail',
    )
  })

  it('coerces legacy/malformed draft snapshots with the renderer coerceInputText semantics', () => {
    expect(coerceDraftInput(undefined)).toBe('')
    expect(coerceDraftInput(null)).toBe('')
    expect(coerceDraftInput('plain')).toBe('plain')
    expect(coerceDraftInput(42)).toBe('42')
    expect(coerceDraftInput(new String('wrapped'))).toBe('wrapped')
    // Legacy stored snapshots that persisted an entire draft object.
    expect(coerceDraftInput({ text: 'recovered from object' })).toBe('recovered from object')
    expect(coerceDraftInput({ text: { nested: true } })).toBe('')
    expect(coerceDraftInput([1, 2, 3])).toBe('')
  })
})
