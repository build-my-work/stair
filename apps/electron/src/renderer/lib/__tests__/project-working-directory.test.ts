import { describe, expect, it } from 'bun:test'
import type { LoadedProject } from '@craft-agent/shared/projects/types'
import type { SessionMeta } from '@/atoms/sessions'
import { getProjectForRoute } from '../project-working-directory'

const projects = [
  {
    config: {
      id: 'project-1',
      slug: 'demo',
      name: 'Demo',
      workingDirectory: '/work/demo',
      createdAt: 1,
      updatedAt: 1,
    },
  },
] as LoadedProject[]

describe('getProjectForRoute', () => {
  it('uses the live project binding for session routes', () => {
    const sessions = new Map<string, SessionMeta>([
      ['s1', {
        id: 's1',
        workspaceId: 'workspace',
        projectId: 'project-1',
        workingDirectory: '/stale/session/path',
      }],
    ])

    expect(getProjectForRoute('allSessions/session/s1', sessions, projects)?.config.workingDirectory)
      .toBe('/work/demo')
  })

  it('resolves project detail routes by slug', () => {
    expect(getProjectForRoute('projects/project/demo', new Map(), projects)?.config.id)
      .toBe('project-1')
  })

  it('prefers the live session binding for project-session routes', () => {
    const otherProject = {
      config: {
        id: 'project-2',
        slug: 'other',
        name: 'Other',
        workingDirectory: '/work/other',
        createdAt: 1,
        updatedAt: 1,
      },
    } as LoadedProject
    const sessions = new Map<string, SessionMeta>([
      ['s1', {
        id: 's1',
        workspaceId: 'workspace',
        projectId: 'project-1',
      }],
    ])

    expect(
      getProjectForRoute(
        'projects/project/other/session/s1',
        sessions,
        [...projects, otherProject],
      )?.config.id,
    ).toBe('project-1')
  })

  it('does not fall back to an unbound session working directory', () => {
    const sessions = new Map<string, SessionMeta>([
      ['s1', {
        id: 's1',
        workspaceId: 'workspace',
        workingDirectory: '/session/only',
      }],
    ])

    expect(getProjectForRoute('allSessions/session/s1', sessions, projects)).toBeUndefined()
  })
})
