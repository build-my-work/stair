import type { LoadedProject } from '@craft-agent/shared/projects/types'
import type { SessionMeta } from '@/atoms/sessions'
import { parseRouteToNavigationState } from '../../shared/route-parser'
import type { ViewRoute } from '../../shared/routes'

export function getProjectForRoute(
  route: ViewRoute,
  sessionMetaMap: Map<string, SessionMeta>,
  projects: LoadedProject[],
): LoadedProject | undefined {
  const navigationState = parseRouteToNavigationState(route)
  if (!navigationState) return undefined

  if (navigationState.navigator === 'projects' && navigationState.details) {
    if (navigationState.details.sessionId) {
      const session = sessionMetaMap.get(navigationState.details.sessionId)
      if (session?.projectId) {
        const liveProject = projects.find(project => project.config.id === session.projectId)
        if (liveProject) return liveProject
      }
    }
    return projects.find(project => project.config.slug === navigationState.details?.projectSlug)
  }

  if (navigationState.navigator === 'sessions' && navigationState.details) {
    const session = sessionMetaMap.get(navigationState.details.sessionId)
    if (!session?.projectId) return undefined
    return projects.find(project => project.config.id === session.projectId)
  }

  return undefined
}
