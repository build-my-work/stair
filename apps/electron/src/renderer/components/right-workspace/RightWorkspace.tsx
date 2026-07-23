import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { FileReference } from '@craft-agent/core/types'

import {
  RIGHT_WORKSPACE_MAX_FILE_EXPLORER_WIDTH,
  RIGHT_WORKSPACE_MAX_WIDTH,
  RIGHT_WORKSPACE_DEFAULT_FILE_EXPLORER_WIDTH,
  RIGHT_WORKSPACE_DEFAULT_WIDTH,
  RIGHT_WORKSPACE_MIN_FILE_EXPLORER_WIDTH,
  RIGHT_WORKSPACE_MIN_WIDTH,
  closeRightWorkspaceTabAtom,
  openRightWorkspaceFileTabAtom,
  openRightWorkspaceArtifactTabAtom,
  openRightWorkspaceNewTabAtom,
  openRightWorkspaceSideChatTabAtom,
  rightWorkspaceActiveTabAtom,
  rightWorkspaceFileNavigationAtom,
  rightWorkspaceStateAtom,
  renameRightWorkspaceArtifactTabAtom,
  setRightWorkspaceActiveTabAtom,
  setRightWorkspaceWidthAtom,
  updateRightWorkspaceFileExplorerAtom,
} from '@/atoms/right-workspace'
import { cn } from '@/lib/utils'
import { RightWorkspaceResizeSash } from './RightWorkspaceResizeSash'
import { RightWorkspaceTabBar, type ArtifactMenuItem, type SideChatMenuItem } from './RightWorkspaceTabBar'
import { RightWorkspaceTabContent } from './RightWorkspaceTabContent'
import { WorkingDirectoryFileExplorer } from './WorkingDirectoryFileExplorer'

interface RightWorkspaceProps {
  workspaceId: string
  sessionId: string
  className?: string
  sideChats?: SideChatMenuItem[]
  onCreateSideChat?: () => Promise<SideChatMenuItem | null> | SideChatMenuItem | null
  onOpenArtifacts?: () => void
  renderSideChat?: (sessionId: string) => React.ReactNode
  renderArtifact?: (artifactId: string) => React.ReactNode
  onAddFileReference?: (sessionId: string, reference: FileReference) => void
}

export function RightWorkspace({
  workspaceId,
  sessionId,
  className,
  sideChats,
  onCreateSideChat,
  onOpenArtifacts,
  renderSideChat,
  renderArtifact,
  onAddFileReference,
}: RightWorkspaceProps) {
  const state = useAtomValue(rightWorkspaceStateAtom)
  const activeTab = useAtomValue(rightWorkspaceActiveTabAtom)
  const fileNavigation = useAtomValue(rightWorkspaceFileNavigationAtom)
  const activateTab = useSetAtom(setRightWorkspaceActiveTabAtom)
  const closeTab = useSetAtom(closeRightWorkspaceTabAtom)
  const openNewTab = useSetAtom(openRightWorkspaceNewTabAtom)
  const openFile = useSetAtom(openRightWorkspaceFileTabAtom)
  const openArtifact = useSetAtom(openRightWorkspaceArtifactTabAtom)
  const openSideChat = useSetAtom(openRightWorkspaceSideChatTabAtom)
  const setWidth = useSetAtom(setRightWorkspaceWidthAtom)
  const updateFileExplorer = useSetAtom(updateRightWorkspaceFileExplorerAtom)
  const renameArtifactTab = useSetAtom(renameRightWorkspaceArtifactTabAtom)
  const [artifacts, setArtifacts] = React.useState<ArtifactMenuItem[]>([])

  const refreshArtifacts = React.useCallback(() => {
    void window.electronAPI.listProjectArtifacts(sessionId)
      .then(items => setArtifacts(items.map(item => ({ artifactId: item.id, title: item.title }))))
      .catch(() => setArtifacts([]))
  }, [sessionId])

  React.useEffect(() => {
    refreshArtifacts()
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{
        id?: string
        artifactId?: string
        title?: string
      }>).detail
      const artifactId = detail?.artifactId ?? detail?.id
      if (artifactId && detail?.title) {
        renameArtifactTab({ artifactId, title: detail.title })
      }
      refreshArtifacts()
    }
    window.addEventListener('craft:artifact-changed', refresh)
    window.addEventListener('craft:artifact-deleted', refresh)
    return () => {
      window.removeEventListener('craft:artifact-changed', refresh)
      window.removeEventListener('craft:artifact-deleted', refresh)
    }
  }, [refreshArtifacts, renameArtifactTab])

  const toggleFiles = React.useCallback(() => {
    updateFileExplorer({ visible: !state.fileExplorerVisible })
  }, [state.fileExplorerVisible, updateFileExplorer])

  const createSideChat = React.useCallback(async () => {
    if (!onCreateSideChat) return null
    const created = await Promise.resolve(onCreateSideChat())
    if (created) openSideChat(created)
    return created
  }, [onCreateSideChat, openSideChat])

  const lastSideChatSessionIdRef = React.useRef<string | null>(sideChats?.[0]?.sessionId ?? null)
  React.useEffect(() => {
    if (activeTab.type === 'sideChat') {
      lastSideChatSessionIdRef.current = activeTab.sessionId
      return
    }
    if (
      lastSideChatSessionIdRef.current
      && !sideChats?.some(item => item.sessionId === lastSideChatSessionIdRef.current)
    ) {
      lastSideChatSessionIdRef.current = sideChats?.[0]?.sessionId ?? null
    }
  }, [activeTab, sideChats])

  const addFileReference = React.useCallback(async (
    reference: FileReference,
    target: 'main' | 'sideChat',
  ) => {
    if (!onAddFileReference) return
    if (target === 'main') {
      onAddFileReference(sessionId, reference)
      return
    }

    let targetSideChat = sideChats?.find(
      item => item.sessionId === lastSideChatSessionIdRef.current,
    ) ?? sideChats?.[0]
    if (!targetSideChat) {
      targetSideChat = await createSideChat() ?? undefined
    }
    if (!targetSideChat) return

    lastSideChatSessionIdRef.current = targetSideChat.sessionId
    onAddFileReference(targetSideChat.sessionId, reference)
    openSideChat(targetSideChat)
  }, [createSideChat, onAddFileReference, openSideChat, sessionId, sideChats])

  const openArtifacts = React.useCallback(() => {
    if (onOpenArtifacts) {
      onOpenArtifacts()
      return
    }
    const latest = artifacts[0]
    if (latest) openArtifact(latest)
  }, [artifacts, onOpenArtifacts, openArtifact])

  const maxExplorerWidth = Math.min(RIGHT_WORKSPACE_MAX_FILE_EXPLORER_WIDTH, state.width - 180)
  const explorerWidth = Math.min(
    state.fileExplorerWidth,
    Math.max(RIGHT_WORKSPACE_MIN_FILE_EXPLORER_WIDTH, maxExplorerWidth),
  )
  const createSideChatAction = onCreateSideChat ? createSideChat : undefined
  const openArtifactsAction = artifacts.length > 0 || onOpenArtifacts ? openArtifacts : undefined
  const addFileReferenceAction = onAddFileReference ? addFileReference : undefined

  return (
    <aside
      aria-label="Right workspace"
      className={cn(
        'relative h-full shrink-0 overflow-hidden rounded-xl bg-background shadow-middle',
        className,
      )}
      style={{ width: state.width }}
    >
      <RightWorkspaceResizeSash
        value={state.width}
        min={RIGHT_WORKSPACE_MIN_WIDTH}
        max={RIGHT_WORKSPACE_MAX_WIDTH}
        edge="left"
        onChange={setWidth}
        resetValue={RIGHT_WORKSPACE_DEFAULT_WIDTH}
      />

      <div className="flex h-full min-h-0 flex-col">
        <RightWorkspaceTabBar
          tabs={state.tabs}
          activeTabId={state.activeTabId}
          fileExplorerVisible={state.fileExplorerVisible}
          sideChats={sideChats}
          artifacts={artifacts}
          onActivateTab={activateTab}
          onCloseTab={closeTab}
          onNewTab={openNewTab}
          onToggleFiles={toggleFiles}
          onCreateSideChat={createSideChatAction}
          onOpenSideChat={(sideChat) => openSideChat(sideChat)}
          onOpenArtifact={(artifact) => openArtifact(artifact)}
        />

        <div className="flex min-h-0 flex-1">
          {state.fileExplorerVisible && (
            <div className="relative h-full shrink-0 border-r border-border/70" style={{ width: explorerWidth }}>
              <WorkingDirectoryFileExplorer
                sessionId={sessionId}
                expandedDirectories={state.expandedDirectories}
                scrollTop={state.fileExplorerScrollTop}
                onExpandedDirectoriesChange={(expandedDirectories) => updateFileExplorer({ expandedDirectories })}
                onScrollTopChange={(scrollTop) => updateFileExplorer({ scrollTop })}
                onOpenFile={openFile}
              />
              <RightWorkspaceResizeSash
                value={explorerWidth}
                min={RIGHT_WORKSPACE_MIN_FILE_EXPLORER_WIDTH}
                max={maxExplorerWidth}
                edge="right"
                onChange={(width) => updateFileExplorer({ width })}
                resetValue={RIGHT_WORKSPACE_DEFAULT_FILE_EXPLORER_WIDTH}
              />
            </div>
          )}

          <div role="tabpanel" className="min-w-0 flex-1 overflow-hidden">
            <RightWorkspaceTabContent
              workspaceId={workspaceId}
              sessionId={sessionId}
              tab={activeTab}
              onOpenFiles={() => updateFileExplorer({ visible: true })}
              onCreateSideChat={createSideChatAction}
              onOpenArtifacts={openArtifactsAction}
              renderSideChat={renderSideChat}
              renderArtifact={renderArtifact}
              onReference={addFileReferenceAction}
              fileNavigation={fileNavigation}
            />
          </div>
        </div>
      </div>
    </aside>
  )
}
