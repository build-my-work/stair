import { describe, expect, it } from 'bun:test'

import {
  getPiSessionToolProxyDefsForMode,
  PiAgent,
  resolvePiTurnToolMode,
} from '../pi-agent.ts'
import { createMockBackendConfig, createMockSession } from './test-utils.ts'

describe('Pi tutor learning artifact tools', () => {
  it('keeps ordinary Tutor turns tool-free', () => {
    const mode = resolvePiTurnToolMode('tutor', new Set())

    expect(mode).toBe('none')
    expect(getPiSessionToolProxyDefsForMode(mode)).toEqual([])
  })

  it('exposes only save_project_artifact for the explicit learning Artifact skill', () => {
    const mode = resolvePiTurnToolMode(
      'tutor',
      new Set(['create-learning-artifact']),
    )

    expect(mode).toBe('tutor-artifact')
    expect(getPiSessionToolProxyDefsForMode(mode).map(tool => tool.name)).toEqual([
      'mcp__session__save_project_artifact',
    ])
  })

  it('keeps the existing full tool set for non-Tutor sessions', () => {
    const mode = resolvePiTurnToolMode('default', new Set())

    expect(mode).toBe('default')
    expect(getPiSessionToolProxyDefsForMode(mode).length).toBeGreaterThan(1)
  })

  it('restarts an existing Tutor subprocess when the turn enters Artifact mode', async () => {
    const agent = new PiAgent(createMockBackendConfig({
      systemPromptPreset: 'tutor',
      session: createMockSession({ systemPromptPreset: 'tutor' }),
    }))
    let restarts = 0
    ;(agent as any).subprocess = {}
    ;(agent as any).subprocessToolMode = 'none'
    ;(agent as any)._currentTurnSkillSlugs = new Set(['create-learning-artifact'])
    ;(agent as any).killSubprocessGracefully = async () => {
      restarts += 1
      ;(agent as any).subprocess = null
      ;(agent as any).subprocessToolMode = null
    }

    await (agent as any).alignSubprocessToolModeForCurrentTurn()

    expect(restarts).toBe(1)
    agent.destroy()
  })
})
