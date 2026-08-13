import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  PanelRightOpen,
  RefreshCw,
} from 'lucide-react'
import type { ProjectDirectoryEntry } from '@craft-agent/shared/project-files'
import type { LoadedProject } from '@craft-agent/shared/projects/types'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'

interface DirectoryState {
  entries: ProjectDirectoryEntry[]
  loading: boolean
  error?: string
  truncated?: boolean
}

interface ProjectFilesTreeProps {
  project?: LoadedProject
  openFilePaths: ReadonlySet<string>
  onOpenFile: (relativePath: string) => void
  onOpenFileInPanel: (relativePath: string) => void
}

function fileIcon(name: string) {
  const extension = name.split('.').at(-1)?.toLowerCase()
  const className = 'h-3.5 w-3.5 shrink-0 text-muted-foreground/75'
  if (['md', 'mdx', 'txt', 'log', 'csv'].includes(extension ?? '')) {
    return <FileText className={className} />
  }
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'json', 'yaml', 'yml'].includes(extension ?? '')) {
    return <FileCode2 className={className} />
  }
  return <File className={className} />
}

function TreeEntry({
  entry,
  depth,
  directoryStates,
  expandedPaths,
  openFilePaths,
  onToggleDirectory,
  onOpenFile,
  onOpenFileInPanel,
}: {
  entry: ProjectDirectoryEntry
  depth: number
  directoryStates: Map<string, DirectoryState>
  expandedPaths: Set<string>
  openFilePaths: ReadonlySet<string>
  onToggleDirectory: (relativePath: string) => void
  onOpenFile: (relativePath: string) => void
  onOpenFileInPanel: (relativePath: string) => void
}) {
  const { t } = useTranslation()
  const isDirectory = entry.type === 'directory'
  const expanded = isDirectory && expandedPaths.has(entry.relativePath)
  const state = isDirectory ? directoryStates.get(entry.relativePath) : undefined
  const button = (
    <button
      type="button"
      className={cn(
        'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[6px] pr-2 text-left text-[13px]',
        'text-foreground/85 outline-none transition-colors hover:bg-foreground/[0.045] focus-visible:ring-1 focus-visible:ring-ring',
        !isDirectory && openFilePaths.has(entry.relativePath) && 'bg-foreground/[0.055]',
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => isDirectory
        ? onToggleDirectory(entry.relativePath)
        : onOpenFile(entry.relativePath)}
    >
      {isDirectory ? (
        <>
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-90')} />
          {expanded
            ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            : <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        </>
      ) : (
        <>
          <span className="w-3.5 shrink-0" />
          {fileIcon(entry.name)}
        </>
      )}
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
    </button>
  )

  return (
    <div>
      {isDirectory ? button : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
          <StyledContextMenuContent>
            <StyledContextMenuItem onSelect={() => onOpenFileInPanel(entry.relativePath)}>
              <PanelRightOpen />
              {t('filesSidebar.openInNewPanel')}
            </StyledContextMenuItem>
          </StyledContextMenuContent>
        </ContextMenu>
      )}
      {expanded && (
        <div>
          {state?.loading && (
            <div className="flex h-7 items-center text-xs text-muted-foreground" style={{ paddingLeft: 36 + depth * 14 }}>
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              {t('common.loading')}
            </div>
          )}
          {state?.error && (
            <div className="py-1 pr-2 text-xs text-destructive" style={{ paddingLeft: 36 + depth * 14 }}>
              {state.error}
            </div>
          )}
          {state?.entries.map(child => (
            <TreeEntry
              key={child.relativePath}
              entry={child}
              depth={depth + 1}
              directoryStates={directoryStates}
              expandedPaths={expandedPaths}
              openFilePaths={openFilePaths}
              onToggleDirectory={onToggleDirectory}
              onOpenFile={onOpenFile}
              onOpenFileInPanel={onOpenFileInPanel}
            />
          ))}
          {state?.truncated && (
            <p className="py-1 text-[11px] text-muted-foreground" style={{ paddingLeft: 36 + depth * 14 }}>
              {t('filesSidebar.truncated', { count: state.entries.length })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function ProjectFilesTree({
  project,
  openFilePaths,
  onOpenFile,
  onOpenFileInPanel,
}: ProjectFilesTreeProps) {
  const { t } = useTranslation()
  const [directoryStates, setDirectoryStates] = useState<Map<string, DirectoryState>>(new Map())
  const statesRef = useRef(directoryStates)
  const requestGenerationRef = useRef(0)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [revision, setRevision] = useState(0)
  const projectId = project?.config.id
  const workingDirectory = project?.config.workingDirectory

  useEffect(() => { statesRef.current = directoryStates }, [directoryStates])

  const loadDirectory = useCallback(async (relativePath: string) => {
    if (!projectId || !workingDirectory) return
    const generation = requestGenerationRef.current
    const current = statesRef.current.get(relativePath)
    setDirectoryStates(previous => new Map(previous).set(relativePath, {
      entries: current?.entries ?? [],
      loading: true,
    }))
    try {
      const result = await window.electronAPI.listProjectDirectoryEntries({
        projectId,
        relativePath: relativePath || undefined,
      })
      if (generation !== requestGenerationRef.current) return
      setDirectoryStates(previous => new Map(previous).set(relativePath, {
        entries: result.entries,
        loading: false,
        truncated: result.truncated,
      }))
    } catch (loadError) {
      if (generation !== requestGenerationRef.current) return
      setDirectoryStates(previous => new Map(previous).set(relativePath, {
        entries: [],
        loading: false,
        error: loadError instanceof Error ? loadError.message : String(loadError),
      }))
    }
  }, [projectId, workingDirectory])

  useEffect(() => {
    requestGenerationRef.current += 1
    setDirectoryStates(new Map())
    setExpandedPaths(new Set())
    if (projectId && workingDirectory) void loadDirectory('')
  }, [loadDirectory, projectId, revision, workingDirectory])

  useEffect(() => () => {
    requestGenerationRef.current += 1
  }, [])

  const handleToggleDirectory = useCallback((relativePath: string) => {
    setExpandedPaths(previous => {
      const next = new Set(previous)
      if (next.has(relativePath)) next.delete(relativePath)
      else {
        next.add(relativePath)
        if (!statesRef.current.has(relativePath)) void loadDirectory(relativePath)
      }
      return next
    })
  }, [loadDirectory])

  if (!projectId || !workingDirectory) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Folder className="h-7 w-7 text-muted-foreground/45" />
        <p className="text-sm font-medium">{t('filesSidebar.noProjectTitle')}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('filesSidebar.noProjectDescription')}
        </p>
      </div>
    )
  }

  const root = directoryStates.get('')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/45 px-3 py-2.5">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{project.config.name}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground/60" title={workingDirectory}>
            {workingDirectory}
          </div>
        </div>
        <PanelHeaderCenterButton
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          tooltip={t('common.refresh')}
          onClick={() => setRevision(value => value + 1)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {root?.loading && root.entries.length === 0 ? (
          <div className="flex items-center px-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            {t('common.loading')}
          </div>
        ) : root?.error ? (
          <div className="px-2 py-3 text-xs text-destructive">{root.error}</div>
        ) : root?.entries.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">{t('filesSidebar.empty')}</div>
        ) : root?.entries.map(entry => (
          <TreeEntry
            key={entry.relativePath}
            entry={entry}
            depth={0}
            directoryStates={directoryStates}
            expandedPaths={expandedPaths}
            openFilePaths={openFilePaths}
            onToggleDirectory={handleToggleDirectory}
            onOpenFile={onOpenFile}
            onOpenFileInPanel={onOpenFileInPanel}
          />
        ))}
        {root?.truncated && (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            {t('filesSidebar.truncated', { count: root.entries.length })}
          </p>
        )}
      </div>
    </div>
  )
}
