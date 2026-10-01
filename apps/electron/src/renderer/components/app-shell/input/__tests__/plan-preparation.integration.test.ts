import { expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('runs real plan preparation, coordinator and host in an isolated profile', () => {
  const profile = mkdtempSync(join(tmpdir(), 'stair-plan-preparation-profile-'))
  try {
    const repo = resolve(import.meta.dir, '../../../../../../../..')
    copyFileSync(join(repo, 'apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
    const child = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'plan-preparation.fixture.ts')], {
      env: { ...process.env, CRAFT_CONFIG_DIR: profile }, stdout: 'inherit', stderr: 'inherit',
    })
    expect(child.exitCode).toBe(0)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}, 30_000)
