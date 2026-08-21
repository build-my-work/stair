import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  File,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image,
  Loader2,
  PanelRightOpen,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import type {
  ProjectDirectoryEntry,
  ProjectFileSearchResult,
} from '@craft-agent/shared/project-files'
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

interface InlineCreateState {
  kind: 'file' | 'directory'
  parentRelativePath: string
  name: string
  submitting: boolean
  error?: string
}

function fileIcon(name: string) {
  const extension = name.split('.').at(-1)?.toLowerCase()
  const className = 'h-3.5 w-3.5 shrink-0 text-muted-foreground/75'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(extension ?? '')) {
    return <Image className={className} />
  }
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
  selectedDirectoryPath,
  inlineCreate,
  onToggleDirectory,
  onSelectDirectory,
  onOpenFile,
  onOpenFileInPanel,
}: {
  entry: ProjectDirectoryEntry
  depth: number
  directoryStates: Map<string, DirectoryState>
  expandedPaths: Set<string>
  openFilePaths: ReadonlySet<string>
  selectedDirectoryPath: string
  inlineCreate: InlineCreateState | null
  onToggleDirectory: (relativePath: string) => void
  onSelectDirectory: (relativePath: string) => void
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
        isDirectory && selectedDirectoryPath === entry.relativePath && 'bg-foreground/[0.055]',
        !isDirectory && openFilePaths.has(entry.relativePath) && 'bg-foreground/[0.055]',
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => {
        if (isDirectory) {
          onSelectDirectory(entry.relativePath)
          onToggleDirectory(entry.relativePath)
        } else {
          onOpenFile(entry.relativePath)
        }
      }}
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
          {inlineCreate?.parentRelativePath === entry.relativePath && (
            <InlineCreateEntry state={inlineCreate} depth={depth + 1} />
          )}
          {state?.entries.map(child => (
            <TreeEntry
              key={child.relativePath}
              entry={child}
              depth={depth + 1}
              directoryStates={directoryStates}
              expandedPaths={expandedPaths}
              openFilePaths={openFilePaths}
              selectedDirectoryPath={selectedDirectoryPath}
              inlineCreate={inlineCreate}
              onToggleDirectory={onToggleDirectory}
              onSelectDirectory={onSelectDirectory}
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

function InlineCreateEntry({
  state,
  depth,
}: {
  state: InlineCreateState
  depth: number
}) {
  const { t } = useTranslation()
  return (
    <div className="py-0.5 pr-2" style={{ paddingLeft: 8 + depth * 14 }}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="w-3.5 shrink-0" />
        {state.kind === 'directory'
          ? <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          : <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <input
          autoFocus
          value={state.name}
          disabled={state.submitting}
          aria-label={t(state.kind === 'directory'
            ? 'filesSidebar.newFolderName'
            : 'filesSidebar.newFileName')}
          aria-invalid={Boolean(state.error)}
          data-project-file-create-input
          className={cn(
            'h-6 min-w-0 flex-1 rounded border bg-background px-1.5 text-xs outline-none',
            state.error ? 'border-destructive' : 'border-foreground/25',
          )}
        />
        {state.submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>
      {state.error && <p className="pl-5 text-[10px] text-destructive">{state.error}</p>}
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
  const [selectedDirectoryPath, setSelectedDirectoryPath] = useState('')
  const [inlineCreate, setInlineCreate] = useState<InlineCreateState | null>(null)
  const [filter, setFilter] = useState('')
  const [searchResults, setSearchResults] = useState<ProjectFileSearchResult[] | null>([])
  const [searchFailed, setSearchFailed] = useState(false)
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
    setSelectedDirectoryPath('')
    setInlineCreate(null)
    if (projectId && workingDirectory) void loadDirectory('')
  }, [loadDirectory, projectId, revision, workingDirectory])

  useEffect(() => () => {
    requestGenerationRef.current += 1
  }, [])

  useEffect(() => {
    const query = filter.trim()
    if (!projectId || !workingDirectory || !query) {
      setSearchResults([])
      setSearchFailed(false)
      return
    }
    setSearchResults(null)
    setSearchFailed(false)
    let cancelled = false
    const timeout = window.setTimeout(() => {
      window.electronAPI.searchProjectFiles({ projectId, query })
        .then(results => {
          if (!cancelled) setSearchResults(results)
        })
        .catch(() => {
          if (!cancelled) {
            setSearchResults([])
            setSearchFailed(true)
          }
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [filter, projectId, revision, workingDirectory])

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

  const beginCreate = useCallback((kind: InlineCreateState['kind']) => {
    if (!projectId || inlineCreate?.submitting) return
    setFilter('')
    setInlineCreate({
      kind,
      parentRelativePath: selectedDirectoryPath,
      name: '',
      submitting: false,
    })
    if (selectedDirectoryPath) {
      setExpandedPaths(previous => new Set(previous).add(selectedDirectoryPath))
      if (!statesRef.current.has(selectedDirectoryPath)) {
        void loadDirectory(selectedDirectoryPath)
      }
    }
  }, [inlineCreate?.submitting, loadDirectory, projectId, selectedDirectoryPath])

  const submitCreate = useCallback(async () => {
    if (!inlineCreate || inlineCreate.submitting || !projectId) return
    const name = inlineCreate.name
    if (!name.trim()) {
      setInlineCreate(current => current ? {
        ...current,
        error: t('filesSidebar.createEnterName'),
      } : null)
      return
    }
    if (name !== name.trim()) {
      setInlineCreate(current => current ? {
        ...current,
        error: t('filesSidebar.createTrimName'),
      } : null)
      return
    }
    const pending = inlineCreate
    setInlineCreate({ ...pending, submitting: true, error: undefined })
    try {
      const request = {
        projectId,
        ...(pending.parentRelativePath
          ? { parentRelativePath: pending.parentRelativePath }
          : {}),
        name,
      }
      const created = pending.kind === 'directory'
        ? await window.electronAPI.createProjectDirectory(request)
        : await window.electronAPI.createProjectFile(request)
      setInlineCreate(null)
      await loadDirectory(pending.parentRelativePath)
      if (created.type === 'file') onOpenFile(created.relativePath)
    } catch (createError) {
      setInlineCreate(current => current ? {
        ...current,
        submitting: false,
        error: (createError instanceof Error ? createError.message : String(createError))
          .replace(/^PROJECT_FILE_[A-Z_]+:\s*/u, ''),
      } : null)
    }
  }, [inlineCreate, loadDirectory, onOpenFile, projectId, t])

  const handleCreateKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!inlineCreate || !(event.target instanceof HTMLInputElement)) return
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submitCreate()
    } else if (event.key === 'Escape' && !inlineCreate.submitting) {
      event.preventDefault()
      setInlineCreate(null)
    }
  }, [inlineCreate, submitCreate])

  const handleCreateChange = useCallback((event: FormEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.hasAttribute('data-project-file-create-input')) return
    const name = event.target.value
    setInlineCreate(current => current ? {
      ...current,
      name,
      error: undefined,
    } : null)
  }, [])

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
      <div className="shrink-0 border-b border-border/45 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedDirectoryPath('')}>
            <div className="truncate text-xs font-medium">{project.config.name}</div>
            <div className="truncate font-mono text-[10px] text-muted-foreground/60" title={workingDirectory}>
              {workingDirectory}
            </div>
          </button>
          <PanelHeaderCenterButton
            icon={<FilePlus2 className="h-3.5 w-3.5" />}
            tooltip={t('filesSidebar.newFile')}
            disabled={Boolean(inlineCreate?.submitting)}
            onClick={() => beginCreate('file')}
          />
          <PanelHeaderCenterButton
            icon={<FolderPlus className="h-3.5 w-3.5" />}
            tooltip={t('filesSidebar.newFolder')}
            disabled={Boolean(inlineCreate?.submitting)}
            onClick={() => beginCreate('directory')}
          />
          <PanelHeaderCenterButton
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            tooltip={t('common.refresh')}
            onClick={() => setRevision(value => value + 1)}
          />
        </div>
        <label className="relative mt-2 block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <input
            value={filter}
            onChange={event => setFilter(event.target.value)}
            placeholder={t('filesSidebar.filterPlaceholder')}
            aria-label={t('filesSidebar.filterPlaceholder')}
            className="h-8 w-full rounded border border-border/55 bg-background pl-8 pr-8 text-xs outline-none"
          />
          {filter && (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground"
              aria-label={t('common.close')}
              onClick={() => setFilter('')}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </label>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
        onKeyDown={handleCreateKeyDown}
        onChange={handleCreateChange}
      >
        {filter.trim() ? (
          searchResults === null ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">{t('common.loading')}</div>
          ) : searchFailed ? (
            <div className="px-2 py-3 text-xs text-destructive">{t('filesSidebar.loadError')}</div>
          ) : searchResults.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">{t('filesSidebar.noMatches')}</div>
          ) : searchResults.map(result => (
            <button
              key={result.relativePath}
              type="button"
              className="flex w-full min-w-0 items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-foreground/[0.04]"
              onClick={() => onOpenFile(result.relativePath)}
            >
              {fileIcon(result.name)}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{result.name}</span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">{result.relativePath}</span>
              </span>
            </button>
          ))
        ) : root?.loading && root.entries.length === 0 ? (
          <div className="flex items-center px-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            {t('common.loading')}
          </div>
        ) : root?.error ? (
          <div className="px-2 py-3 text-xs text-destructive">{root.error}</div>
        ) : root?.entries.length === 0 && !inlineCreate ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">{t('filesSidebar.empty')}</div>
        ) : (
          <>
            {inlineCreate?.parentRelativePath === '' && (
              <InlineCreateEntry state={inlineCreate} depth={0} />
            )}
            {root?.entries.map(entry => (
              <TreeEntry
                key={entry.relativePath}
                entry={entry}
                depth={0}
                directoryStates={directoryStates}
                expandedPaths={expandedPaths}
                openFilePaths={openFilePaths}
                selectedDirectoryPath={selectedDirectoryPath}
                inlineCreate={inlineCreate}
                onToggleDirectory={handleToggleDirectory}
                onSelectDirectory={setSelectedDirectoryPath}
                onOpenFile={onOpenFile}
                onOpenFileInPanel={onOpenFileInPanel}
              />
            ))}
          </>
        )}
        {root?.truncated && (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            {t('filesSidebar.truncated', { count: root.entries.length })}
          </p>
        )}
      </div>
    </div>
  )
}
