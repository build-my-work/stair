import type { PanelStackEntry } from '@/atoms/panel-stack'
import { parseRouteToNavigationState } from '../../../shared/route-parser'
import ProjectFilePage from '@/pages/ProjectFilePage'
import { MainContentPanel } from './MainContentPanel'

interface PanelContentRouterProps {
  entry: PanelStackEntry
  isSidebarAndNavigatorHidden: boolean
}

export function PanelContentRouter({
  entry,
  isSidebarAndNavigatorHidden,
}: PanelContentRouterProps) {
  switch (entry.route.kind) {
    case 'navigation': {
      const navState = parseRouteToNavigationState(entry.route.viewRoute)
      if (!navState) return null
      return (
        <MainContentPanel
          navStateOverride={navState}
          isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
        />
      )
    }
    case 'projectFile':
      return <ProjectFilePage route={entry.route} panelId={entry.id} />
  }
}
