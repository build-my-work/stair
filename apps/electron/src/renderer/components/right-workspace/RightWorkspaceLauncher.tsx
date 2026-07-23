import {
  FileText,
  FolderTree,
  MessageSquare,
} from 'lucide-react'

import { cn } from '@/lib/utils'

interface RightWorkspaceLauncherProps {
  onOpenFiles: () => void
  onCreateSideChat?: () => void
  onOpenArtifacts?: () => void
}

export function RightWorkspaceLauncher({
  onOpenFiles,
  onCreateSideChat,
  onOpenArtifacts,
}: RightWorkspaceLauncherProps) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-7">
      <div className="w-full max-w-[460px]">
        <div className="mb-7">
          <div className="mb-2 font-serif text-[22px] leading-7 text-foreground">Learning workspace</div>
          <p className="max-w-sm text-xs leading-5 text-muted-foreground">
            Keep the source beside your conversation. Open a book, inspect a file, or continue a focused side chat.
          </p>
        </div>

        <div className="grid gap-2">
          <LauncherAction
            icon={<FolderTree className="size-4" />}
            title="Browse project files"
            description="Open EPUB, PDF, Markdown, images, and code"
            onClick={onOpenFiles}
          />
          {onCreateSideChat && (
            <LauncherAction
              icon={<MessageSquare className="size-4" />}
              title="New side chat"
              description="Ask a focused question without leaving the main chat"
              onClick={onCreateSideChat}
            />
          )}
          {onOpenArtifacts && (
            <LauncherAction
              icon={<FileText className="size-4" />}
              title="Open artifacts"
              description="Review saved Markdown outcomes"
              onClick={onOpenArtifacts}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function LauncherAction({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl border border-border/70 bg-background/80 px-3.5 py-3 text-left shadow-minimal',
        'transition-colors hover:border-border hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
      onClick={onClick}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors group-hover:text-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}
