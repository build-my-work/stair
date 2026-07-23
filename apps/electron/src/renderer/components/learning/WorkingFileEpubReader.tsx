import * as React from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'

import type { WorkingDirectoryTextbookResult } from '@craft-agent/shared/protocol'
import type { FileReference } from '@craft-agent/core/types'
import type { RightWorkspaceFileNavigation } from '@/atoms/right-workspace'

import { EpubReader } from './EpubReader'

export interface WorkingFileEpubReaderProps {
  workspaceId: string
  sessionId: string
  sourcePath: string
  onReference?: (reference: FileReference, target: 'main' | 'sideChat') => void
  navigation?: RightWorkspaceFileNavigation
}

export function WorkingFileEpubReader({
  workspaceId,
  sessionId,
  sourcePath,
  onReference,
  navigation,
}: WorkingFileEpubReaderProps) {
  const [result, setResult] = React.useState<WorkingDirectoryTextbookResult | null>(null)
  const [selectedChapterId, setSelectedChapterId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let disposed = false
    setResult(null)
    setError(null)
    setSelectedChapterId(null)

    void window.electronAPI.parseWorkingDirectoryTextbook(sessionId, sourcePath)
      .then((parsed) => {
        if (disposed) return
        if (parsed.textbook.format !== 'epub') throw new Error('The selected file is not an EPUB')
        setResult(parsed)
        setSelectedChapterId(parsed.textbook.chapters[0]?.id ?? null)
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
      })

    return () => {
      disposed = true
    }
  }, [sessionId, sourcePath])

  const workingFile = React.useMemo(() => {
    if (!result) return null
    return {
      sessionId,
      sourcePath: result.sourcePath,
      projectId: result.projectId,
    }
  }, [result, sessionId])

  if (error) {
    return (
      <div className="flex h-full min-h-80 items-center justify-center px-6 text-center">
        <div className="max-w-sm space-y-2">
          <AlertCircle className="mx-auto size-7 text-destructive" />
          <p className="text-sm font-medium">Couldn’t open this EPUB</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    )
  }

  if (!result || !workingFile) {
    return (
      <div className="flex h-full min-h-80 items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  const navigationTarget = navigation?.locator.type === 'epub-cfi'
    ? { cfiRange: navigation.locator.cfiRange, nonce: navigation.nonce }
    : undefined

  return (
    <EpubReader
      workingFile={workingFile}
      sourceKey={`${workspaceId}:${result.projectId}:${result.sourcePath}`}
      textbook={result.textbook}
      selectedChapterId={selectedChapterId}
      compactLayout
      onChapterChange={setSelectedChapterId}
      onReference={onReference}
      navigationTarget={navigationTarget}
    />
  )
}
