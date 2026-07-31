import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, FileText, Loader2, NotebookPen } from 'lucide-react'
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
  recentPaths?: string[]
  intent: 'configure' | 'append'
  quote?: string
  onSelect: (relativePath: string) => Promise<void>
  onCancel: () => void
  onRestoreFocus?: () => void
}

function getPathParts(relativePath: string) {
  const parts = relativePath.split('/')
  return {
    name: parts.pop() ?? relativePath,
    parent: parts.join('/'),
  }
}

export function ProjectNoteTargetPicker({
  open,
  projectId,
  projectName,
  rootPath,
  sessionName,
  currentPath,
  recentPaths = [],
  intent,
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
  const isSubmittingRef = React.useRef(false)
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
    if (!rootPath || isSubmittingRef.current || browserBusy) return
    isSubmittingRef.current = true
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
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }, [browserBusy, onSelect, rootPath, t])
  const quickTargets = React.useMemo(() => {
    const validCurrentPath = currentPath
      && isProjectNoteTargetPath(currentPath)
      ? currentPath
      : undefined
    const recent = recentPaths
      .filter(path =>
        path !== validCurrentPath
        && isProjectNoteTargetPath(path))
      .slice(0, validCurrentPath ? 4 : 5)
    return {
      current: validCurrentPath,
      recent,
    }
  }, [currentPath, recentPaths])
  const defaultSelectedPath = quickTargets.current

  React.useEffect(() => {
    setSelectedPath(defaultSelectedPath)
    setSubmitError(undefined)
  }, [defaultSelectedPath, projectId])

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen && !isSubmitting && !browserBusy) onCancel()
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

        {(quickTargets.current || quickTargets.recent.length > 0) && (
          <div className="shrink-0 border-b border-border/55 bg-background px-4 py-3">
            {quickTargets.current && (
              <div>
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                  {t('projectNoteTarget.currentTarget')}
                </div>
                <button
                  type="button"
                  disabled={!rootPath || isSubmitting || browserBusy}
                  aria-label={`${t('projectNoteTarget.currentTarget')}: ${quickTargets.current}`}
                  onClick={() => {
                    setSelectedPath(quickTargets.current)
                    setSubmitError(undefined)
                    void handleSelect(quickTargets.current!)
                  }}
                  className="flex h-10 w-full min-w-0 items-center gap-2 rounded-[7px] px-2 text-left outline-none transition-colors hover:bg-foreground/[0.045] focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {getPathParts(quickTargets.current).name}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground/65">
                      {getPathParts(quickTargets.current).parent || '.'}
                    </span>
                  </span>
                  <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              </div>
            )}

            {quickTargets.recent.length > 0 && (
              <div className={quickTargets.current ? 'mt-2.5' : undefined}>
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                  {t('projectNoteTarget.recentTargets')}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {quickTargets.recent.map(path => {
                    const { name, parent } = getPathParts(path)
                    return (
                      <button
                        key={path}
                        type="button"
                        disabled={!rootPath || isSubmitting || browserBusy}
                        aria-label={`${t('projectNoteTarget.recentTargets')}: ${path}`}
                        onClick={() => {
                          setSelectedPath(path)
                          setSubmitError(undefined)
                          void handleSelect(path)
                        }}
                        className="flex h-10 min-w-0 items-center gap-2 rounded-[7px] px-2 text-left outline-none transition-colors hover:bg-foreground/[0.045] focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {name}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-muted-foreground/65">
                            {parent || '.'}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

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
              disabled={isSubmitting || browserBusy}
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
              {intent === 'append'
                ? t('projectNoteTarget.addNoteHere')
                : t('projectNoteTarget.setAsTarget')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
