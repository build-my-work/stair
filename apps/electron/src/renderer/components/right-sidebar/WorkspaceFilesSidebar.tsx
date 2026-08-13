import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LoadedProject } from '@craft-agent/shared/projects/types'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { ProjectFilesTree } from '@/components/project-files/ProjectFilesTree'

interface WorkspaceFilesSidebarProps {
  project?: LoadedProject
  openFilePaths: ReadonlySet<string>
  onClose: () => void
  onOpenFile: (relativePath: string) => void
  onOpenFileInPanel: (relativePath: string) => void
}

export function WorkspaceFilesSidebar({
  project,
  openFilePaths,
  onClose,
  onOpenFile,
  onOpenFileInPanel,
}: WorkspaceFilesSidebarProps) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-col bg-foreground-2">
      <PanelHeader
        title={t('filesSidebar.title')}
        actions={(
          <PanelHeaderCenterButton
            icon={<X className="h-3.5 w-3.5" />}
            tooltip={t('common.close')}
            onClick={onClose}
          />
        )}
      />
      <ProjectFilesTree
        project={project}
        openFilePaths={openFilePaths}
        onOpenFile={onOpenFile}
        onOpenFileInPanel={onOpenFileInPanel}
      />
    </div>
  )
}
