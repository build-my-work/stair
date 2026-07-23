import { MessageSquare } from 'lucide-react'

import type { RightWorkspaceFileNavigation, RightWorkspaceTab } from '@/atoms/right-workspace'
import { RightWorkspaceLauncher } from './RightWorkspaceLauncher'
import { WorkspaceFileTab } from './WorkspaceFileTab'
import type { FileReference } from '@craft-agent/core/types'
import { ArtifactWorkspaceTab } from '@/components/artifacts/ArtifactWorkspaceTab'

interface RightWorkspaceTabContentProps {
  workspaceId: string
  sessionId: string
  tab: RightWorkspaceTab
  onOpenFiles: () => void
  onCreateSideChat?: () => void
  onOpenArtifacts?: () => void
  renderSideChat?: (sessionId: string) => React.ReactNode
  renderArtifact?: (artifactId: string) => React.ReactNode
  onReference?: (reference: FileReference, target: 'main' | 'sideChat') => void
  fileNavigation?: RightWorkspaceFileNavigation | null
}

export function RightWorkspaceTabContent({
  workspaceId,
  sessionId,
  tab,
  onOpenFiles,
  onCreateSideChat,
  onOpenArtifacts,
  renderSideChat,
  renderArtifact,
  onReference,
  fileNavigation,
}: RightWorkspaceTabContentProps) {
  if (tab.type === 'new') {
    return (
      <RightWorkspaceLauncher
        onOpenFiles={onOpenFiles}
        onCreateSideChat={onCreateSideChat}
        onOpenArtifacts={onOpenArtifacts}
      />
    )
  }

  if (tab.type === 'file') {
    return (
      <WorkspaceFileTab
        workspaceId={workspaceId}
        sessionId={sessionId}
        path={tab.path}
        onReference={onReference}
        navigation={fileNavigation?.path === tab.path ? fileNavigation : undefined}
      />
    )
  }

  if (tab.type === 'sideChat') {
    if (renderSideChat) return renderSideChat(tab.sessionId)
    return (
      <UnavailableTab
        icon={<MessageSquare className="size-7" strokeWidth={1.35} />}
        title="Side chat unavailable"
        description="This chat could not be restored. You can close this tab without deleting the saved session."
      />
    )
  }

  if (renderArtifact) return renderArtifact(tab.artifactId)
  return <ArtifactWorkspaceTab sessionId={sessionId} artifactId={tab.artifactId} />
}

function UnavailableTab({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="max-w-xs">
        <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground/65">
          {icon}
        </div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
