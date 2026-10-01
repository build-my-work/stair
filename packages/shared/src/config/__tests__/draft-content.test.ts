import { expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Storage captures CRAFT_CONFIG_DIR at module load. Keep its imports in a
// child process so other test files cannot redirect this suite's profile.
if (process.env.CRAFT_DRAFT_CONTENT_TEST_CHILD === '1') {
  await import('./draft-content.fixture.ts')
} else {
  test('draft content mutation and recovery contract uses an isolated profile', () => {
    const profile = mkdtempSync(join(tmpdir(), 'craft-draft-content-test-'))
    try {
      copyFileSync(
        join(import.meta.dir, '../../../../../apps/electron/resources/config-defaults.json'),
        join(profile, 'config-defaults.json'),
      )
      const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
        env: {
          ...process.env,
          CRAFT_CONFIG_DIR: profile,
          CRAFT_DRAFT_CONTENT_TEST_CHILD: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (run.exitCode !== 0) {
        throw new Error(`draft content fixture failed (exit ${run.exitCode})\n${run.stdout.toString()}\n${run.stderr.toString()}`)
      }
      expect(run.exitCode).toBe(0)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30_000)
}
