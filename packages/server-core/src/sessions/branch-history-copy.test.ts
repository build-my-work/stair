import { expect, test } from 'bun:test'

if (process.env.STAIR_BRANCH_COPY_TEST_CHILD === '1') {
  await import('./branch-history-copy.fixture.ts')
} else {
  test('branch copies preserve historical content and own usable files', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, STAIR_BRANCH_COPY_TEST_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe',
    })
    if (run.exitCode !== 0) throw new Error(run.stdout.toString() + run.stderr.toString())
    expect(run.exitCode).toBe(0)
  }, 30000)
}
