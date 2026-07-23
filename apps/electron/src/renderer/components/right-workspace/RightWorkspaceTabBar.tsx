import * as React from 'react'
import {
  BookOpen,
  FileText,
  FolderTree,
  MessageSquare,
  Plus,
  Sparkles,
  X,
} from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'

import type { RightWorkspaceTab } from '@/atoms/right-workspace'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'

export interface SideChatMenuItem {
  sessionId: string
  title: string
}

export interface ArtifactMenuItem {
  artifactId: string
  title: string
}

interface RightWorkspaceTabBarProps {
  tabs: RightWorkspaceTab[]
  activeTabId: string
  fileExplorerVisible: boolean
  sideChats?: SideChatMenuItem[]
  artifacts?: ArtifactMenuItem[]
  onActivateTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onNewTab: () => void
  onToggleFiles: () => void
  onCreateSideChat?: () => void
  onOpenSideChat?: (sideChat: SideChatMenuItem) => void
  onOpenArtifact?: (artifact: ArtifactMenuItem) => void
}

export function RightWorkspaceTabBar({
  tabs,
  activeTabId,
  fileExplorerVisible,
  sideChats = [],
  artifacts = [],
  onActivateTab,
  onCloseTab,
  onNewTab,
  onToggleFiles,
  onCreateSideChat,
  onOpenSideChat,
  onOpenArtifact,
}: RightWorkspaceTabBarProps) {
  const activeRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border/70 bg-muted/20">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={fileExplorerVisible ? 'Hide files' : 'Show files'}
            aria-pressed={fileExplorerVisible}
            className={cn(
              'flex w-9 shrink-0 items-center justify-center border-r border-border/60 text-muted-foreground transition-colors',
              'hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
              fileExplorerVisible && 'bg-muted/70 text-foreground',
            )}
            onClick={onToggleFiles}
          >
            <FolderTree className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Files</TooltipContent>
      </Tooltip>

      <div role="tablist" aria-label="Right workspace tabs" className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={cn(
                'group relative flex min-w-[112px] max-w-[190px] flex-1 items-center border-r border-border/60 text-xs',
                'text-muted-foreground hover:bg-background/50 hover:text-foreground',
                active && 'bg-background text-foreground',
              )}
              onAuxClick={(event) => {
                if (event.button === 1) onCloseTab(tab.id)
              }}
            >
              <button
                ref={active ? activeRef : undefined}
                type="button"
                role="tab"
                aria-selected={active}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                title={tab.title}
                onClick={() => onActivateTab(tab.id)}
              >
                <TabIcon tab={tab} />
                <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/0 transition-colors hover:bg-muted group-hover:text-muted-foreground focus-visible:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => onCloseTab(tab.id)}
              >
                <X className="size-3" />
              </button>
              {active && <span className="absolute inset-x-2 bottom-0 h-px bg-foreground/45" />}
            </div>
          )
        })}
      </div>

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="New workspace tab"
                className="flex w-9 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Plus className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">New tab</TooltipContent>
        </Tooltip>
        <StyledDropdownMenuContent align="end" minWidth="min-w-52">
          <StyledDropdownMenuItem onClick={onNewTab}>
            <Sparkles className="size-3.5" />
            New tab
          </StyledDropdownMenuItem>
          <StyledDropdownMenuItem onClick={onToggleFiles}>
            <FolderTree className="size-3.5" />
            {fileExplorerVisible ? 'Hide files' : 'Files'}
          </StyledDropdownMenuItem>
          {onCreateSideChat && (
            <>
              <StyledDropdownMenuSeparator />
              <StyledDropdownMenuItem onClick={onCreateSideChat}>
                <MessageSquare className="size-3.5" />
                New side chat
              </StyledDropdownMenuItem>
            </>
          )}
          {sideChats.map((sideChat) => (
            <StyledDropdownMenuItem
              key={sideChat.sessionId}
              onClick={() => onOpenSideChat?.(sideChat)}
            >
              <MessageSquare className="size-3.5" />
              <span className="truncate">{sideChat.title}</span>
            </StyledDropdownMenuItem>
          ))}
          {artifacts.length > 0 && <StyledDropdownMenuSeparator />}
          {artifacts.map((artifact) => (
            <StyledDropdownMenuItem
              key={artifact.artifactId}
              onClick={() => onOpenArtifact?.(artifact)}
            >
              <FileText className="size-3.5" />
              <span className="truncate">{artifact.title}</span>
            </StyledDropdownMenuItem>
          ))}
        </StyledDropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function TabIcon({ tab }: { tab: RightWorkspaceTab }) {
  const className = 'size-3.5 shrink-0 text-muted-foreground'
  if (tab.type === 'file') {
    return tab.path.toLowerCase().endsWith('.epub')
      ? <BookOpen className={className} />
      : <FileText className={className} />
  }
  if (tab.type === 'sideChat') return <MessageSquare className={className} />
  if (tab.type === 'artifact') return <FileText className={className} />
  return <Sparkles className={className} />
}
