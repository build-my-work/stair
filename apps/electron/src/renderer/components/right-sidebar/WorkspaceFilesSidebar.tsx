import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Braces,
  ChevronRight,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Link2,
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

interface DirectoryState {
  entries: ProjectDirectoryEntry[]
  loading: boolean
  error?: string
  truncated?: boolean
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
  onToggleDirectory: (path: string) => void
  onOpenFile: (relativePath: string) => void
}

function TreeEntry({
  entry,
  depth,
  directoryStates,
  expandedPaths,
  onToggleDirectory,
  onOpenFile,
}: TreeEntryProps) {
  const { t } = useTranslation()
  const isDirectory = entry.type === 'directory'
  const expanded = isDirectory && expandedPaths.has(entry.relativePath)
  const directoryState = isDirectory ? directoryStates.get(entry.relativePath) : undefined

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isDirectory) onToggleDirectory(entry.relativePath)
          else onOpenFile(entry.relativePath)
        }}
        className={cn(
          'group flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[6px] pr-2 text-left text-[13px]',
          'text-foreground/85 outline-none transition-colors hover:bg-foreground/[0.045]',
          'focus-visible:ring-1 focus-visible:ring-ring',
        )}
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
          {directoryState?.entries.map(child => (
            <TreeEntry
              key={child.relativePath}
              entry={child}
              depth={depth + 1}
              directoryStates={directoryStates}
              expandedPaths={expandedPaths}
              onToggleDirectory={onToggleDirectory}
              onOpenFile={onOpenFile}
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
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [searchResults, setSearchResults] = useState<ProjectFileSearchResult[] | null>([])

  useEffect(() => {
    directoryStatesRef.current = directoryStates
  }, [directoryStates])

  const loadDirectory = useCallback(async (relativePath: string, force = false) => {
    if (!projectId) return

    const generation = requestGenerationRef.current
    const current = directoryStatesRef.current.get(relativePath)
    if (!force && current && !current.error) return

    setDirectoryStates(previous => {
      const next = new Map(previous)
      next.set(relativePath, { entries: current?.entries ?? [], loading: true })
      return next
    })

    try {
      const result = await window.electronAPI.listProjectDirectoryEntries({
        projectId,
        relativePath: relativePath || undefined,
      })
      if (generation !== requestGenerationRef.current) return
      setDirectoryStates(previous => {
        const next = new Map(previous)
        next.set(relativePath, {
          entries: result.entries,
          loading: false,
          truncated: result.truncated,
        })
        return next
      })
    } catch (error) {
      if (generation !== requestGenerationRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      window.electronAPI.debugLog('[ProjectFiles] Failed to list directory:', message)
      setDirectoryStates(previous => {
        const next = new Map(previous)
        next.set(relativePath, { entries: [], loading: false, error: message })
        return next
      })
    }
  }, [projectId])

  const refreshTree = useCallback(() => {
    requestGenerationRef.current += 1
    setDirectoryStates(new Map())
    setExpandedPaths(new Set())
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

  const rootState = rootPath ? directoryStates.get('') : undefined
  const normalizedRootPath = rootPath?.replace(/[\\/]+$/, '')
  const rootLabel = normalizedRootPath?.split(/[\\/]/).pop() || rootPath || ''
  const hasFilter = filter.trim().length > 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-foreground-2">
      <PanelHeader
        title={t('filesSidebar.title')}
        actions={(
          <div className="flex items-center gap-1">
            {projectId && rootPath && (
              <PanelHeaderCenterButton
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                tooltip={t('common.refresh')}
                onClick={refreshTree}
              />
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
            <div className="mb-2 flex min-w-0 items-start gap-2 px-1">
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
            </div>
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
            ) : !rootState || rootState.loading ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">{t('common.loading')}</div>
            ) : rootState?.error ? (
              <div className="px-2 py-3 text-xs text-destructive/80">{t('filesSidebar.loadError')}</div>
            ) : rootState?.entries.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">{t('filesSidebar.empty')}</div>
            ) : (
              <>
                {rootState?.entries.map(entry => (
                  <TreeEntry
                    key={entry.relativePath}
                    entry={entry}
                    depth={0}
                    directoryStates={directoryStates}
                    expandedPaths={expandedPaths}
                    onToggleDirectory={handleToggleDirectory}
                    onOpenFile={onOpenFile}
                  />
                ))}
                {rootState?.truncated && (
                  <p className="px-2 pt-2 text-[11px] text-muted-foreground">
                    {t('filesSidebar.truncated', { count: rootState.entries.length })}
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
