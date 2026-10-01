import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

// The normal approval routing stays separate from compact preparation. Its
// asynchronous behavior is covered by plan-preparation.integration.test.ts.
const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf8')

describe('plan approval draft references', () => {
  it('consumes references together with draft text for normal approval', () => {
    expect(source).toContain('references: [...referencesValue]')
    expect(source).toContain('onReferencesChange?.([])')
    expect(source).toContain(
      'onSubmit(text, undefined, undefined, draftSnapshot.references)',
    )
  })

  it('keeps the reload dispatch handoff on the host', () => {
    // The reload/dispatch path is host-owned: one RPC performs readiness,
    // durable acceptance and the model-turn kickoff — the renderer no longer
    // holds claim→send→clear ownership.
    expect(source).toContain("type: 'dispatchPendingPlanExecution'")
    expect(source).not.toContain('markPendingPlanExecutionDispatched')
  })
})
