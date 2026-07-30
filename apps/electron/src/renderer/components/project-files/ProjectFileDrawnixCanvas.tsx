import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Drawnix } from '@drawnix/drawnix'
import type { PlaitBoard } from '@plait/core'
import type { SourceFingerprint } from '@craft-agent/core'
import './drawnix-project-file.css'
import {
  DrawnixDocumentController,
  parseNativeDrawnixDocument,
  type DrawnixDocumentState,
} from './drawnix-document-controller'
import { registerOpenDrawnixBoard } from './drawnix-board-registry'

interface ProjectFileDrawnixCanvasProps {
  projectId: string
  relativePath: string
  content: string
  sourceFingerprint: SourceFingerprint
  onReload: () => void
}

const IDLE_STATE: DrawnixDocumentState = {
  saving: false,
  error: null,
}

export function ProjectFileDrawnixCanvas({
  projectId,
  relativePath,
  content,
  sourceFingerprint,
  onReload,
}: ProjectFileDrawnixCanvasProps) {
  const { t } = useTranslation()
  const documentResult = useMemo(() => {
    try {
      return {
        document: parseNativeDrawnixDocument(content),
        error: null,
      }
    } catch (error) {
      return {
        document: null,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }, [content])
  const document = documentResult.document
  const [board, setBoard] = useState<PlaitBoard | null>(null)
  const [documentState, setDocumentState] =
    useState<DrawnixDocumentState>(IDLE_STATE)
  const controllerRef = useRef<DrawnixDocumentController | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)

  const initializeBoard = useCallback((initializedBoard: PlaitBoard) => {
    const globalKeyDown = initializedBoard.globalKeyDown
    const keyDown = initializedBoard.keyDown
    const keyUp = initializedBoard.keyUp
    const isFromThisCanvas = (event: globalThis.KeyboardEvent) => (
      event.target instanceof Node
      && hostRef.current?.contains(event.target)
    )

    initializedBoard.globalKeyDown = event => {
      if (isFromThisCanvas(event)) globalKeyDown(event)
    }
    initializedBoard.keyDown = event => {
      if (isFromThisCanvas(event)) keyDown(event)
    }
    initializedBoard.keyUp = event => {
      if (isFromThisCanvas(event)) keyUp(event)
    }
    setBoard(initializedBoard)
  }, [])

  useEffect(() => {
    if (!board || !document) return
    const controller = new DrawnixDocumentController(
      board,
      projectId,
      relativePath,
      sourceFingerprint,
      request => window.electronAPI.saveDrawnixProjectFile(request),
      setDocumentState,
    )

    let unregister: (() => void) | undefined
    try {
      unregister = registerOpenDrawnixBoard(
        projectId,
        relativePath,
        controller,
      )
      controllerRef.current = controller
    } catch (error) {
      setDocumentState({
        saving: false,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }

    return () => {
      unregister?.()
      if (controllerRef.current === controller) controllerRef.current = null
      void controller.flush().catch(error => {
        window.electronAPI.debugLog(
          '[Drawnix] Failed to flush while closing:',
          error instanceof Error ? error.message : String(error),
        )
      })
    }
  }, [board, document, projectId, relativePath, sourceFingerprint])

  const notifyBoardChanged = useCallback(() => {
    controllerRef.current?.notifyBoardChanged()
  }, [])

  const blockNativeFileShortcut = useCallback((
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    if (
      (event.metaKey || event.ctrlKey)
      && event.key.toLowerCase() === 's'
    ) {
      event.preventDefault()
      event.stopPropagation()
      void controllerRef.current?.flush()
    }
  }, [])

  const focusCanvas = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.focus({ preventScroll: true })
  }, [])

  if (documentResult.error || !document) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive/55" />
        <p className="text-sm font-medium text-destructive">
          This is not a valid Drawnix Project File.
        </p>
        <p className="max-w-xl text-xs text-muted-foreground">
          {documentResult.error?.message}
        </p>
        <button
          type="button"
          onClick={onReload}
          className="rounded-[7px] bg-background px-3 py-1.5 text-xs shadow-minimal hover:bg-foreground/[0.04]"
        >
          {t('common.reload')}
        </button>
      </div>
    )
  }

  return (
    <div
      ref={hostRef}
      tabIndex={-1}
      className="stair-drawnix-host relative h-full min-h-0 overflow-hidden bg-background outline-none"
      onKeyDownCapture={blockNativeFileShortcut}
      onPointerDownCapture={focusCanvas}
    >
      <Drawnix
        value={document.elements}
        viewport={document.viewport}
        theme={document.theme}
        afterInit={initializeBoard}
        onValueChange={notifyBoardChanged}
        onViewportChange={notifyBoardChanged}
        onThemeChange={notifyBoardChanged}
      />

      {documentState.saving && !documentState.error && (
        <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-minimal backdrop-blur">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('common.saving')}
        </div>
      )}

      {documentState.error && (
        <div className="absolute inset-x-3 top-3 z-50 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-background/95 p-3 text-xs shadow-strong backdrop-blur">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">
              Drawnix could not save this Project File.
            </p>
            <p className="mt-1 break-words text-muted-foreground">
              {documentState.error.message}
            </p>
          </div>
          <button
            type="button"
            onClick={onReload}
            className="shrink-0 rounded-md bg-foreground/[0.06] px-2 py-1 font-medium hover:bg-foreground/[0.1]"
          >
            {t('common.reload')}
          </button>
        </div>
      )}
    </div>
  )
}
