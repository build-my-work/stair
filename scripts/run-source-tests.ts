import { existsSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const SOURCE_ROOTS = ['apps', 'packages', 'scripts']
const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'release',
  'tmp',
  'vendor',
])
const EXCLUDED_SOURCE_PREFIXES = ['apps/online-docs/']

export type TestInventory = {
  regular: string[]
  isolated: string[]
  external: string[]
}

export function isIsolatedTestFile(fileName: string): boolean {
  return fileName.endsWith('.isolated.ts')
}

export function isExternalTestFile(fileName: string): boolean {
  return /\.e2e\.(?:test|spec)\.[cm]?[jt]sx?$/.test(fileName)
}

export function isRegularTestFile(fileName: string): boolean {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(fileName) &&
    !isExternalTestFile(fileName)
  )
}

export function collectTestInventory(repoRoot: string): TestInventory {
  const inventory: TestInventory = { regular: [], isolated: [], external: [] }

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIR_NAMES.has(entry.name)) continue

      const fullPath = resolve(directory, entry.name)
      const repoPath = relative(repoRoot, fullPath).split(sep).join('/')
      if (EXCLUDED_SOURCE_PREFIXES.some((prefix) => `${repoPath}/`.startsWith(prefix))) {
        continue
      }

      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() && isIsolatedTestFile(entry.name)) {
        inventory.isolated.push(fullPath)
      } else if (entry.isFile() && isExternalTestFile(entry.name)) {
        inventory.external.push(fullPath)
      } else if (entry.isFile() && isRegularTestFile(entry.name)) {
        inventory.regular.push(fullPath)
      }
    }
  }

  for (const sourceRoot of SOURCE_ROOTS) {
    const directory = resolve(repoRoot, sourceRoot)
    if (existsSync(directory)) walk(directory)
  }

  inventory.regular.sort()
  inventory.isolated.sort()
  inventory.external.sort()
  return inventory
}

export function getTestGroup(filePath: string, repoRoot: string): string {
  const [scope, workspace] = relative(repoRoot, filePath).split(sep)
  if ((scope === 'apps' || scope === 'packages') && workspace) {
    return `${scope}/${workspace}`
  }
  return scope || '.'
}

async function runTestProcess(label: string, files: string[]): Promise<void> {
  console.log(`\n[tests] ${label} (${files.length} file${files.length === 1 ? '' : 's'})`)
  const testPaths = files.map((file) => `./${relative(REPO_ROOT, file).split(sep).join('/')}`)
  const child = Bun.spawn({
    cmd: [process.execPath, 'test', ...testPaths],
    cwd: REPO_ROOT,
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`)
  }
}

async function main(): Promise<void> {
  const inventory = collectTestInventory(REPO_ROOT)

  if (process.argv.includes('--external')) {
    if (inventory.external.length === 0) {
      console.log('[tests] No external tests found.')
      return
    }
    await runTestProcess('external', inventory.external)
    return
  }

  const groups = new Map<string, string[]>()
  for (const file of inventory.regular) {
    const group = getTestGroup(file, REPO_ROOT)
    const files = groups.get(group) ?? []
    files.push(file)
    groups.set(group, files)
  }

  for (const [group, files] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    await runTestProcess(group, files)
  }

  for (const file of inventory.isolated) {
    await runTestProcess(`isolated: ${relative(REPO_ROOT, file)}`, [file])
  }

  console.log(
    `\n[tests] Source suite passed: ${inventory.regular.length} regular files, ` +
      `${inventory.isolated.length} isolated files.`,
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`\n[tests] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
