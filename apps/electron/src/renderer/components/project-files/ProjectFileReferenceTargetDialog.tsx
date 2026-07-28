import * as React from 'react'
import { MessageSquarePlus } from 'lucide-react'

import type { MessageReference } from '@craft-agent/core'
import type { SessionMeta } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface ProjectFileReferenceTargetDialogProps {
  reference: MessageReference | null
  sessions: SessionMeta[]
  onOpenChange: (open: boolean) => void
  onSelect: (sessionId: string) => void
  onCreate: () => Promise<void>
}

export function ProjectFileReferenceTargetDialog({
  reference,
  sessions,
  onOpenChange,
  onSelect,
  onCreate,
}: ProjectFileReferenceTargetDialogProps) {
  const [creating, setCreating] = React.useState(false)

  React.useEffect(() => {
    if (!reference) setCreating(false)
  }, [reference])

  return (
    <Dialog open={reference !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Add selection to a chat</DialogTitle>
          <DialogDescription>
            Choose a session in this Project. The EPUB selection stays a structured
            reference and does not change the draft text.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[320px] space-y-1 overflow-y-auto py-1">
          {sessions.length > 0 ? sessions.map(session => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelect(session.id)}
              className="flex w-full min-w-0 flex-col rounded-[8px] px-3 py-2 text-left hover:bg-foreground/[0.045]"
            >
              <span className="truncate text-sm font-medium">
                {getSessionTitle(session)}
              </span>
              {session.preview && (
                <span className="mt-0.5 truncate text-xs text-muted-foreground">
                  {session.preview}
                </span>
              )}
            </button>
          )) : (
            <div className="rounded-[8px] border border-dashed border-border px-4 py-8 text-center">
              <MessageSquarePlus className="mx-auto h-5 w-5 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">No available sessions</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Create a Project session explicitly to attach this selection.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={creating}
            onClick={async () => {
              setCreating(true)
              try {
                await onCreate()
              } finally {
                setCreating(false)
              }
            }}
          >
            <MessageSquarePlus />
            {creating ? 'Creating…' : 'Create session'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
