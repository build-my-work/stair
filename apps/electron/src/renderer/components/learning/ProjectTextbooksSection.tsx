import * as React from 'react'
import { BookOpen, FileText, Loader2, Play, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import type { ImportedTextbook } from '@craft-agent/shared/learning'
import type { LoadedProject, ProjectAsset } from '@craft-agent/shared/projects/types'

import { useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Info_Section } from '@/components/info'

import { EpubReader } from './EpubReader'
import { buildLessonKickoff } from './lesson-kickoff'

const MAX_TEXTBOOK_BYTES = 25 * 1024 * 1024
const MAX_CHAPTER_CHARS = 200_000
const SUPPORTED_TEXTBOOK = /\.(?:md|markdown|epub)$/i

interface ProjectTextbooksSectionProps {
  workspaceId: string
  project: LoadedProject
  assets: ProjectAsset[]
  refreshAssets: () => Promise<void>
}

export function ProjectTextbooksSection({
  workspaceId,
  project,
  assets,
  refreshAssets,
}: ProjectTextbooksSectionProps) {
  const { t, i18n } = useTranslation()
  const { onCreateSession } = useAppShellContext()
  const [textbook, setTextbook] = React.useState<ImportedTextbook | null>(null)
  const [textbookAsset, setTextbookAsset] = React.useState<ProjectAsset | null>(null)
  const [selectedChapterId, setSelectedChapterId] = React.useState<string | null>(null)
  const [loadingFilename, setLoadingFilename] = React.useState<string | null>(null)
  const [importing, setImporting] = React.useState(false)
  const [starting, setStarting] = React.useState(false)

  const textbookAssets = React.useMemo(
    () => assets.filter((asset) => SUPPORTED_TEXTBOOK.test(asset.filename)),
    [assets],
  )
  const selectedChapter = textbook?.chapters.find((chapter) => chapter.id === selectedChapterId) ?? null

  const selectTextbook = React.useCallback((loaded: ImportedTextbook, asset: ProjectAsset) => {
    setTextbook(loaded)
    setTextbookAsset(asset)
    setSelectedChapterId(loaded.chapters[0]?.id ?? null)
  }, [])

  const handleOpenTextbook = React.useCallback(async (asset: ProjectAsset) => {
    setLoadingFilename(asset.filename)
    try {
      const loaded = await window.electronAPI.parseProjectTextbookAsset(
        workspaceId,
        project.config.slug,
        asset.filename,
      )
      selectTextbook(loaded, asset)
    } catch (error) {
      console.error('[ProjectTextbooksSection] Failed to parse textbook:', error)
      toast.error(t('projectInfo.uploadFailed'))
    } finally {
      setLoadingFilename(null)
    }
  }, [workspaceId, project.config.slug, selectTextbook, t])

  const handleImport = React.useCallback(async (file: File) => {
    if (!SUPPORTED_TEXTBOOK.test(file.name)) {
      toast.error(t('projectInfo.supportedTextbookFormats'))
      return
    }
    if (file.size === 0 || file.size > MAX_TEXTBOOK_BYTES) {
      toast.error(t('projectInfo.supportedTextbookFormats'))
      return
    }

    setImporting(true)
    try {
      const base64 = arrayBufferToBase64(await file.arrayBuffer())
      const result = await window.electronAPI.importProjectTextbook(
        workspaceId,
        project.config.slug,
        { filename: file.name, base64 },
      )
      await refreshAssets()
      selectTextbook(result.textbook, result.asset)
      toast.success(t('projectInfo.importedTextbook', { name: result.textbook.title }))
    } catch (error) {
      console.error('[ProjectTextbooksSection] Import failed:', error)
      toast.error(t('projectInfo.uploadFailed'))
    } finally {
      setImporting(false)
    }
  }, [workspaceId, project.config.slug, refreshAssets, selectTextbook, t])

  const handleStartLearning = React.useCallback(async () => {
    if (!textbook || !selectedChapter) return
    if (selectedChapter.content.length > MAX_CHAPTER_CHARS) {
      toast.error(t('projectInfo.chapterTooLarge'))
      return
    }

    setStarting(true)
    try {
      const session = await onCreateSession(workspaceId, {
        name: `${textbook.title} · ${selectedChapter.title}`,
        projectId: project.config.id,
        workingDirectory: 'none',
        permissionMode: 'safe',
        enabledSourceSlugs: [],
        systemPromptPreset: 'tutor',
        learningContext: {
          sourceFilename: textbook.sourceFilename,
          textbookTitle: textbook.title,
          chapterId: selectedChapter.id,
          chapterTitle: selectedChapter.title,
          format: textbook.format,
        },
      })
      if (!session?.id) throw new Error('Session was not created')

      const kickoff = buildLessonKickoff(textbook, selectedChapter, i18n.resolvedLanguage ?? i18n.language)
      await window.electronAPI.sendMessage(session.id, kickoff, undefined, undefined, { hidden: true })
      navigate(routes.view.projectSession(project.config.slug, session.id))
    } catch (error) {
      console.error('[ProjectTextbooksSection] Failed to start lesson:', error)
      toast.error(t('projectInfo.newSessionFailed'))
    } finally {
      setStarting(false)
    }
  }, [textbook, selectedChapter, onCreateSession, workspaceId, project.config.id, project.config.slug, i18n, t])

  return (
    <div className="space-y-4">
      <Info_Section
        title={t('projectInfo.tabLearning')}
        actions={
          <label
            className={cn(
              'inline-flex items-center gap-1 h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal transition-colors',
              importing ? 'cursor-wait opacity-60' : 'cursor-pointer hover:bg-foreground/[0.03]',
            )}
          >
            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {t('projectInfo.importTextbook')}
            <input
              type="file"
              className="hidden"
              accept=".md,.markdown,.epub,text/markdown,application/epub+zip"
              disabled={importing}
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (file) await handleImport(file)
                event.target.value = ''
              }}
            />
          </label>
        }
      >
        {textbookAssets.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            <p>{t('projectInfo.noTextbooks')}</p>
            <p className="mt-1 text-xs">{t('projectInfo.supportedTextbookFormats')}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {textbookAssets.map((asset) => {
              const active = textbook?.sourceFilename === asset.filename
              const loading = loadingFilename === asset.filename
              return (
                <li key={asset.filename}>
                  <button
                    type="button"
                    className={cn(
                      'w-full px-4 py-3 flex items-center gap-3 text-left transition-colors',
                      active ? 'bg-foreground/[0.05]' : 'hover:bg-foreground/[0.03]',
                    )}
                    disabled={loadingFilename !== null}
                    onClick={() => handleOpenTextbook(asset)}
                  >
                    {loading
                      ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                      : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{asset.filename}</span>
                      <span className="block text-xs text-muted-foreground">
                        {(asset.sizeBytes / 1024).toFixed(1)} KB
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Info_Section>

      {textbook && (
        <Info_Section title={textbook.title}>
          {textbook.format === 'epub' && textbookAsset ? (
            <EpubReader
              key={textbookAsset.absolutePath}
              assetPath={textbookAsset.absolutePath}
              sourceKey={`${workspaceId}:${project.config.slug}:${textbook.sourceFilename}`}
              workspaceId={workspaceId}
              projectSlug={project.config.slug}
              textbook={textbook}
              selectedChapterId={selectedChapterId}
              accentColor={project.config.color}
              starting={starting}
              onChapterChange={setSelectedChapterId}
              onStartLearning={handleStartLearning}
            />
          ) : (
            <>
              <div className="px-4 py-3 border-b border-border/50 flex items-center gap-3">
                <BookOpen className="h-5 w-5 text-muted-foreground" />
                <div className="min-w-0">
                  {textbook.author && <div className="text-sm text-foreground/80">{textbook.author}</div>}
                  <div className="text-xs text-muted-foreground">
                    {textbook.format.toUpperCase()} · {t('projectInfo.chapterCount', { count: textbook.chapters.length })}
                  </div>
                </div>
              </div>

              <div className="px-4 pt-3 pb-2 text-xs font-medium text-muted-foreground">
                {t('projectInfo.chooseChapter')}
              </div>
              <ul className="max-h-[360px] overflow-y-auto pb-2">
                {textbook.chapters.map((chapter) => {
                  const selected = chapter.id === selectedChapterId
                  return (
                    <li key={chapter.id}>
                      <button
                        type="button"
                        className={cn(
                          'w-full min-h-10 pr-4 py-2 flex items-center gap-3 text-left text-sm transition-colors',
                          selected ? 'bg-foreground/[0.06] text-foreground' : 'hover:bg-foreground/[0.03] text-foreground/80',
                        )}
                        style={{ paddingLeft: 16 + Math.min(Math.max(chapter.level - 1, 0), 4) * 14 }}
                        onClick={() => setSelectedChapterId(chapter.id)}
                      >
                        <span
                          className={cn(
                            'h-3.5 w-3.5 rounded-full border shrink-0 flex items-center justify-center',
                            selected ? 'border-foreground/60' : 'border-foreground/25',
                          )}
                        >
                          {selected && <span className="h-1.5 w-1.5 rounded-full bg-foreground/70" />}
                        </span>
                        <span className="truncate">{chapter.title}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>

              <div className="px-4 py-3 border-t border-border/50 flex justify-end">
                <Button onClick={handleStartLearning} disabled={!selectedChapter || starting}>
                  {starting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />}
                  {t('projectInfo.startLearning')}
                </Button>
              </div>
            </>
          )}
        </Info_Section>
      )}
    </div>
  )
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
