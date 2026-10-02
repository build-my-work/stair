import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('Pi steering admission and cancellation retain durable input ownership', () => {
  const child = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'pi-steering-lifecycle.fixture.ts')], {
    env: process.env, stdout: 'inherit', stderr: 'inherit',
  })
  expect(child.exitCode).toBe(0)
}, 30_000)
