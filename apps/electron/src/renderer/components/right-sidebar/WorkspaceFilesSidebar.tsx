import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Braces,
  ChevronRight,
  File,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import {
  type ProjectDirectoryEntry,
  type ProjectFileSearchResult,
} from '@craft-agent/shared/protocol'
import { cn } from '@/lib/utils'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'

interface DirectoryState {
  entries: ProjectDirectoryEntry[]
  loading: boolean
  error?: string
  truncated?: boolean
}

type CreateEntryKind = 'file' | 'directory'

interface InlineCreateState {
  id: number
  kind: CreateEntryKind
  parentRelativePath: string
  name: string
  submitting: boolean
  error?: string
}

interface InlineCreateActions {
  begin: (kind: CreateEntryKind, parentRelativePath: string) => void
  changeName: (name: string) => void
  submit: () => void
  cancel: () => void
}

interface WorkspaceFilesSidebarProps {
  projectId?: string
  projectName?: string
  rootPath?: string
  onClose: () => void
  onOpenFile: (relativePath: string) => void
}

function fileIcon(name: string) {
  const extension = name.split('.').pop()?.toLowerCase()
  const className = 'h-3.5 w-3.5 shrink-0 text-muted-foreground/75'

  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'rb', 'sh'].includes(extension ?? '')) {
    return <FileCode2 className={className} />
  }
  if (['json', 'jsonl', 'yaml', 'yml', 'toml'].includes(extension ?? '')) {
    return <Braces className={className} />
  }
  if (['md', 'mdx', 'txt', 'csv'].includes(extension ?? '')) {
    return <FileText className={className} />
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(extension ?? '')) {
    return <Image className={className} />
  }
  return <File className={className} />
}

interface TreeEntryProps {
  entry: ProjectDirectoryEntry
  depth: number
  directoryStates: Map<string, DirectoryState>
  expandedPaths: Set<string>
  selectedDirectoryPath: string
  inlineCreate: InlineCreateState | null
  onToggleDirectory: (path: string) => void
  onSelectDirectory: (path: string) => void
  onOpenFile: (relativePath: string) => void
  createActions: InlineCreateActions
}

function TreeEntry({
  entry,
  depth,
  directoryStates,
  expandedPaths,
  selectedDirectoryPath,
  inlineCreate,
  onToggleDirectory,
  onSelectDirectory,
  onOpenFile,
  createActions,
}: TreeEntryProps) {
  const { t } = useTranslation()
  const isDirectory = entry.type === 'directory'
  const canCreateWithinDirectory = isDirectory && !entry.isSymlink
  const expanded = isDirectory && expandedPaths.has(entry.relativePath)
  const directoryState = isDirectory ? directoryStates.get(entry.relativePath) : undefined
  const selected = canCreateWithinDirectory
    && selectedDirectoryPath === entry.relativePath

  const entryButton = (
    <button
      type="button"
      onClick={() => {
        if (isDirectory) {
          if (canCreateWithinDirectory) {
            onSelectDirectory(entry.relativePath)
          }
          onToggleDirectory(entry.relativePath)
        } else {
          onOpenFile(entry.relativePath)
        }
      }}
      className={cn(
        'group flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[6px] pr-2 text-left text-[13px]',
        'outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring',
        selected
          ? 'bg-foreground/[0.065] text-foreground'
          : 'text-foreground/85 hover:bg-foreground/[0.045]',
      )}
      aria-pressed={canCreateWithinDirectory ? selected : undefined}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {isDirectory ? (
        <>
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          {expanded
            ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
            : <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />}
        </>
      ) : (
        <>
          <span className="w-3.5 shrink-0" />
          {fileIcon(entry.name)}
        </>
      )}
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.isSymlink && <Link2 className="h-3 w-3 shrink-0 text-muted-foreground/45" />}
    </button>
  )

  return (
    <div>
      {canCreateWithinDirectory ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            {entryButton}
          </ContextMenuTrigger>
          <StyledContextMenuContent>
            <StyledContextMenuItem
              onSelect={() => createActions.begin('file', entry.relativePath)}
            >
              <FilePlus2 />
              {t('filesSidebar.newFile')}
            </StyledContextMenuItem>
            <StyledContextMenuItem
              onSelect={() => createActions.begin('directory', entry.relativePath)}
            >
              <FolderPlus />
              {t('filesSidebar.newFolder')}
            </StyledContextMenuItem>
          </StyledContextMenuContent>
        </ContextMenu>
      ) : entryButton}

      {isDirectory && expanded && (
        <div className="relative">
          <div
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-border/45"
            style={{ left: 15 + depth * 14 }}
          />
          {directoryState?.loading && (
            <div
              className="flex h-7 items-center text-xs text-muted-foreground"
              style={{ paddingLeft: 36 + depth * 14 }}
            >
              {t('common.loading')}
            </div>
          )}
          {directoryState?.error && (
            <div
              className="py-1 pr-2 text-xs text-destructive/80"
              style={{ paddingLeft: 36 + depth * 14 }}
            >
              {t('filesSidebar.loadError')}
            </div>
          )}
          {inlineCreate?.parentRelativePath === entry.relativePath && (
            <InlineCreateEntry
              key={inlineCreate.id}
              state={inlineCreate}
              depth={depth + 1}
              onNameChange={createActions.changeName}
              onSubmit={createActions.submit}
              onCancel={createActions.cancel}
            />
          )}
          {directoryState?.entries.map(child => (
            <TreeEntry
              key={child.relativePath}
              entry={child}
              depth={depth + 1}
              directoryStates={directoryStates}
              expandedPaths={expandedPaths}
              selectedDirectoryPath={selectedDirectoryPath}
              inlineCreate={inlineCreate}
              onToggleDirectory={onToggleDirectory}
              onSelectDirectory={onSelectDirectory}
              onOpenFile={onOpenFile}
              createActions={createActions}
            />
          ))}
          {directoryState?.truncated && (
            <p
              className="py-1 pr-2 text-[11px] text-muted-foreground"
              style={{ paddingLeft: 36 + depth * 14 }}
            >
              {t('filesSidebar.truncated', { count: directoryState.entries.length })}
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
  onNameChange,
  onSubmit,
  onCancel,
}: {
  state: InlineCreateState
  depth: number
  onNameChange: (name: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (state.error) inputRef.current?.focus()
  }, [state.error])

  return (
    <div
      className="py-0.5 pr-2"
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="w-3.5 shrink-0" />
        {state.kind === 'directory'
          ? <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
          : <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75" />}
        <input
          ref={inputRef}
          value={state.name}
          disabled={state.submitting}
          onChange={event => onNameChange(event.target.value)}
          onKeyDown={event => {
            if (state.submitting) return
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              onSubmit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
            }
          }}
          onBlur={() => {
            if (!state.submitting) onCancel()
          }}
          aria-label={state.kind === 'directory'
            ? t('filesSidebar.newFolderName')
            : t('filesSidebar.newFileName')}
          aria-invalid={Boolean(state.error)}
          className={cn(
            'h-6 min-w-0 flex-1 rounded-[4px] border bg-background px-1.5 text-xs outline-none',
            state.error
              ? 'border-destructive focus:ring-1 focus:ring-destructive/35'
              : 'border-foreground/25 focus:ring-1 focus:ring-ring/40',
          )}
        />
        {state.submitting && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>
      {state.error && (
        <p className="mt-1 pl-5 text-[10px] leading-4 text-destructive" role="alert">
          {state.error}
        </p>
      )}
    </div>
  )
}

export function WorkspaceFilesSidebar({
  projectId,
  projectName,
  rootPath,
  onClose,
  onOpenFile,
}: WorkspaceFilesSidebarProps) {
  const { t } = useTranslation()
  const [directoryStates, setDirectoryStates] = useState<Map<string, DirectoryState>>(new Map())
  const directoryStatesRef = useRef(directoryStates)
  const requestGenerationRef = useRef(0)
  const inlineCreateIdRef = useRef(0)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [selectedDirectoryPath, setSelectedDirectoryPath] = useState('')
  const [inlineCreate, setInlineCreate] = useState<InlineCreateState | null>(null)
  const [filter, setFilter] = useState('')
  const [searchResults, setSearchResults] = useState<ProjectFileSearchResult[] | null>([])

  useEffect(() => {
    directoryStatesRef.current = directoryStates
  }, [directoryStates])

  const setDirectoryState = useCallback((
    relativePath: string,
    state: DirectoryState,
  ) => {
    setDirectoryStates(previous => {
      const next = new Map(previous)
      next.set(relativePath, state)
      return next
    })
  }, [])

  const loadDirectory = useCallback(async (relativePath: string, force = false) => {
    if (!projectId) return

    const generation = requestGenerationRef.current
    const current = directoryStatesRef.current.get(relativePath)
    if (!force && current && !current.error) return

    setDirectoryState(relativePath, {
      entries: current?.entries ?? [],
      loading: true,
    })

    try {
      const result = await window.electronAPI.listProjectDirectoryEntries({
        projectId,
        relativePath: relativePath || undefined,
      })
      if (generation !== requestGenerationRef.current) return
      setDirectoryState(relativePath, {
        entries: result.entries,
        loading: false,
        truncated: result.truncated,
      })
    } catch (error) {
      if (generation !== requestGenerationRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      window.electronAPI.debugLog('[ProjectFiles] Failed to list directory:', message)
      setDirectoryState(relativePath, {
        entries: [],
        loading: false,
        error: message,
      })
    }
  }, [projectId, setDirectoryState])

  const refreshTree = useCallback(() => {
    requestGenerationRef.current += 1
    setDirectoryStates(new Map())
    setExpandedPaths(new Set())
    setSelectedDirectoryPath('')
    setInlineCreate(null)
    if (projectId && rootPath) {
      void loadDirectory('', true)
    }
  }, [loadDirectory, projectId, rootPath])

  useEffect(() => {
    setFilter('')
    setSearchResults([])
    refreshTree()
  }, [refreshTree])

  useEffect(() => {
    const query = filter.trim()
    if (!projectId || !rootPath || !query) {
      setSearchResults([])
      return
    }

    setSearchResults(null)
    let cancelled = false
    const timeout = window.setTimeout(() => {
      window.electronAPI.searchProjectFiles({ projectId, query })
        .then(results => {
          if (!cancelled) setSearchResults(results)
        })
        .catch(() => {
          if (!cancelled) setSearchResults([])
        })
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [filter, projectId, rootPath])

  const handleToggleDirectory = useCallback((path: string) => {
    setExpandedPaths(previous => {
      const next = new Set(previous)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        void loadDirectory(path)
      }
      return next
    })
  }, [loadDirectory])

  const handleBeginCreate = useCallback((
    kind: CreateEntryKind,
    createParent = selectedDirectoryPath,
  ) => {
    if (!projectId || !rootPath) return
    setFilter('')
    setSelectedDirectoryPath(createParent)
    inlineCreateIdRef.current += 1
    setInlineCreate({
      id: inlineCreateIdRef.current,
      kind,
      parentRelativePath: createParent,
      name: '',
      submitting: false,
    })
    if (createParent) {
      setExpandedPaths(previous => {
        const next = new Set(previous)
        next.add(createParent)
        return next
      })
      void loadDirectory(createParent)
    }
  }, [loadDirectory, projectId, rootPath, selectedDirectoryPath])

  const handleInlineCreateNameChange = useCallback((name: string) => {
    setInlineCreate(previous => previous
      ? { ...previous, name, error: undefined }
      : previous)
  }, [])

  const handleInlineCreateCancel = useCallback(() => {
    setInlineCreate(previous => previous?.submitting ? previous : null)
  }, [])

  const handleInlineCreateSubmit = useCallback(async () => {
    if (!inlineCreate || inlineCreate.submitting || !projectId) return
    const pendingCreate = inlineCreate
    const name = pendingCreate.name
    const trimmedName = name.trim()
    let validationError: string | undefined
    if (!trimmedName) {
      validationError = t('filesSidebar.createEnterName')
    } else if (name !== trimmedName) {
      validationError = t('filesSidebar.createTrimName')
    }
    if (validationError) {
      setInlineCreate(previous => previous
        ? { ...previous, error: validationError }
        : previous)
      return
    }

    const generation = requestGenerationRef.current
    const request = {
      projectId,
      parentRelativePath: pendingCreate.parentRelativePath || undefined,
      name,
    }
    setInlineCreate(previous => previous
      ? { ...previous, name, submitting: true, error: undefined }
      : previous)

    try {
      const created = pendingCreate.kind === 'directory'
        ? await window.electronAPI.createProjectDirectory(request)
        : await window.electronAPI.createProjectFile(request)
      if (generation !== requestGenerationRef.current) return

      setInlineCreate(null)
      setExpandedPaths(previous => {
        const next = new Set(previous)
        if (pendingCreate.parentRelativePath) {
          next.add(pendingCreate.parentRelativePath)
        }
        if (created.type === 'directory') next.add(created.relativePath)
        return next
      })
      if (created.type === 'directory') {
        setSelectedDirectoryPath(created.relativePath)
        setDirectoryState(created.relativePath, {
          entries: [],
          loading: false,
          truncated: false,
        })
      } else {
        onOpenFile(created.relativePath)
      }
      await loadDirectory(pendingCreate.parentRelativePath, true)
    } catch (error) {
      if (generation !== requestGenerationRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setInlineCreate(previous => previous
        ? {
            ...previous,
            submitting: false,
            error: message.replace(/^PROJECT_FILE_[A-Z_]+:\s*/, ''),
          }
        : previous)
    }
  }, [
    inlineCreate,
    loadDirectory,
    onOpenFile,
    projectId,
    setDirectoryState,
    t,
  ])

  const rootState = rootPath ? directoryStates.get('') : undefined
  const normalizedRootPath = rootPath?.replace(/[\\/]+$/, '')
  const rootLabel = normalizedRootPath?.split(/[\\/]/).pop() || rootPath || ''
  const hasFilter = filter.trim().length > 0
  const rootInlineCreate = inlineCreate?.parentRelativePath === ''
    ? (
        <InlineCreateEntry
          key={inlineCreate.id}
          state={inlineCreate}
          depth={0}
          onNameChange={handleInlineCreateNameChange}
          onSubmit={handleInlineCreateSubmit}
          onCancel={handleInlineCreateCancel}
        />
      )
    : null
  const createActions = {
    begin: handleBeginCreate,
    changeName: handleInlineCreateNameChange,
    submit: handleInlineCreateSubmit,
    cancel: handleInlineCreateCancel,
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-foreground-2">
      <PanelHeader
        title={t('filesSidebar.title')}
        actions={(
          <div className="flex items-center gap-1">
            {projectId && rootPath && (
              <>
                <PanelHeaderCenterButton
                  icon={<FilePlus2 className="h-3.5 w-3.5" />}
                  tooltip={t('filesSidebar.newFile')}
                  onClick={() => handleBeginCreate('file')}
                />
                <PanelHeaderCenterButton
                  icon={<FolderPlus className="h-3.5 w-3.5" />}
                  tooltip={t('filesSidebar.newFolder')}
                  onClick={() => handleBeginCreate('directory')}
                />
                <PanelHeaderCenterButton
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  tooltip={t('common.refresh')}
                  onClick={refreshTree}
                />
              </>
            )}
            <PanelHeaderCenterButton
              icon={<X className="h-3.5 w-3.5" />}
              tooltip={t('common.close')}
              onClick={onClose}
            />
          </div>
        )}
      />

      {!projectId || !rootPath ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Folder className="h-7 w-7 text-muted-foreground/45" />
          <p className="text-sm font-medium text-foreground/80">{t('filesSidebar.noProjectTitle')}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('filesSidebar.noProjectDescription')}</p>
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-border/45 px-3 pb-3">
            <button
              type="button"
              onClick={() => setSelectedDirectoryPath('')}
              aria-pressed={selectedDirectoryPath === ''}
              className={cn(
                'mb-2 flex w-full min-w-0 items-start gap-2 rounded-[6px] px-1 py-1 text-left outline-none transition-colors',
                selectedDirectoryPath === ''
                  ? 'bg-foreground/[0.055]'
                  : 'hover:bg-foreground/[0.035]',
                'focus-visible:ring-1 focus-visible:ring-ring',
              )}
              aria-label={t('filesSidebar.useAsLocation', {
                name: projectName || rootLabel,
              })}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{projectName || rootLabel}</div>
                <div
                  className="mt-0.5 break-all font-mono text-[10px] leading-4 text-muted-foreground/60"
                  title={rootPath}
                >
                  {rootPath}
                </div>
              </div>
            </button>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <input
                value={filter}
                onChange={event => setFilter(event.target.value)}
                placeholder={t('filesSidebar.filterPlaceholder')}
                className={cn(
                  'h-8 w-full rounded-[8px] border border-border/55 bg-background pl-8 pr-8 text-xs',
                  'outline-none transition-colors placeholder:text-muted-foreground/55',
                  'focus:border-foreground/20 focus:ring-1 focus:ring-ring/40',
                )}
              />
              {filter && (
                <button
                  type="button"
                  onClick={() => setFilter('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  aria-label={t('common.close')}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </label>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {hasFilter ? (
              searchResults === null ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">{t('common.loading')}</div>
              ) : searchResults.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">{t('filesSidebar.noMatches')}</div>
              ) : (
                searchResults.map(result => (
                  <button
                    key={result.relativePath}
                    type="button"
                    onClick={() => onOpenFile(result.relativePath)}
                    className={cn(
                      'flex w-full min-w-0 items-start gap-2 rounded-[6px] px-2 py-1.5 text-left',
                      'outline-none transition-colors hover:bg-foreground/[0.045] focus-visible:ring-1 focus-visible:ring-ring',
                    )}
                  >
                    <span className="mt-0.5">{fileIcon(result.name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground/85">{result.name}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground/55">
                        {result.relativePath}
                      </span>
                    </span>
                  </button>
                ))
              )
            ) : (
              <>
                {rootInlineCreate}
                {!rootState || rootState.loading ? (
                  <div className="px-2 py-3 text-xs text-muted-foreground">{t('common.loading')}</div>
                ) : rootState.error ? (
                  <div className="px-2 py-3 text-xs text-destructive/80">{t('filesSidebar.loadError')}</div>
                ) : (
                  <>
                    {rootState.entries.length === 0 && !inlineCreate && (
                      <div className="px-2 py-3 text-xs text-muted-foreground">{t('filesSidebar.empty')}</div>
                    )}
                    {rootState.entries.map(entry => (
                      <TreeEntry
                        key={entry.relativePath}
                        entry={entry}
                        depth={0}
                        directoryStates={directoryStates}
                        expandedPaths={expandedPaths}
                        selectedDirectoryPath={selectedDirectoryPath}
                        inlineCreate={inlineCreate}
                        onToggleDirectory={handleToggleDirectory}
                        onSelectDirectory={setSelectedDirectoryPath}
                        onOpenFile={onOpenFile}
                        createActions={createActions}
                      />
                    ))}
                    {rootState.truncated && (
                      <p className="px-2 pt-2 text-[11px] text-muted-foreground">
                        {t('filesSidebar.truncated', { count: rootState.entries.length })}
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
