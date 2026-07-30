import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  FileText,
  FolderOpen,
  Loader2,
  NotebookPen,
} from 'lucide-react'
import type { ProjectFileSearchResult } from '@craft-agent/shared/protocol'

import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

const MARKDOWN_EXTENSIONS = ['md', 'markdown']
const PROJECT_NOTE_TARGET_TIMEOUT_MS = 5_000

export async function withProjectNoteTargetTimeout<T>(
  request: Promise<T>,
  timeoutMs = PROJECT_NOTE_TARGET_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Setting the Add Note target timed out. Try again.'))
    }, timeoutMs)
  })

  try {
    return await Promise.race([request, timeoutPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export function isProjectNoteTargetPath(path: string): boolean {
  const lowerPath = path.toLowerCase()
  return lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown')
}

export function filterProjectNoteTargets(
  results: ProjectFileSearchResult[],
): ProjectFileSearchResult[] {
  const seen = new Set<string>()
  return results.filter(result => {
    if (!isProjectNoteTargetPath(result.relativePath) || seen.has(result.relativePath)) {
      return false
    }
    seen.add(result.relativePath)
    return true
  })
}

interface ProjectNoteTargetPickerProps {
  open: boolean
  projectId: string
  projectName?: string
  sessionName: string
  currentPath?: string
  quote?: string
  onSelect: (relativePath: string) => Promise<void>
  onCancel: () => void
  onManageProjectFiles: () => void
  onRestoreFocus?: () => void
}

export function ProjectNoteTargetPicker({
  open,
  projectId,
  projectName,
  sessionName,
  currentPath,
  quote,
  onSelect,
  onCancel,
  onManageProjectFiles,
  onRestoreFocus,
}: ProjectNoteTargetPickerProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<ProjectFileSearchResult[]>([])
  const [searching, setSearching] = React.useState(false)
  const [searchError, setSearchError] = React.useState<string>()
  const [submittingPath, setSubmittingPath] = React.useState<string>()
  const searchGenerationRef = React.useRef(0)
  const isSubmitting = Boolean(submittingPath)
  const hasQuery = query.trim().length > 0
  const returnFocusRef = React.useRef<HTMLElement | null>(
    typeof document !== 'undefined'
      && document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      ? document.activeElement
      : null,
  )

  React.useEffect(() => {
    if (!open) {
      searchGenerationRef.current += 1
      return
    }
    setQuery('')
    setResults([])
    setSearching(false)
    setSearchError(undefined)
    setSubmittingPath(undefined)
  }, [open, projectId])

  React.useEffect(() => {
    if (!open) return

    const generation = ++searchGenerationRef.current
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      setResults([])
      setSearching(false)
      setSearchError(undefined)
      return
    }
    setResults([])
    setSearching(true)
    setSearchError(undefined)

    const timeout = window.setTimeout(() => {
      window.electronAPI.searchProjectFiles({
        projectId,
        query: trimmedQuery,
        extensions: MARKDOWN_EXTENSIONS,
      }).then(nextResults => {
        if (searchGenerationRef.current !== generation) return
        setResults(filterProjectNoteTargets(nextResults))
        setSearching(false)
      }).catch(() => {
        if (searchGenerationRef.current !== generation) return
        setResults([])
        setSearching(false)
        setSearchError(t('projectNoteTarget.searchError'))
      })
    }, 180)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [open, projectId, query, t])

  const handleSelect = React.useCallback(async (relativePath: string) => {
    if (submittingPath) return
    setSubmittingPath(relativePath)
    setSearchError(undefined)
    try {
      await onSelect(relativePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSearchError(
        message.replace(/^PROJECT_NOTE_[A-Z_]+:\s*/, '')
        || t('projectNoteTarget.setError'),
      )
      setSubmittingPath(undefined)
    }
  }, [onSelect, submittingPath, t])

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen && !isSubmitting) onCancel()
  }, [isSubmitting, onCancel])

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      onCloseAutoFocus={event => {
        event.preventDefault()
        if (returnFocusRef.current?.isConnected) {
          returnFocusRef.current.focus()
        } else {
          onRestoreFocus?.()
        }
      }}
      commandProps={{
        shouldFilter: false,
        label: t('projectNoteTarget.searchAria'),
        'aria-busy': searching || isSubmitting,
      }}
      footer={(
        <div className="flex items-center justify-between gap-3 border-t border-border/55 px-3 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isSubmitting}
            onClick={onManageProjectFiles}
            className="min-w-0 justify-start px-2 text-muted-foreground"
          >
            <FolderOpen />
            <span className="truncate">{t('projectNoteTarget.manageFiles')}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSubmitting}
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

      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t('projectNoteTarget.searchPlaceholder')}
        aria-label={t('projectNoteTarget.searchAria')}
        disabled={isSubmitting}
        autoFocus
      />

      <CommandList className="h-[320px] max-h-[40vh] py-1 [&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:min-h-full [&_[cmdk-list-sizer]]:flex-col">
        {currentPath && !hasQuery && (
          <CommandGroup heading={t('projectNoteTarget.current')}>
            <CommandItem
              value={currentPath}
              disabled={isSubmitting}
              onSelect={() => void handleSelect(currentPath)}
              className="py-2"
            >
              <FileText />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {currentPath}
              </span>
              {submittingPath === currentPath
                ? <Loader2 className="animate-spin" />
                : (
                    <>
                      <span className="sr-only">
                        {t('projectNoteTarget.currentFile')}
                      </span>
                      <Check />
                    </>
                  )}
            </CommandItem>
          </CommandGroup>
        )}

        {results.length > 0 && (
          <CommandGroup heading={t('projectNoteTarget.files')}>
            {results.map(result => (
              <CommandItem
                key={result.relativePath}
                value={result.relativePath}
                disabled={isSubmitting}
                onSelect={() => void handleSelect(result.relativePath)}
                className="py-2"
              >
                <FileText />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{result.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {result.relativePath}
                  </span>
                </span>
                {submittingPath === result.relativePath && (
                  <Loader2 className="animate-spin" />
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {searching && (
          <div
            className="flex flex-1 items-center justify-center gap-2 px-4 py-7 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('projectNoteTarget.searching')}
          </div>
        )}

        {!searching && searchError && (
          <div className="flex flex-1 items-center justify-center px-4 py-7 text-center text-xs text-destructive" role="alert">
            {searchError}
          </div>
        )}

        {!searching && !searchError && results.length === 0 && (
          <div
            className="flex flex-1 items-center justify-center px-4 py-7 text-center text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            {hasQuery
              ? t('projectNoteTarget.noMatches')
              : t('projectNoteTarget.searchHint')}
          </div>
        )}
      </CommandList>
    </CommandDialog>
  )
}
