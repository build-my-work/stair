import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { AlertTriangle, Check, Eye, FileQuestion, Loader2, Pencil, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Markdown,
  ShikiCodeViewer,
  getLanguageFromPath,
} from '@craft-agent/ui'
import {
  classifyProjectFile,
  isCanonicalProjectRelativePath,
  isEditableProjectTextFile,
  MAX_EDITABLE_PROJECT_FILE_BYTES,
  type ProjectFileBinaryResponse,
  type ProjectFileTextResponse,
} from '@craft-agent/shared/project-files'
import { useAppShellContext } from '@/context/AppShellContext'
import { useTheme } from '@/context/ThemeContext'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { ShikiCodeEditor } from '@/components/shiki/ShikiCodeEditor'
import {
  registerOpenProjectFileDocument,
} from '@/components/project-files/project-file-document-registry'
import {
  ProjectTextDocumentController,
  type ProjectTextDocumentState,
} from '@/components/project-files/project-text-document-controller'
import { ProjectFileEpubReader } from '@/components/project-files/ProjectFileEpubReader'
import { ProjectFilePdfReader } from '@/components/project-files/ProjectFilePdfReader'
import { openProjectFilePreviewAtom } from '@/workbench/workbench-commands'
import { resolveProjectFileMarkdownTarget } from './project-file-markdown-links'
import { createProjectFileImageDataUrl } from './project-file-image'
import { saveTextFile } from '@/lib/save-text-file'

interface ProjectFilePageProps {
  projectId: string
  relativePath: string
  presentation: 'preview' | 'explicit'
}

const CLEAN_STATE: ProjectTextDocumentState = { status: 'clean', error: null }

function saveStatusKey(state: ProjectTextDocumentState): string | null {
  switch (state.status) {
    case 'dirty': return 'projectFileEditor.unsaved'
    case 'saving': return 'projectFileEditor.saving'
    case 'saved': return 'projectFileEditor.saved'
    case 'conflict': return 'projectFileEditor.conflictTitle'
    case 'error': return 'projectFileEditor.saveFailedTitle'
    default: return null
  }
}

export default function ProjectFilePage({
  projectId,
  relativePath,
}: ProjectFilePageProps) {
  const { t } = useTranslation()
  const { resolvedMode, shikiTheme } = useTheme()
  const { onOpenFile, onOpenUrl, rightSidebarButton } = useAppShellContext()
  const openProjectFilePreview = useSetAtom(openProjectFilePreviewAtom)
  const [response, setResponse] = useState<ProjectFileTextResponse | null>(null)
  const [binaryResponse, setBinaryResponse] = useState<ProjectFileBinaryResponse | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [documentState, setDocumentState] = useState<ProjectTextDocumentState>(CLEAN_STATE)
  const [isEditing, setIsEditing] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadRevision, setReloadRevision] = useState(0)
  const controllerRef = useRef<ProjectTextDocumentController | null>(null)
  const fileName = relativePath.split('/').at(-1) ?? relativePath
  const kind = classifyProjectFile(relativePath)
  const canRead = isCanonicalProjectRelativePath(relativePath) && kind !== 'unknown'
  const canEdit = Boolean(
    response
    && response.metadata.byteLength <= MAX_EDITABLE_PROJECT_FILE_BYTES
    && isEditableProjectTextFile(relativePath),
  )
  const imageUrl = useMemo(() => (
    kind === 'image' && binaryResponse
      ? createProjectFileImageDataUrl(
          binaryResponse.metadata.mimeType,
          binaryResponse.bytes,
        )
      : null
  ), [binaryResponse, kind])

  useEffect(() => {
    let cancelled = false
    setResponse(null)
    setBinaryResponse(null)
    setEditorContent('')
    setDocumentState(CLEAN_STATE)
    setIsEditing(false)
    setError(null)
    if (!canRead) return

    setIsLoading(true)
    const load = kind === 'epub' || kind === 'pdf' || kind === 'image'
      ? window.electronAPI.readProjectFileBinary({ projectId, relativePath })
      : window.electronAPI.readProjectTextFile({ projectId, relativePath })
    void load
      .then(result => {
        if (cancelled) return
        if ('bytes' in result) {
          setBinaryResponse(result)
        } else {
          setResponse(result)
          setEditorContent(result.text)
        }
      })
      .catch(loadError => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => { cancelled = true }
  }, [canRead, kind, projectId, relativePath, reloadRevision])

  useEffect(() => {
    if (!response || !canEdit) return
    const controller = new ProjectTextDocumentController(
      projectId,
      relativePath,
      response.text,
      response.sourceFingerprint,
      request => window.electronAPI.saveProjectTextFile(request),
      setDocumentState,
    )
    controllerRef.current = controller
    const unregister = registerOpenProjectFileDocument(projectId, relativePath, controller)

    return () => {
      if (controllerRef.current === controller) controllerRef.current = null
      void controller.flush()
        .catch(flushError => {
          window.electronAPI.debugLog(
            '[Project Files] Background flush failed while unmounting:',
            flushError instanceof Error ? flushError.message : String(flushError),
          )
        })
        .finally(() => {
          unregister()
          controller.dispose()
        })
    }
  }, [canEdit, projectId, relativePath, response])

  const handleEdit = useCallback(() => {
    if (!response || !canEdit) return
    setEditorContent(response.text)
    setDocumentState(CLEAN_STATE)
    setIsEditing(true)
  }, [canEdit, response])

  const handlePreview = useCallback(async () => {
    try {
      await controllerRef.current?.flush()
      setIsEditing(false)
      setReloadRevision(revision => revision + 1)
    } catch {
      // Keep the editor and draft visible; the status banner explains the veto.
    }
  }, [])

  const handleChange = useCallback((content: string) => {
    setEditorContent(content)
    controllerRef.current?.updateContent(content)
  }, [])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void controllerRef.current?.flush().catch(() => undefined)
    }
  }, [])

  const handleReloadAfterConflict = useCallback(() => {
    if (!window.confirm(t('projectFileEditor.reloadConflictConfirm'))) return
    controllerRef.current?.discardChanges()
    setReloadRevision(revision => revision + 1)
  }, [t])

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

  const handleMarkdownLink = useCallback((target: string) => {
    const resolved = resolveProjectFileMarkdownTarget(relativePath, target)
    if (resolved.kind === 'project-file') {
      void openProjectFilePreview({
        projectId,
        relativePath: resolved.relativePath,
      })
    } else if (resolved.kind === 'file') {
      onOpenFile(resolved.path)
    } else if (resolved.kind === 'url') {
      onOpenUrl(resolved.url)
    } else {
      onOpenUrl(resolved.target)
    }
  }, [onOpenFile, onOpenUrl, openProjectFilePreview, projectId, relativePath])

  const editButton = canEdit ? (
    <PanelHeaderCenterButton
      icon={isEditing ? <Eye className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
      tooltip={t(isEditing ? 'projectFileEditor.preview' : 'projectFileEditor.edit')}
      onClick={isEditing ? () => { void handlePreview() } : handleEdit}
    />
  ) : null

  const statusKey = saveStatusKey(documentState)
  const statusLabel = statusKey ? t(statusKey) : null
  const statusTone = documentState.status === 'conflict' || documentState.status === 'error'
    ? 'text-destructive'
    : 'text-muted-foreground'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={fileName}
        badge={(
          <span
            className="max-w-[min(34vw,360px)] truncate font-mono text-[10px] font-normal text-muted-foreground/60"
            title={relativePath}
          >
            {relativePath}
          </span>
        )}
        actions={editButton}
        rightSidebarButton={rightSidebarButton}
      />

      {statusLabel && (
        <div className={`flex h-7 shrink-0 items-center gap-1.5 border-y border-border/40 px-4 text-[11px] ${statusTone}`}>
          {documentState.status === 'saving' && <Loader2 className="h-3 w-3 animate-spin" />}
          {documentState.status === 'saved' && <Check className="h-3 w-3" />}
          {(documentState.status === 'conflict' || documentState.status === 'error') && (
            <AlertTriangle className="h-3 w-3" />
          )}
          <span>{statusLabel}</span>
          {(documentState.status === 'conflict' || documentState.status === 'error') && (
            <div className="ml-auto flex items-center gap-3">
              {documentState.status === 'error' && (
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => controllerRef.current?.retry()}
                >
                  {t('common.retry')}
                </button>
              )}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => {
                  void handleSaveDraftAs().catch(saveError => {
                    toast.error(saveError instanceof Error
                      ? saveError.message
                      : String(saveError))
                  })
                }}
              >
                {t('projectFileEditor.saveDraftAs')}
              </button>
              {documentState.status === 'conflict' && (
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={handleReloadAfterConflict}
                >
                  {t('common.reload')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <AlertTriangle className="h-7 w-7 text-destructive/70" />
            <p className="max-w-lg break-words text-sm text-destructive">{error}</p>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md bg-background px-3 py-1.5 text-xs shadow-minimal"
              onClick={() => setReloadRevision(revision => revision + 1)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('common.reload')}
            </button>
          </div>
        ) : !canRead ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-muted-foreground">
            <FileQuestion className="h-8 w-8 opacity-60" />
            <p className="text-sm">{t('filesSidebar.previewUnavailable')}</p>
          </div>
        ) : kind === 'epub' && binaryResponse ? (
          <ProjectFileEpubReader
            key={`${projectId}\0${relativePath}\0${binaryResponse.sourceFingerprint}`}
            projectId={projectId}
            relativePath={relativePath}
            metadata={binaryResponse.metadata}
            bytes={binaryResponse.bytes}
            sourceFingerprint={binaryResponse.sourceFingerprint}
          />
        ) : kind === 'pdf' && binaryResponse ? (
          <ProjectFilePdfReader
            key={`${projectId}\0${relativePath}\0${binaryResponse.sourceFingerprint}`}
            projectId={projectId}
            relativePath={relativePath}
            metadata={binaryResponse.metadata}
            bytes={binaryResponse.bytes}
            sourceFingerprint={binaryResponse.sourceFingerprint}
          />
        ) : kind === 'image' && imageUrl ? (
          <div className="flex h-full items-center justify-center overflow-auto p-6">
            <img
              src={imageUrl}
              alt={fileName}
              className="max-h-full max-w-full rounded-[6px] object-contain shadow-minimal"
            />
          </div>
        ) : isEditing ? (
          <div className="h-full" onKeyDown={handleKeyDown}>
            <ShikiCodeEditor
              value={editorContent}
              language={getLanguageFromPath(relativePath)}
              onChange={handleChange}
              className="h-full"
            />
          </div>
        ) : response && kind === 'markdown' ? (
          <div className="h-full overflow-auto px-8 py-6">
            <Markdown
              mode="full"
              onFileClick={handleMarkdownLink}
              onUrlClick={handleMarkdownLink}
            >
              {response.text}
            </Markdown>
          </div>
        ) : response ? (
          <ShikiCodeViewer
            code={response.text}
            filePath={relativePath}
            theme={resolvedMode}
            shikiTheme={shikiTheme}
            className="h-full"
          />
        ) : null}
      </div>
    </div>
  )
}
