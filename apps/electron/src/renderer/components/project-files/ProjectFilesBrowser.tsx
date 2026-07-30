import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  BrainCircuit,
  Braces,
  Check,
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
  PanelRightOpen,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import {
  PROJECT_NOTE_TARGET_EXTENSIONS,
  isProjectNoteTargetPath,
  type ProjectDirectoryEntry,
  type ProjectFileSearchResult,
} from '@craft-agent/shared/protocol'
import { cn } from '@/lib/utils'
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

type CreateEntryKind = 'file' | 'directory' | 'mindmap'

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

export type ProjectFilesBrowserMode = 'manage' | 'note-target'

interface ProjectFilesBrowserProps {
  projectId?: string
  projectName?: string
  rootPath?: string
  mode: ProjectFilesBrowserMode
  selectedFilePath?: string
  disabled?: boolean
  autoFocusSearch?: boolean
  openFilePaths?: ReadonlySet<string>
  onOpenFile?: (relativePath: string) => void
  onOpenFileInNewPanel?: (relativePath: string) => void
  onSelectFile?: (relativePath: string) => void
  onActivateFile?: (relativePath: string) => void
  onBusyChange?: (busy: boolean) => void
}

function fileIcon(name: string) {
  const extension = name.split('.').pop()?.toLowerCase()
  const className = 'h-3.5 w-3.5 shrink-0 text-muted-foreground/75'

  if (extension === 'drawnix') {
    return <BrainCircuit className={className} />
  }
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
  mode: ProjectFilesBrowserMode
  disabled: boolean
  directoryStates: Map<string, DirectoryState>
  expandedPaths: Set<string>
  selectedDirectoryPath: string
  selectedFilePath?: string
  openFilePaths?: ReadonlySet<string>
  inlineCreate: InlineCreateState | null
  onToggleDirectory: (path: string) => void
  onSelectDirectory: (path: string) => void
  onFileClick: (relativePath: string) => void
  onOpenFileInNewPanel?: (relativePath: string) => void
  onFileActivate?: (relativePath: string) => void
  createActions: InlineCreateActions
}

function TreeEntry({
  entry,
  depth,
  mode,
  disabled,
  directoryStates,
  expandedPaths,
  selectedDirectoryPath,
  selectedFilePath,
  openFilePaths,
  inlineCreate,
  onToggleDirectory,
  onSelectDirectory,
  onFileClick,
  onOpenFileInNewPanel,
  onFileActivate,
  createActions,
}: TreeEntryProps) {
  const { t } = useTranslation()
  const isDirectory = entry.type === 'directory'
  const canCreateWithinDirectory = isDirectory && !entry.isSymlink
  const canBrowseDirectory = isDirectory
    && (mode === 'manage' || !entry.isSymlink)
  const canSelectFile = !isDirectory
    && (
      mode === 'manage'
      || (!entry.isSymlink && isProjectNoteTargetPath(entry.relativePath))
    )
  const expanded = isDirectory && expandedPaths.has(entry.relativePath)
  const directoryState = isDirectory ? directoryStates.get(entry.relativePath) : undefined
  const selected = isDirectory
    ? canCreateWithinDirectory && selectedDirectoryPath === entry.relativePath
    : selectedFilePath === entry.relativePath
  const entryDisabled = disabled
    || (isDirectory ? !canBrowseDirectory : !canSelectFile)
  const isOpenInPanel = openFilePaths?.has(entry.relativePath) ?? false

  const entryButton = (
    <button
      type="button"
      disabled={entryDisabled}
      onClick={() => {
        if (isDirectory) {
          if (canCreateWithinDirectory) {
            onSelectDirectory(entry.relativePath)
          }
          onToggleDirectory(entry.relativePath)
        } else {
          onFileClick(entry.relativePath)
        }
      }}
      onDoubleClick={() => {
        if (!isDirectory) onFileActivate?.(entry.relativePath)
      }}
      className={cn(
        'group flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[6px] pr-2 text-left text-[13px]',
        'outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring',
        selected
          ? 'bg-foreground/[0.065] text-foreground'
          : 'text-foreground/85 hover:bg-foreground/[0.045]',
        entryDisabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
      )}
      aria-pressed={selected}
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
      {!isDirectory && selected && <Check className="h-3.5 w-3.5 shrink-0" />}
    </button>
  )

  let entryControl: ReactNode = entryButton
  if (canCreateWithinDirectory && !disabled) {
    entryControl = (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {entryButton}
        </ContextMenuTrigger>
        <StyledContextMenuContent>
          <StyledContextMenuItem
            onSelect={() => createActions.begin('file', entry.relativePath)}
          >
            <FilePlus2 />
            {mode === 'note-target'
              ? t('projectNoteTarget.newFile')
              : t('filesSidebar.newFile')}
          </StyledContextMenuItem>
          {mode === 'manage' && (
            <StyledContextMenuItem
              onSelect={() => createActions.begin('mindmap', entry.relativePath)}
            >
              <BrainCircuit />
              {t('filesSidebar.newMindMap')}
            </StyledContextMenuItem>
          )}
          <StyledContextMenuItem
            onSelect={() => createActions.begin('directory', entry.relativePath)}
          >
            <FolderPlus />
            {t('filesSidebar.newFolder')}
          </StyledContextMenuItem>
        </StyledContextMenuContent>
      </ContextMenu>
    )
  } else if (
    !isDirectory
    && mode === 'manage'
    && !disabled
    && onOpenFileInNewPanel
  ) {
    entryControl = (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {entryButton}
        </ContextMenuTrigger>
        <StyledContextMenuContent>
          <StyledContextMenuItem
            disabled={isOpenInPanel}
            onSelect={() => onOpenFileInNewPanel(entry.relativePath)}
          >
            <PanelRightOpen />
            {t('filesSidebar.openInNewPanel')}
          </StyledContextMenuItem>
        </StyledContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <div>
      {entryControl}

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
              mode={mode}
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
              mode={mode}
              disabled={disabled}
              directoryStates={directoryStates}
              expandedPaths={expandedPaths}
              selectedDirectoryPath={selectedDirectoryPath}
              selectedFilePath={selectedFilePath}
              openFilePaths={openFilePaths}
              inlineCreate={inlineCreate}
              onToggleDirectory={onToggleDirectory}
              onSelectDirectory={onSelectDirectory}
              onFileClick={onFileClick}
              onOpenFileInNewPanel={onOpenFileInNewPanel}
              onFileActivate={onFileActivate}
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
  mode,
  onNameChange,
  onSubmit,
  onCancel,
}: {
  state: InlineCreateState
  depth: number
  mode: ProjectFilesBrowserMode
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

  let entryIcon = (
    <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75" />
  )
  let nameLabel = mode === 'note-target'
    ? t('projectNoteTarget.newFile')
    : t('filesSidebar.newFileName')
  if (state.kind === 'directory') {
    entryIcon = (
      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
    )
    nameLabel = t('filesSidebar.newFolderName')
  } else if (state.kind === 'mindmap') {
    entryIcon = (
      <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75" />
    )
    nameLabel = t('filesSidebar.newMindMapName')
  }

  return (
    <div
      className="py-0.5 pr-2"
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="w-3.5 shrink-0" />
        {entryIcon}
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
              event.stopPropagation()
              onCancel()
            }
          }}
          onBlur={() => {
            if (!state.submitting) onCancel()
          }}
          aria-label={nameLabel}
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

export function ProjectFilesBrowser({
  projectId,
  projectName,
  rootPath,
  mode,
  selectedFilePath,
  disabled = false,
  autoFocusSearch = false,
  openFilePaths,
  onOpenFile,
  onOpenFileInNewPanel,
  onSelectFile,
  onActivateFile,
  onBusyChange,
}: ProjectFilesBrowserProps) {
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
  const [searchFailed, setSearchFailed] = useState(false)
  const [refreshGeneration, setRefreshGeneration] = useState(0)

  const handleFileClick = useCallback((relativePath: string) => {
    if (mode === 'manage') {
      onOpenFile?.(relativePath)
    } else {
      onSelectFile?.(relativePath)
    }
  }, [mode, onOpenFile, onSelectFile])

  const handleFileActivate = useCallback((relativePath: string) => {
    if (mode === 'note-target') onActivateFile?.(relativePath)
  }, [mode, onActivateFile])

  useEffect(() => {
    directoryStatesRef.current = directoryStates
  }, [directoryStates])

  useEffect(() => {
    onBusyChange?.(Boolean(inlineCreate))
  }, [inlineCreate, onBusyChange])

  useEffect(() => () => {
    requestGenerationRef.current += 1
    onBusyChange?.(false)
  }, [onBusyChange])

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

  const updateInlineCreate = useCallback((
    patch: Partial<Pick<InlineCreateState, 'name' | 'submitting' | 'error'>>,
  ) => {
    setInlineCreate(previous => previous
      ? { ...previous, ...patch }
      : previous)
  }, [])

  const expandDirectories = useCallback((
    ...relativePaths: Array<string | undefined>
  ) => {
    setExpandedPaths(previous => {
      const next = new Set(previous)
      relativePaths.forEach(path => {
        if (path) next.add(path)
      })
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
    setRefreshGeneration(previous => previous + 1)
    if (projectId && rootPath) {
      void loadDirectory('', true)
    }
  }, [loadDirectory, projectId, rootPath])

  useEffect(() => {
    setFilter('')
    setSearchResults([])
    setSearchFailed(false)
    refreshTree()
  }, [refreshTree])

  useEffect(() => {
    if (
      mode !== 'note-target'
      || !projectId
      || !rootPath
      || !selectedFilePath
    ) {
      return
    }

    const segments = selectedFilePath.split('/').filter(Boolean)
    const parentPaths = segments
      .slice(0, -1)
      .map((_, index) => segments.slice(0, index + 1).join('/'))
    if (parentPaths.length === 0) return

    expandDirectories(...parentPaths)
    parentPaths.forEach(path => {
      void loadDirectory(path)
    })
  }, [
    expandDirectories,
    loadDirectory,
    mode,
    projectId,
    refreshGeneration,
    rootPath,
    selectedFilePath,
  ])

  useEffect(() => {
    const query = filter.trim()
    if (!projectId || !rootPath || !query) {
      setSearchResults([])
      setSearchFailed(false)
      return
    }

    setSearchResults(null)
    setSearchFailed(false)
    let cancelled = false
    const timeout = window.setTimeout(() => {
      window.electronAPI.searchProjectFiles({
        projectId,
        query,
        extensions: mode === 'note-target'
          ? [...PROJECT_NOTE_TARGET_EXTENSIONS]
          : undefined,
      })
        .then(results => {
          if (cancelled) return
          if (mode === 'manage') {
            setSearchResults(results)
            return
          }
          const seen = new Set<string>()
          setSearchResults(results.filter(result => {
            if (
              !isProjectNoteTargetPath(result.relativePath)
              || seen.has(result.relativePath)
            ) {
              return false
            }
            seen.add(result.relativePath)
            return true
          }))
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
  }, [filter, mode, projectId, refreshGeneration, rootPath])

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
    if (!projectId || !rootPath || disabled || inlineCreate?.submitting) return
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
      expandDirectories(createParent)
      void loadDirectory(createParent)
    }
  }, [
    disabled,
    expandDirectories,
    inlineCreate?.submitting,
    loadDirectory,
    projectId,
    rootPath,
    selectedDirectoryPath,
  ])

  const handleInlineCreateNameChange = useCallback((name: string) => {
    updateInlineCreate({ name, error: undefined })
  }, [updateInlineCreate])

  const handleInlineCreateCancel = useCallback(() => {
    setInlineCreate(previous => previous?.submitting ? previous : null)
  }, [])

  const handleInlineCreateSubmit = useCallback(async () => {
    if (!inlineCreate || inlineCreate.submitting || !projectId) return
    const pendingCreate = inlineCreate
    const inputName = pendingCreate.name
    const trimmedName = inputName.trim()
    let validationError: string | undefined
    if (!trimmedName) {
      validationError = t('filesSidebar.createEnterName')
    } else if (inputName !== trimmedName) {
      validationError = t('filesSidebar.createTrimName')
    }
    if (validationError) {
      updateInlineCreate({ error: validationError })
      return
    }

    let name = inputName
    if (pendingCreate.kind === 'file' && mode === 'note-target') {
      const extensionIndex = name.lastIndexOf('.')
      const hasExplicitExtension = extensionIndex > 0
        && !/^\.+$/.test(name.slice(0, extensionIndex))
      if (!hasExplicitExtension) {
        name += '.md'
      }
      if (!isProjectNoteTargetPath(name)) {
        updateInlineCreate({
          error: t('projectNoteTarget.unsupportedFileType'),
        })
        return
      }
    }
    if (
      pendingCreate.kind === 'mindmap'
      && !name.toLowerCase().endsWith('.drawnix')
    ) {
      name += '.drawnix'
    }
    const generation = requestGenerationRef.current
    const request = {
      projectId,
      parentRelativePath: pendingCreate.parentRelativePath || undefined,
      name,
    }
    updateInlineCreate({ name, submitting: true, error: undefined })

    try {
      let created: ProjectDirectoryEntry
      if (pendingCreate.kind === 'directory') {
        created = await window.electronAPI.createProjectDirectory(request)
      } else if (pendingCreate.kind === 'mindmap') {
        created = await window.electronAPI.createDrawnixProjectFile(request)
      } else {
        created = await window.electronAPI.createProjectFile(request)
      }
      if (generation !== requestGenerationRef.current) return

      setInlineCreate(null)
      expandDirectories(
        pendingCreate.parentRelativePath,
        created.type === 'directory' ? created.relativePath : undefined,
      )
      if (created.type === 'directory') {
        setSelectedDirectoryPath(created.relativePath)
        setDirectoryState(created.relativePath, {
          entries: [],
          loading: false,
          truncated: false,
        })
      } else {
        handleFileClick(created.relativePath)
      }
      await loadDirectory(pendingCreate.parentRelativePath, true)
    } catch (error) {
      if (generation !== requestGenerationRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      updateInlineCreate({
        submitting: false,
        error: message.replace(/^PROJECT_FILE_[A-Z_]+:\s*/, ''),
      })
    }
  }, [
    expandDirectories,
    handleFileClick,
    inlineCreate,
    loadDirectory,
    mode,
    projectId,
    setDirectoryState,
    t,
    updateInlineCreate,
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
          mode={mode}
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
  const interactionDisabled = disabled || Boolean(inlineCreate?.submitting)
  const searchPlaceholder = mode === 'note-target'
    ? t('projectNoteTarget.searchPlaceholder')
    : t('filesSidebar.filterPlaceholder')
  const searchLabel = mode === 'note-target'
    ? t('projectNoteTarget.searchAria')
    : t('filesSidebar.filterPlaceholder')
  let searchContent: ReactNode
  if (searchResults === null) {
    searchContent = (
      <div className="px-2 py-3 text-xs text-muted-foreground">
        {t('common.loading')}
      </div>
    )
  } else if (searchFailed) {
    searchContent = (
      <div className="px-2 py-3 text-xs text-destructive/80">
        {mode === 'note-target'
          ? t('projectNoteTarget.searchError')
          : t('filesSidebar.loadError')}
      </div>
    )
  } else if (searchResults.length === 0) {
    searchContent = (
      <div className="px-2 py-3 text-xs text-muted-foreground">
        {mode === 'note-target'
          ? t('projectNoteTarget.noMatches')
          : t('filesSidebar.noMatches')}
      </div>
    )
  } else {
    searchContent = searchResults.map(result => {
      const selected = selectedFilePath === result.relativePath
      const resultButton = (
        <button
          key={result.relativePath}
          type="button"
          disabled={interactionDisabled}
          onClick={() => handleFileClick(result.relativePath)}
          onDoubleClick={() => handleFileActivate(result.relativePath)}
          aria-pressed={selected}
          className={cn(
            'flex w-full min-w-0 items-start gap-2 rounded-[6px] px-2 py-1.5 text-left',
            'outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring',
            selected
              ? 'bg-foreground/[0.065]'
              : 'hover:bg-foreground/[0.045]',
            interactionDisabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <span className="mt-0.5">{fileIcon(result.name)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-foreground/85">
              {result.name}
            </span>
            <span className="block truncate font-mono text-[10px] text-muted-foreground/55">
              {result.relativePath}
            </span>
          </span>
          {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        </button>
      )
      if (mode !== 'manage' || !onOpenFileInNewPanel) return resultButton

      return (
        <ContextMenu key={result.relativePath}>
          <ContextMenuTrigger asChild>
            {resultButton}
          </ContextMenuTrigger>
          <StyledContextMenuContent>
            <StyledContextMenuItem
              disabled={openFilePaths?.has(result.relativePath)}
              onSelect={() => onOpenFileInNewPanel(result.relativePath)}
            >
              <PanelRightOpen />
              {t('filesSidebar.openInNewPanel')}
            </StyledContextMenuItem>
          </StyledContextMenuContent>
        </ContextMenu>
      )
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-foreground-2">
      {!projectId || !rootPath ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Folder className="h-7 w-7 text-muted-foreground/45" />
          <p className="text-sm font-medium text-foreground/80">{t('filesSidebar.noProjectTitle')}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('filesSidebar.noProjectDescription')}</p>
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-border/45 px-3 py-3">
            <div className="mb-2 flex min-w-0 items-start gap-2">
              <button
                type="button"
                disabled={interactionDisabled}
                onClick={() => setSelectedDirectoryPath('')}
                aria-pressed={selectedDirectoryPath === ''}
                className={cn(
                  'flex min-w-0 flex-1 items-start gap-2 rounded-[6px] px-1 py-1 text-left outline-none transition-colors',
                  selectedDirectoryPath === ''
                    ? 'bg-foreground/[0.055]'
                    : 'hover:bg-foreground/[0.035]',
                  'focus-visible:ring-1 focus-visible:ring-ring',
                  interactionDisabled && 'cursor-not-allowed opacity-50',
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
              <div className="flex shrink-0 items-center gap-1">
                <PanelHeaderCenterButton
                  icon={<FilePlus2 className="h-3.5 w-3.5" />}
                  tooltip={mode === 'note-target'
                    ? t('projectNoteTarget.newFile')
                    : t('filesSidebar.newFile')}
                  disabled={interactionDisabled}
                  onClick={() => handleBeginCreate('file')}
                />
                {mode === 'manage' && (
                  <PanelHeaderCenterButton
                    icon={<BrainCircuit className="h-3.5 w-3.5" />}
                    tooltip={t('filesSidebar.newMindMap')}
                    disabled={interactionDisabled}
                    onClick={() => handleBeginCreate('mindmap')}
                  />
                )}
                <PanelHeaderCenterButton
                  icon={<FolderPlus className="h-3.5 w-3.5" />}
                  tooltip={t('filesSidebar.newFolder')}
                  disabled={interactionDisabled}
                  onClick={() => handleBeginCreate('directory')}
                />
                <PanelHeaderCenterButton
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  tooltip={t('common.refresh')}
                  disabled={interactionDisabled}
                  onClick={refreshTree}
                />
              </div>
            </div>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <input
                value={filter}
                disabled={interactionDisabled}
                autoFocus={autoFocusSearch}
                onChange={event => setFilter(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchLabel}
                className={cn(
                  'h-8 w-full rounded-[8px] border border-border/55 bg-background pl-8 pr-8 text-xs',
                  'outline-none transition-colors placeholder:text-muted-foreground/55',
                  'focus:border-foreground/20 focus:ring-1 focus:ring-ring/40',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              />
              {filter && (
                <button
                  type="button"
                  disabled={interactionDisabled}
                  onClick={() => setFilter('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:pointer-events-none"
                  aria-label={t('common.close')}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </label>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {hasFilter ? searchContent : (
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
                        mode={mode}
                        disabled={interactionDisabled}
                        directoryStates={directoryStates}
                        expandedPaths={expandedPaths}
                        selectedDirectoryPath={selectedDirectoryPath}
                        selectedFilePath={selectedFilePath}
                        openFilePaths={openFilePaths}
                        inlineCreate={inlineCreate}
                        onToggleDirectory={handleToggleDirectory}
                        onSelectDirectory={setSelectedDirectoryPath}
                        onFileClick={handleFileClick}
                        onOpenFileInNewPanel={onOpenFileInNewPanel}
                        onFileActivate={handleFileActivate}
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
