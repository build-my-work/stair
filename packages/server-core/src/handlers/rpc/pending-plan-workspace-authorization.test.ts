import { expect, test } from 'bun:test'

if (process.env.CRAFT_PENDING_PLAN_WORKSPACE_TEST_CHILD === '1') {
  await import('./pending-plan-workspace-authorization.fixture.ts')
} else {
  test('pending-plan RPCs preserve Workspace ownership in an isolated profile', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CRAFT_PENDING_PLAN_WORKSPACE_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (run.exitCode !== 0) {
      throw new Error(`pending-plan Workspace fixture failed (exit ${run.exitCode})\n${run.stdout.toString()}\n${run.stderr.toString()}`)
    }
    expect(run.exitCode).toBe(0)
  }, 30_000)
}
