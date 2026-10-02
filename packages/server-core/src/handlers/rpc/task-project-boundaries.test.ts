import { expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Task bindings preserve Project and Workspace ownership over RPC and storage', () => {
  const profile = mkdtempSync(join(tmpdir(), 'stair-task-boundaries-'))
  try {
    const repo = resolve(import.meta.dir, '../../../../..')
    copyFileSync(join(repo, 'apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
    const child = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'task-project-boundaries.fixture.ts')], {
      env: { ...process.env, CRAFT_CONFIG_DIR: profile }, stdout: 'pipe', stderr: 'pipe',
    })
    if (child.exitCode !== 0) {
      throw new Error(`Task ownership fixture failed\n${child.stdout.toString()}\n${child.stderr.toString()}`)
    }
    expect(child.exitCode).toBe(0)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}, 30_000)
