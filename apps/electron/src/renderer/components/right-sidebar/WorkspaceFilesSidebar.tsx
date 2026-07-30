import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ProjectFilesBrowser } from '@/components/project-files/ProjectFilesBrowser'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'

interface WorkspaceFilesSidebarProps {
  projectId?: string
  projectName?: string
  rootPath?: string
  onClose: () => void
  onOpenFile: (relativePath: string) => void
}

export function WorkspaceFilesSidebar({
  projectId,
  projectName,
  rootPath,
  onClose,
  onOpenFile,
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
      <ProjectFilesBrowser
        mode="manage"
        projectId={projectId}
        projectName={projectName}
        rootPath={rootPath}
        onOpenFile={onOpenFile}
      />
    </div>
  )
}
