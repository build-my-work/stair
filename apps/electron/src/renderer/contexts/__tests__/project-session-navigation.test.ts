import { describe, expect, it } from 'bun:test'
import type { LoadedProject } from '@craft-agent/shared/projects/types'
import type { SessionMeta } from '@/atoms/sessions'
import type { NavigationState } from '../../../shared/types'
import { validateProjectSessionNavigationState } from '../NavigationContext'

function project(id: string, slug: string): LoadedProject {
  return {
    config: {
      id,
      slug,
      name: slug,
      createdAt: 1,
      updatedAt: 1,
    },
  } as LoadedProject
}

function session(
  id: string,
  projectId: string | undefined,
  workspaceId = 'workspace',
): SessionMeta {
  return { id, projectId, workspaceId }
}

function projectSessionState(
  projectSlug: string,
  sessionId: string,
): NavigationState {
  return {
    navigator: 'projects',
    details: {
      type: 'project',
      projectSlug,
      sessionId,
    },
  }
}

describe('validateProjectSessionNavigationState', () => {
  it('keeps a project session when the URL project owns the session', () => {
    const state = projectSessionState('alpha', 'session-1')
    const sessions = new Map([
      ['session-1', session('session-1', 'project-alpha')],
    ])

    expect(validateProjectSessionNavigationState(
      state,
      sessions,
      [project('project-alpha', 'alpha')],
      'workspace',
    )).toBe(state)
  })

  it('returns to the URL project root when the session belongs to another project', () => {
    const state = projectSessionState('beta', 'session-1')
    const sessions = new Map([
      ['session-1', session('session-1', 'project-alpha')],
    ])

    expect(validateProjectSessionNavigationState(
      state,
      sessions,
      [
        project('project-alpha', 'alpha'),
        project('project-beta', 'beta'),
      ],
      'workspace',
    )).toEqual({
      navigator: 'projects',
      details: {
        type: 'project',
        projectSlug: 'beta',
      },
    })
  })

  it('returns to the project root for an unbound or missing session', () => {
    const state = projectSessionState('alpha', 'session-1')

    expect(validateProjectSessionNavigationState(
      state,
      new Map([['session-1', session('session-1', undefined)]]),
      [project('project-alpha', 'alpha')],
      'workspace',
    )).toEqual({
      navigator: 'projects',
      details: {
        type: 'project',
        projectSlug: 'alpha',
      },
    })

    expect(validateProjectSessionNavigationState(
      state,
      new Map(),
      [project('project-alpha', 'alpha')],
      'workspace',
    )).toEqual({
      navigator: 'projects',
      details: {
        type: 'project',
        projectSlug: 'alpha',
      },
    })
  })

  it('returns to the project root when the session is from another workspace', () => {
    const state = projectSessionState('alpha', 'session-1')
    const sessions = new Map([
      ['session-1', session('session-1', 'project-alpha', 'other-workspace')],
    ])

    expect(validateProjectSessionNavigationState(
      state,
      sessions,
      [project('project-alpha', 'alpha')],
      'workspace',
    )).toEqual({
      navigator: 'projects',
      details: {
        type: 'project',
        projectSlug: 'alpha',
      },
    })
  })

  it('defers project matching while project metadata is still unavailable', () => {
    const state = projectSessionState('alpha', 'session-1')
    const sessions = new Map([
      ['session-1', session('session-1', 'project-alpha')],
    ])

    expect(validateProjectSessionNavigationState(
      state,
      sessions,
      [],
      'workspace',
    )).toBe(state)
  })

  it('rejects a stale slug once the session project is known', () => {
    const state = projectSessionState('renamed-away', 'session-1')
    const sessions = new Map([
      ['session-1', session('session-1', 'project-alpha')],
    ])

    expect(validateProjectSessionNavigationState(
      state,
      sessions,
      [project('project-alpha', 'alpha')],
      'workspace',
    )).toEqual({
      navigator: 'projects',
      details: {
        type: 'project',
        projectSlug: 'renamed-away',
      },
    })
  })
})
