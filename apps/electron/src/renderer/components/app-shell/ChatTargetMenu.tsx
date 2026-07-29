import type { ReactElement } from 'react'
import { Check, MessageSquare } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface ChatTargetOption {
  id: string
  title: string
}

interface ChatTargetMenuProps {
  targetSessionId: string | null
  targets: readonly ChatTargetOption[]
  onChange: (sessionId: string) => void
  align?: 'start' | 'center' | 'end'
}

export function ChatTargetMenu({
  targetSessionId,
  targets,
  onChange,
  align = 'start',
}: ChatTargetMenuProps): ReactElement {
  const target = targets.find(option => option.id === targetSessionId)
  const tooltip = target
    ? `Chat: ${target.title}`
    : 'Choose a discussion chat'

  return (
    <Tooltip>
      <DropdownMenu>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'size-8 shrink-0',
                target ? 'text-blue-500' : 'text-muted-foreground',
              )}
              aria-label={tooltip}
            >
              <MessageSquare className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <DropdownMenuContent
          align={align}
          sideOffset={8}
          className="max-h-[240px] w-56"
        >
          <DropdownMenuLabel className="px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Discussion chat
          </DropdownMenuLabel>
          {targets.length > 0 ? targets.map(option => {
            const selected = option.id === targetSessionId
            return (
              <DropdownMenuItem
                key={option.id}
                className="text-xs"
                aria-current={selected ? 'true' : undefined}
                onSelect={() => onChange(option.id)}
              >
                <Check
                  className={cn(
                    'size-3.5',
                    selected ? 'text-blue-500 opacity-100' : 'opacity-0',
                  )}
                />
                <span className="truncate">{option.title}</span>
              </DropdownMenuItem>
            )
          }) : (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              No available chats
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <TooltipContent side="bottom" className="max-w-64 truncate">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
