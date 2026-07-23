import * as React from 'react'
import {
  BookOpen,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
} from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'

import { cn } from '@/lib/utils'
import { getWorkspaceFileKind } from './workspace-file-types'

export interface WorkingDirectoryEntry {
  name: string
  relativePath?: string
  path?: string
  type?: 'file' | 'directory' | 'symlink'
  isDirectory?: boolean
  size?: number
}

interface WorkingDirectoryFileApi {
  listWorkingDirectoryEntries(
    sessionId: string,
    relativeDirectory?: string,
  ): Promise<WorkingDirectoryEntry[]>
}

function getApi(): WorkingDirectoryFileApi {
  return window.electronAPI as typeof window.electronAPI & WorkingDirectoryFileApi
}

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function pathForEntry(entry: WorkingDirectoryEntry, parent: string): string {
  return entry.relativePath ?? entry.path ?? joinRelative(parent, entry.name)
}

function isDirectory(entry: WorkingDirectoryEntry): boolean {
  return entry.type === 'directory' || entry.isDirectory === true
}

function sortEntries(entries: WorkingDirectoryEntry[]): WorkingDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const directoryOrder = Number(isDirectory(right)) - Number(isDirectory(left))
    return directoryOrder || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })
}

interface WorkingDirectoryFileExplorerProps {
  sessionId: string
  expandedDirectories: string[]
  scrollTop: number
  onExpandedDirectoriesChange: (paths: string[]) => void
  onScrollTopChange: (scrollTop: number) => void
  onOpenFile: (path: string) => void
}

export function WorkingDirectoryFileExplorer({
  sessionId,
  expandedDirectories,
  scrollTop,
  onExpandedDirectoriesChange,
  onScrollTopChange,
  onOpenFile,
}: WorkingDirectoryFileExplorerProps) {
  const [entriesByDirectory, setEntriesByDirectory] = React.useState<Record<string, WorkingDirectoryEntry[]>>({})
  const [loadingDirectories, setLoadingDirectories] = React.useState<Set<string>>(new Set())
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const scrollFrameRef = React.useRef<number | null>(null)
  const sessionIdRef = React.useRef(sessionId)
  sessionIdRef.current = sessionId
  const expandedSet = React.useMemo(() => new Set(expandedDirectories), [expandedDirectories])

  const loadDirectory = React.useCallback(async (directory: string, force = false) => {
    if (!force && entriesByDirectory[directory]) return
    setLoadingDirectories((current) => new Set(current).add(directory))
    setErrors((current) => {
      const next = { ...current }
      delete next[directory]
      return next
    })
    try {
      const requestedSessionId = sessionId
      const entries = await getApi().listWorkingDirectoryEntries(sessionId, directory || undefined)
      if (sessionIdRef.current !== requestedSessionId) return
      setEntriesByDirectory((current) => ({ ...current, [directory]: sortEntries(entries) }))
    } catch (reason) {
      if (sessionIdRef.current !== sessionId) return
      setErrors((current) => ({
        ...current,
        [directory]: reason instanceof Error ? reason.message : 'Unable to load folder',
      }))
    } finally {
      if (sessionIdRef.current !== sessionId) return
      setLoadingDirectories((current) => {
        const next = new Set(current)
        next.delete(directory)
        return next
      })
    }
  }, [entriesByDirectory, sessionId])

  React.useEffect(() => {
    let disposed = false
    setEntriesByDirectory({})
    setLoadingDirectories(new Set())
    setErrors({})
    void getApi().listWorkingDirectoryEntries(sessionId).then((entries) => {
      if (!disposed) setEntriesByDirectory({ '': sortEntries(entries) })
    }).catch((reason) => {
      if (!disposed) {
        setErrors({ '': reason instanceof Error ? reason.message : 'Unable to load files' })
      }
    })
    return () => {
      disposed = true
    }
  }, [sessionId])

  React.useEffect(() => {
    for (const directory of expandedDirectories) {
      if (!entriesByDirectory[directory] && !loadingDirectories.has(directory)) {
        void loadDirectory(directory)
      }
    }
  }, [entriesByDirectory, expandedDirectories, loadDirectory, loadingDirectories])

  React.useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollTop
  }, [scrollTop, sessionId])

  React.useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  const toggleDirectory = React.useCallback((path: string) => {
    const next = new Set(expandedDirectories)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      void loadDirectory(path)
    }
    onExpandedDirectoriesChange([...next])
  }, [expandedDirectories, loadDirectory, onExpandedDirectoriesChange])

  const refresh = React.useCallback(() => {
    setEntriesByDirectory({})
    setErrors({})
    void loadDirectory('', true)
    for (const directory of expandedDirectories) void loadDirectory(directory, true)
  }, [expandedDirectories, loadDirectory])

  const handleScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      onScrollTopChange(nextScrollTop)
    })
  }, [onScrollTopChange])

  const renderDirectory = (directory: string, level: number): React.ReactNode => {
    const entries = entriesByDirectory[directory]
    if (!entries) {
      if (!loadingDirectories.has(directory)) return null
      return (
        <div className="flex h-7 items-center gap-2 text-xs text-muted-foreground" style={{ paddingLeft: 12 + level * 14 }}>
          <Loader2 className="size-3 animate-spin" />
          Loading…
        </div>
      )
    }

    return entries.map((entry) => {
      const path = pathForEntry(entry, directory)
      const directoryEntry = isDirectory(entry)
      const expanded = directoryEntry && expandedSet.has(path)
      return (
        <React.Fragment key={path}>
          <button
            type="button"
            className={cn(
              'group flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-xs',
              'text-foreground/75 hover:bg-muted/65 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
            style={{ paddingLeft: 6 + level * 14 }}
            title={path}
            onClick={() => directoryEntry ? toggleDirectory(path) : onOpenFile(path)}
          >
            {directoryEntry ? (
              <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {directoryEntry ? (
              <DirectoryIcon expanded={expanded} />
            ) : (
              <WorkspaceFileIcon path={path} />
            )}
            <span className="min-w-0 truncate">{entry.name}</span>
          </button>
          {expanded && renderDirectory(path, level + 1)}
          {expanded && errors[path] && (
            <button
              type="button"
              className="block w-full truncate py-1 pr-2 text-left text-[11px] text-destructive"
              style={{ paddingLeft: 26 + (level + 1) * 14 }}
              title={errors[path]}
              onClick={() => void loadDirectory(path, true)}
            >
              Couldn’t load — click to retry
            </button>
          )}
        </React.Fragment>
      )
    })
  }

  const rootLoading = !entriesByDirectory[''] && !errors['']
  const rootError = errors['']
  let content: React.ReactNode
  if (rootLoading) {
    content = (
      <div className="flex h-20 items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  } else if (rootError) {
    content = (
      <button
        type="button"
        className="flex w-full flex-col items-center gap-2 rounded-lg px-3 py-5 text-center text-xs text-muted-foreground hover:bg-muted/50"
        onClick={refresh}
      >
        <span>{rootError}</span>
        <span className="text-foreground">Try again</span>
      </button>
    )
  } else if (entriesByDirectory['']?.length === 0) {
    content = (
      <div className="px-3 py-8 text-center text-xs leading-5 text-muted-foreground">
        This project folder is empty.
      </div>
    )
  } else {
    content = renderDirectory('', 0)
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-muted/15">
      <div className="flex h-10 shrink-0 items-center border-b border-border/60 px-2.5">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Files
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Refresh files"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={refresh}
            >
              <RefreshCw className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Refresh files</TooltipContent>
        </Tooltip>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5" onScroll={handleScroll}>
        {content}
      </div>
    </div>
  )
}

function DirectoryIcon({ expanded }: { expanded: boolean }) {
  const className = 'size-3.5 shrink-0 text-amber-600/75 dark:text-amber-400/65'
  if (expanded) return <FolderOpen className={className} />
  return <Folder className={className} />
}

function WorkspaceFileIcon({ path }: { path: string }) {
  const kind = getWorkspaceFileKind(path)
  const className = 'size-3.5 shrink-0 text-muted-foreground'
  if (kind === 'epub') return <BookOpen className={className} />
  if (kind === 'image') return <FileImage className={className} />
  if (kind === 'markdown' || kind === 'pdf') return <FileText className={className} />
  if (kind === 'text') return <FileCode2 className={className} />
  return <File className={className} />
}
