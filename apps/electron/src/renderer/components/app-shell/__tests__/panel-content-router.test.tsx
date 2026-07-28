import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PanelStackEntry } from '@/atoms/panel-stack'

mock.module('../MainContentPanel', () => ({
  MainContentPanel: () => <div data-testid="navigation-content" />,
}))
mock.module('@/pages/ProjectFilePage', () => ({
  default: ({ route }: { route: { relativePath: string } }) => (
    <div data-testid="project-file-content">{route.relativePath}</div>
  ),
}))

const { PanelContentRouter } = await import('../PanelContentRouter')

function entry(route: PanelStackEntry['route']): PanelStackEntry {
  return {
    id: 'panel-1',
    route,
    proportion: 1,
  }
}

describe('PanelContentRouter', () => {
  it('dispatches navigation content', () => {
    const html = renderToStaticMarkup(
      <PanelContentRouter
        entry={entry({
          kind: 'navigation',
          viewRoute: 'projects/project/demo',
        })}
        isSidebarAndNavigatorHidden={false}
      />,
    )
    expect(html).toContain('data-testid="navigation-content"')
    expect(html).not.toContain('data-testid="project-file-content"')
  })

  it('dispatches Project File content', () => {
    const html = renderToStaticMarkup(
      <PanelContentRouter
        entry={entry({
          kind: 'projectFile',
          projectId: 'project-1',
          relativePath: 'README.md',
          contextRoute: 'projects/project/demo',
        })}
        isSidebarAndNavigatorHidden={false}
      />,
    )
    expect(html).toContain('data-testid="project-file-content"')
    expect(html).toContain('README.md')
    expect(html).not.toContain('data-testid="navigation-content"')
  })
})
