import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, FileText, Loader2 } from 'lucide-react'
import { isProjectNoteTargetPath } from '@craft-agent/shared/protocol'

import { ProjectFilesBrowser } from '@/components/project-files/ProjectFilesBrowser'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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
  currentPath?: string
  recentPaths?: string[]
  intent: 'configure' | 'append'
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
  currentPath,
  recentPaths = [],
  intent,
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
  const recentTargets = React.useMemo(() => {
    const seen = new Set<string>()
    return [currentPath, ...recentPaths]
      .filter((path): path is string => {
        if (!path || !isProjectNoteTargetPath(path) || seen.has(path)) {
          return false
        }
        seen.add(path)
        return true
      })
      .slice(0, 5)
  }, [currentPath, recentPaths])
  const defaultSelectedPath = recentTargets[0]

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
        className="flex h-[min(620px,calc(100vh-2rem))] w-[min(680px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
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
        <div className="shrink-0 border-b border-border/55 px-4 py-3">
          <DialogTitle className="text-sm font-medium">
            {t('projectNoteTarget.title')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('projectNoteTarget.searchHint')}
          </DialogDescription>
        </div>

        {recentTargets.length > 0 && (
          <div className="shrink-0 border-b border-border/55 px-4 py-3">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t('projectNoteTarget.recentTargets')}
            </div>
            <div className="space-y-0.5">
              {recentTargets.map(path => {
                const { name, parent } = getPathParts(path)
                const selected = selectedPath === path
                return (
                  <button
                    key={path}
                    type="button"
                    disabled={!rootPath || isSubmitting || browserBusy}
                    aria-label={`${t('projectNoteTarget.recentTargets')}: ${path}`}
                    aria-pressed={selected}
                    onClick={() => {
                      setSelectedPath(path)
                      setSubmitError(undefined)
                    }}
                    onDoubleClick={() => void handleSelect(path)}
                    onKeyDown={event => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      void handleSelect(path)
                    }}
                    className={cn(
                      'flex h-10 w-full min-w-0 items-center gap-2 rounded-[7px] px-2 text-left outline-none transition-colors',
                      'focus-visible:ring-1 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50',
                      selected
                        ? 'bg-accent/[0.09] ring-1 ring-inset ring-accent/20'
                        : 'hover:bg-foreground/[0.04]',
                    )}
                  >
                    <FileText
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        selected ? 'text-accent' : 'text-muted-foreground',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {name}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {parent || '.'}
                      </span>
                    </span>
                    {selected && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                    )}
                  </button>
                )
              })}
            </div>
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

        <div className="flex shrink-0 items-center gap-3 border-t border-border/55 px-3 py-2.5">
          {submitError && (
            <p
              className="min-w-0 flex-1 truncate text-xs text-destructive"
              role="alert"
              title={submitError}
            >
              {submitError}
            </p>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
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
