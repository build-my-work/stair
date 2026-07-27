import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { FileReference } from '@craft-agent/core/types'

import {
  CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID,
  closeContentWorkspaceTabAtom,
  contentWorkspaceFileNavigationAtomFamily,
  contentWorkspaceStateAtomFamily,
  renameContentWorkspaceBrowserAtom,
  setContentWorkspaceActiveTabAtom,
  type ContentWorkspaceKey,
  type ContentWorkspaceTab,
} from '@/atoms/content-workspace'
import { EmbeddedBrowserSurface } from '@/components/browser/EmbeddedBrowserSurface'
import { WorkspaceFileTab } from '@/components/right-workspace/WorkspaceFileTab'
import { cn } from '@/lib/utils'
import { ContentWorkspaceTabBar } from './ContentWorkspaceTabBar'

export interface ContentWorkspaceProps extends ContentWorkspaceKey {
  mainChat: React.ReactNode
  className?: string
  onReference?: (reference: FileReference, target: 'main' | 'sideChat') => void
}

export function ContentWorkspace({
  workspaceId,
  sessionId,
  mainChat,
  className,
  onReference,
}: ContentWorkspaceProps) {
  const key = React.useMemo(
    () => ({ workspaceId, sessionId }),
    [sessionId, workspaceId],
  )
  const state = useAtomValue(contentWorkspaceStateAtomFamily(key))
  const fileNavigation = useAtomValue(contentWorkspaceFileNavigationAtomFamily(key))
  const setActiveTab = useSetAtom(setContentWorkspaceActiveTabAtom)
  const closeTab = useSetAtom(closeContentWorkspaceTabAtom)
  const renameBrowser = useSetAtom(renameContentWorkspaceBrowserAtom)
  const [mountedTabIds, setMountedTabIds] = React.useState<Set<string>>(() => (
    new Set([CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID, state.activeTabId])
  ))

  React.useEffect(() => {
    setMountedTabIds((current) => {
      const liveTabIds = new Set(state.tabs.map(tab => tab.id))
      const next = new Set(
        [...current].filter(tabId => liveTabIds.has(tabId)),
      )
      next.add(CONTENT_WORKSPACE_MAIN_CHAT_TAB_ID)
      next.add(state.activeTabId)
      return next
    })
  }, [state.activeTabId, state.tabs])

  const activateTab = React.useCallback((tabId: string) => {
    setActiveTab({ ...key, tabId })
  }, [key, setActiveTab])

  const handleCloseTab = React.useCallback((tab: ContentWorkspaceTab) => {
    if (tab.type === 'browser') {
      void window.electronAPI.browserPane.destroy(tab.instanceId).catch((error) => {
        console.warn('[ContentWorkspace] Failed to destroy browser:', error)
      })
    }
    closeTab({ ...key, tabId: tab.id })
  }, [closeTab, key])

  return (
    <section
      aria-label="Content workspace"
      data-active-tab-type={state.tabs.find(tab => tab.id === state.activeTabId)?.type}
      className={cn('flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background', className)}
    >
      <ContentWorkspaceTabBar
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onActivateTab={activateTab}
        onCloseTab={handleCloseTab}
      />

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {state.tabs.map((tab) => {
          const active = tab.id === state.activeTabId
          const mounted = mountedTabIds.has(tab.id)
          return (
            <div
              key={tab.id}
              role="tabpanel"
              aria-hidden={!active}
              className={cn('absolute inset-0 min-h-0 min-w-0 overflow-hidden', !active && 'hidden')}
            >
              {mounted && tab.type === 'chat' && mainChat}
              {mounted && tab.type === 'file' && (
                <WorkspaceFileTab
                  workspaceId={workspaceId}
                  sessionId={sessionId}
                  path={tab.path}
                  onReference={onReference}
                  navigation={fileNavigation?.path === tab.path ? fileNavigation : undefined}
                />
              )}
              {mounted && tab.type === 'browser' && active && (
                <EmbeddedBrowserSurface
                  instanceId={tab.instanceId}
                  onTitleChange={(title) => {
                    renameBrowser({ ...key, instanceId: tab.instanceId, title })
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
