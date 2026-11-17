import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileText, Loader2, RefreshCw } from 'lucide-react'
import type { LoadedProject } from '@craft-agent/shared/projects/types'
import type { NotionPage } from '@craft-agent/shared/notion'
import { openNotionPageAtom } from './notion-workbench'
import { toast } from 'sonner'

function PageRow({ page, projectId, depth }: { page: NotionPage; projectId: string; depth: number }) {
  const { t } = useTranslation()
  const open = useSetAtom(openNotionPageAtom)
  const [expanded, setExpanded] = useState(false)
  return <div>
    <div className="flex h-7 items-center gap-1 text-[13px]" style={{ paddingLeft: 8 + depth * 14 }}>
      <button type="button" className="rounded p-0.5 hover:bg-foreground/5" disabled={page.kind === 'database'} aria-label={t(expanded ? 'notion.collapse' : 'notion.expand')} onClick={() => setExpanded(value => !value)}>
        <ChevronRight className={`size-3.5 ${expanded ? 'rotate-90' : ''}`} />
      </button>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-foreground/5" onClick={() => { void open({ projectId, pageId: page.pageId }).catch(error => toast.error(String(error))) }}>
        <FileText className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{page.title || t('notion.untitled')}</span>
      </button>
    </div>
    {expanded && <PageChildren projectId={projectId} pageId={page.pageId} depth={depth + 1} />}
  </div>
}

function PageChildren({ projectId, pageId, depth }: { projectId: string; pageId: string; depth: number }) {
  const { t } = useTranslation()
  const [pages, setPages] = useState<NotionPage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stopped = false
    setPages(null); setError(null)
    void window.electronAPI.getNotionChildren({ projectId, pageId })
      .then(value => { if (!stopped) setPages(value) })
      .catch(reason => { if (!stopped) setError(String(reason)) })
    return () => { stopped = true }
  }, [projectId, pageId])
  if (error) return <p className="px-3 py-2 text-xs text-destructive">{error}</p>
  if (!pages) return <Loader2 className="m-3 size-3.5 animate-spin" />
  if (!pages.length) return <p className="px-4 py-2 text-xs text-muted-foreground">{t('notion.noPages')}</p>
  return <>{pages.map(page => <PageRow key={page.pageId} page={page} projectId={projectId} depth={depth} />)}</>
}

export function NotionPagesTree({ project }: { project: LoadedProject }) {
  const { t } = useTranslation()
  const open = useSetAtom(openNotionPageAtom)
  const [revision, setRevision] = useState(0)
  const rootPageId = project.config.notion!.rootPageId
  return <div className="min-h-0 flex-1 overflow-y-auto p-2">
    <div className="mb-2 flex items-center gap-1">
      <button type="button" className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-foreground/5" onClick={() => { void open({ projectId: project.config.id, pageId: rootPageId }).catch(error => toast.error(String(error))) }}>{t('notion.openRoot')}</button>
      <button type="button" className="rounded p-1" aria-label={t('common.refresh')} onClick={() => setRevision(value => value + 1)}><RefreshCw className="size-3.5" /></button>
    </div>
    <PageChildren key={`${project.config.id}:${rootPageId}:${revision}`} projectId={project.config.id} pageId={rootPageId} depth={0} />
  </div>
}
