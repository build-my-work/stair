import { expect, test } from 'bun:test'
import { join } from 'node:path'

for (const fixture of ['chat-page-attachments', 'project-file-response', 'navigation-readiness']) {
  test(`${fixture} preserves the latest editor and source identity`, () => {
    const child = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, `${fixture}.isolated.ts`)], {
      env: process.env, stdout: 'pipe', stderr: 'pipe',
    })
    if (child.exitCode !== 0) throw new Error(`${child.stdout.toString()}\n${child.stderr.toString()}`)
    expect(child.exitCode).toBe(0)
  })
}
