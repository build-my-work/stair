import { expect, it } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('preserves queued session history across durable pending-plan transactions', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'pending-plan-durability-test-'))
  try {
    copyFileSync(
      resolve(import.meta.dir, '../../../../../apps/electron/resources/config-defaults.json'),
      join(configDir, 'config-defaults.json'),
    )
    const child = Bun.spawnSync([
      process.execPath,
      'test',
      join(import.meta.dir, 'pending-plan-durability.fixture.ts'),
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
