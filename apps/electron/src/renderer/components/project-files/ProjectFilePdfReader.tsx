import * as React from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { FileQuestion, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS,
  type ProjectFileSelectionReferenceV1,
  type SourceFingerprint,
} from '@craft-agent/core'
import type { ProjectFileMetadata } from '@craft-agent/shared/protocol'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import {
  captureProjectFileDomSelection,
  ProjectFileSelectionPopover,
  type ProjectFileDomSelection,
} from './ProjectFileTextSelection'

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

function closestPageNumber(node: Node): number | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement
  const page = element?.closest<HTMLElement>('[data-pdf-page-number]')
  const value = Number(page?.dataset.pdfPageNumber)
  return Number.isSafeInteger(value) && value >= 1 ? value : null
}

export function ProjectFilePdfReader({
  projectId,
  relativePath,
  metadata,
  bytes,
  sourceFingerprint,
  onAddNote,
}: {
  projectId: string
  relativePath: string
  metadata: ProjectFileMetadata
  bytes: Uint8Array
  sourceFingerprint: SourceFingerprint
  onAddNote: (
    reference: ProjectFileSelectionReferenceV1,
    mode?: 'current' | 'choose-target',
  ) => boolean | Promise<boolean>
}) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [numPages, setNumPages] = React.useState(0)
  const [width, setWidth] = React.useState(760)
  const [error, setError] = React.useState<string>()
  const [selection, setSelection] = React.useState<{
    dom: ProjectFileDomSelection
    startPage: number
    endPage: number
  } | null>(null)
  const [adding, setAdding] = React.useState(false)

  // pdf.js may transfer/detach its input buffer, so keep the Project File
  // response immutable and hand the renderer its own copy.
  const file = React.useMemo(() => ({ data: bytes.slice() }), [bytes])

  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width
      if (!nextWidth) return
      setWidth(Math.max(280, Math.min(900, nextWidth - 32)))
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  const dismiss = React.useCallback(() => setSelection(null), [])

  const handleMouseUp = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (!root) return
    requestAnimationFrame(() => {
      const domSelection = window.getSelection()
      const captured = captureProjectFileDomSelection(
        root,
        domSelection,
        { x: event.clientX, y: event.clientY },
      )
      if (!captured || !domSelection || domSelection.rangeCount === 0) {
        setSelection(null)
        return
      }
      if (captured.quote.length > MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS) {
        toast.error('Add Note selections are limited to 4,000 characters.')
        setSelection(null)
        return
      }
      const range = domSelection.getRangeAt(0)
      const firstPage = closestPageNumber(range.startContainer)
      const lastPage = closestPageNumber(range.endContainer)
      if (!firstPage || !lastPage) {
        setSelection(null)
        return
      }
      setSelection({
        dom: captured,
        startPage: Math.min(firstPage, lastPage),
        endPage: Math.max(firstPage, lastPage),
      })
    })
  }, [])

  const addNote = React.useCallback(async (
    mode: 'current' | 'choose-target' = 'current',
  ) => {
    if (!selection || adding) return
    const reference: ProjectFileSelectionReferenceV1 = {
      version: 1,
      kind: 'project-file',
      projectId,
      relativePath,
      sourceFingerprint,
      fileName: metadata.name,
      quote: selection.dom.quote,
      contextBefore: selection.dom.prefix,
      contextAfter: selection.dom.suffix,
      locator: {
        type: 'pdf-text-quote',
        exact: selection.dom.quote,
        ...(selection.dom.prefix ? { prefix: selection.dom.prefix } : {}),
        ...(selection.dom.suffix ? { suffix: selection.dom.suffix } : {}),
        startPage: selection.startPage,
        endPage: selection.endPage,
      },
    }

    setAdding(true)
    try {
      const added = await onAddNote(reference, mode)
      if (added) {
        window.getSelection()?.removeAllRanges()
        dismiss()
      }
    } catch (addError) {
      console.error('[ProjectFilePdfReader] Failed to add note:', addError)
    } finally {
      setAdding(false)
    }
  }, [
    adding,
    dismiss,
    metadata.name,
    onAddNote,
    projectId,
    relativePath,
    selection,
    sourceFingerprint,
  ])

  return (
    <div
      ref={rootRef}
      onMouseUp={handleMouseUp}
      onScroll={dismiss}
      className="relative h-full overflow-auto bg-foreground/[0.025] py-4"
    >
      {error ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
          <FileQuestion className="h-7 w-7 text-destructive/55" />
          <p className="text-sm font-medium text-destructive">PDF could not be rendered</p>
          <p className="max-w-lg text-xs text-muted-foreground">{error}</p>
        </div>
      ) : (
        <Document
          file={file}
          onLoadSuccess={({ numPages: count }) => setNumPages(count)}
          onLoadError={loadError => setError(loadError.message)}
          loading={(
            <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Rendering PDF…
            </div>
          )}
          className="flex flex-col items-center gap-4"
        >
          {Array.from({ length: numPages }, (_, index) => {
            const pageNumber = index + 1
            return (
              <div
                key={pageNumber}
                data-pdf-page-number={pageNumber}
                className="overflow-hidden rounded-[4px] bg-white shadow-minimal"
              >
                <Page
                  pageNumber={pageNumber}
                  width={width}
                  renderTextLayer
                  renderAnnotationLayer
                />
              </div>
            )
          })}
        </Document>
      )}

      {selection && (
        <ProjectFileSelectionPopover
          selection={selection.dom}
          collisionBoundary={rootRef.current}
          adding={adding}
          onAddNote={() => void addNote()}
          onAddNoteTo={() => void addNote('choose-target')}
          onDismiss={dismiss}
        />
      )}
    </div>
  )
}
