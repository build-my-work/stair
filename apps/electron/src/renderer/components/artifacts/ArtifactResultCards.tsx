import { ArrowUpRight, FileText } from 'lucide-react'

import type { ActivityItem } from '@craft-agent/ui'

import { parseSavedArtifactResult } from './artifact-result'

export function ArtifactResultCards({ activities }: { activities: ActivityItem[] }) {
  const artifacts = activities
    .map(parseSavedArtifactResult)
    .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null)

  if (artifacts.length === 0) return null

  return (
    <div className="mt-2 grid gap-2">
      {artifacts.map(artifact => (
        <button
          key={artifact.artifactId}
          type="button"
          className="group flex w-full items-center gap-3 rounded-xl border border-border/70 bg-background px-3.5 py-3 text-left shadow-minimal transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => window.dispatchEvent(new CustomEvent('craft:open-artifact', {
            detail: artifact,
          }))}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground group-hover:text-foreground">
            <FileText className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] uppercase tracking-[0.13em] text-muted-foreground">Artifact</span>
            <span className="mt-0.5 block truncate text-sm font-medium text-foreground">{artifact.title}</span>
          </span>
          <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
        </button>
      ))}
    </div>
  )
}
