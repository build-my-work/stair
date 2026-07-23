import { describe, expect, it } from 'bun:test'

import {
  assertRequestingWorkspace,
  resolveSessionProject,
  resolveSessionProjectWorkingDirectory,
} from './session-project'

const getSession = async () => ({
  id: 'session-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
}) as never

describe('session to Project working-directory resolution', () => {
  it('requires the authenticated RPC workspace to own the Session', () => {
    expect(() => assertRequestingWorkspace(null, 'workspace-1')).toThrow('Workspace context')
    expect(() => assertRequestingWorkspace('workspace-2', 'workspace-1')).toThrow('requesting workspace')
    expect(assertRequestingWorkspace('workspace-1', 'workspace-1')).toBeUndefined()
  })

  it('resolves Project storage even when the Project has no working directory', async () => {
    const resolved = await resolveSessionProject(
      { getSession },
      'session-1',
      () => ({ id: 'workspace-1', rootPath: '/workspace' }) as never,
      () => ({ config: { id: 'project-1', slug: 'systems' } }) as never,
    )

    expect(resolved).toEqual({
      workspaceId: 'workspace-1',
      workspaceRootPath: '/workspace',
      projectId: 'project-1',
      projectSlug: 'systems',
    })
  })

  it('derives the trusted root from the session project binding, never its cwd', async () => {
    const resolved = await resolveSessionProjectWorkingDirectory(
      { getSession },
      'session-1',
      () => ({ id: 'workspace-1', rootPath: '/workspace' }) as never,
      () => ({
        config: {
          id: 'project-1',
          slug: 'systems',
          workingDirectory: '/trusted/project-root',
        },
      }) as never,
    )

    expect(resolved).toEqual({
      workspaceId: 'workspace-1',
      workspaceRootPath: '/workspace',
      projectId: 'project-1',
      projectSlug: 'systems',
      workingDirectory: '/trusted/project-root',
    })
  })

  it('rejects unknown, unbound and working-directory-less sessions', async () => {
    expect(resolveSessionProjectWorkingDirectory(
      { getSession: async () => null },
      'missing',
      () => null,
      () => null,
    )).rejects.toThrow('Session not found')

    expect(resolveSessionProjectWorkingDirectory(
      { getSession: async () => ({ workspaceId: 'workspace-1' }) as never },
      'session-1',
      () => ({ rootPath: '/workspace' }) as never,
      () => null,
    )).rejects.toThrow('not bound to a Project')

    expect(resolveSessionProjectWorkingDirectory(
      { getSession },
      'session-1',
      () => ({ rootPath: '/workspace' }) as never,
      () => ({ config: { id: 'project-1', slug: 'systems' } }) as never,
    )).rejects.toThrow('has no working directory')

    expect(resolveSessionProject(
      { getSession },
      'session-1',
      () => ({ rootPath: '/workspace' }) as never,
      () => ({ config: { id: 'project-1', slug: '../outside' } }) as never,
    )).rejects.toThrow('Invalid Project slug')
  })
})
