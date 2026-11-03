import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, MessageSquare, Zap, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Info_Markdown } from '@/components/info'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { routes, navigate } from '@/lib/navigate'
import type { PreparedSkillImport } from '@craft-agent/shared/skills/marketplace'

interface Props {
  prepared: PreparedSkillImport
  workspaceName: string
  busy: boolean
  installed: string[]
  onBack: () => void
  onInstall: (ids: string[], replace: boolean) => void
}

export function SkillInstallPreview({ prepared, workspaceName, busy, installed, onBack, onInstall }: Props) {
  const { t } = useTranslation()
  const { candidates } = prepared
  const [selected, setSelected] = React.useState<string[]>(candidates.length === 1 ? [candidates[0]!.id] : [])
  const [activeId, setActiveId] = React.useState(candidates[0]!.id)
  const [replace, setReplace] = React.useState(false)
  const [showContent, setShowContent] = React.useState(false)
  const active = candidates.find(candidate => candidate.id === activeId)!
  const remaining = selected.filter(id => {
    const candidate = candidates.find(candidate => candidate.id === id)!
    return !installed.includes(candidate.slug)
  })
  const conflicts = candidates.filter(candidate => remaining.includes(candidate.id) && candidate.existing)
  const isInstalled = installed.includes(active.slug)
  let sourceName: string
  if (active.origin.source === 'eduhub') {
    sourceName = 'EduHub'
  } else if (active.origin.source === 'github') {
    sourceName = 'GitHub'
  } else {
    sourceName = t('skillMarket.local')
  }

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-12 shrink-0 items-center border-b border-subtle px-4">
      <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}><ArrowLeft className="size-4" />{t('skillMarket.discover')}</Button>
    </div>
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-foreground/5"><Zap className="size-6" /></div>
            <div className="min-w-0">
              <h1 className="break-words text-title">{active.name}</h1>
              <p className="mt-1 text-label-sm text-secondary">{sourceName}</p>
            </div>
          </div>
          {isInstalled ? <Button onClick={() => navigate(routes.action.newSession({ input: '[skill:' + active.slug + '] ' }))}>
            <MessageSquare className="size-4" />{t('skillMarket.useInChat')}
          </Button> : <Button disabled={busy || !remaining.length || (conflicts.length > 0 && !replace)}
            onClick={() => onInstall(remaining, replace)}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('skillMarket.installCount', { count: remaining.length })}
          </Button>}
        </div>
        <p className="text-label text-secondary">{active.description}</p>
        <p className="text-label-sm text-secondary">{t('skillMarket.destination', { name: workspaceName })}</p>
        {candidates.length > 1 && <section aria-label={t('skillMarket.chooseSkills')} className="space-y-2">
          <h2 className="text-label-lg font-medium">{t('skillMarket.chooseSkills')}</h2>
          {candidates.map(candidate => <div key={candidate.id} className="flex items-center gap-3 rounded-lg border border-subtle p-3">
            <input type="checkbox" disabled={busy || installed.includes(candidate.slug)} aria-label={t('skillMarket.selectSkill', { name: candidate.name })}
              checked={selected.includes(candidate.id)} onChange={e => {
                setReplace(false)
                setSelected(current => e.target.checked ? [...current, candidate.id] : current.filter(id => id !== candidate.id))
              }} />
            <button className="flex-1 text-left" onClick={() => setActiveId(candidate.id)}>
              <span className="text-label font-medium">{candidate.name}</span>
              <span className="block break-all text-label-sm text-secondary">{candidate.id}</span>
            </button>
            {installed.includes(candidate.slug) && <Check className="size-4 text-success" aria-label={t('skillMarket.installed')} />}
          </div>)}
        </section>}
        {conflicts.length > 0 && <div className="space-y-2 rounded-lg border border-subtle p-4">
          <p className="text-label">{t('skillMarket.conflict')}</p>
          {conflicts.map(candidate => <p key={candidate.id} className="text-label-sm text-secondary">
            {candidate.name} · {candidate.existing?.modified ? t('skillMarket.locallyModified') : t('skillMarket.installed')}
            {!candidate.existing?.sameOrigin && ' · ' + t('skillMarket.differentOrigin')}
          </p>)}
          <label className="flex items-center gap-2 text-label"><input type="checkbox" checked={replace} disabled={busy}
            onChange={e => setReplace(e.target.checked)} />{t('skillMarket.replaceConfirmation')}</label>
        </div>}
        <section className="space-y-3">
          <h2 className="text-label-lg font-medium">{t('skillMarket.instructions')}</h2>
          <button onClick={() => setShowContent(true)} className="flex w-full items-center gap-3 rounded-lg border border-subtle p-4 text-left hover:bg-foreground/5">
            <Zap className="size-5 shrink-0" /><span className="min-w-0 flex-1"><span className="block text-label font-medium">{active.name}</span>
              <span className="block text-label-sm text-secondary">{t('skillMarket.readInstructions')}</span></span>
          </button>
        </section>
        {(active.compatibility || active.requiredSources.length > 0 || active.alwaysAllow.length > 0) && <section className="space-y-2">
          <h2 className="text-label-lg font-medium">{t('skillMarket.requirements')}</h2>
          {active.compatibility && <p className="text-label text-secondary">{active.compatibility}</p>}
          {active.requiredSources.length > 0 && <p className="text-label text-secondary">{t('skillInfo.requiredSources')}: {active.requiredSources.join(', ')}</p>}
          {active.alwaysAllow.length > 0 && <p className="text-label text-secondary">{t('skillMarket.allowedTools')}: {active.alwaysAllow.join(', ')}</p>}
        </section>}
        <section className="space-y-3">
          <h2 className="text-label-lg font-medium">{t('skillMarket.information')}</h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 border-t border-subtle pt-4 text-label">
            <dt className="text-secondary">{t('common.slug')}</dt><dd className="break-all">{active.slug}</dd>
            {active.origin.revision && <><dt className="text-secondary">{t('skillMarket.version')}</dt><dd className="break-all font-mono text-mono-ui">{active.origin.revision}</dd></>}
            {active.license && <><dt className="text-secondary">{t('skillMarket.license')}</dt><dd>{active.license}</dd></>}
            {active.origin.subpath && <><dt className="text-secondary">{t('skillMarket.directory')}</dt><dd className="break-all">{active.origin.subpath}</dd></>}
            {active.origin.url && <><dt className="text-secondary">{t('common.source')}</dt><dd><button onClick={() => window.electronAPI.openUrl(active.origin.url!)}
              className="inline-flex max-w-full items-center gap-1 text-left text-accent hover:underline"><span className="break-all">{active.origin.url}</span><ExternalLink className="size-3 shrink-0" /></button></dd></>}
          </dl>
          <details className="border-t border-subtle pt-3">
            <summary className="cursor-pointer text-label">{t('skillMarket.filesCount', { count: active.files.length })}</summary>
            <ul className="mt-3 max-h-60 overflow-y-auto text-label-sm text-secondary">
              {active.files.map(file => <li key={file.path} className="flex justify-between gap-4 py-1"><span className="break-all">{file.path}</span><span className="shrink-0">{Math.ceil(file.size / 1024)} KB</span></li>)}
            </ul>
          </details>
        </section>
      </div>
    </div>
    <Dialog open={showContent} onOpenChange={setShowContent}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>{active.name}</DialogTitle><DialogDescription>{active.description}</DialogDescription></DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-lg bg-foreground/5 p-3"><Info_Markdown mode="full">{active.content}</Info_Markdown></div>
      </DialogContent>
    </Dialog>
  </div>
}
