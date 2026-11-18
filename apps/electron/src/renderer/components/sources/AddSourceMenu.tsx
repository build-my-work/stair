import * as React from 'react'
import { BookOpen, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EditPopover, getEditConfig, type EditContextKey } from '@/components/ui/EditPopover'
import {
  DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent,
  StyledDropdownMenuItem, StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { navigate, routes } from '@/lib/navigate'
import { NotionSourceDialog } from './NotionSourceDialog'

interface AddSourceMenuProps {
  workspaceId: string
  workspaceRootPath: string
  sourceType?: 'api' | 'mcp' | 'local'
  trigger: React.ReactNode
}

export function AddSourceMenu({ workspaceId, workspaceRootPath, sourceType, trigger }: AddSourceMenuProps) {
  const { t } = useTranslation()
  const [notionOpen, setNotionOpen] = React.useState(false)
  const [customOpen, setCustomOpen] = React.useState(false)
  const config = getEditConfig(sourceType ? `add-source-${sourceType}` as EditContextKey : 'add-source', workspaceRootPath)

  if (sourceType === 'mcp' || sourceType === 'local') {
    return <EditPopover trigger={trigger} {...config} />
  }

  return (
    <div className="relative inline-flex">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <StyledDropdownMenuContent
          align="end"
          onCloseAutoFocus={event => { if (notionOpen || customOpen) event.preventDefault() }}
        >
          <StyledDropdownMenuItem onSelect={() => setNotionOpen(true)}>
            <BookOpen className="h-4 w-4" />
            <span>Notion</span>
          </StyledDropdownMenuItem>
          <StyledDropdownMenuSeparator />
          <StyledDropdownMenuItem onSelect={() => setCustomOpen(true)}>
            <Plus className="h-4 w-4" />
            <span>{t('sourcesList.customSource')}</span>
          </StyledDropdownMenuItem>
        </StyledDropdownMenuContent>
      </DropdownMenu>
      <EditPopover
        open={customOpen}
        onOpenChange={setCustomOpen}
        modal
        trigger={<span className="pointer-events-none absolute inset-0" aria-hidden="true" />}
        {...config}
      />
      {notionOpen && <NotionSourceDialog
        key={workspaceId}
        workspaceId={workspaceId}
        onClose={() => setNotionOpen(false)}
        onConnected={source => {
          setNotionOpen(false)
          void navigate(routes.view.sourcesApi(source.slug))
        }}
      />}
    </div>
  )
}
