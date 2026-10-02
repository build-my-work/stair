import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('failed input recovery writes preserve input and complete cleanup without unhandled rejections', () => {
  const child = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'input-recovery-persistence.fixture.ts')], {
    env: process.env, stdout: 'pipe', stderr: 'pipe',
  })
  if (child.exitCode !== 0) throw new Error(`${child.stdout.toString()}\n${child.stderr.toString()}`)
  expect(child.exitCode).toBe(0)
}, 30_000)
