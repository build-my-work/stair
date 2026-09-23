import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  collectTestInventory,
  getTestGroup,
  isExternalTestFile,
  isIsolatedTestFile,
  isRegularTestFile,
} from './run-source-tests'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('source test discovery', () => {
  test('classifies supported test file names', () => {
    expect(isRegularTestFile('example.test.ts')).toBe(true)
    expect(isRegularTestFile('example.spec.tsx')).toBe(true)
    expect(isRegularTestFile('example.e2e.test.ts')).toBe(false)
    expect(isExternalTestFile('example.e2e.test.ts')).toBe(true)
    expect(isIsolatedTestFile('example.isolated.ts')).toBe(true)
    expect(isRegularTestFile('source-test.ts')).toBe(false)
  })

  test('finds source tests while excluding generated and external trees', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'source-test-discovery-'))
    temporaryDirectories.push(repoRoot)

    const files = [
      'apps/desktop/src/app.test.ts',
      'apps/desktop/release/copied.test.ts',
      'apps/online-docs/src/docs.test.ts',
      'packages/core/src/core.spec.ts',
      'packages/core/dist/copied.spec.ts',
      'packages/shared/src/task.isolated.ts',
      'packages/shared/src/oauth.e2e.test.ts',
      'scripts/runner.test.ts',
      'node_modules/dependency.test.ts',
    ]
    for (const file of files) {
      const fullPath = join(repoRoot, file)
      mkdirSync(join(fullPath, '..'), { recursive: true })
      writeFileSync(fullPath, '')
    }

    const inventory = collectTestInventory(repoRoot)
    const toRepoPaths = (paths: string[]) => paths.map((path) => relative(repoRoot, path))

    expect(toRepoPaths(inventory.regular)).toEqual([
      'apps/desktop/src/app.test.ts',
      'packages/core/src/core.spec.ts',
      'scripts/runner.test.ts',
    ])
    expect(toRepoPaths(inventory.isolated)).toEqual([
      'packages/shared/src/task.isolated.ts',
    ])
    expect(toRepoPaths(inventory.external)).toEqual([
      'packages/shared/src/oauth.e2e.test.ts',
    ])
  })

  test('uses one process group per workspace', () => {
    const repoRoot = '/repo'
    expect(getTestGroup('/repo/apps/electron/src/app.test.ts', repoRoot)).toBe(
      'apps/electron',
    )
    expect(getTestGroup('/repo/packages/shared/src/unit.test.ts', repoRoot)).toBe(
      'packages/shared',
    )
    expect(getTestGroup('/repo/scripts/check.test.ts', repoRoot)).toBe('scripts')
  })

  test('keeps successful test names visible in source-suite evidence', () => {
    const source = readFileSync(join(import.meta.dir, 'run-source-tests.ts'), 'utf8')
    expect(source).not.toContain('--reporter=dots')
  })
})
