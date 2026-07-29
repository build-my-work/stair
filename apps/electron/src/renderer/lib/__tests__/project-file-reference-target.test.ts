import { describe, expect, test } from 'bun:test'
import type { PanelStackEntry } from '@/atoms/panel-stack'
import type { SessionMeta } from '@/atoms/sessions'
import type { ViewRoute } from '../../../shared/routes'
import {
  getProjectFileChatTargetSessionId,
  getProjectFileOwnerSessionId,
  listProjectReferenceTargets,
  resolveProjectFileOpenIntent,
} from '../project-file-reference-target'

function panel(
  id: string,
  viewRoute: ViewRoute,
  ownerPanelId?: string,
): PanelStackEntry {
  return {
    id,
    route: ownerPanelId
      ? {
          kind: 'projectFile',
          projectId: 'project-1',
          relativePath: 'book.epub',
          contextRoute: viewRoute,
        }
      : { kind: 'navigation', viewRoute },
    widthRatio: 0.47,
    ownerPanelId,
  }
}

function orphanFilePanel(id: string, contextRoute: ViewRoute): PanelStackEntry {
  return {
    id,
    route: {
      kind: 'projectFile',
      projectId: 'project-1',
      relativePath: 'book.epub',
      contextRoute,
    },
    widthRatio: 0.7,
  }
}

const session = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 'session-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  ...overrides,
})

describe('Project File reference target selection', () => {
  test('uses only a physical owner bound to the same Project', () => {
    const stack = [
      panel('owner', 'allSessions/session/session-1'),
      panel('file', 'allSessions/session/session-1', 'owner'),
    ]
    const sessions = new Map([['session-1', session()]])

    expect(getProjectFileOwnerSessionId(stack, 'file', sessions, 'project-1'))
      .toBe('session-1')
    expect(getProjectFileOwnerSessionId(stack, 'file', sessions, 'project-2'))
      .toBeNull()
  })

  test('does not infer an orphan target from contextRoute', () => {
    const stack = [orphanFilePanel('file', 'allSessions/session/session-1')]
    const sessions = new Map([['session-1', session()]])

    expect(getProjectFileOwnerSessionId(stack, 'file', sessions, 'project-1'))
      .toBeNull()
  })

  test('prefers an explicit chat target and falls back to the physical owner', () => {
    const owner = panel('owner', 'allSessions/session/session-1')
    const file = {
      ...panel('file', 'allSessions/session/session-1', 'owner'),
      chatTargetSessionId: 'session-2',
    }
    const sessions = new Map<string, SessionMeta>([
      ['session-1', session()],
      ['session-2', session({ id: 'session-2' })],
    ])

    expect(getProjectFileChatTargetSessionId(
      [owner, file],
      'file',
      sessions,
      'project-1',
    )).toBe('session-2')

    sessions.set('session-2', session({
      id: 'session-2',
      isArchived: true,
    }))
    expect(getProjectFileChatTargetSessionId(
      [owner, file],
      'file',
      sessions,
      'project-1',
    )).toBe('session-1')
  })

  test('filters archived and hidden sessions without silently selecting one', () => {
    const sessions = new Map<string, SessionMeta>([
      ['old', session({ id: 'old', lastMessageAt: 1 })],
      ['new', session({ id: 'new', lastMessageAt: 2 })],
      ['archived', session({ id: 'archived', isArchived: true })],
      ['hidden', session({ id: 'hidden', hidden: true })],
      ['other', session({ id: 'other', projectId: 'project-2' })],
    ])

    expect(listProjectReferenceTargets(sessions, 'project-1').map(item => item.id))
      .toEqual(['new', 'old'])
  })
})

describe('Project File reference open intent', () => {
  const currentFingerprint = `sha256:${'a'.repeat(64)}` as const
  const locator = {
    type: 'epub-cfi' as const,
    cfiRange: 'epubcfi(/6/2!/4/2:0)',
  }

  test('jumps only when the current bytes have the expected fingerprint', () => {
    expect(resolveProjectFileOpenIntent({
      expectedFingerprint: currentFingerprint,
      locator,
    }, currentFingerprint)).toEqual({
      locator,
      stale: false,
    })
  })

  test('marks replacement bytes stale without exposing the old locator', () => {
    expect(resolveProjectFileOpenIntent({
      expectedFingerprint: `sha256:${'b'.repeat(64)}`,
      locator,
    }, currentFingerprint)).toEqual({ stale: true })
    expect(resolveProjectFileOpenIntent(undefined, currentFingerprint))
      .toEqual({ stale: false })
  })
})
