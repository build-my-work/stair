import { expect, test } from 'bun:test'

// Keep config imports and the real persistence queue out of the grouped
// runner's module cache. The fixture owns its profile before importing them.
if (process.env.CRAFT_PENDING_PLAN_METADATA_TEST_CHILD === '1') {
  await import('./pending-plan-metadata-races.fixture.ts')
} else {
  test('pending-plan transitions preserve concurrent metadata in an isolated profile', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CRAFT_PENDING_PLAN_METADATA_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (run.exitCode !== 0) {
      throw new Error(`pending-plan metadata fixture failed (exit ${run.exitCode})\n${run.stdout.toString()}\n${run.stderr.toString()}`)
    }
    expect(run.exitCode).toBe(0)
  }, 30_000)
}
