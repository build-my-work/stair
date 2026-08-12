import { describe, expect, it, mock } from 'bun:test'
import type { PropsWithChildren } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

function Passthrough({ children }: PropsWithChildren) {
  return <>{children}</>
}

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

mock.module('@/actions', () => ({
  useActionLabel: () => ({ hotkey: '' }),
}))

mock.module('@craft-agent/ui', () => ({
  Tooltip: Passthrough,
  TooltipTrigger: Passthrough,
  TooltipContent: Passthrough,
}))

mock.module('../../AppMenu', () => ({ AppMenu: () => null }))
mock.module('../../browser/BrowserTabStrip', () => ({ BrowserTabStrip: () => null }))
mock.module('../WorkspaceSwitcher', () => ({ WorkspaceSwitcher: () => null }))
mock.module('../CompactWorkspaceSwitcher', () => ({ CompactWorkspaceSwitcher: () => null }))
mock.module('../../ui/styled-dropdown', () => ({
  DropdownMenu: Passthrough,
  DropdownMenuTrigger: Passthrough,
  StyledDropdownMenuContent: Passthrough,
  StyledDropdownMenuItem: Passthrough,
  StyledDropdownMenuSeparator: () => null,
}))

const { TopBar } = await import('../TopBar')

function renderTopBar(isCompact = false) {
  return renderToStaticMarkup(
    <TopBar
      workspaces={[]}
      activeWorkspaceId={null}
      onSelectWorkspace={() => {}}
      onNewChat={() => {}}
      onOpenSettings={() => {}}
      onOpenSettingsSubpage={() => {}}
      onOpenKeyboardShortcuts={() => {}}
      onOpenStoredUserPreferences={() => {}}
      onBack={() => {}}
      onForward={() => {}}
      canGoBack={false}
      canGoForward={false}
      onToggleSidebar={() => {}}
      onToggleNavigator={() => {}}
      onToggleFocusMode={() => {}}
      onAddSessionPanel={() => {}}
      onAddBrowserPanel={() => {}}
      isCompact={isCompact}
    />,
  )
}

describe('TopBar Navigator toggle', () => {
  it('keeps a persistent Navigator toggle beside the Sidebar control on desktop', () => {
    expect(renderTopBar()).toContain('aria-label="menu.toggleNavigator"')
  })

  it('does not add the desktop shell toggle to compact mode', () => {
    expect(renderTopBar(true)).not.toContain('aria-label="menu.toggleNavigator"')
  })
})
