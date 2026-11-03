import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getWorkspaceSkillsPath } from '../workspaces/storage'
import { restoreFiles, validateBundleFile, type BundleFile } from '../utils/bundle-files'
import type { SkillInstallation } from './marketplace-types'

export const SKILL_INSTALLATION_FILE = 'stair-install.json'

export function readSkillInstallation(skillDir: string): SkillInstallation | undefined {
  try {
    const path = join(skillDir, SKILL_INSTALLATION_FILE)
    const info = lstatSync(path)
    if (!info.isFile() || info.size > 64 * 1024) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value.schemaVersion === 1 && typeof value.identity === 'string'
      && typeof value.contentHash === 'string' && typeof value.installedAt === 'string'
      && ['eduhub', 'github', 'folder', 'zip'].includes(value.source)) {
      // Older records identified updates by display name, but already retained the stable directory.
      if (value.source === 'github' && value.updateSource?.kind === 'github'
        && value.updateSource.skillPath === undefined && typeof value.subpath === 'string') {
        value.updateSource = { ...value.updateSource, skillPath: value.subpath }
      }
      return value
    }
  } catch { /* Skills created outside the marketplace have no installation record. */ }
}

export function hashSkillFiles(files: BundleFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].filter(f => f.relativePath !== SKILL_INSTALLATION_FILE)
    .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)) {
    hash.update(file.relativePath).update('\0').update(Buffer.from(file.contentBase64, 'base64'))
      .update(process.platform !== 'win32' && file.executable ? 'x' : '-').update('\0')
  }
  return hash.digest('hex')
}

/** Strict snapshot for optimistic replacement; a symlink/unreadable file is never silently omitted. */
export function fingerprintSkillDirectory(directory: string, contentOnly = false): string | undefined {
  const directoryInfo = lstatSync(directory, { throwIfNoEntry: false })
  if (!directoryInfo) return undefined
  if (directoryInfo.isSymbolicLink()) throw new Error('Cannot replace a symbolic link')
  const hash = createHash('sha256')
  const contents: Array<{ path: string; content: Buffer; executable: boolean }> = []
  let count = 0
  let bytes = 0
  function walk(dir: string, prefix: string): void {
    for (const name of readdirSync(dir).sort()) {
      if (contentOnly && !prefix && name === SKILL_INSTALLATION_FILE) continue
      const path = join(dir, name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) throw new Error('Cannot replace a skill containing symbolic links')
      const relativePath = prefix + name
      if (info.isDirectory()) walk(path, relativePath + '/')
      else if (info.isFile()) {
        bytes += info.size
        if (++count > 10000 || bytes > 100 * 1024 * 1024) throw new Error('Existing skill is too large to replace')
        contents.push({ path: relativePath, content: readFileSync(path), executable: process.platform !== 'win32' && Boolean(info.mode & 0o111) })
      } else throw new Error('Unsupported file in existing skill')
    }
  }
  walk(directory, '')
  for (const file of contents.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(file.path).update('\0').update(file.content).update(file.executable ? 'x' : '-').update('\0')
  }
  return hash.digest('hex')
}

/** Shared by resource transfer and marketplace installation. Old contents survive a failed rename. */
export function writeSkillDirectory(
  workspaceRoot: string, slug: string, files: BundleFile[], overwrite: boolean,
): 'installed' | 'skipped' {
  // Preserve safe legacy directory names; marketplace naming policy is checked during preview.
  if (typeof slug !== 'string' || !slug || slug === '.' || slug === '..'
    || /[/\\\x00-\x1f:]/.test(slug) || /[. ]$/.test(slug)) throw new Error('Invalid skill slug')
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot)
  mkdirSync(skillsDir, { recursive: true })
  if (lstatSync(skillsDir).isSymbolicLink()) throw new Error('Skills directory must not be a symbolic link')
  const target = join(skillsDir, slug)
  const targetInfo = lstatSync(target, { throwIfNoEntry: false })
  if (targetInfo?.isSymbolicLink()) throw new Error('Cannot replace a symbolic link')
  if (targetInfo && !overwrite) return 'skipped'
  const paths = new Set<string>()
  for (const file of files) {
    const error = validateBundleFile(file)
    const path = file.relativePath
    if (error || path.split('/').some(p => !p || p === '.' || /[\x00-\x1f:]/.test(p) || /[. ]$/.test(p))
      || paths.has(path.toLowerCase())) throw new Error(error ?? 'Invalid or duplicate file path: ' + path)
    paths.add(path.toLowerCase())
  }
  if (!files.some(f => f.relativePath === 'SKILL.md')) throw new Error('SKILL.md missing after restore')
  const staging = join(skillsDir, '.tmp-' + slug + '-' + randomUUID())
  const backup = join(skillsDir, '.backup-' + slug + '-' + randomUUID())
  let backedUp = false
  mkdirSync(staging)
  try {
    restoreFiles(staging, files)
    if (lstatSync(target, { throwIfNoEntry: false })) {
      if (lstatSync(target).isSymbolicLink()) throw new Error('Cannot replace a symbolic link')
      renameSync(target, backup)
      backedUp = true
    }
    try {
      renameSync(staging, target)
    } catch (error) {
      if (backedUp) renameSync(backup, target)
      throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  // Installation has committed; a cleanup failure must not be reported as an installation failure.
  if (backedUp) {
    try { rmSync(backup, { recursive: true, force: true }) } catch { /* Retain the recovery copy. */ }
  }
  return 'installed'
}
