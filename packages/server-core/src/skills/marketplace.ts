import { randomUUID } from 'node:crypto'
import { basename, posix, join } from 'node:path'
import matter from 'gray-matter'
import { validateSkillContent } from '@craft-agent/shared/config/validators'
import { validateBundleFile, type BundleFile } from '@craft-agent/shared/utils/bundle-files'
import {
  loadAllSkills, invalidateSkillsCache, writeSkillDirectory, hashSkillFiles,
  fingerprintSkillDirectory, readSkillInstallation, normalizeRequiredSources, SKILL_INSTALLATION_FILE,
} from '@craft-agent/shared/skills'
import {
  MAX_SKILL_UPLOAD_BYTES, MAX_SKILL_PACKAGE_BYTES, MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES,
  type SkillImportSource, type PreparedSkillImport, type SkillImportCandidate,
  type SkillInstallRequest, type SkillInstallResult,
} from '@craft-agent/shared/skills/marketplace'
import { resolveRemoteSkills, type ResolvedSkillSource, type SkillFetch } from './catalogs'
import { readSkillArchive } from './archive'

interface PreparedEntry {
  candidate: SkillImportCandidate
  files: BundleFile[]
  fingerprint?: string
}

/** Owns reviewed snapshots and installation. Tokens are scoped to a client and workspace. */
export class SkillMarketplace {
  private readonly pending = new Map<string, {
    owner: string; workspaceRoot: string; expiresAt: number; requestOrder: number; entries: PreparedEntry[]
  }>()
  private nextRequestOrder = 0

  constructor(private readonly fetcher: SkillFetch = fetch) {}

  async prepare(workspaceRoot: string, owner: string, source: SkillImportSource): Promise<PreparedSkillImport> {
    if (!source || typeof source !== 'object') throw new Error('Invalid skill source')
    const requestOrder = ++this.nextRequestOrder
    let resolved: ResolvedSkillSource
    if (source.kind === 'github' || source.kind === 'eduhub') {
      resolved = await resolveRemoteSkills(source, this.fetcher)
    } else if (source.kind === 'zip' || source.kind === 'folder') {
      if (typeof source.name !== 'string' || source.name.length > 255) throw new Error('Invalid upload name')
      let files: BundleFile[]
      if (source.kind === 'zip') {
        if (typeof source.contentBase64 !== 'string' || source.contentBase64.length > Math.ceil(MAX_SKILL_UPLOAD_BYTES / 3) * 4) {
          throw new Error('Local uploads must be at most 8 MB')
        }
        const bytes = Buffer.from(source.contentBase64, 'base64')
        if (bytes.length > MAX_SKILL_UPLOAD_BYTES) throw new Error('Local uploads must be at most 8 MB')
        files = await readSkillArchive(bytes)
      } else {
        files = source.files
        if (!Array.isArray(files) || files.length > 10000
          || files.reduce((sum, f) => sum + (typeof f?.size === 'number' ? f.size : Infinity), 0) > MAX_SKILL_UPLOAD_BYTES) {
          throw new Error('Local uploads must be at most 8 MB')
        }
      }
      resolved = {
        files, identityPrefix: source.kind + ':' + source.name,
        origin: { schemaVersion: 1, source: source.kind },
      }
    } else throw new Error('Unsupported skill source')

    const paths = new Set<string>()
    let total = 0
    for (const file of resolved.files) {
      const invalid = validateBundleFile(file)
      if (invalid || file.relativePath.split('/').some(p => p === '.' || /[\x00-\x1f:]/.test(p))
        || paths.has(file.relativePath.toLowerCase())) throw new Error(invalid ?? 'Duplicate or invalid file path')
      paths.add(file.relativePath.toLowerCase())
      total += file.size
      if (total > 100 * 1024 * 1024) throw new Error('Import exceeds 100 MB')
    }
    const roots = resolved.files.filter(f => posix.basename(f.relativePath) === 'SKILL.md')
      .map(file => {
        const directory = posix.dirname(file.relativePath)
        return directory === '.' ? '' : directory
      })
    const installed = loadAllSkills(workspaceRoot).filter(skill => skill.source === 'workspace')
    const entries: PreparedEntry[] = []
    const nameFilter = resolved.skillPath === undefined ? resolved.skill : undefined
    let previewBytes = 0
    for (const root of roots) {
      if (resolved.subpath && root !== resolved.subpath && !root.startsWith(resolved.subpath + '/')) continue
      if (resolved.skillPath !== undefined && root !== resolved.skillPath) continue
      const prefix = root ? root + '/' : ''
      const nestedRoots = roots.filter(other => other !== root && other.startsWith(prefix))
      const files = resolved.files.filter(f => f.relativePath.startsWith(prefix)
        && !nestedRoots.some(nested => f.relativePath.startsWith(nested + '/')))
        .map(f => ({ ...f, relativePath: f.relativePath.slice(prefix.length) }))
        .filter(f => f.relativePath !== SKILL_INSTALLATION_FILE)
      const markdown = files.find(f => f.relativePath === 'SKILL.md')!
      const directorySlug = (resolved.slug || (root ? basename(root) : ''))
        .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
      let text: string
      let parsed: ReturnType<typeof matter>
      try {
        if (markdown.size > 256 * 1024) throw new Error('SKILL.md exceeds 256 KB')
        text = Buffer.from(markdown.contentBase64, 'base64').toString('utf8')
        // gray-matter also ships an executable JavaScript engine. Imports accept YAML only.
        if (!/^\uFEFF?---(?:yaml)?[ \t]*\r?\n/.test(text)) throw new Error('SKILL.md must use YAML frontmatter')
        parsed = matter(text)
      } catch (error) {
        // A catalog lookup must not be blocked by an unrelated repository template.
        if (nameFilter && nameFilter !== directorySlug) continue
        throw error
      }
      const importedSlug = directorySlug || String(parsed.data.name || '')
        .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
      if (nameFilter && nameFilter !== importedSlug && nameFilter !== parsed.data.name) continue
      if (resolved.symbolicLinks?.some(path => path === root || root.startsWith(path + '/')
        || (path.startsWith(prefix) && !nestedRoots.some(nested => path.startsWith(nested + '/'))))) {
        throw new Error((root || 'SKILL.md') + ': Skills with symbolic links are not supported')
      }
      const identity = resolved.identityPrefix + (resolved.origin.source === 'eduhub' ? '' : ':' + root)
      // Reuse the existing destination even when the catalog supplied a different display name.
      const slug = installed.find(s => s.installation?.identity === identity)?.slug ?? importedSlug
      const validation = validateSkillContent(text, slug)
      if (!validation.valid) throw new Error((root || 'SKILL.md') + ': ' + validation.errors.map(e => e.message).join('; '))
      if (files.length > MAX_SKILL_FILES || files.some(f => f.size > MAX_SKILL_FILE_BYTES)
        || files.reduce((sum, f) => sum + f.size, 0) > MAX_SKILL_PACKAGE_BYTES) {
        throw new Error('Skill exceeds 600 files, 4 MB per file, or 40 MB total')
      }
      previewBytes += markdown.size
      if (entries.length >= 100 || previewBytes > 4 * 1024 * 1024) throw new Error('Select a smaller skill directory')
      const target = join(workspaceRoot, 'skills', slug)
      const fingerprint = fingerprintSkillDirectory(target)
      const existing = readSkillInstallation(target)
      const candidate: SkillImportCandidate = {
        id: root || '.', slug, name: parsed.data.name, description: parsed.data.description,
        content: parsed.content,
        license: typeof parsed.data.license === 'string' ? parsed.data.license : resolved.license,
        compatibility: typeof parsed.data.compatibility === 'string' ? parsed.data.compatibility : undefined,
        requiredSources: normalizeRequiredSources(parsed.data.requiredSources) ?? [],
        alwaysAllow: Array.isArray(parsed.data.alwaysAllow) ? parsed.data.alwaysAllow.filter((s: unknown) => typeof s === 'string') : [],
        files: files.map(f => ({ path: f.relativePath, size: f.size })),
        origin: {
          ...resolved.origin, identity, subpath: root, installedAt: new Date().toISOString(),
          contentHash: hashSkillFiles(files),
          updateSource: resolved.origin.updateSource?.kind === 'github'
            ? { ...resolved.origin.updateSource, skillPath: root } : resolved.origin.updateSource,
        },
        existing: fingerprint ? {
          sameOrigin: existing?.identity === identity,
          modified: !existing || existing.contentHash !== fingerprintSkillDirectory(target, true),
        } : undefined,
      }
      entries.push({ candidate, files, fingerprint })
    }
    if (!entries.length) throw new Error('No matching SKILL.md found')
    // Each preview owns its token, even when another request from the same client finishes later.
    // Expire abandoned previews and cap retained package memory. No background daemon or disk cache.
    for (const [key, value] of this.pending) {
      if (value.expiresAt < Date.now()) this.pending.delete(key)
    }
    const token = randomUUID()
    const expiresAt = Date.now() + 15 * 60 * 1000
    this.pending.set(token, { owner, workspaceRoot, expiresAt, requestOrder, entries })
    // Keep the latest requests, not the latest completions: old downloads may finish last.
    while (this.pending.size > 3) {
      const oldest = [...this.pending].sort(([, a], [, b]) => a.requestOrder - b.requestOrder)[0]!
      this.pending.delete(oldest[0])
    }
    return { token, expiresAt, candidates: entries.map(e => e.candidate) }
  }

  install(workspaceRoot: string, owner: string, request: SkillInstallRequest): SkillInstallResult {
    const prepared = this.pending.get(request?.token)
    if (!prepared || prepared.owner !== owner || prepared.workspaceRoot !== workspaceRoot
      || prepared.expiresAt < Date.now()) throw new Error('Preview expired; open the skill again')
    if (!Array.isArray(request.candidateIds) || !request.candidateIds.length
      || new Set(request.candidateIds).size !== request.candidateIds.length) throw new Error('Select skills to install')
    const selected = request.candidateIds.map(id => {
      const entry = prepared.entries.find(e => e.candidate.id === id)
      if (!entry) throw new Error('Unknown skill selection')
      return entry
    })
    if (new Set(selected.map(e => e.candidate.slug)).size !== selected.length) throw new Error('Selected skills have the same slug; install them separately')
    for (const entry of selected) {
      const target = join(workspaceRoot, 'skills', entry.candidate.slug)
      if (fingerprintSkillDirectory(target) !== entry.fingerprint) throw new Error('Skill changed since preview; open it again')
      if (entry.fingerprint && request.replace !== true) throw new Error('Confirm replacement of existing skills')
    }
    const result: SkillInstallResult = { installed: [], failed: [] }
    for (const entry of selected) {
      const { candidate, files } = entry
      try {
        const record = Buffer.from(JSON.stringify(candidate.origin, null, 2) + '\n')
        writeSkillDirectory(workspaceRoot, candidate.slug, [
          ...files, { relativePath: SKILL_INSTALLATION_FILE, contentBase64: record.toString('base64'), size: record.length },
        ], request.replace === true)
        result.installed.push(candidate.slug)
        prepared.entries = prepared.entries.filter(e => e !== entry)
      } catch (error) {
        result.failed.push({ slug: candidate.slug, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (!prepared.entries.length) this.pending.delete(request.token)
    invalidateSkillsCache()
    return result
  }
}
