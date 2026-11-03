import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, FolderOpen, Github, FileArchive, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MAX_SKILL_UPLOAD_BYTES, type SkillImportSource } from '@craft-agent/shared/skills/marketplace'

interface Props {
  disabled: boolean
  onPrepare: (source: SkillImportSource) => void
  onError: (message: string) => void
}

export function SkillImportMenu({ disabled, onPrepare, onError }: Props) {
  const { t } = useTranslation()
  const [githubOpen, setGithubOpen] = React.useState(false)
  const [url, setUrl] = React.useState('')
  const folderRef = React.useRef<HTMLInputElement>(null)
  const zipRef = React.useRef<HTMLInputElement>(null)

  async function importFiles(list: FileList | null, kind: 'folder' | 'zip') {
    if (!list?.length) return
    const files = Array.from(list).filter(file =>
      !(file.webkitRelativePath || file.name).split('/').some(part => ['.git', 'node_modules', '.DS_Store'].includes(part)))
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_SKILL_UPLOAD_BYTES) {
      onError(t('skillMarket.uploadLimit')); return
    }
    try {
      const bundled = []
      for (const file of files) {
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(new Error(t('skillMarket.readFailed')))
          reader.onload = () => resolve(String(reader.result).split(',')[1]!)
          reader.readAsDataURL(file)
        })
        bundled.push({ relativePath: file.webkitRelativePath || file.name, size: file.size, contentBase64 })
      }
      if (kind === 'zip') {
        onPrepare({ kind, name: files[0]!.name, contentBase64: bundled[0]!.contentBase64 })
      } else {
        onPrepare({ kind, name: bundled[0]?.relativePath.split('/')[0] || 'skills', files: bundled })
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" disabled={disabled}><Plus className="size-4" />{t('skillMarket.add')}<ChevronDown className="size-3.5" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setGithubOpen(true)}><Github className="size-4" />{t('skillMarket.githubLink')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => folderRef.current?.click()}><FolderOpen className="size-4" />{t('skillMarket.folder')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => zipRef.current?.click()}><FileArchive className="size-4" />{t('skillMarket.zip')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <input ref={folderRef} type="file" className="hidden" multiple {...{ webkitdirectory: '', directory: '' }}
      aria-label={t('skillMarket.folder')} onChange={e => { void importFiles(e.currentTarget.files, 'folder'); e.currentTarget.value = '' }} />
    <input ref={zipRef} type="file" className="hidden" accept=".zip" aria-label={t('skillMarket.zip')}
      onChange={e => { void importFiles(e.currentTarget.files, 'zip'); e.currentTarget.value = '' }} />
    <Dialog open={githubOpen} onOpenChange={setGithubOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('skillMarket.githubLink')}</DialogTitle>
          <DialogDescription>{t('skillMarket.githubDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={e => { e.preventDefault(); setGithubOpen(false); onPrepare({ kind: 'github', url: url.trim() }) }}>
          <Input autoFocus value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/owner/repository"
            aria-label={t('skillMarket.githubLink')} required type="url" />
          <DialogFooter className="mt-4"><Button type="submit" disabled={!url.trim()}>{t('skillMarket.preview')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>
}
