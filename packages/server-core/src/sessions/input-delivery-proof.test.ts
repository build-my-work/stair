import { expect, it } from 'bun:test'
import { join } from 'node:path'

for (const fixture of ['input-delivery-proof.fixture.ts', 'claude-input-delivery.fixture.ts']) {
  it(`checks real input delivery without providers (${fixture})`, () => {
    const child = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, fixture)], {
      env: process.env,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    expect(child.exitCode).toBe(0)
  }, 30_000)
}
