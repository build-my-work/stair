import { describe, expect, it } from 'bun:test'

import { resolveClaudeTurnToolPolicy } from '../claude-agent.ts'
import { getSessionScopedTools } from '../session-scoped-tools.ts'

describe('Claude tutor learning artifact tools', () => {
  it('keeps ordinary Tutor turns tool-free', () => {
    expect(resolveClaudeTurnToolPolicy('tutor', new Set())).toEqual({
      builtinTools: [],
      sessionToolNames: [],
    })
  })

  it('enables only Read and save_project_artifact for the explicit skill', () => {
    const policy = resolveClaudeTurnToolPolicy(
      'tutor',
      new Set(['create-learning-artifact']),
    )

    expect(policy).toEqual({
      builtinTools: ['Read'],
      sessionToolNames: ['save_project_artifact'],
    })

    const server = getSessionScopedTools('tutor-test', '/tmp/tutor-test', undefined, {
      toolNames: policy.sessionToolNames ?? undefined,
    })
    const registeredTools = Object.keys(
      (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    )
    expect(registeredTools).toEqual(['save_project_artifact'])
  })

  it('preserves the existing full policy outside Tutor mode', () => {
    expect(resolveClaudeTurnToolPolicy('default', new Set())).toEqual({
      builtinTools: null,
      sessionToolNames: null,
    })
  })
})
