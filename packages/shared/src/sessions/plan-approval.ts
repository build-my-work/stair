import i18next from 'i18next'

/**
 * The "plan approved" message, shared by every dispatch surface: the
 * renderer's Accept button, the Accept & Compact reload dispatcher and the
 * server-owned durable dispatch all send byte-identical approval text built
 * here, so the persisted message never depends on which surface dispatched it.
 *
 * Imports the i18next singleton directly (never the shared i18n index): the
 * main process and the renderer each configure this same singleton themselves,
 * and the builder must run in both.
 */

export interface BuildPlanApprovalMessageOptions {
  /** Optional accepted plan path (kept for call-site compatibility; message remains path-agnostic). */
  planPath?: string
  draftInput?: string
}

/**
 * Coerce untrusted draft-input values into plain text with the SAME semantics
 * as the renderer's `coerceInputText` (apps/electron/src/renderer/lib/input-text.ts):
 * legacy/malformed persisted snapshots can carry an entire draft object, a
 * `String` wrapper or a primitive — a typeof-string-only check would silently
 * drop the recovered additional user context from those records.
 */
export function coerceDraftInput(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof String) return value.toString()
  if (typeof value === 'object') {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return ''
}

export function buildPlanApprovalMessage(options: BuildPlanApprovalMessageOptions = {}): string {
  const draftInput = coerceDraftInput(options.draftInput).trim()

  // Fallbacks keep the approval contract byte-stable even when i18next has
  // not been initialized in this process (the headless server bootstrap never
  // initializes the singleton — verified by the Codex approval probe). Every
  // dispatch surface therefore produces a valid canonical approval without an
  // uninitialized-global runtime dependency.
  const sections: string[] = [i18next.t('plan.approved') || 'Plan approved, please execute.']

  if (draftInput.length > 0) {
    sections.push(['---', `**${i18next.t('plan.additionalUserContext') || 'Additional user context'}**`, draftInput].join('\n\n'))
  }

  return sections.join('\n\n')
}
