import { expect, it } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('checks pending-plan recovery boundaries against isolated real storage', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'pending-plan-recovery-test-'))
  try {
    copyFileSync(
      resolve(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'),
      join(configDir, 'config-defaults.json'),
    )
    const child = Bun.spawnSync([
      process.execPath,
      'test',
      join(import.meta.dir, 'pending-plan-recovery-boundaries.fixture.ts'),
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
