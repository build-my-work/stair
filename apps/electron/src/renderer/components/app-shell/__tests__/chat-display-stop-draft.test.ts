import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('ChatDisplay Stop uses host cancellation and preserves draft ownership', () => {
  const run = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'chat-display-stop-draft.isolated.ts')], { stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(run.stdout.toString() + run.stderr.toString())
  expect(run.exitCode).toBe(0)
}, 15_000)
