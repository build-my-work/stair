import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

describe('default workspace storage path', () => {
  it('keeps default workspaces inside CRAFT_CONFIG_DIR', () => {
    const storagePath = join(import.meta.dir, '..', 'storage.ts')
    const configDir = join('/tmp', 'stair-user-data')
    const script = `
      import { getDefaultWorkspacesDir } from ${JSON.stringify(storagePath)}
      console.log(getDefaultWorkspacesDir())
    `
    const result = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe(join(configDir, 'workspaces'))
  })
})
