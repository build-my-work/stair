import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('OAuth client lifecycle preserves ownership through preparation, exchange and disconnect', () => {
  const run = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'oauth-client-lifecycle.fixture.ts')], {
    env: process.env, stdout: 'pipe', stderr: 'pipe',
  })
  if (run.exitCode !== 0) throw new Error(`${run.stdout.toString()}\n${run.stderr.toString()}`)
  expect(run.exitCode).toBe(0)
}, 30_000)
