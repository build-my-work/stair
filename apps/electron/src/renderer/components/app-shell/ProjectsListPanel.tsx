/**
 * ProjectsListPanel
 *
 * Workspace-scoped project list shown in the navigator slot when the Projects
 * sidebar item is active. Mirrors the lightweight skeleton of
 * SkillsListPanel / AutomationsListPanel — no multi-select / drag-drop in v1.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FolderKanban, Plus, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { useMenuComponents } from '@/components/ui/menu-context'
import type { LoadedProject } from '@craft-agent/shared/projects/types'

export interface ProjectsListPanelProps {
  projects: LoadedProject[]
  onProjectClick: (slug: string) => void
  onAddProject?: () => void
  /** Open the shared Project Settings dialog for this project. */
  onProjectSettings?: (project: LoadedProject) => void
  selectedProjectSlug?: string | null
  className?: string
}

export function ProjectsListPanel({
  projects,
  onProjectClick,
  onAddProject,
  onProjectSettings,
  selectedProjectSlug,
  className,
}: ProjectsListPanelProps) {
  const { t } = useTranslation()

  if (projects.length === 0) {
    return (
      <div className={cn('flex flex-col flex-1 min-h-0', className)}>
        <EntityListEmptyScreen
          icon={<FolderKanban />}
          title={t('projectsList.empty')}
          description={t('projectsList.emptyDescription')}
        >
          {onAddProject && (
            <button
              type="button"
              onClick={onAddProject}
              className="inline-flex items-center gap-1 h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('projectsList.addProject')}
            </button>
          )}
        </EntityListEmptyScreen>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      <ScrollArea className="flex-1">
        <div className="pb-2" data-list-role="projects">
          <div className="pt-1">
            {projects.map((project, index) => (
              <ProjectRow
                key={project.config.slug}
                project={project}
                isSelected={selectedProjectSlug === project.config.slug}
                isFirst={index === 0}
                onClick={() => onProjectClick(project.config.slug)}
                onOpenSettings={onProjectSettings
                  ? () => onProjectSettings(project)
                  : undefined}
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

interface ProjectRowProps {
  project: LoadedProject
  isSelected: boolean
  isFirst: boolean
  onClick: () => void
  onOpenSettings?: () => void
}

function ProjectRow({ project, isSelected, isFirst, onClick, onOpenSettings }: ProjectRowProps) {
  const config = project.config
  const subtitle = config.description?.trim() || config.workingDirectory || ''

  return (
    <EntityRow
      showSeparator={!isFirst}
      separatorClassName="pl-10 pr-4"
      isSelected={isSelected}
      onMouseDown={(e: React.MouseEvent) => {
        if (e.button === 0) onClick()
      }}
      icon={<FolderKanban className="h-3.5 w-3.5 text-foreground/60" />}
      title={config.name}
      subtitle={subtitle}
      menuContent={onOpenSettings
        ? <ProjectRowMenu onOpenSettings={onOpenSettings} />
        : undefined}
    />
  )
}

function ProjectRowMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation()
  const { MenuItem } = useMenuComponents()
  return (
    <MenuItem onClick={() => {
      window.setTimeout(onOpenSettings, 0)
    }}>
      <Settings className="h-3.5 w-3.5" />
      <span className="flex-1">
        {t('projectSettings.menuItem', { defaultValue: 'Project settings…' })}
      </span>
    </MenuItem>
  )
}
