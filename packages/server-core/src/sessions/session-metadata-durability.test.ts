import { expect, test } from 'bun:test'

if (process.env.CRAFT_METADATA_DURABILITY_TEST_CHILD === '1') {
  await import('./session-metadata-durability.fixture.ts')
} else {
  test('metadata updates preserve durable session state in an isolated profile', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CRAFT_METADATA_DURABILITY_TEST_CHILD: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    if (run.exitCode !== 0) throw new Error(`metadata durability fixture failed\n${run.stdout.toString()}\n${run.stderr.toString()}`)
    expect(run.exitCode).toBe(0)
  }, 30_000)
}
