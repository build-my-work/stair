import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('durable auth continuation preserves input, ownership and disk failure boundaries', () => {
  const child = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'auth-continuation.fixture.ts')], {
    env: process.env, stdout: 'pipe', stderr: 'pipe',
  })
  if (child.exitCode !== 0) throw new Error(`${child.stdout.toString()}\n${child.stderr.toString()}`)
  expect(child.exitCode).toBe(0)
}, 30_000)
