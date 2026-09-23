import * as React from 'react'
import { useTranslation } from 'react-i18next'

import type { LoadedProject } from '@craft-agent/shared/projects/types'
import { isProjectNoteTargetPath } from '@craft-agent/shared/protocol'

import { ProjectFilesTree } from '@/components/project-files/ProjectFilesTree'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useRegisterModal } from '@/context/ModalContext'

const PROJECT_NOTE_SEARCH_EXTENSIONS = ['md', 'markdown', 'txt'] as const

export function ProjectNoteTargetDialog({
  open,
  project,
  initialPath,
  recentPaths,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean
  project?: LoadedProject
  initialPath?: string
  recentPaths: string[]
  busy: boolean
  error?: string
  onCancel: () => void
  onConfirm: (relativePath: string) => void
}) {
  const { t } = useTranslation()
  const [selectedPath, setSelectedPath] = React.useState('')
  const [selectionError, setSelectionError] = React.useState('')
  const wasOpenRef = React.useRef(false)
  const handleCancel = React.useCallback(() => {
    if (!busy) onCancel()
  }, [busy, onCancel])

  useRegisterModal(open, handleCancel)

  React.useEffect(() => {
    if (open && !wasOpenRef.current) {
      setSelectedPath(initialPath && isProjectNoteTargetPath(initialPath) ? initialPath : '')
      setSelectionError('')
    }
    wasOpenRef.current = open
  }, [initialPath, open])

  const selectPath = React.useCallback((relativePath: string) => {
    if (!isProjectNoteTargetPath(relativePath)) {
      setSelectionError(t('projectNoteTarget.unsupportedFile'))
      return
    }
    setSelectionError('')
    setSelectedPath(relativePath)
  }, [t])

  return (
    <Dialog open={open} onOpenChange={next => !next && handleCancel()}>
      <DialogContent
        data-ca-island-blocker="true"
        data-ca-user-reference-menu="true"
        className="flex h-[min(720px,82vh)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 border-b border-border/45 px-5 py-4">
          <DialogTitle>{t('projectNoteTarget.title')}</DialogTitle>
        </DialogHeader>

        {recentPaths.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/45 px-4 py-2">
            <span className="mr-1 text-[11px] text-muted-foreground">
              {t('projectNoteTarget.recent')}
            </span>
            {recentPaths.filter(isProjectNoteTargetPath).map(path => (
              <button
                key={path}
                type="button"
                className="max-w-56 truncate rounded bg-foreground/[0.045] px-2 py-1 font-mono text-[10px] hover:bg-foreground/[0.08]"
                title={path}
                onClick={() => selectPath(path)}
              >
                {path}
              </button>
            ))}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <ProjectFilesTree
            project={project}
            openFilePaths={new Set(selectedPath ? [selectedPath] : [])}
            onOpenFile={selectPath}
            fileFilter={isProjectNoteTargetPath}
            fileFilterError={t('projectNoteTarget.unsupportedFile')}
            searchExtensions={PROJECT_NOTE_SEARCH_EXTENSIONS}
          />
        </div>

        <div className="shrink-0 border-t border-border/45 px-5 py-3">
          <div className="mb-3 min-h-8 rounded bg-foreground/[0.03] px-3 py-2 font-mono text-[11px]">
            {selectedPath || t('projectNoteTarget.chooseFile')}
          </div>
          {(selectionError || error) && (
            <p className="mb-3 text-xs text-destructive">{selectionError || error}</p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={handleCancel}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={busy || !selectedPath}
              onClick={() => onConfirm(selectedPath)}
            >
              {busy ? t('common.saving') : t('projectNoteTarget.useFile')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
