import { describe, expect, it } from 'bun:test'
import {
  buildCompoundRoute,
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import { routes } from '../routes'
import {
  getNavigationStateKey,
  isProjectsNavigation,
  parseNavigationStateKey,
  type ProjectsNavigationState,
} from '../types'

describe('route-parser: project session routes', () => {
  const projectState: ProjectsNavigationState = {
    navigator: 'projects',
    details: { type: 'project', projectSlug: 'operating-systems' },
  }
  const projectSessionState: ProjectsNavigationState = {
    navigator: 'projects',
    details: {
      type: 'project',
      projectSlug: 'operating-systems',
      sessionId: 'session-123',
    },
  }

  it('builds project and project-session routes', () => {
    expect(routes.view.projects()).toBe('projects')
    expect(routes.view.projects('operating-systems')).toBe(
      'projects/project/operating-systems'
    )
    expect(routes.view.projectSession('operating-systems', 'session-123')).toBe(
      'projects/project/operating-systems/session/session-123'
    )
  })

  it('parses and rebuilds a project-session compound route', () => {
    const route = 'projects/project/operating-systems/session/session-123'
    const parsed = parseCompoundRoute(route)

    expect(parsed).toEqual({
      navigator: 'projects',
      details: {
        type: 'project',
        id: 'operating-systems',
        sessionId: 'session-123',
      },
    })
    expect(buildCompoundRoute(parsed!)).toBe(route)
  })

  it('preserves project context in the generic parsed route', () => {
    expect(
      parseRoute('projects/project/operating-systems/session/session-123')
    ).toEqual({
      type: 'view',
      name: 'project-info',
      id: 'operating-systems',
      params: { sessionId: 'session-123' },
    })
  })

  it.each([
    ['project', projectState, 'projects/project/operating-systems'],
    [
      'project session',
      projectSessionState,
      'projects/project/operating-systems/session/session-123',
    ],
  ] as const)('round-trips %s navigation state', (_name, state, route) => {
    expect(buildRouteFromNavigationState(state)).toBe(route)

    const parsed = parseRouteToNavigationState(route)
    expect(parsed).toEqual(state)
    expect(parsed && isProjectsNavigation(parsed)).toBe(true)
  })

  it.each([projectState, projectSessionState])(
    'round-trips the project navigation key for %#',
    (state) => {
      const key = getNavigationStateKey(state)
      expect(parseNavigationStateKey(key)).toEqual(state)
    }
  )

  it('rejects incomplete or trailing project-session paths', () => {
    expect(parseCompoundRoute('projects/project/operating-systems/session')).toBeNull()
    expect(
      parseCompoundRoute(
        'projects/project/operating-systems/session/session-123/extra'
      )
    ).toBeNull()
    expect(
      parseNavigationStateKey('projects/project/operating-systems/session')
    ).toBeNull()
  })
})
