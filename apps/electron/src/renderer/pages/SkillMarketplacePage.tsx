import * as React from 'react'
import { atom, useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Search, Plus, Check, Loader2, X, Zap, ArrowUpRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { SkillImportMenu } from '@/components/skills/SkillImportMenu'
import { SkillInstallPreview } from '@/components/skills/SkillInstallPreview'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { routes, navigate } from '@/lib/navigate'
import { skillsAtom, skillImportSourceAtom } from '@/atoms/skills'
import type { SkillMarket, SkillImportSource, SkillCatalogEntry, PreparedSkillImport } from '@craft-agent/shared/skills/marketplace'

interface BrowseState {
  query: string
  market: 'all' | SkillMarket
  tab: 'discover' | 'installed'
  scrollTop: number
}
const browseStateAtom = atom<Record<string, BrowseState>>({})
const initialBrowse: BrowseState = { query: '', market: 'all', tab: 'discover', scrollTop: 0 }
const marketNames: Record<SkillMarket, string> = { eduhub: 'EduHub', 'skills-sh': 'skills.sh' }

export default function SkillMarketplacePage({ workspaceId, workingDirectory }: { workspaceId: string; workingDirectory?: string }) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const [skills, setSkills] = useAtom(skillsAtom)
  const [pendingSource, setPendingSource] = useAtom(skillImportSourceAtom)
  const [browsing, setBrowsing] = useAtom(browseStateAtom)
  const browse = browsing[workspaceId] ?? initialBrowse
  const [entries, setEntries] = React.useState<SkillCatalogEntry[]>([])
  const [catalogErrors, setCatalogErrors] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [prepared, setPrepared] = React.useState<PreparedSkillImport | null>(null)
  const [installed, setInstalled] = React.useState<string[]>([])
  const [retry, setRetry] = React.useState(0)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const generation = React.useRef(0)
  const requestId = React.useRef(0)
  const workingDirectoryRef = React.useRef(workingDirectory)
  workingDirectoryRef.current = workingDirectory

  const updateBrowse = (patch: Partial<BrowseState>) => setBrowsing(current => ({
    ...current, [workspaceId]: { ...(current[workspaceId] ?? initialBrowse), ...patch },
  }))

  React.useEffect(() => {
    // Imports belong to the workspace, even if a session changes its working directory.
    return () => { generation.current += 1 }
  }, [workspaceId])

  React.useEffect(() => {
    let cancelled = false
    window.electronAPI.getSkills(workspaceId, workingDirectory)
      .then(value => {
        if (!cancelled) setSkills(value)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [workspaceId, workingDirectory, setSkills])

  React.useEffect(() => {
    if (browse.tab !== 'discover') return
    let cancelled = false
    setLoading(true)
    const timeout = setTimeout(async () => {
      const markets: SkillMarket[] = browse.market === 'all' ? ['eduhub', 'skills-sh'] : [browse.market]
      const results = await Promise.allSettled(markets.map(market => window.electronAPI.searchSkillMarketplace(workspaceId, market, browse.query)))
      if (cancelled) return
      setEntries(results.flatMap(result => result.status === 'fulfilled' ? result.value : []))
      setCatalogErrors(results.flatMap((result, index) => {
        if (result.status === 'fulfilled') return []
        const market = markets[index]!
        const message = String(result.reason?.message ?? result.reason)
        return [marketNames[market] + ': ' + message]
      }))
      setLoading(false)
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [workspaceId, browse.market, browse.query, browse.tab, retry])

  React.useLayoutEffect(() => {
    if (!prepared && scrollRef.current) scrollRef.current.scrollTop = browse.scrollTop
  }, [prepared, entries, browse.tab, browse.scrollTop])

  const prepare = React.useCallback(async (source: SkillImportSource) => {
    const currentGeneration = generation.current
    const currentRequest = ++requestId.current
    const isCurrentRequest = () => currentGeneration === generation.current && currentRequest === requestId.current
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI.prepareSkillImport(workspaceId, source)
      if (!isCurrentRequest()) return
      setPrepared(result)
      setInstalled([])
    } catch (error) {
      if (isCurrentRequest()) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (isCurrentRequest()) setBusy(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    if (pendingSource?.workspaceId === workspaceId) {
      const source = pendingSource.source
      setPendingSource(null)
      void prepare(source)
    }
  }, [pendingSource, workspaceId, prepare, setPendingSource])

  async function install(ids: string[], replace: boolean) {
    if (!prepared) return
    const currentGeneration = generation.current
    const isCurrentWorkspace = () => currentGeneration === generation.current
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI.installSkills(workspaceId, { token: prepared.token, candidateIds: ids, replace })
      if (!isCurrentWorkspace()) return
      setInstalled(current => [...current, ...result.installed])
      if (result.failed.length) setError(result.failed.map(f => f.slug + ': ' + f.error).join('\n'))
      if (result.installed.length) {
        toast.success(t('skillMarket.installSuccess', { count: result.installed.length }))
        const directory = workingDirectoryRef.current
        const loaded = await window.electronAPI.getSkills(workspaceId, directory)
        if (isCurrentWorkspace() && directory === workingDirectoryRef.current) setSkills(loaded)
      }
    } catch (error) {
      if (isCurrentWorkspace()) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (isCurrentWorkspace()) setBusy(false)
    }
  }

  const filteredSkills = skills.filter(skill => (skill.metadata.name + ' ' + skill.metadata.description).toLowerCase().includes(browse.query.toLowerCase()))
  return <div className="@container flex h-full min-h-0 flex-col">
    {error && <div role="alert" className="flex shrink-0 items-start justify-between gap-3 border-b border-subtle px-5 py-3 text-label-sm text-destructive">
      <div><span className="font-medium">{t('skillMarket.operationFailed')}</span><p className="whitespace-pre-wrap break-words">{error}</p></div>
      <Button size="icon" variant="ghost" aria-label={t('common.close')} onClick={() => setError(null)}><X className="size-4" /></Button>
    </div>}
    {prepared ? <SkillInstallPreview key={prepared.token} prepared={prepared} workspaceName={workspace?.name ?? workspaceId}
      busy={busy} installed={installed} onBack={() => { setPrepared(null); setError(null) }} onInstall={(ids, replace) => { void install(ids, replace) }} />
      : <>
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-subtle px-4">
          <div className="flex items-center gap-1">
            {(['discover', 'installed'] as const).map(tab => <Button key={tab} size="sm" variant={browse.tab === tab ? 'secondary' : 'ghost'}
              aria-pressed={browse.tab === tab} onClick={() => updateBrowse({ tab, scrollTop: 0 })}>{tab === 'discover' ? t('skillMarket.discover') : t('skillMarket.installed')}</Button>)}
          </div>
          <SkillImportMenu disabled={busy} onPrepare={source => { void prepare(source) }} onError={setError} />
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6" onScroll={e => {
          // Keep navigation state without tying the package preview to a catalog adapter.
          const top = e.currentTarget.scrollTop
          if (Math.abs(top - browse.scrollTop) > 8) updateBrowse({ scrollTop: top })
        }}>
          <div className="mx-auto max-w-4xl space-y-6">
            <div><h1 className="text-title">{t('skillMarket.title')}</h1><p className="mt-1 text-label text-secondary">{t('skillMarket.description')}</p></div>
            <div className="flex items-center gap-2 rounded-full border border-subtle bg-foreground/5 px-4 focus-within:ring-2 focus-within:ring-ring">
              <Search className="size-4 text-secondary" />
              <input value={browse.query} onChange={e => updateBrowse({ query: e.target.value, scrollTop: 0 })}
                placeholder={t('skillMarket.search')} aria-label={t('skillMarket.search')}
                className="h-11 min-w-0 flex-1 bg-transparent text-label outline-none" />
              {browse.query && <button aria-label={t('skillMarket.clearSearch')} onClick={() => updateBrowse({ query: '', scrollTop: 0 })}><X className="size-4" /></button>}
            </div>
            {browse.tab === 'discover' && <div className="flex flex-wrap gap-2">
              {(['all', 'eduhub', 'skills-sh'] as const).map(market => <Button size="sm" key={market}
                variant={browse.market === market ? 'secondary' : 'ghost'} aria-pressed={browse.market === market}
                onClick={() => updateBrowse({ market, scrollTop: 0 })}>{market === 'all' ? t('skillMarket.allSources') : marketNames[market]}</Button>)}
            </div>}
            {busy && <div role="status" className="flex items-center gap-2 text-label text-secondary"><Loader2 className="size-4 animate-spin" />{t('skillMarket.preparing')}</div>}
            {browse.tab === 'discover' ? <>
              {catalogErrors.map(message => <div role="alert" key={message} className="text-label-sm text-secondary">{message} <button className="underline" onClick={() => setRetry(n => n + 1)}>{t('skillMarket.retry')}</button></div>)}
              {browse.market !== 'eduhub' && browse.query.trim().length < 2 && <p className="text-label-sm text-secondary">{t('skillMarket.searchHint')}</p>}
              {loading ? <div role="status" className="flex items-center gap-2 py-8 text-label text-secondary"><Loader2 className="size-4 animate-spin" />{t('common.loading')}</div>
                : <div className="grid grid-cols-1 gap-x-8 gap-y-1 @min-[640px]:grid-cols-2">
                  {entries.map(entry => {
                    const isInstalled = skills.some(skill => {
                      const installation = skill.installation
                      if (installation?.identity === entry.id) return true
                      if (entry.source.kind !== 'github' || installation?.source !== 'github') return false
                      return installation.url?.toLowerCase() === entry.source.url.toLowerCase()
                        && (skill.metadata.name === entry.source.skill || installation.subpath?.split('/').at(-1) === entry.source.skill)
                    })
                    return <button key={entry.id} disabled={busy} onClick={() => { void prepare(entry.source) }}
                      className="flex min-w-0 items-center gap-3 rounded-xl p-3 text-left hover:bg-foreground/5 disabled:opacity-50">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-foreground/5"><Zap className="size-5 text-secondary" /></div>
                      <div className="min-w-0 flex-1"><span className="block truncate text-label font-medium">{entry.name}</span>
                        <span className="mt-0.5 block truncate text-label-sm text-secondary">{entry.author ? entry.author + ' · ' : ''}{marketNames[entry.market]}</span>
                        <span className="mt-0.5 line-clamp-2 text-label-sm text-secondary">{entry.description}</span></div>
                      {isInstalled ? <Check className="size-4 shrink-0" aria-label={t('skillMarket.installed')} /> : <Plus className="size-4 shrink-0" />}
                    </button>
                  })}
                </div>}
              {!loading && !entries.length && !catalogErrors.length && <p className="py-8 text-center text-label text-secondary">{t('skillMarket.noResults')}</p>}
              {!loading && entries.length > 0 && <p className="text-label-sm text-secondary">{t('skillMarket.resultLimit')}</p>}
            </> : <div className="grid grid-cols-1 gap-x-8 gap-y-1 @min-[640px]:grid-cols-2">
              {filteredSkills.map(skill => <button key={skill.slug} onClick={() => navigate(routes.view.skills(skill.slug))}
                className="flex min-w-0 items-center gap-3 rounded-xl p-3 text-left hover:bg-foreground/5">
                <SkillAvatar skill={skill} workspaceId={workspaceId} />
                <span className="min-w-0 flex-1"><span className="block truncate text-label font-medium">{skill.metadata.name}</span>
                  <span className="mt-1 line-clamp-2 text-label-sm text-secondary">{skill.metadata.description}</span></span><ArrowUpRight className="size-4 shrink-0" />
              </button>)}
              {!filteredSkills.length && <p className="py-8 text-label text-secondary">{t('skillMarket.noInstalled')}</p>}
            </div>}
          </div>
        </div>
      </>}
  </div>
}
