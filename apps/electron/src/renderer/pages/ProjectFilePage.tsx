import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  Eye,
  FileQuestion,
  FileWarning,
  Loader2,
  Pencil,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Markdown,
  MAX_EDITABLE_PROJECT_FILE_BYTES,
  ShikiCodeViewer,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  classifyFile,
  getLanguageFromPath,
  isEditableProjectTextFile,
} from '@craft-agent/ui'
import { Panel } from '@/components/app-shell/Panel'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { useAppShellContext } from '@/context/AppShellContext'
import { useTheme } from '@/context/ThemeContext'
import { projectsAtom } from '@/atoms/projects'
import type {
  ProjectFileMetadata,
  ProjectFileRequest,
} from '@craft-agent/shared/protocol'
import {
  isCanonicalProjectRelativePath,
  type MessageReference,
  type ProjectFileReferenceV1,
  type ProjectFileSelectionReferenceV1,
  type SourceFingerprint,
} from '@craft-agent/core'
import { ProjectFileEpubReader } from '@/components/project-files/ProjectFileEpubReader'
import { ProjectFileTextSelectionSurface } from '@/components/project-files/ProjectFileTextSelection'
import { ProjectFilePdfReader } from '@/components/project-files/ProjectFilePdfReader'
import { ProjectFileDrawnixCanvas } from '@/components/project-files/ProjectFileDrawnixCanvas'
import { ShikiCodeEditor } from '@/components/shiki/ShikiCodeEditor'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import {
  registerOpenProjectFileDocument,
} from '@/components/project-files/project-file-document-registry'
import {
  ProjectTextDocumentController,
  type ProjectTextDocumentState,
} from '@/components/project-files/project-text-document-controller'
import {
  consumeProjectFileOpenIntentAtom,
  panelStackAtom,
  projectFileOpenIntentsAtom,
  pushPanelAtom,
  setCompanionChatTargetAtom,
} from '@/atoms/panel-stack'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import {
  getProjectFileChatTargetSessionId,
  listProjectReferenceTargets,
  resolveProjectFileOpenIntent,
} from '@/lib/project-file-reference-target'
import { saveTextFile } from '@/lib/save-text-file'
import { routes } from '../../shared/routes'
import type { ProjectFileRoute } from '@/lib/project-file-route'
import { focusExistingProjectSessionPanel } from '@/components/app-shell/project-session-panel-navigation'
import { getSessionTitle } from '@/utils/session'

interface ProjectFilePageProps {
  route: ProjectFileRoute
  panelId: string
}

const CLEAN_TEXT_DOCUMENT_STATE: ProjectTextDocumentState = {
  status: 'clean',
  error: null,
}

export type ProjectFileKind =
  | 'drawnix'
  | 'epub'
  | 'pdf'
  | 'image'
  | 'markdown'
  | 'code'
  | 'json'
  | 'text'
  | 'unknown'

export function getProjectFileKind(relativePath: string): ProjectFileKind {
  if (relativePath.toLowerCase().endsWith('.drawnix')) return 'drawnix'
  if (relativePath.toLowerCase().endsWith('.epub')) return 'epub'
  return classifyFile(relativePath).type ?? 'unknown'
}

type ProjectFilePreviewApi = Pick<
  Window['electronAPI'],
  'readProjectFileBinary' | 'readProjectFileText'
>

export async function loadProjectFilePreview(
  request: ProjectFileRequest,
  kind: ProjectFileKind,
  canPreview: boolean,
  api: ProjectFilePreviewApi = window.electronAPI,
) {
  if (kind === 'image' || kind === 'pdf' || kind === 'epub') {
    return {
      type: 'binary' as const,
      response: await api.readProjectFileBinary(request),
    }
  }
  if (!canPreview) {
    return { type: 'unsupported' as const }
  }
  return {
    type: 'text' as const,
    response: await api.readProjectFileText(request),
  }
}

export default function ProjectFilePage({
  route,
  panelId,
}: ProjectFilePageProps) {
  const { t } = useTranslation()
  const {
    activeWorkspaceId,
    onAddDraftReference,
    onAddSelectionNote,
    onCreateSession,
    rightSidebarButton,
  } = useAppShellContext()
  const { resolvedMode, shikiTheme } = useTheme()
  const projects = useAtomValue(projectsAtom)
  const panelStack = useAtomValue(panelStackAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const openIntent = useAtomValue(projectFileOpenIntentsAtom).get(panelId)
  const consumeOpenIntent = useSetAtom(consumeProjectFileOpenIntentAtom)
  const setChatTarget = useSetAtom(setCompanionChatTargetAtom)
  const store = useStore()
  const project = useMemo(
    () => projects.find(candidate => candidate.config.id === route.projectId),
    [projects, route.projectId],
  )
  const relativePath = route.relativePath
  const safePath = isCanonicalProjectRelativePath(relativePath)
  const kind = getProjectFileKind(relativePath)
  const classification = classifyFile(relativePath)
  const [content, setContent] = useState<string | null>(null)
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [metadata, setMetadata] = useState<ProjectFileMetadata | null>(null)
  const [sourceFingerprint, setSourceFingerprint] = useState<SourceFingerprint | null>(null)
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [isEditing, setIsEditing] = useState(false)
  const [editorContent, setEditorContent] = useState('')
  const [textDocumentState, setTextDocumentState] =
    useState<ProjectTextDocumentState>(CLEAN_TEXT_DOCUMENT_STATE)
  const [showSavedStatus, setShowSavedStatus] = useState(false)
  const textDocumentControllerRef = useRef<ProjectTextDocumentController | null>(null)
  const [initialLocator, setInitialLocator] =
    useState<ProjectFileReferenceV1['locator']>()
  const [staleReference, setStaleReference] = useState(false)
  const fileName = relativePath.split(/[\\/]/).pop() || t('filesSidebar.previewTitle')
  const fileIdentity = `${route.projectId}\0${relativePath}`
  const canEditText = content !== null
    && metadata !== null
    && sourceFingerprint !== null
    && metadata.projectId === route.projectId
    && metadata.relativePath === relativePath
    && metadata.byteLength <= MAX_EDITABLE_PROJECT_FILE_BYTES
    && isEditableProjectTextFile(relativePath)
  const referenceTargets = useMemo(
    () => listProjectReferenceTargets(sessionMetaMap, route.projectId),
    [route.projectId, sessionMetaMap],
  )
  const chatTargetSessionId = useMemo(
    () => getProjectFileChatTargetSessionId(
      panelStack,
      panelId,
      sessionMetaMap,
      route.projectId,
    ),
    [panelId, panelStack, route.projectId, sessionMetaMap],
  )
  const chatTargets = useMemo(
    () => referenceTargets.map(session => ({
      id: session.id,
      title: getSessionTitle(session),
    })),
    [referenceTargets],
  )

  useEffect(() => {
    setIsEditing(false)
    setEditorContent('')
    setTextDocumentState(CLEAN_TEXT_DOCUMENT_STATE)
  }, [fileIdentity])

  useEffect(() => {
    if (textDocumentState.status !== 'saved') {
      setShowSavedStatus(false)
      return
    }
    setShowSavedStatus(true)
    const timer = setTimeout(() => setShowSavedStatus(false), 1_500)
    return () => clearTimeout(timer)
  }, [textDocumentState.status])

  useEffect(() => {
    if (
      !isEditing
      || !canEditText
      || content === null
      || !sourceFingerprint
    ) {
      return
    }

    setEditorContent(content)
    setTextDocumentState(CLEAN_TEXT_DOCUMENT_STATE)
    const controller = new ProjectTextDocumentController(
      route.projectId,
      relativePath,
      content,
      sourceFingerprint,
      request => window.electronAPI.saveProjectTextFile(request),
      setTextDocumentState,
      () => setReloadToken(token => token + 1),
    )
    textDocumentControllerRef.current = controller
    const unregister = registerOpenProjectFileDocument(
      route.projectId,
      relativePath,
      controller,
    )

    return () => {
      unregister()
      if (textDocumentControllerRef.current === controller) {
        textDocumentControllerRef.current = null
      }
      controller.dispose()
      void controller.flush().catch(flushError => {
        window.electronAPI.debugLog(
          '[Project Files] Failed to flush text while closing:',
          flushError instanceof Error ? flushError.message : String(flushError),
        )
      })
    }
  }, [
    canEditText,
    content,
    isEditing,
    relativePath,
    route.projectId,
    sourceFingerprint,
  ])

  const selectChatTarget = useCallback((sessionId: string) => {
    setChatTarget({ panelId, sessionId })
  }, [panelId, setChatTarget])

  const handleStartEditing = useCallback(() => {
    if (!canEditText || content === null) return
    setEditorContent(content)
    setTextDocumentState(CLEAN_TEXT_DOCUMENT_STATE)
    setIsEditing(true)
  }, [canEditText, content])

  const handleEditorContentChange = useCallback((nextContent: string) => {
    setEditorContent(nextContent)
    textDocumentControllerRef.current?.updateContent(nextContent)
  }, [])

  const handleShowPreview = useCallback(async () => {
    try {
      await textDocumentControllerRef.current?.flush()
      setIsEditing(false)
      setReloadToken(token => token + 1)
    } catch {
      // The editor keeps the draft visible and shows the detailed save error.
    }
  }, [])

  const handleEditorKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (
      (event.metaKey || event.ctrlKey)
      && event.key.toLowerCase() === 's'
    ) {
      event.preventDefault()
      void textDocumentControllerRef.current?.flush().catch(() => undefined)
    }
  }, [])

  const handleSaveDraftAs = useCallback(async () => {
    const extensionIndex = fileName.lastIndexOf('.')
    const suggestedName = extensionIndex > 0
      ? `${fileName.slice(0, extensionIndex)}.draft${fileName.slice(extensionIndex)}`
      : `${fileName}.draft.txt`
    const result = await saveTextFile({
      suggestedName,
      content: editorContent,
    })
    if (result.saved) toast.success(t('projectFileEditor.draftSaved'))
  }, [editorContent, fileName, t])

  const handleReloadTextFromDisk = useCallback(() => {
    setIsEditing(false)
    setReloadToken(token => token + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    let nextBinaryUrl: string | null = null

    setContent(null)
    setBytes(null)
    setMetadata(null)
    setSourceFingerprint(null)
    setBinaryUrl(null)
    setError(null)
    setIsLoading(false)
    setInitialLocator(undefined)
    setStaleReference(false)

    if (!safePath) {
      setError(t('filesSidebar.invalidPath'))
      return
    }

    setIsLoading(true)
    const load = async () => {
      try {
        const request = {
          projectId: route.projectId,
          relativePath,
        }
        const result = await loadProjectFilePreview(
          request,
          kind,
          kind === 'drawnix'
            || (classification.canPreview && !!classification.type),
        )
        if (result.type === 'binary') {
          const response = result.response
          if (cancelled) return
          setMetadata(response.metadata)
          setBytes(response.bytes)
          setSourceFingerprint(response.sourceFingerprint)

          if (kind !== 'image') return
          const data = response.bytes
          const buffer = data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
          ) as ArrayBuffer
          nextBinaryUrl = URL.createObjectURL(new Blob(
            [buffer],
            { type: response.metadata.mimeType },
          ))
          if (cancelled) {
            URL.revokeObjectURL(nextBinaryUrl)
            nextBinaryUrl = null
          } else {
            setBinaryUrl(nextBinaryUrl)
          }
          return
        }
        if (result.type === 'unsupported') return
        const response = result.response
        if (!cancelled) {
          setMetadata(response.metadata)
          setContent(response.text)
          setSourceFingerprint(response.sourceFingerprint)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : t('fileViewer.errorLoading'))
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
      if (nextBinaryUrl) URL.revokeObjectURL(nextBinaryUrl)
    }
  }, [
    classification.canPreview,
    classification.type,
    kind,
    relativePath,
    reloadToken,
    route.projectId,
    safePath,
    t,
  ])

  useEffect(() => {
    if (!openIntent) {
      setInitialLocator(undefined)
      return
    }
    if (!sourceFingerprint || kind !== 'epub') return
    const resolution = resolveProjectFileOpenIntent(
      openIntent,
      sourceFingerprint,
    )
    if (resolution.stale) {
      setInitialLocator(undefined)
      setStaleReference(true)
      consumeOpenIntent(panelId)
      return
    }
    setStaleReference(false)
    setInitialLocator(resolution.locator)
  }, [
    consumeOpenIntent,
    kind,
    openIntent,
    panelId,
    sourceFingerprint,
  ])

  const focusSession = useCallback((sessionId: string) => {
    const projectSlug = project?.config.slug
    if (!projectSlug) return
    if (focusExistingProjectSessionPanel(store, projectSlug, sessionId)) return

    const filePanelIndex = panelStack.findIndex(entry => entry.id === panelId)
    store.set(pushPanelAtom, {
      route: routes.view.projectSession(projectSlug, sessionId),
      afterIndex: filePanelIndex >= 0 ? filePanelIndex : undefined,
    })
  }, [panelId, panelStack, project?.config.slug, store])

  const attachReferenceToSession = useCallback((
    sessionId: string,
    reference: MessageReference,
  ) => {
    if (!onAddDraftReference(sessionId, reference)) return false
    toast.success('EPUB selection added to the chat draft')
    focusSession(sessionId)
    return true
  }, [focusSession, onAddDraftReference])

  const createSessionWithReference = useCallback(async (
    reference: MessageReference,
  ) => {
    if (!activeWorkspaceId) return null
    const session = await onCreateSession(activeWorkspaceId, {
      projectId: route.projectId,
    })
    return attachReferenceToSession(session.id, reference)
      ? session.id
      : null
  }, [
    activeWorkspaceId,
    attachReferenceToSession,
    onCreateSession,
    route.projectId,
  ])

  const createAndSelectSessionWithReference = useCallback(async (
    reference: MessageReference,
  ) => {
    const sessionId = await createSessionWithReference(reference)
    if (!sessionId) {
      throw new Error('The new chat could not accept this reference.')
    }
    selectChatTarget(sessionId)
    return true
  }, [createSessionWithReference, selectChatTarget])

  const handleAddChatReference = useCallback(async (
    reference: MessageReference,
  ) => {
    if (chatTargetSessionId) {
      if (!attachReferenceToSession(chatTargetSessionId, reference)) {
        throw new Error('The target chat draft is currently locked.')
      }
      return true
    }
    return createAndSelectSessionWithReference(reference)
  }, [
    attachReferenceToSession,
    chatTargetSessionId,
    createAndSelectSessionWithReference,
  ])

  const handleAddNoteReference = useCallback(async (
    reference: ProjectFileSelectionReferenceV1,
    mode: 'current' | 'choose-target' = 'current',
  ) => {
    if (!chatTargetSessionId) {
      toast.error('Choose a target Session before using Add Note.')
      return false
    }
    if (!onAddSelectionNote) {
      toast.error('Add Note is unavailable.')
      return false
    }
    return onAddSelectionNote(chatTargetSessionId, reference, mode)
  }, [
    chatTargetSessionId,
    onAddSelectionNote,
  ])

  const selectionSource = metadata && sourceFingerprint
    ? {
        projectId: route.projectId,
        relativePath,
        metadata,
        sourceFingerprint,
        onAddNote: handleAddNoteReference,
      }
    : null

  const preview = (() => {
    if (isLoading) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
          <Spinner />
          <span className="text-sm">{t('fileViewer.loadingContent')}</span>
        </div>
      )
    }
    if (error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
          <FileQuestion className="h-8 w-8 text-destructive/55" />
          <p className="text-sm font-medium text-destructive">{t('fileViewer.errorLoading')}</p>
          <p className="max-w-xl text-xs text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={() => setReloadToken(token => token + 1)}
            className="rounded-[7px] bg-background px-3 py-1.5 text-xs shadow-minimal hover:bg-foreground/[0.04]"
          >
            {t('common.retry')}
          </button>
        </div>
      )
    }
    if (isEditing && canEditText) {
      let editorLanguage = 'text'
      if (classification.type === 'markdown') {
        editorLanguage = 'markdown'
      } else if (classification.type === 'json') {
        editorLanguage = 'json'
      } else if (classification.type === 'code') {
        editorLanguage = getLanguageFromPath(relativePath)
      }
      const saveError = textDocumentState.error
      const isConflict = textDocumentState.status === 'conflict'

      return (
        <div
          className="flex h-full min-h-0 flex-col bg-background"
          onKeyDownCapture={handleEditorKeyDown}
        >
          {saveError && (
            <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs">
              {isConflict
                ? <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">
                  {t(isConflict
                    ? 'projectFileEditor.conflictTitle'
                    : 'projectFileEditor.saveFailedTitle')}
                </p>
                <p className="mt-0.5 break-words text-muted-foreground">
                  {saveError.message.replace(/^PROJECT_FILE_[A-Z_]+:\s*/, '')}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {!isConflict && (
                    <button
                      type="button"
                      className="rounded-md bg-background px-2.5 py-1 shadow-minimal hover:bg-foreground/[0.04]"
                      onClick={() => textDocumentControllerRef.current?.retry()}
                    >
                      {t('common.retry')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded-md bg-background px-2.5 py-1 shadow-minimal hover:bg-foreground/[0.04]"
                    onClick={() => {
                      void handleSaveDraftAs().catch(saveDraftError => {
                        toast.error(saveDraftError instanceof Error
                          ? saveDraftError.message
                          : String(saveDraftError))
                      })
                    }}
                  >
                    {t('projectFileEditor.saveDraftAs')}
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-background px-2.5 py-1 shadow-minimal hover:bg-foreground/[0.04]"
                    onClick={handleReloadTextFromDisk}
                  >
                    {t('projectFileEditor.reloadDisk')}
                  </button>
                </div>
              </div>
            </div>
          )}
          <ShikiCodeEditor
            value={editorContent}
            language={editorLanguage}
            onChange={handleEditorContentChange}
            className="min-h-0 flex-1"
            textareaId={`project-file-editor-${panelId}`}
            ariaLabel={t('projectFileEditor.editorLabel', { fileName })}
          />
        </div>
      )
    }
    if (
      kind === 'epub'
      && bytes
      && metadata
      && sourceFingerprint
    ) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          {staleReference && (
            <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              This reference belongs to an older version of the EPUB. The current
              file is open without jumping to the saved location.
            </div>
          )}
          <div className="min-h-0 flex-1">
            <ProjectFileEpubReader
              key={`${fileIdentity}\0${sourceFingerprint}`}
              identity={{
                projectId: route.projectId,
                relativePath,
              }}
              metadata={metadata}
              bytes={bytes}
              sourceFingerprint={sourceFingerprint}
              initialLocator={initialLocator}
              chatTargetSessionId={chatTargetSessionId}
              chatTargets={chatTargets}
              onChatTargetChange={selectChatTarget}
              onAddChatReference={handleAddChatReference}
              onAddNewChatReference={createAndSelectSessionWithReference}
              onAddNoteReference={handleAddNoteReference}
              onExportMarkdown={async ({ suggestedFilename, content }) => {
                await saveTextFile({
                  suggestedName: suggestedFilename,
                  content,
                })
              }}
              onReady={() => {
                if (openIntent?.expectedFingerprint === sourceFingerprint) {
                  consumeOpenIntent(panelId)
                }
              }}
            />
          </div>
        </div>
      )
    }
    if (
      kind === 'drawnix'
      && content !== null
      && sourceFingerprint
    ) {
      return (
        <ProjectFileDrawnixCanvas
          key={`${fileIdentity}\0${sourceFingerprint}`}
          projectId={route.projectId}
          relativePath={relativePath}
          content={content}
          sourceFingerprint={sourceFingerprint}
          onReload={() => setReloadToken(token => token + 1)}
        />
      )
    }
    if (!classification.canPreview || !classification.type) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
          <FileQuestion className="h-8 w-8 text-muted-foreground/45" />
          <p className="text-sm font-medium">{t('filesSidebar.previewUnavailable')}</p>
        </div>
      )
    }
    if (classification.type === 'image' && binaryUrl) {
      return (
        <div className="flex h-full items-center justify-center overflow-auto p-6">
          <img src={binaryUrl} alt={fileName} className="max-h-full max-w-full rounded-[6px] object-contain shadow-minimal" />
        </div>
      )
    }
    if (
      classification.type === 'pdf'
      && bytes
      && selectionSource
    ) {
      return (
        <ProjectFilePdfReader
          key={`${fileIdentity}\0${sourceFingerprint}`}
          {...selectionSource}
          bytes={bytes}
        />
      )
    }
    if (
      classification.type === 'markdown'
      && selectionSource
    ) {
      return (
        <ProjectFileTextSelectionSurface
          key={`${fileIdentity}\0${sourceFingerprint}`}
          {...selectionSource}
          className="h-full overflow-y-auto px-8 py-8"
        >
          <div className="mx-auto max-w-[900px] rounded-[12px] bg-background px-8 py-7 shadow-minimal">
            <Markdown mode="minimal">{content ?? ''}</Markdown>
          </div>
        </ProjectFileTextSelectionSurface>
      )
    }
    if (!selectionSource) return null
    return (
      <ProjectFileTextSelectionSurface
        key={`${fileIdentity}\0${sourceFingerprint}`}
        {...selectionSource}
        className="h-full overflow-auto bg-background"
      >
        <ShikiCodeViewer
          code={content ?? ''}
          filePath={relativePath}
          language={classification.type === 'json' ? 'json' : undefined}
          showLineNumbers={false}
          theme={resolvedMode}
          shikiTheme={shikiTheme}
          className="min-h-full"
        />
      </ProjectFileTextSelectionSurface>
    )
  })()

  let headerActions: ReactNode = null
  if (canEditText && !isEditing) {
    headerActions = (
      <HeaderIconButton
        icon={<Pencil className="h-3.5 w-3.5" />}
        tooltip={t('projectFileEditor.edit')}
        aria-label={t('projectFileEditor.edit')}
        onClick={handleStartEditing}
      />
    )
  } else if (canEditText) {
    let statusLabel = t('projectFileEditor.editing')
    let statusIcon = <Pencil className="h-3.5 w-3.5" />
    let statusClassName = 'text-muted-foreground'

    switch (textDocumentState.status) {
      case 'dirty':
        statusLabel = t('projectFileEditor.unsaved')
        break
      case 'saving':
        statusLabel = t('projectFileEditor.saving')
        statusIcon = <Loader2 className="h-3.5 w-3.5 animate-spin" />
        break
      case 'saved':
        if (showSavedStatus) {
          statusLabel = t('projectFileEditor.saved')
          statusIcon = <Check className="h-3.5 w-3.5" />
          statusClassName = 'text-emerald-600 dark:text-emerald-400'
        }
        break
      case 'error':
        statusLabel = t('projectFileEditor.saveFailed')
        statusIcon = <AlertTriangle className="h-3.5 w-3.5" />
        statusClassName = 'text-amber-600 dark:text-amber-400'
        break
      case 'conflict':
        statusLabel = t('projectFileEditor.conflict')
        statusIcon = <FileWarning className="h-3.5 w-3.5" />
        statusClassName = 'text-amber-600 dark:text-amber-400'
        break
    }

    headerActions = (
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="status"
              aria-label={statusLabel}
              className={`inline-flex h-7 w-7 items-center justify-center ${statusClassName}`}
            >
              {statusIcon}
            </span>
          </TooltipTrigger>
          <TooltipContent>{statusLabel}</TooltipContent>
        </Tooltip>
        <HeaderIconButton
          icon={<Eye className="h-3.5 w-3.5" />}
          tooltip={t('projectFileEditor.preview')}
          aria-label={t('projectFileEditor.preview')}
          onClick={() => void handleShowPreview()}
        />
      </div>
    )
  }

  return (
    <Panel
      variant="grow"
      className="bg-foreground-3"
      data-content-panel-id={panelId}
    >
      <PanelHeader
        title={fileName}
        badge={(
          <span className="max-w-[min(34vw,360px)] truncate font-mono text-[10px] font-normal text-muted-foreground/60">
            {relativePath}
          </span>
        )}
        actions={headerActions}
        rightSidebarButton={rightSidebarButton}
      />
      <div key={fileIdentity} className="min-h-0 flex-1">{preview}</div>
    </Panel>
  )
}
