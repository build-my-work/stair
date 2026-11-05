import { createHash } from 'node:crypto'
import type { BundleFile } from '@craft-agent/shared/utils/bundle-files'
import type { SkillCatalogEntry, SkillInstallation, SkillMarket, SkillRemoteSource } from '@craft-agent/shared/skills/marketplace'
import { readSkillArchive } from './archive'

export type SkillFetch = (url: string, init?: RequestInit) => Promise<Response>
const EDUHUB = 'https://eduhub.deeptutor.info'

async function request(url: string, fetcher: SkillFetch, json: true): Promise<any>
async function request(url: string, fetcher: SkillFetch, json: false): Promise<Buffer>
async function request(url: string, fetcher: SkillFetch, json: boolean): Promise<any> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(25000), redirect: 'error',
    headers: { Accept: json ? 'application/json' : 'application/zip' },
  })
  if (!response.ok) throw new Error(new URL(url).hostname + ': HTTP ' + response.status)
  if (!response.body) throw new Error('Empty response')
  const limit = (json ? 2 : 20) * 1024 * 1024
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) throw new Error('Download exceeds size limit')
      chunks.push(part.value)
    }
  } finally { await reader.cancel() }
  const bytes = Buffer.concat(chunks)
  return json ? JSON.parse(bytes.toString('utf8')) : bytes
}

export async function searchSkillCatalog(market: SkillMarket, query: string, fetcher: SkillFetch = fetch): Promise<SkillCatalogEntry[]> {
  if (typeof query !== 'string' || query.length > 200) throw new Error('Invalid search query')
  const q = query.trim()
  if (market === 'eduhub') {
    const path = q ? '/api/v1/search?q=' + encodeURIComponent(q) + '&limit=40' : '/api/v1/skills?limit=40'
    const data = await request(EDUHUB + path, fetcher, true)
    return (q ? data.results : data.skills).map((entry: any) => ({
      id: 'eduhub:' + entry.slug, name: entry.displayName || entry.slug,
      description: entry.summary || '', author: entry.owner?.displayName || entry.ownerHandle,
      version: entry.version, market, url: EDUHUB + '/skills/' + encodeURIComponent(entry.slug),
      source: { kind: 'eduhub', slug: entry.slug, version: entry.version },
    }))
  }
  if (market !== 'skills-sh') throw new Error('Unknown skill catalog')
  if (q.length === 1) return []
  // Empty queries use the website's default leaderboard; keyword search requires two characters.
  const path = q ? '/api/search?q=' + encodeURIComponent(q) + '&limit=40' : '/api/skills/all-time/0'
  const data = await request('https://skills.sh' + path, fetcher, true)
  // The directory also indexes external hosts; only repository-backed entries use this installer.
  return data.skills.filter((entry: any) => typeof entry.source === 'string'
    && /^[\w.-]+\/[\w.-]+$/.test(entry.source) && typeof entry.skillId === 'string').slice(0, 40).map((entry: any) => {
    // Leaderboard entries omit the id supplied by the search endpoint.
    const id = entry.id ?? entry.source + '/' + entry.skillId
    return {
      id: 'skills-sh:' + id, name: entry.name || entry.skillId,
      description: entry.source, author: entry.source.split('/')[0], market,
      url: 'https://skills.sh/' + id,
      source: { kind: 'github', url: 'https://github.com/' + entry.source, skill: entry.skillId },
    }
  })
}

export interface ResolvedSkillSource {
  files: BundleFile[]
  symbolicLinks?: string[]
  origin: Omit<SkillInstallation, 'installedAt' | 'contentHash' | 'identity'>
  identityPrefix: string
  subpath?: string
  skill?: string
  skillPath?: string
  slug?: string
  license?: string
}

export function parseGitHubSkillUrl(input: string): { repository: string; tree: string[] } {
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) {
    throw new Error('Use a public https://github.com/owner/repository link')
  }
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const owner = parts[0]
  const repo = parts[1]?.replace(/\.git$/, '')
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)
    || parts.some(p => p === '.' || p === '..' || p.includes('/') || p.includes('\\'))
    || (parts.length > 2 && !['tree', 'blob'].includes(parts[2]!))) throw new Error('Invalid GitHub repository or skill directory URL')
  const tree = parts.slice(3)
  if (parts[2] === 'blob') {
    if (tree.at(-1) !== 'SKILL.md') throw new Error('File links must point to SKILL.md')
    tree.pop()
  }
  if (parts.length > 2 && !tree.length) throw new Error('GitHub link is missing a revision')
  return { repository: owner + '/' + repo, tree }
}

export async function resolveRemoteSkills(source: SkillRemoteSource, fetcher: SkillFetch = fetch): Promise<ResolvedSkillSource> {
  // One deadline for the entire resolution, within the existing RPC request timeout.
  const deadline = AbortSignal.timeout(25000)
  const remote: SkillFetch = (url, init) => fetcher(url, { ...init, signal: deadline })
  if (source.kind === 'eduhub') {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(source.slug)) throw new Error('Invalid EduHub skill')
    const detail = await request(EDUHUB + '/api/v1/skills/' + source.slug + '?files=true'
      + (source.version ? '&version=' + encodeURIComponent(source.version) : ''), remote, true)
    const revision = source.version || detail.latestVersion?.version
    if (!revision) throw new Error('EduHub skill has no version')
    const files = await readSkillArchive(await request(EDUHUB + '/api/v1/download?slug=' + source.slug
      + '&version=' + encodeURIComponent(revision), remote, false))
    if (!Array.isArray(detail.files) || detail.files.length !== files.length) throw new Error('EduHub package manifest does not match download')
    for (const file of files) {
      const expected = detail.files.find((entry: any) => entry.path === file.relativePath)
      const hash = createHash('sha256').update(Buffer.from(file.contentBase64, 'base64')).digest('hex')
      if (!expected || expected.size !== file.size || expected.sha256 !== hash) throw new Error('EduHub package checksum mismatch')
    }
    return {
      files, slug: source.slug, identityPrefix: 'eduhub:' + source.slug,
      license: detail.latestVersion?.license,
      origin: { schemaVersion: 1, source: 'eduhub', url: EDUHUB + '/skills/' + source.slug, revision,
        updateSource: { kind: 'eduhub', slug: source.slug } },
    }
  }
  if (source.kind !== 'github') throw new Error('Unsupported remote source')
  if (source.skillPath !== undefined && typeof source.skillPath !== 'string') throw new Error('Invalid GitHub skill path')
  const { repository, tree } = parseGitHubSkillUrl(source.url)
  const api = 'https://api.github.com/repos/' + repository
  let ref: string
  let subpath = ''
  let commit: { sha: string } | undefined
  if (!tree.length) {
    const repo = await request(api, remote, true)
    ref = repo.default_branch
    commit = await request(api + '/commits/' + encodeURIComponent(ref), remote, true)
  } else {
    // Git branch names may contain '/'; resolve the longest valid ref before interpreting the directory.
    ref = ''
    for (let length = Math.min(tree.length, 12); length >= 1; length--) {
      try {
        const candidate = tree.slice(0, length).join('/')
        commit = await request(api + '/commits/' + encodeURIComponent(candidate), remote, true)
        ref = candidate
        subpath = tree.slice(length).join('/')
        break
      } catch (error) {
        if (!(error instanceof Error) || !(/HTTP (404|422)$/.test(error.message))) throw error
      }
    }
  }
  if (!commit || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('GitHub revision not found')
  const symbolicLinks: string[] = []
  const archived = await readSkillArchive(await request('https://codeload.github.com/' + repository + '/zip/' + commit.sha, remote, false),
    path => symbolicLinks.push(path.slice(path.indexOf('/') + 1)))
  const files = archived.map(file => ({ ...file, relativePath: file.relativePath.slice(file.relativePath.indexOf('/') + 1) }))
  return {
    files, symbolicLinks, subpath, skill: source.skill, skillPath: source.skillPath, identityPrefix: 'github:' + repository.toLowerCase(),
    origin: { schemaVersion: 1, source: 'github', url: 'https://github.com/' + repository,
      revision: commit.sha, updateSource: { kind: 'github',
        url: 'https://github.com/' + repository + '/tree/' + ref.split('/').map(encodeURIComponent).join('/') } },
  }
}
