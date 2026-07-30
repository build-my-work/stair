import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  FolderKanban,
  Loader2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

interface ProjectNoteProjectOption {
  id: string
  name: string
  color?: string
}

interface ProjectNoteProjectPickerProps {
  open: boolean
  sessionName: string
  projects: ProjectNoteProjectOption[]
  assigningProjectId?: string
  quote?: string
  onSelect: (projectId: string) => void
  onCancel: () => void
}

export function ProjectNoteProjectPicker({
  open,
  sessionName,
  projects,
  assigningProjectId,
  quote,
  onSelect,
  onCancel,
}: ProjectNoteProjectPickerProps) {
  const { t } = useTranslation()
  const isAssigning = Boolean(assigningProjectId)

  return (
    <CommandDialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen && !isAssigning) onCancel()
      }}
      commandProps={{
        shouldFilter: false,
        label: t('projectNoteTarget.chooseProjectTitle'),
        'aria-busy': isAssigning,
      }}
      footer={(
        <div className="flex justify-end border-t border-border/55 px-3 py-2.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isAssigning}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </Button>
        </div>
      )}
    >
      <div className="border-b border-border/55 px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 rounded-[7px] bg-foreground/5 p-1.5">
            <FolderKanban className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-sm font-medium">
              {t('projectNoteTarget.chooseProjectTitle')}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-5">
              {t('projectNoteTarget.chooseProjectDescription', {
                sessionName,
              })}
            </DialogDescription>
          </div>
        </div>
        {quote && (
          <blockquote className="mt-3 line-clamp-2 border-l-2 border-foreground/15 pl-2.5 text-[11px] leading-4 text-muted-foreground">
            {quote}
          </blockquote>
        )}
      </div>

      <CommandList className="h-[320px] max-h-[40vh] py-1 [&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:min-h-full [&_[cmdk-list-sizer]]:flex-col">
        {projects.length > 0
          ? (
              <CommandGroup heading={t('sessionMenu.projects')}>
                {projects.map(project => (
                  <CommandItem
                    key={project.id}
                    value={project.id}
                    disabled={isAssigning}
                    onSelect={() => onSelect(project.id)}
                    className="py-2"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full border border-foreground/10"
                      style={{ backgroundColor: project.color ?? 'currentColor' }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {project.name}
                    </span>
                    {assigningProjectId === project.id && (
                      <Loader2 className="animate-spin" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          : (
              <div className="flex flex-1 items-center justify-center px-4 py-7 text-center text-xs text-muted-foreground">
                {t('projectsList.empty')}
              </div>
            )}
      </CommandList>
    </CommandDialog>
  )
}
