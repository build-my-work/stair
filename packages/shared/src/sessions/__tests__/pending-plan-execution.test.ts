import { expect, it } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('runs pending-plan persistence and draft consumption in an isolated profile', () => {
  // Source tests share a module cache within each workspace. A subprocess
  // prevents another file's cached CONFIG_DIR from selecting a real profile.
  const configDir = mkdtempSync(join(tmpdir(), 'pending-plan-test-profile-'))
  try {
    copyFileSync(
      resolve(import.meta.dir, '../../../../../apps/electron/resources/config-defaults.json'),
      join(configDir, 'config-defaults.json'),
    )
    const child = Bun.spawnSync([
      process.execPath,
      'test',
      join(import.meta.dir, 'pending-plan-execution.fixture.ts'),
    ], {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    expect(child.exitCode).toBe(0)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}, 30_000)
