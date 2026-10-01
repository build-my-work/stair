import { expect, it } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

it('runs connection-runtime refresh against isolated configured connections', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'runtime-refresh-test-profile-'))
  try {
    copyFileSync(
      resolve(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'),
      join(configDir, 'config-defaults.json'),
    )
    const child = Bun.spawnSync([
      process.execPath,
      'test',
      join(import.meta.dir, 'refresh-connection-runtime.fixture.ts'),
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
