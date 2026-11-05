import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { createHash } from 'node:crypto'
import { SkillMarketplace } from './marketplace'
import { readSkillArchive } from './archive'
import { parseGitHubSkillUrl, searchSkillCatalog, type SkillFetch } from './catalogs'
import { loadAllSkills, invalidateSkillsCache, fingerprintSkillDirectory, writeSkillDirectory } from '@craft-agent/shared/skills'
import type { BundleFile } from '@craft-agent/shared/utils/bundle-files'
import type { SkillImportSource } from '@craft-agent/shared/skills/marketplace'
import { importResources, exportResources } from '@craft-agent/shared/resources'

const directories: string[] = []
function workspace() {
  const path = mkdtempSync(join(tmpdir(), 'skill-market-test-'))
  directories.push(path)
  return path
}
function file(relativePath: string, content: string | Buffer, executable = false): BundleFile {
  const bytes = Buffer.from(content)
  return { relativePath, contentBase64: bytes.toString('base64'), size: bytes.length, executable }
}
function skill(name: string, body = 'Use the attached references.'): string {
  return '---\nname: ' + name + '\ndescription: A test skill\n---\n\n' + body
}
function folder(files: BundleFile[]): SkillImportSource { return { kind: 'folder', name: 'skills', files } }

function githubFetcher(archive: () => Buffer): SkillFetch {
  return async url => {
    const bytes = archive()
    if (url.includes('codeload.github.com')) return new Response(bytes)
    if (url.endsWith('/commits/main')) return Response.json({ sha: createHash('sha1').update(bytes).digest('hex') })
    if (url.includes('/commits/')) return new Response('', { status: 422 })
    return Response.json({ default_branch: 'main' })
  }
}

/** Stored ZIP fixtures let malformed paths, file modes and metadata exercise the real archive reader. */
function zip(entries: Array<{ name: string; content: string | Buffer; mode?: number; flags?: number; size?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const content = Buffer.from(entry.content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0x800, 6)
    local.writeUInt32LE(crc32(content), 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(entry.size ?? content.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0x800, 8)
    central.writeUInt32LE(crc32(content), 16)
    central.writeUInt32LE(content.length, 20)
    central.writeUInt32LE(entry.size ?? content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(Buffer.concat([local, name, content]))
    centrals.push(Buffer.concat([central, name]))
    offset += 30 + name.length + content.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  invalidateSkillsCache()
})

describe('reviewed skill installation', () => {
  test('folder with multiple skills installs only selected skill and all support files through the existing loader', async () => {
    const root = workspace()
    const service = new SkillMarketplace()
    const prepared = await service.prepare(root, 'client', folder([
      file('collection/one/SKILL.md', skill('one')),
      file('collection/one/references/notes.md', 'Reference material'),
      file('collection/one/scripts/run.sh', '#!/bin/sh\necho test', true),
      file('collection/one/assets/image.bin', Buffer.from([0, 1, 255])),
      file('collection/two/SKILL.md', skill('two')),
    ]))
    expect(prepared.candidates).toHaveLength(2)
    expect(existsSync(join(root, 'skills/one'))).toBe(false)
    expect(service.install(root, 'client', { token: prepared.token, candidateIds: ['collection/one'], replace: false }).installed).toEqual(['one'])
    expect(existsSync(join(root, 'skills/two'))).toBe(false)
    const loaded = loadAllSkills(root).find(s => s.slug === 'one')!
    expect(loaded.content).toContain('attached references')
    expect(loaded.installation?.contentHash).toBe(fingerprintSkillDirectory(loaded.path, true))
    expect(readFileSync(join(loaded.path, 'assets/image.bin'))).toEqual(Buffer.from([0, 1, 255]))
    if (process.platform !== 'win32') expect(statSync(join(loaded.path, 'scripts/run.sh')).mode & 0o111).not.toBe(0)
  })

  test('replacement is explicit, detects local changes and checks the reviewed snapshot before writing', async () => {
    const root = workspace()
    const service = new SkillMarketplace()
    const source = folder([file('one/SKILL.md', skill('one'))])
    let prepared = await service.prepare(root, 'client', source)
    service.install(root, 'client', { token: prepared.token, candidateIds: ['one'], replace: false })
    prepared = await service.prepare(root, 'client', source)
    expect(prepared.candidates[0]!.existing).toEqual({ modified: false, sameOrigin: true })
    expect(() => service.install(root, 'client', { token: prepared.token, candidateIds: ['one'], replace: false })).toThrow('Confirm replacement')
    writeFileSync(join(root, 'skills/one/local.txt'), 'keep this')
    expect(() => service.install(root, 'client', { token: prepared.token, candidateIds: ['one'], replace: true })).toThrow('changed since preview')
    prepared = await service.prepare(root, 'client', source)
    expect(prepared.candidates[0]!.existing?.modified).toBe(true)
    expect(readFileSync(join(root, 'skills/one/local.txt'), 'utf8')).toBe('keep this')
    expect(service.install(root, 'client', { token: prepared.token, candidateIds: ['one'], replace: true }).installed).toEqual(['one'])
    expect(existsSync(join(root, 'skills/one/local.txt'))).toBe(false)
    expect(readdirSync(join(root, 'skills'))).toEqual(['one'])
  })

  test('review tokens cannot be used by another client or workspace', async () => {
    const root = workspace()
    const other = workspace()
    const service = new SkillMarketplace()
    const prepared = await service.prepare(root, 'client', folder([file('one/SKILL.md', skill('one'))]))
    const request = { token: prepared.token, candidateIds: ['one'], replace: false }
    expect(() => service.install(other, 'client', request)).toThrow('Preview expired')
    expect(() => service.install(root, 'other', request)).toThrow('Preview expired')
    expect(() => service.install(root, 'client', { ...request, candidateIds: ['unknown'] })).toThrow('Unknown skill')
    expect(existsSync(join(root, 'skills/one'))).toBe(false)
  })

  test('duplicate slugs in one import never silently overwrite each other', async () => {
    const root = workspace()
    const service = new SkillMarketplace()
    const prepared = await service.prepare(root, 'client', folder([
      file('a/one/SKILL.md', skill('one')), file('b/one/SKILL.md', skill('one')),
    ]))
    expect(() => service.install(root, 'client', { token: prepared.token, candidateIds: prepared.candidates.map(c => c.id), replace: false })).toThrow('same slug')
    expect(existsSync(join(root, 'skills/one'))).toBe(false)
  })

  test('nested skills do not leak their files into the parent package', async () => {
    const prepared = await new SkillMarketplace().prepare(workspace(), 'client', folder([
      file('one/SKILL.md', skill('one')), file('one/two/SKILL.md', skill('two')),
    ]))
    expect(prepared.candidates.find(c => c.slug === 'one')!.files.map(f => f.path)).toEqual(['SKILL.md'])
  })

  test('failed staging preserves the previously installed directory', () => {
    const root = workspace()
    writeSkillDirectory(root, 'one', [file('SKILL.md', skill('one', 'old version'))], false)
    expect(() => writeSkillDirectory(root, 'one', [
      file('SKILL.md', skill('one', 'new version')), file('collision', 'file'), file('collision/child', 'child'),
    ], true)).toThrow()
    expect(readFileSync(join(root, 'skills/one/SKILL.md'), 'utf8')).toContain('old version')
    expect(readdirSync(join(root, 'skills'))).toEqual(['one'])
  })

  test('invalid and executable frontmatter cannot run during preview', async () => {
    const service = new SkillMarketplace()
    const root = workspace()
    await expect(service.prepare(root, 'client', folder([file('SKILL.md', '---\nname: bad\n---\ncontent')]))).rejects.toThrow()
    await expect(service.prepare(root, 'client', folder([file('SKILL.md',
      '---javascript\n({name: "bad", description: "bad", run: (() => { throw new Error("EXECUTED") })()})\n---\ncontent',
    )]))).rejects.toThrow('YAML frontmatter')
    expect(existsSync(join(root, 'skills'))).toBe(false)
  })

  test.each([1, 3])('%i late previews cannot invalidate the newer preview from the same client and workspace', async count => {
    const root = workspace()
    let release!: () => void
    let started!: () => void
    let downloads = 0
    const download = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const fetcher = githubFetcher(() => zip([{ name: 'repo/slow/SKILL.md', content: skill('slow') }]))
    const service = new SkillMarketplace(async (url, init) => {
      if (url.includes('codeload.github.com')) {
        if (++downloads === count) started()
        await download
      }
      return fetcher(url, init)
    })
    const pending = Array.from({ length: count }, () => service.prepare(root, 'client', { kind: 'github', url: 'https://github.com/owner/repo' }))
    await entered
    let newer
    try {
      newer = await service.prepare(root, 'client', folder([file('newer/SKILL.md', skill('newer'))]))
    } finally {
      release()
    }
    const older = await Promise.all(pending)
    expect(service.install(root, 'client', { token: newer.token, candidateIds: ['newer'], replace: false }).installed).toEqual(['newer'])
    if (count === 3) {
      expect(() => service.install(root, 'client', { token: older[0]!.token, candidateIds: ['slow'], replace: false })).toThrow('Preview expired')
    }
    expect(service.install(root, 'client', { token: older.at(-1)!.token, candidateIds: ['slow'], replace: false }).installed).toEqual(['slow'])
  })

  test('a Chinese folder name falls back to the skill name without changing valid directory slugs', async () => {
    const root = workspace()
    const service = new SkillMarketplace()
    const prepared = await service.prepare(root, 'client', folder([
      file('我的技能/SKILL.md', skill('code-review')),
      file('stable-directory/SKILL.md', skill('Display Title')),
    ]))
    expect(prepared.candidates.map(c => c.slug)).toEqual(['code-review', 'stable-directory'])
    expect(service.install(root, 'client', { token: prepared.token, candidateIds: ['我的技能'], replace: false }).installed).toEqual(['code-review'])
    expect(loadAllSkills(root).find(s => s.slug === 'code-review')?.metadata.name).toBe('code-review')
  })

  test.each(['github', '[" github ", "", "github", "notion"]'])('preview and installed loader agree on requiredSources: %s', async requiredSources => {
    const root = workspace()
    const service = new SkillMarketplace()
    const content = '---\nname: requirements\ndescription: Test requirements\nrequiredSources: ' + requiredSources + '\n---\nUse the required sources.'
    const prepared = await service.prepare(root, 'client', folder([file('requirements/SKILL.md', content)]))
    service.install(root, 'client', { token: prepared.token, candidateIds: ['requirements'], replace: false })
    const installed = loadAllSkills(root).find(s => s.slug === 'requirements')!
    expect(prepared.candidates[0]!.requiredSources).toEqual(installed.metadata.requiredSources!)
    expect(prepared.candidates[0]!.requiredSources).toEqual(requiredSources === 'github' ? ['github'] : ['github', 'notion'])
  })

  test('traversal, duplicate paths and symlink targets are rejected', async () => {
    const service = new SkillMarketplace()
    const root = workspace()
    await expect(service.prepare(root, 'client', folder([file('../SKILL.md', skill('one'))]))).rejects.toThrow('traversal')
    await expect(service.prepare(root, 'client', folder([file('one/SKILL.md', skill('one')), file('ONE/skill.md', 'other')]))).rejects.toThrow('Duplicate')
    mkdirSync(join(root, 'skills'))
    symlinkSync(workspace(), join(root, 'skills/one'), 'dir')
    await expect(service.prepare(root, 'client', folder([file('one/SKILL.md', skill('one'))]))).rejects.toThrow('symbolic link')
  })

  test('local ZIP preserves executable mode, binary assets, origin and resource-transfer compatibility', async () => {
    const root = workspace()
    const service = new SkillMarketplace()
    const bytes = zip([
      { name: 'one/SKILL.md', content: skill('one') },
      { name: 'one/scripts/run.sh', content: '#!/bin/sh\necho test', mode: 0o100755 },
      { name: 'one/assets/data.bin', content: Buffer.from([0, 12, 255]) },
    ])
    const prepared = await service.prepare(root, 'client', { kind: 'zip', name: 'one.zip', contentBase64: bytes.toString('base64') })
    service.install(root, 'client', { token: prepared.token, candidateIds: ['one'], replace: false })
    const { bundle } = await exportResources(root, { skills: ['one'] })
    const other = workspace()
    const result = await importResources(other, bundle, 'skip', { clearSourceCredentials: async () => {} })
    expect(result.skills.imported).toEqual(['one'])
    expect(readFileSync(join(other, 'skills/one/assets/data.bin'))).toEqual(Buffer.from([0, 12, 255]))
    expect(loadAllSkills(other).find(s => s.slug === 'one')!.installation?.source).toBe('zip')
    expect(fingerprintSkillDirectory(join(root, 'skills/one'))).toBe(fingerprintSkillDirectory(join(other, 'skills/one')))
  })
})

describe('archive boundaries', () => {
  test.each([
    ['../SKILL.md', 0o100644, 0x800],
    ['/SKILL.md', 0o100644, 0x800],
    ['SKILL.md', 0o120777, 0x800],
    ['SKILL.md', 0o100644, 0x801],
  ])('rejects unsafe archive %s mode %i flags %i', async (name, mode, flags) => {
    await expect(readSkillArchive(zip([{ name, content: skill('one'), mode, flags }]))).rejects.toThrow()
  })
  test('rejects corrupted contents and invalid ZIP metadata', async () => {
    const bytes = zip([{ name: 'SKILL.md', content: skill('one') }])
    bytes[30 + 'SKILL.md'.length + 1] ^= 1
    await expect(readSkillArchive(bytes)).rejects.toThrow('checksum')
    await expect(readSkillArchive(Buffer.from('not a zip'))).rejects.toThrow()
    await expect(readSkillArchive(zip([{ name: 'SKILL.md', content: 'a', size: 200 * 1024 * 1024 }]))).rejects.toThrow()
  })
})

describe('remote adapters', () => {
  test.each([
    { kind: 'github' as const, url: 'https://github.com/owner/repo/tree/main/skills/good' },
    { kind: 'github' as const, url: 'https://github.com/owner/repo', skill: 'good' },
    { kind: 'github' as const, url: 'https://github.com/owner/repo/tree/main', skillPath: 'skills/good' },
  ])('GitHub selection ignores symlinks outside the selected skill (%#)', async source => {
    const root = workspace()
    const service = new SkillMarketplace(githubFetcher(() => zip([
      { name: 'repo/CLAUDE.md', content: 'AGENTS.md', mode: 0o120777 },
      { name: 'repo/skills/other/SKILL.md', content: skill('other') },
      { name: 'repo/skills/other/reference', content: '../../secret', mode: 0o120777 },
      { name: 'repo/skills/good/SKILL.md', content: skill('good') },
      { name: 'repo/skills/good/references/notes.md', content: 'Read me' },
    ])))
    const prepared = await service.prepare(root, 'client', source)
    expect(prepared.candidates.map(c => c.id)).toEqual(['skills/good'])
    expect(service.install(root, 'client', { token: prepared.token, candidateIds: ['skills/good'], replace: false }).installed).toEqual(['good'])
    expect(readdirSync(join(root, 'skills/good')).sort()).toEqual(['SKILL.md', 'references', 'stair-install.json'])
    expect(readFileSync(join(root, 'skills/good/references/notes.md'), 'utf8')).toBe('Read me')
  })

  test.each(['references/notes.md', 'scripts/run.sh', 'nested'])('rejects symlinks inside the selected GitHub skill: %s', async path => {
    const service = new SkillMarketplace(githubFetcher(() => zip([
      { name: 'repo/good/SKILL.md', content: skill('good') },
      { name: 'repo/good/' + path, content: '../../outside', mode: 0o120777 },
    ])))
    await expect(service.prepare(workspace(), 'client', {
      kind: 'github', url: 'https://github.com/owner/repo', skill: 'good',
    })).rejects.toThrow('symbolic link')
  })

  test.each(['node_modules', '.git', '__MACOSX'])('GitHub ignores links in excluded %s directories but local archives remain strict', async excluded => {
    const bytes = zip([
      { name: 'repo/good/SKILL.md', content: skill('good') },
      { name: 'repo/good/' + excluded + '/link', content: '../../outside', mode: 0o120777 },
    ])
    const service = new SkillMarketplace(githubFetcher(() => bytes))
    const prepared = await service.prepare(workspace(), 'client', {
      kind: 'github', url: 'https://github.com/owner/repo', skill: 'good',
    })
    expect(prepared.candidates[0]!.files.map(file => file.path)).toEqual(['SKILL.md'])
    await expect(readSkillArchive(bytes)).rejects.toThrow('symbolic link')
  })

  test.each([
    '# Template without frontmatter',
    '---\nname: [broken\n---\nInstructions',
    '---javascript\nthrow new Error("EXECUTED")\n---\nInstructions',
    'x'.repeat(256 * 1024 + 1),
  ])('selected catalog skill ignores unrelated malformed templates (%#)', async template => {
    const fetcher = githubFetcher(() => zip([
      { name: 'repo/template/SKILL.md', content: template },
      { name: 'repo/good/SKILL.md', content: skill('good') },
    ]))
    const root = workspace()
    const service = new SkillMarketplace(fetcher)
    const prepared = await service.prepare(root, 'client', { kind: 'github', url: 'https://github.com/owner/repo', skill: 'good' })
    expect(prepared.candidates.map(c => c.id)).toEqual(['good'])
    expect(service.install(root, 'client', { token: prepared.token, candidateIds: ['good'], replace: false }).installed).toEqual(['good'])
    expect(existsSync(join(root, 'skills/template'))).toBe(false)
    await expect(service.prepare(root, 'client', { kind: 'github', url: 'https://github.com/owner/repo', skill: 'template' })).rejects.toThrow()
  })

  test.each(['', 'skills/stable-directory'])('updates use the exact installed path after a name change: "%s"', async path => {
    const root = workspace()
    let name = 'Original Title'
    const prefix = path ? path + '/' : ''
    const fetcher = githubFetcher(() => zip([
      { name: 'repo/' + prefix + 'SKILL.md', content: skill(name) },
      { name: 'repo/' + prefix + 'nested/SKILL.md', content: skill(name) },
    ]))
    const service = new SkillMarketplace(fetcher)
    const original = await service.prepare(root, 'client', { kind: 'github', url: 'https://github.com/owner/repo' })
    const candidate = original.candidates.find(c => c.id === (path || '.'))!
    service.install(root, 'client', { token: original.token, candidateIds: [candidate.id], replace: false })

    // An already-written installation record can still contain the old name-only update reference.
    const legacyRecord = { ...candidate.origin, updateSource: {
      kind: 'github', url: 'https://github.com/owner/repo/tree/main' + (path ? '/' + path : ''), skill: name,
    } }
    writeFileSync(join(root, 'skills', candidate.slug, 'stair-install.json'), JSON.stringify(legacyRecord))
    const legacySource = loadAllSkills(root).find(s => s.slug === candidate.slug)!.installation!.updateSource!
    name = 'Renamed Title'
    for (const source of [candidate.origin.updateSource!, legacySource]) {
      const update = await service.prepare(root, 'client', source)
      expect(update.candidates).toHaveLength(1)
      expect(update.candidates[0]!.id).toBe(candidate.id)
      expect(update.candidates[0]!.slug).toBe(candidate.slug)
      expect(update.candidates[0]!.name).toBe(name)
      expect(update.candidates[0]!.origin.identity).toBe(candidate.origin.identity)
      expect(update.candidates[0]!.origin.revision).not.toBe(candidate.origin.revision)
      expect(update.candidates[0]!.existing?.sameOrigin).toBe(true)
      expect(service.install(root, 'client', { token: update.token, candidateIds: [candidate.id], replace: true }).installed).toEqual([candidate.slug])
    }
    expect(loadAllSkills(root).find(s => s.slug === candidate.slug)?.metadata.name).toBe(name)
    expect(existsSync(join(root, 'skills/nested'))).toBe(false)
  })

  test.each(['', '   '])('skills.sh empty query "%s" returns the first 40 GitHub skills in leaderboard order', async query => {
    const calls: string[] = []
    const fetcher: SkillFetch = async url => {
      calls.push(url)
      return Response.json({ skills: [
        { name: 'external', skillId: 'external', source: 'skills.example.com' },
        ...Array.from({ length: 45 }, (_, index) => ({
          name: 'Skill ' + index, skillId: 'skill-' + index, source: 'owner/repo', installs: 1000 - index,
        })),
      ] })
    }
    const result = await searchSkillCatalog('skills-sh', query, fetcher)
    expect(calls).toEqual(['https://skills.sh/api/skills/all-time/0'])
    expect(result).toHaveLength(40)
    expect(result.map(entry => entry.name)).toEqual(Array.from({ length: 40 }, (_, index) => 'Skill ' + index))
    expect(result[0]).toEqual({
      id: 'skills-sh:owner/repo/skill-0', name: 'Skill 0', description: 'owner/repo', author: 'owner',
      market: 'skills-sh', url: 'https://skills.sh/owner/repo/skill-0',
      source: { kind: 'github', url: 'https://github.com/owner/repo', skill: 'skill-0' },
    })
  })
  test.each(['a', ' a '])('skills.sh short query "%s" does not request search or popular skills', async query => {
    let calls = 0
    expect(await searchSkillCatalog('skills-sh', query, async () => {
      calls += 1
      return Response.json({ skills: [] })
    })).toEqual([])
    expect(calls).toBe(0)
  })
  test('skills.sh search uses its public CLI endpoint and returns installable GitHub references', async () => {
    const calls: string[] = []
    const fetcher: SkillFetch = async url => {
      calls.push(url)
      return Response.json({ skills: [
        { id: 'owner/repo/one', name: 'one', skillId: 'one', source: 'owner/repo' },
        { id: 'external/one', name: 'one', skillId: 'one', source: 'skills.example.com' },
      ] })
    }
    const result = await searchSkillCatalog('skills-sh', 'one', fetcher)
    expect(calls).toEqual(['https://skills.sh/api/search?q=one&limit=40'])
    expect(result).toHaveLength(1)
    expect(result[0]!.source).toEqual({ kind: 'github', url: 'https://github.com/owner/repo', skill: 'one' })
  })
  test('skills.sh trims and encodes keywords without replacing empty search results with popular skills', async () => {
    const calls: string[] = []
    const result = await searchSkillCatalog('skills-sh', ' agent & notes ', async url => {
      calls.push(url)
      return Response.json({ skills: [] })
    })
    expect(calls).toEqual(['https://skills.sh/api/search?q=agent%20%26%20notes&limit=40'])
    expect(result).toEqual([])
  })
  test('skills.sh popular feed failures are surfaced instead of becoming empty results', async () => {
    await expect(searchSkillCatalog('skills-sh', '', async () => new Response('', { status: 503 })))
      .rejects.toThrow('skills.sh: HTTP 503')
  })
  test('GitHub catalog and directory links converge on the same immutable package identity', async () => {
    const sha = 'a'.repeat(40)
    const bytes = zip([{ name: 'repo-' + sha + '/skills/one/SKILL.md', content: skill('one') }])
    const fetcher: SkillFetch = async url => {
      if (url.includes('codeload.github.com')) return new Response(bytes)
      if (url.endsWith('/commits/main')) return Response.json({ sha })
      if (url.includes('/commits/')) return new Response('', { status: 422 })
      return Response.json({ default_branch: 'main' })
    }
    const root = workspace()
    const service = new SkillMarketplace(fetcher)
    const fromCatalog = await service.prepare(root, 'client', { kind: 'github', url: 'https://github.com/Owner/Repo', skill: 'one' })
    service.install(root, 'client', { token: fromCatalog.token, candidateIds: ['skills/one'], replace: false })
    const direct = await service.prepare(root, 'client', { kind: 'github', url: 'https://github.com/owner/repo/tree/main/skills/one' })
    expect(direct.candidates[0]!.origin.identity).toBe(fromCatalog.candidates[0]!.origin.identity)
    expect(direct.candidates[0]!.existing).toEqual({ modified: false, sameOrigin: true })
    expect(direct.candidates[0]!.origin.revision).toBe(sha)
    expect(parseGitHubSkillUrl('https://github.com/owner/repo/blob/main/skills/one/SKILL.md').tree).toEqual(['main', 'skills', 'one'])
    expect(() => parseGitHubSkillUrl('https://evil.example/owner/repo')).toThrow('public https')
  })
  test('EduHub pins the preview version and verifies every downloaded file against its manifest', async () => {
    const markdown = skill('one')
    const bytes = zip([{ name: 'SKILL.md', content: markdown }])
    let expectedHash = createHash('sha256').update(markdown).digest('hex')
    const fetcher: SkillFetch = async url => {
      if (url.includes('/download?')) {
        expect(url).toContain('version=1.0.0')
        return new Response(bytes)
      }
      return Response.json({
        latestVersion: { version: '1.0.0', license: 'MIT' },
        files: [{ path: 'SKILL.md', size: Buffer.byteLength(markdown), sha256: expectedHash }],
      })
    }
    const service = new SkillMarketplace(fetcher)
    const prepared = await service.prepare(workspace(), 'client', { kind: 'eduhub', slug: 'one' })
    expect(prepared.candidates[0]!.license).toBe('MIT')
    expectedHash = '0'.repeat(64)
    await expect(service.prepare(workspace(), 'client', { kind: 'eduhub', slug: 'one' })).rejects.toThrow('checksum mismatch')
  })
})
