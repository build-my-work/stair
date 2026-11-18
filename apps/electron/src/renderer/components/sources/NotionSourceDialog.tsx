import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { FolderSourceConfig } from '@craft-agent/shared/sources'
import { useRegisterModal } from '@/context/ModalContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

interface NotionSourceDialogProps {
  workspaceId: string
  onClose: () => void
  onConnected: (source: FolderSourceConfig) => void
}

export function NotionSourceDialog({ workspaceId, onClose, onConnected }: NotionSourceDialogProps) {
  const { t } = useTranslation()
  const [token, setToken] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const close = () => { if (!saving) onClose() }
  useRegisterModal(true, close)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!token.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const source = await window.electronAPI.connectNotionSource(workspaceId, token.trim())
      if (!mounted.current) return
      setToken('')
      onConnected(source)
    } catch (error) {
      if (!mounted.current) return
      const message = error instanceof Error ? error.message : ''
      if (message.includes('NOTION_AUTH_FAILED')) setError(t('notion.authFailed'))
      else if (message.includes('NOTION_UNAVAILABLE')) setError(t('notion.connectionFailed'))
      else setError(t('notion.saveFailed'))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="sm:max-w-md" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{t('notion.connect')}</DialogTitle>
          <DialogDescription>{t('notion.tokenHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="notion-api-token">{t('notion.apiToken')}</Label>
            <Input
              id="notion-api-token"
              type="password"
              autoFocus
              autoComplete="new-password"
              value={token}
              onChange={event => setToken(event.target.value)}
              disabled={saving}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'notion-token-help notion-source-error' : 'notion-token-help'}
            />
            <p id="notion-token-help" className="text-label-sm text-secondary">
              <Trans
                i18nKey="notion.tokenHelp"
                components={{ portal: (
                  <a
                    href="https://app.notion.com/developers/connections"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent underline underline-offset-2"
                  />
                ) }}
              />
            </p>
          </div>
          {error && <p id="notion-source-error" role="alert" className="text-label-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} disabled={saving}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!token.trim() || saving}>
              {saving ? t('common.connecting') : t('common.connect')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
