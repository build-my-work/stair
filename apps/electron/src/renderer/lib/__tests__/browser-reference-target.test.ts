import { describe, expect, it } from 'bun:test'
import type { PanelStackEntry } from '@/atoms/panel-stack'
import type { SessionMeta } from '@/atoms/sessions'
import {
  getBrowserChatTargetSessionId,
  getBrowserReferenceProjectId,
  listBrowserReferenceTargets,
} from '../browser-reference-target'

function session(
  id: string,
  overrides: Partial<SessionMeta> = {},
): SessionMeta {
  return {
    id,
    workspaceId: 'workspace-1',
    createdAt: 1,
    ...overrides,
  }
}

function stack(chatTargetSessionId?: string): PanelStackEntry[] {
  return [
    {
      id: 'owner',
      widthRatio: 0.47,
      route: {
        kind: 'navigation',
        viewRoute: 'projects/project/demo/session/owner-session',
      },
    },
    {
      id: 'browser',
      ownerPanelId: 'owner',
      widthRatio: 0.47,
      route: {
        kind: 'browser',
        browserId: 'browser-1',
        contextRoute: 'projects/project/demo/session/owner-session',
      },
      ...(chatTargetSessionId ? { chatTargetSessionId } : {}),
    },
  ]
}

describe('browser reference target', () => {
  it('prefers an explicit available target over the owner Session', () => {
    const sessions = new Map([
      ['owner-session', session('owner-session', { projectId: 'project-1' })],
      ['target-session', session('target-session', { projectId: 'project-2' })],
    ])

    expect(getBrowserChatTargetSessionId(
      stack('target-session'),
      'browser',
      sessions,
      'workspace-1',
    )).toBe('target-session')
    expect(getBrowserReferenceProjectId(
      stack('target-session'),
      'browser',
      sessions,
      'workspace-1',
    )).toBe('project-2')
  })

  it('falls back to the owner when the explicit target is unavailable', () => {
    const sessions = new Map([
      ['owner-session', session('owner-session')],
      ['target-session', session('target-session', { isArchived: true })],
    ])

    expect(getBrowserChatTargetSessionId(
      stack('target-session'),
      'browser',
      sessions,
      'workspace-1',
    )).toBe('owner-session')
  })

  it('lists only available workspace Sessions with the preferred Project first', () => {
    const sessions = new Map([
      ['old-preferred', session('old-preferred', {
        projectId: 'project-1',
        lastMessageAt: 10,
      })],
      ['new-other', session('new-other', {
        projectId: 'project-2',
        lastMessageAt: 30,
      })],
      ['new-preferred', session('new-preferred', {
        projectId: 'project-1',
        lastMessageAt: 20,
      })],
      ['hidden', session('hidden', { hidden: true, lastMessageAt: 40 })],
      ['other-workspace', session('other-workspace', {
        workspaceId: 'workspace-2',
        lastMessageAt: 50,
      })],
    ])

    expect(listBrowserReferenceTargets(
      sessions,
      'workspace-1',
      'project-1',
    ).map(item => item.id)).toEqual([
      'new-preferred',
      'old-preferred',
      'new-other',
    ])
  })

  it('accepts the remote mirror workspace as part of the current scope', () => {
    const sessions = new Map([
      ['remote-session', session('remote-session', {
        workspaceId: 'remote-workspace',
      })],
    ])

    expect(listBrowserReferenceTargets(
      sessions,
      ['workspace-1', 'remote-workspace'],
    ).map(item => item.id)).toEqual(['remote-session'])
  })
})
