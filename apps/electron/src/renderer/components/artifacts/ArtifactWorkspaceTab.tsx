import * as React from 'react'
import {
  Download,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Save,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import type { Artifact } from '@craft-agent/shared/projects'

import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface ArtifactWorkspaceTabProps {
  sessionId: string
  artifactId: string
}

export function ArtifactWorkspaceTab({ sessionId, artifactId }: ArtifactWorkspaceTabProps) {
  const [artifact, setArtifact] = React.useState<Artifact | null>(null)
  const [title, setTitle] = React.useState('')
  const [markdown, setMarkdown] = React.useState('')
  const [editing, setEditing] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let disposed = false
    setLoading(true)
    setError(null)
    void window.electronAPI.getProjectArtifact(sessionId, artifactId)
      .then((loaded) => {
        if (disposed) return
        if (!loaded) throw new Error('Artifact not found')
        setArtifact(loaded)
        setTitle(loaded.title)
        setMarkdown(loaded.markdown)
      })
      .catch(reason => {
        if (!disposed) setError(getErrorMessage(reason))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => { disposed = true }
  }, [artifactId, sessionId])

  const save = React.useCallback(async () => {
    if (!artifact || saving || !title.trim()) return
    setSaving(true)
    try {
      const updated = await window.electronAPI.saveProjectArtifact(sessionId, {
        id: artifact.id,
        title: title.trim(),
        markdown,
        templateId: artifact.templateId,
        references: artifact.references,
      })
      setArtifact(updated)
      setTitle(updated.title)
      setMarkdown(updated.markdown)
      setEditing(false)
      window.dispatchEvent(new CustomEvent('craft:artifact-changed', { detail: updated }))
      toast.success('Artifact saved')
    } catch (reason) {
      toast.error('Could not save Artifact', {
        description: getErrorMessage(reason),
      })
    } finally {
      setSaving(false)
    }
  }, [artifact, markdown, saving, sessionId, title])

  const remove = React.useCallback(async () => {
    if (!artifact || !window.confirm(`Delete “${artifact.title}”?`)) return
    try {
      await window.electronAPI.deleteProjectArtifact(sessionId, artifact.id)
      setArtifact(null)
      setError('Artifact deleted')
      window.dispatchEvent(new CustomEvent('craft:artifact-deleted', {
        detail: { artifactId: artifact.id },
      }))
    } catch (reason) {
      toast.error('Could not delete Artifact', {
        description: getErrorMessage(reason),
      })
    }
  }, [artifact, sessionId])

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  }
  if (error || !artifact) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">{error ?? 'Artifact not found'}</div>
  }

  const dirty = title !== artifact.title || markdown !== artifact.markdown
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        {editing ? (
          <input
            value={title}
            aria-label="Artifact title"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-sm font-medium outline-none focus:border-foreground/30"
            onChange={event => setTitle(event.target.value)}
          />
        ) : (
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{artifact.title}</div>
        )}

        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={editing ? 'Preview Artifact' : 'Edit Artifact'}
          onClick={() => setEditing(value => !value)}
        >
          {editing ? <Eye /> : <Pencil />}
        </Button>
        {editing && (
          <Button type="button" size="icon" variant="ghost" aria-label="Save Artifact" disabled={!dirty || saving || !title.trim()} onClick={save}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
          </Button>
        )}
        <Button type="button" size="icon" variant="ghost" aria-label="Export Artifact" onClick={() => downloadArtifact(artifact.title, markdown)}>
          <Download />
        </Button>
        <Button type="button" size="icon" variant="ghost" aria-label="Delete Artifact" onClick={remove}>
          <Trash2 />
        </Button>
      </header>

      {editing ? (
        <Textarea
          value={markdown}
          aria-label="Artifact Markdown"
          className="min-h-0 flex-1 resize-none rounded-none border-0 px-5 py-4 font-mono text-[13px] leading-6 focus-visible:ring-0"
          onChange={event => setMarkdown(event.target.value)}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <article className="mx-auto max-w-[760px] px-7 py-7 text-[15px] leading-7">
            <Markdown mode="full">{markdown}</Markdown>
            {artifact.references.length > 0 && (
              <section className="mt-8 border-t border-border/70 pt-5">
                <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">References</div>
                <div className="grid gap-1.5">
                  {artifact.references.map((reference, index) => (
                    <button
                      key={`${reference.path}:${index}`}
                      type="button"
                      className="rounded-lg border border-border/60 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40"
                      onClick={() => window.dispatchEvent(new CustomEvent('craft:open-file-reference', { detail: reference }))}
                    >
                      <span className="block truncate font-medium text-foreground">{reference.path}</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{formatLocator(reference.locator)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </article>
        </div>
      )}
    </div>
  )
}

function formatLocator(locator: Artifact['references'][number]['locator']): string {
  if (locator.type === 'epub-cfi') return 'EPUB selection'
  if (locator.type === 'pdf-page') return `Page ${locator.page}`
  if (locator.startLine === locator.endLine) return `Line ${locator.startLine}`
  return `Lines ${locator.startLine}–${locator.endLine}`
}

function getErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function downloadArtifact(title: string, markdown: string): void {
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-').trim() || 'artifact'
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${safeTitle}.md`
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    URL.revokeObjectURL(url)
  }
}
