import { describe, expect, it } from 'bun:test'
import type { LoadedProject } from '@craft-agent/shared/projects/types'
import type { PanelStackEntry } from '@/atoms/panel-stack'
import type { SessionMeta } from '@/atoms/sessions'
import {
  getBrowserContextRoute,
  getStaleBrowserPanelIds,
} from '../BrowserPaneController'

const project = {
  config: {
    id: 'project-1',
    slug: 'reading',
  },
} as LoadedProject

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    ...overrides,
  }
}

describe('getBrowserContextRoute', () => {
  it('keeps archived sessions in the archived navigator', () => {
    expect(getBrowserContextRoute(
      'session-1',
      new Map([['session-1', session({
        isArchived: true,
        projectId: 'project-1',
      })]]),
      [project],
      'settings',
    )).toBe('archived/session/session-1')
  })

  it('keeps live project sessions in their project navigator', () => {
    expect(getBrowserContextRoute(
      'session-1',
      new Map([['session-1', session({ projectId: 'project-1' })]]),
      [project],
      'settings',
    )).toBe('projects/project/reading/session/session-1')
  })

  it('falls back to all sessions for an ordinary session', () => {
    expect(getBrowserContextRoute(
      'session-1',
      new Map([['session-1', session()]]),
      [],
      'settings',
    )).toBe('allSessions/session/session-1')
  })
})

describe('getStaleBrowserPanelIds', () => {
  it('reconciles browser panels restored after the initial instance list', () => {
    const panelStack: PanelStackEntry[] = [
      {
        id: 'chat-panel',
        route: {
          kind: 'navigation',
          viewRoute: 'allSessions/session/session-1',
        },
        proportion: 0.5,
      },
      {
        id: 'live-browser-panel',
        route: {
          kind: 'browser',
          browserId: 'browser-live',
          contextRoute: 'allSessions/session/session-1',
        },
        proportion: 0.25,
      },
      {
        id: 'stale-browser-panel',
        route: {
          kind: 'browser',
          browserId: 'browser-stale',
          contextRoute: 'allSessions/session/session-1',
        },
        proportion: 0.25,
      },
    ]

    expect(getStaleBrowserPanelIds(
      panelStack,
      new Set(['browser-live']),
    )).toEqual(['stale-browser-panel'])
  })
})
