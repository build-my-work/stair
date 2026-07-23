import * as React from 'react'
import {
  AlertCircle,
  ExternalLink,
  FileQuestion,
  Loader2,
  RotateCw,
} from 'lucide-react'

import { Markdown } from '@/components/markdown'
import { ShikiCodeViewer } from '@/components/shiki/ShikiCodeViewer'
import { Button } from '@/components/ui/button'
import type { FileReference } from '@craft-agent/core/types'
import type { RightWorkspaceFileNavigation } from '@/atoms/right-workspace'
import { getWorkspaceFileKind, getWorkspaceFileLanguage } from './workspace-file-types'

export { getWorkspaceFileKind, getWorkspaceFileLanguage } from './workspace-file-types'

interface WorkingDirectoryRendererApi {
  readWorkingDirectoryText(sessionId: string, relativePath: string): Promise<string>
  readWorkingDirectoryDataUrl(sessionId: string, relativePath: string): Promise<string>
  openWorkingDirectoryFile(sessionId: string, relativePath: string): Promise<void>
}

function getApi(): WorkingDirectoryRendererApi {
  return window.electronAPI as typeof window.electronAPI & WorkingDirectoryRendererApi
}

const WorkingFileEpubReader = React.lazy(async () => {
  const module = await import('@/components/learning/WorkingFileEpubReader')
  return { default: module.WorkingFileEpubReader }
})

interface WorkspaceFileTabProps {
  workspaceId: string
  sessionId: string
  path: string
  onReference?: (reference: FileReference, target: 'main' | 'sideChat') => void
  navigation?: RightWorkspaceFileNavigation
}

export function WorkspaceFileTab({ workspaceId, sessionId, path, onReference, navigation }: WorkspaceFileTabProps) {
  const kind = getWorkspaceFileKind(path)
  const [content, setContent] = React.useState<string | null>(null)
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadKey, setReloadKey] = React.useState(0)
  const filename = path.split('/').at(-1) ?? path
  const textRange = navigation?.locator.type === 'text-range' ? navigation.locator : null

  React.useEffect(() => {
    if (kind === 'epub' || kind === 'external') return
    let disposed = false
    setContent(null)
    setDataUrl(null)
    setError(null)

    let load: Promise<void>
    if (kind === 'pdf' || kind === 'image') {
      load = getApi().readWorkingDirectoryDataUrl(sessionId, path).then((value) => {
        if (!disposed) setDataUrl(value)
      })
    } else {
      load = getApi().readWorkingDirectoryText(sessionId, path).then((value) => {
        if (!disposed) setContent(value)
      })
    }

    void load.catch((reason) => {
      if (!disposed) {
        setError(reason instanceof Error ? reason.message : 'Unable to open this file')
      }
    })

    return () => {
      disposed = true
    }
  }, [kind, path, reloadKey, sessionId])

  const openExternally = React.useCallback(() => {
    void getApi().openWorkingDirectoryFile(sessionId, path).catch((reason) => {
      setError(reason instanceof Error ? reason.message : 'Unable to open this file')
    })
  }, [path, sessionId])

  if (kind === 'epub') {
    return (
      <React.Suspense fallback={<WorkspaceFileLoading />}>
        <WorkingFileEpubReader
          workspaceId={workspaceId}
          sessionId={sessionId}
          sourcePath={path}
          onReference={onReference}
          navigation={navigation}
        />
      </React.Suspense>
    )
  }

  if (kind === 'external') {
    return (
      <EmptyFileState
        icon={<FileQuestion className="size-8" strokeWidth={1.35} />}
        title="Open in the default app"
        description="This file type does not have an in-app preview."
        action={
          <Button size="sm" variant="outline" className="gap-2" onClick={openExternally}>
            <ExternalLink className="size-3.5" />
            Open file
          </Button>
        }
      />
    )
  }

  if (error) {
    return (
      <EmptyFileState
        icon={<AlertCircle className="size-8" strokeWidth={1.35} />}
        title="Couldn’t open this file"
        description={error}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="gap-2" onClick={() => setReloadKey((key) => key + 1)}>
              <RotateCw className="size-3.5" />
              Try again
            </Button>
            <Button size="sm" variant="ghost" className="gap-2" onClick={openExternally}>
              <ExternalLink className="size-3.5" />
              Open externally
            </Button>
          </div>
        }
      />
    )
  }

  if ((kind === 'pdf' || kind === 'image') && !dataUrl) return <WorkspaceFileLoading />
  if ((kind === 'markdown' || kind === 'text') && content === null) return <WorkspaceFileLoading />

  if (kind === 'image') {
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-muted/15 p-6">
        <img
          src={dataUrl ?? ''}
          alt={filename}
          className="max-h-full max-w-full rounded-md object-contain shadow-minimal"
        />
      </div>
    )
  }

  if (kind === 'pdf') {
    const pdfUrl = navigation?.locator.type === 'pdf-page'
      ? `${dataUrl ?? ''}#page=${navigation.locator.page}`
      : dataUrl ?? ''
    return (
      <iframe
        title={filename}
        src={pdfUrl}
        className="h-full w-full border-0 bg-background"
      />
    )
  }

  if (kind === 'markdown' && navigation?.locator.type !== 'text-range') {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <article className="mx-auto w-full max-w-[760px] px-8 py-8 text-[15px] leading-7">
          <Markdown mode="full">{content ?? ''}</Markdown>
        </article>
      </div>
    )
  }

  return (
    <ShikiCodeViewer
      code={content ?? ''}
      filePath={path}
      language={getWorkspaceFileLanguage(path)}
      targetLine={textRange?.startLine}
      targetEndLine={textRange?.endLine}
      className="h-full"
    />
  )
}

function WorkspaceFileLoading() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
    </div>
  )
}

function EmptyFileState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground/60">
          {icon}
        </div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{description}</p>
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  )
}
