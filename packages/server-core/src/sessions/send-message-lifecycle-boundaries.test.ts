import { expect, test } from 'bun:test'

// Keep config imports and real persistence out of the grouped runner's cache.
if (process.env.CRAFT_SEND_LIFECYCLE_TEST_CHILD === '1') {
  await import('./send-message-lifecycle-boundaries.fixture.ts')
} else {
  test('send lifecycle boundaries preserve warm sends in an isolated profile', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CRAFT_SEND_LIFECYCLE_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (run.exitCode !== 0) {
      throw new Error(`send lifecycle fixture failed (exit ${run.exitCode})\n${run.stdout.toString()}\n${run.stderr.toString()}`)
    }
    expect(run.exitCode).toBe(0)
  }, 30_000)
}
