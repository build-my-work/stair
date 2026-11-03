import type { BundleFile } from '../utils/bundle-files'

/** Browser-safe contracts. Catalogs discover skills; every source prepares the same installable package. */
export type SkillMarket = 'eduhub' | 'skills-sh'
export type SkillRemoteSource =
  | { kind: 'eduhub'; slug: string; version?: string }
  | {
    kind: 'github'
    url: string
    skill?: string
    /** Exact repository-relative skill directory for updates; an empty string selects the root. */
    skillPath?: string
  }
export type SkillImportSource = SkillRemoteSource
  | { kind: 'folder'; name: string; files: BundleFile[] }
  | { kind: 'zip'; name: string; contentBase64: string }

export const MAX_SKILL_UPLOAD_BYTES = 8 * 1024 * 1024
export const MAX_SKILL_PACKAGE_BYTES = 40 * 1024 * 1024
export const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024
export const MAX_SKILL_FILES = 600

export interface SkillCatalogEntry {
  id: string
  name: string
  description: string
  author?: string
  version?: string
  market: SkillMarket
  url: string
  source: SkillRemoteSource
}

export interface SkillInstallation {
  schemaVersion: 1
  /** Same GitHub repository + skill directory, independent of discovery catalog. */
  identity: string
  source: 'eduhub' | 'github' | 'folder' | 'zip'
  url?: string
  revision?: string
  subpath?: string
  installedAt: string
  contentHash: string
  updateSource?: SkillRemoteSource
}

export interface SkillImportCandidate {
  id: string
  slug: string
  name: string
  description: string
  content: string
  license?: string
  compatibility?: string
  requiredSources: string[]
  alwaysAllow: string[]
  files: Array<{ path: string; size: number }>
  origin: SkillInstallation
  existing?: { modified: boolean; sameOrigin: boolean }
}

export interface PreparedSkillImport {
  token: string
  candidates: SkillImportCandidate[]
  expiresAt: number
}

export interface SkillInstallRequest {
  token: string
  candidateIds: string[]
  replace: boolean
}

export interface SkillInstallResult {
  installed: string[]
  failed: Array<{ slug: string; error: string }>
}
