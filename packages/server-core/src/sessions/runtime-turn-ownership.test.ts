import { expect, it } from 'bun:test'
import { join } from 'node:path'

it('keeps connection refresh within the owning turn against isolated real runtimes', () => {
  const child = Bun.spawnSync([
    process.execPath,
    'test',
    join(import.meta.dir, 'runtime-turn-ownership.fixture.ts'),
  ], {
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  expect(child.exitCode).toBe(0)
}, 30_000)
