import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Loader2, NotebookPen } from 'lucide-react'
import { isProjectNoteTargetPath } from '@craft-agent/shared/protocol'

import { ProjectFilesBrowser } from '@/components/project-files/ProjectFilesBrowser'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

interface ProjectNoteTargetPickerProps {
  open: boolean
  projectId: string
  projectName?: string
  rootPath?: string
  sessionName: string
  currentPath?: string
  quote?: string
  onSelect: (relativePath: string) => Promise<void>
  onCancel: () => void
  onRestoreFocus?: () => void
}

export function ProjectNoteTargetPicker({
  open,
  projectId,
  projectName,
  rootPath,
  sessionName,
  currentPath,
  quote,
  onSelect,
  onCancel,
  onRestoreFocus,
}: ProjectNoteTargetPickerProps) {
  const { t } = useTranslation()
  const [selectedPath, setSelectedPath] = React.useState<string | undefined>(
    rootPath && currentPath && isProjectNoteTargetPath(currentPath)
      ? currentPath
      : undefined,
  )
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [browserBusy, setBrowserBusy] = React.useState(false)
  const [submitError, setSubmitError] = React.useState<string>()
  const returnFocusRef = React.useRef<HTMLElement | null>(
    typeof document !== 'undefined'
      && document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      ? document.activeElement
      : null,
  )

  const handleSelect = React.useCallback(async (relativePath: string) => {
    if (!rootPath || isSubmitting || browserBusy) return
    setIsSubmitting(true)
    setSubmitError(undefined)
    try {
      await onSelect(relativePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSubmitError(
        message.replace(/^PROJECT_NOTE_[A-Z_]+:\s*/, '')
        || t('projectNoteTarget.setError'),
      )
      setIsSubmitting(false)
    }
  }, [browserBusy, isSubmitting, onSelect, rootPath, t])

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen && !isSubmitting) onCancel()
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-busy={browserBusy || isSubmitting}
        className="flex h-[min(720px,calc(100vh-2rem))] w-[min(760px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        onEscapeKeyDown={event => {
          if (browserBusy) event.preventDefault()
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          if (returnFocusRef.current?.isConnected) {
            returnFocusRef.current.focus()
          } else {
            onRestoreFocus?.()
          }
        }}
      >
        <div className="shrink-0 border-b border-border/55 px-4 py-3.5">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 rounded-[7px] bg-foreground/5 p-1.5">
              <NotebookPen className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-sm font-medium">
                {t('projectNoteTarget.title')}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-5">
                {projectName
                  ? t('projectNoteTarget.descriptionProject', {
                      sessionName,
                      projectName,
                    })
                  : t('projectNoteTarget.description', { sessionName })}
              </DialogDescription>
            </div>
          </div>
          {quote && (
            <blockquote className="mt-3 line-clamp-2 border-l-2 border-foreground/15 pl-2.5 text-[11px] leading-4 text-muted-foreground">
              {quote}
            </blockquote>
          )}
        </div>

        <ProjectFilesBrowser
          mode="note-target"
          projectId={projectId}
          projectName={projectName}
          rootPath={rootPath}
          selectedFilePath={selectedPath}
          disabled={isSubmitting}
          autoFocusSearch
          onSelectFile={relativePath => {
            setSelectedPath(relativePath)
            setSubmitError(undefined)
          }}
          onActivateFile={relativePath => void handleSelect(relativePath)}
          onBusyChange={setBrowserBusy}
        />

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/55 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span
              className={submitError
                ? 'truncate text-destructive'
                : 'truncate font-mono text-muted-foreground'}
              role={submitError ? 'alert' : undefined}
              title={submitError || selectedPath}
            >
              {submitError || selectedPath || t('projectNoteTarget.searchHint')}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSubmitting}
              onClick={onCancel}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!rootPath || !selectedPath || isSubmitting || browserBusy}
              onClick={() => {
                if (selectedPath) void handleSelect(selectedPath)
              }}
            >
              {isSubmitting && <Loader2 className="animate-spin" />}
              {t('projectNoteTarget.useFile')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
