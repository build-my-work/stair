import { FileText, MessageSquareQuote, X } from 'lucide-react'
import type { Reference } from '@craft-agent/core'
import { cn } from '../../lib/utils'
import { useTranslation } from 'react-i18next'

export interface MessageReferencePreviewProps {
  reference: Reference
  className?: string
  onActivate?: (reference: Reference) => void
  onRemove?: (reference: Reference) => void
}

export function MessageReferencePreview({
  reference,
  className,
  onActivate,
  onRemove,
}: MessageReferencePreviewProps) {
  const { t } = useTranslation()
  const label = reference.kind === 'project-file'
    ? reference.fileName
    : `Chat · ${reference.role}`
  const source = reference.kind === 'project-file'
    ? reference.relativePath
    : reference.sessionId
  const Icon = reference.kind === 'project-file' ? FileText : MessageSquareQuote

  return (
    <div className={cn(
      'inline-flex min-w-0 max-w-[320px] items-center gap-2 rounded-[8px] bg-background px-2 py-1.5 shadow-minimal',
      className,
    )}>
      <button
        type="button"
        disabled={!onActivate}
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        title={source}
        onClick={() => onActivate?.(reference)}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate text-[11px] font-medium">{label}</span>
          <span className="block truncate text-[10px] italic text-muted-foreground">
            “{reference.quote}”
          </span>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          aria-label={t('reference.remove')}
          onClick={() => onRemove(reference)}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}
