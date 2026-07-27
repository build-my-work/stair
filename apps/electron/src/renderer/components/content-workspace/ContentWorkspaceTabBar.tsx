import * as React from 'react'
import { BookOpen, FileText, Globe, MessageSquare, X } from 'lucide-react'

import type { ContentWorkspaceTab } from '@/atoms/content-workspace'
import { getWorkspaceFileKind } from '@/components/right-workspace/workspace-file-types'
import { cn } from '@/lib/utils'

interface ContentWorkspaceTabBarProps {
  tabs: ContentWorkspaceTab[]
  activeTabId: string
  onActivateTab: (tabId: string) => void
  onCloseTab: (tab: ContentWorkspaceTab) => void
}

export function ContentWorkspaceTabBar({
  tabs,
  activeTabId,
  onActivateTab,
  onCloseTab,
}: ContentWorkspaceTabBarProps) {
  const activeRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border/70 bg-muted/20">
      <div
        role="tablist"
        aria-label="Content workspace tabs"
        className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const canClose = tab.type !== 'chat'
          return (
            <div
              key={tab.id}
              className={cn(
                'group relative flex min-w-[132px] max-w-[240px] items-center border-r border-border/60 text-xs',
                'text-muted-foreground hover:bg-background/50 hover:text-foreground',
                active && 'bg-background text-foreground',
              )}
              onAuxClick={(event) => {
                if (event.button === 1 && canClose) onCloseTab(tab)
              }}
            >
              <button
                ref={active ? activeRef : undefined}
                type="button"
                role="tab"
                aria-selected={active}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                title={tab.title}
                onClick={() => onActivateTab(tab.id)}
              >
                <ContentTabIcon tab={tab} />
                <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              </button>
              {canClose && (
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/0 transition-colors hover:bg-muted group-hover:text-muted-foreground focus-visible:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => onCloseTab(tab)}
                >
                  <X className="size-3" />
                </button>
              )}
              {active && <span className="absolute inset-x-2 bottom-0 h-px bg-foreground/45" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ContentTabIcon({ tab }: { tab: ContentWorkspaceTab }) {
  const className = 'size-3.5 shrink-0 text-muted-foreground'
  if (tab.type === 'chat') return <MessageSquare className={className} />
  if (tab.type === 'browser') return <Globe className={className} />
  return getWorkspaceFileKind(tab.path) === 'epub'
    ? <BookOpen className={className} />
    : <FileText className={className} />
}
