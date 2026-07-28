import { describe, expect, it } from 'bun:test'
import {
  buildNavigationPanelRoute,
  buildProjectFileRoute,
  getPanelContextRoute,
  isProjectFileRoute,
  panelContentRoutesEqual,
} from '../project-file-route'

describe('project file routes', () => {
  it('keeps project identity, relative path, and navigation context separate', () => {
    const route = buildProjectFileRoute({
      projectId: 'project-1',
      relativePath: '文档/My file.md',
      contextRoute: 'projects/project/demo/session/s1',
    })

    expect(route).toEqual({
      kind: 'projectFile',
      projectId: 'project-1',
      relativePath: '文档/My file.md',
      contextRoute: 'projects/project/demo/session/s1',
    })
    expect(isProjectFileRoute(route)).toBe(true)
    expect(getPanelContextRoute(route)).toBe('projects/project/demo/session/s1')
  })

  it('returns a navigation panel view route as its context', () => {
    expect(getPanelContextRoute(
      buildNavigationPanelRoute('allSessions/session/s1'),
    )).toBe('allSessions/session/s1')
  })

  it('compares discriminated routes by their complete identity', () => {
    const first = buildProjectFileRoute({
      projectId: 'project-1',
      relativePath: 'src/index.ts',
      contextRoute: 'projects/project/demo',
    })
    const same = buildProjectFileRoute({
      projectId: 'project-1',
      relativePath: 'src/index.ts',
      contextRoute: 'projects/project/demo',
    })
    const differentProject = buildProjectFileRoute({
      projectId: 'project-2',
      relativePath: 'src/index.ts',
      contextRoute: 'projects/project/demo',
    })

    expect(panelContentRoutesEqual(first, same)).toBe(true)
    expect(panelContentRoutesEqual(first, differentProject)).toBe(false)
  })
})
