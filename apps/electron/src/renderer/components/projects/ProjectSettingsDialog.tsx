import * as React from 'react'
import { FolderOpen, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import type { LoadedProject } from '@craft-agent/shared/projects/types'
import { PROJECT_COLOR_PALETTE } from '@/utils/project-colors'
import { useRegisterModal } from '@/context/ModalContext'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { InlineColorPickerRow } from '@/components/ui/inline-color-picker-row'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

interface ProjectSettingsDialogProps {
  open: boolean
  workspaceId: string | null
  project: LoadedProject | null
  onOpenChange: (open: boolean) => void
  onDeleted?: (projectSlug: string) => void
}

export function ProjectSettingsDialog({
  open,
  workspaceId,
  project,
  onOpenChange,
  onDeleted,
}: ProjectSettingsDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [workingDirectory, setWorkingDirectory] = React.useState('')
  const [details, setDetails] = React.useState('')
  const [color, setColor] = React.useState('')
  const [pendingAction, setPendingAction] = React.useState<'save' | 'delete' | null>(null)
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange])
  useRegisterModal(open, close)

  React.useEffect(() => {
    if (!open || !project) return
    setName(project.config.name)
    setDescription(project.config.description ?? '')
    setWorkingDirectory(project.config.workingDirectory ?? '')
    setDetails(project.config.details ?? '')
    setColor(project.config.color ?? '')
    setPendingAction(null)
    setConfirmingDelete(false)
  }, [open, project])

  const trimmedName = name.trim()
  const saving = pendingAction === 'save'
  const deleting = pendingAction === 'delete'
  const canSave = !!workspaceId && !!project && trimmedName.length > 0 && pendingAction === null

  const handlePickWorkingDirectory = React.useCallback(async () => {
    try {
      const picked = await window.electronAPI.openFolderDialog?.()
      if (typeof picked === 'string' && picked.trim()) {
        setWorkingDirectory(picked)
      }
    } catch (error) {
      console.error('[ProjectSettingsDialog] Folder picker failed:', error)
    }
  }, [])

  const handleSave = React.useCallback(async () => {
    if (!workspaceId || !project || !canSave) return
    setPendingAction('save')
    try {
      await window.electronAPI.updateProject(workspaceId, project.config.slug, {
        name: trimmedName,
        description: description.trim() || undefined,
        workingDirectory: workingDirectory.trim() || undefined,
        details: details.trim() || undefined,
        color: color.trim() || undefined,
      })
      toast.success(t('projectInfo.saved'))
      onOpenChange(false)
    } catch (error) {
      console.error('[ProjectSettingsDialog] Save failed:', error)
      toast.error(t('projectInfo.saveFailed'))
    } finally {
      setPendingAction(null)
    }
  }, [
    canSave,
    color,
    description,
    details,
    onOpenChange,
    project,
    t,
    trimmedName,
    workingDirectory,
    workspaceId,
  ])

  const handleDelete = React.useCallback(async () => {
    if (!workspaceId || !project || pendingAction !== null) return
    setPendingAction('delete')
    try {
      await window.electronAPI.deleteProject(workspaceId, project.config.slug)
      onDeleted?.(project.config.slug)
      onOpenChange(false)
    } catch (error) {
      console.error('[ProjectSettingsDialog] Delete failed:', error)
      toast.error(t('projectInfo.deleteFailed'))
    } finally {
      setPendingAction(null)
    }
  }, [onDeleted, onOpenChange, pendingAction, project, t, workspaceId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(86vh,760px)] overflow-y-auto sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>
            {t('projectSettings.title', { defaultValue: 'Edit project' })}
          </DialogTitle>
          <DialogDescription>
            {t('projectSettings.description', {
              defaultValue: 'Configure how this project and its sessions use the working directory.',
            })}
          </DialogDescription>
        </DialogHeader>

        {project && (
          <div className="space-y-5 py-1">
            <Field label={t('projectInfo.title')}>
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canSave) {
                    event.preventDefault()
                    void handleSave()
                  }
                }}
              />
            </Field>

            <Field label={t('projectInfo.description')}>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('projectInfo.descriptionPlaceholder')}
              />
            </Field>

            <Field
              label={t('projectInfo.workingDirectory')}
              hint={t('projectSettings.workingDirectoryHint', {
                defaultValue: 'Files and new sessions in this project use this directory.',
              })}
            >
              <div className="flex gap-2">
                <Input
                  value={workingDirectory}
                  onChange={(event) => setWorkingDirectory(event.target.value)}
                  placeholder={t('projectInfo.workingDirectoryPlaceholder')}
                  className="min-w-0 flex-1 font-mono text-xs"
                />
                <Button type="button" variant="outline" onClick={handlePickWorkingDirectory}>
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('projectInfo.workingDirectoryPicker')}
                </Button>
              </div>
            </Field>

            <Field
              label={t('projectInfo.color')}
              hint={t('projectInfo.colorHint')}
            >
              <InlineColorPickerRow
                value={color}
                onChange={setColor}
                presets={PROJECT_COLOR_PALETTE}
                onClear={() => setColor('')}
                clearLabel={t('projectInfo.colorClear')}
                customAriaLabel={t('projectInfo.colorCustom')}
              />
            </Field>

            <Field
              label={t('projectInfo.details')}
              hint={t('projectInfo.detailsHelpText')}
            >
              <Textarea
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                rows={5}
                placeholder={t('projectInfo.detailsPlaceholder')}
              />
            </Field>

            <div className="border-t border-border/60 pt-4">
              {!confirmingDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={saving || deleting}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('projectInfo.deleteProject')}
                </Button>
              ) : (
                <div
                  role="alert"
                  className="flex flex-col gap-3 rounded-[8px] border border-destructive/20 bg-destructive/[0.04] p-3 sm:flex-row sm:items-center"
                >
                  <p className="flex-1 text-sm text-foreground/75">
                    {t('projectInfo.deleteConfirm', { name: project.config.name })}
                  </p>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmingDelete(false)}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={deleting}
                      onClick={() => { void handleDelete() }}
                    >
                      {deleting ? t('common.deleting', { defaultValue: 'Deleting…' }) : t('common.delete')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={saving || deleting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => { void handleSave() }} disabled={!canSave}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-foreground/70">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-foreground/50">{hint}</span>}
    </label>
  )
}
