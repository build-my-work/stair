import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-web-links-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  }))
  writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
    version: 'test',
    description: 'test defaults',
    defaults: {
      webLinkOpenTarget: 'system',
    },
    workspaceDefaults: {},
  }))
  return { configDir, configPath }
}

function runStorage(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getWebLinkOpenTarget, setWebLinkOpenTarget } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) {
    throw new Error(run.stderr.toString())
  }
  return run.stdout.toString().trim()
}

describe('web link opening target storage', () => {
  it('defaults to the system browser', () => {
    const { configDir } = setupConfigDir()
    expect(runStorage(configDir, 'console.log(getWebLinkOpenTarget())')).toBe('system')
  })

  it('persists the built-in browser choice', () => {
    const { configDir, configPath } = setupConfigDir()
    runStorage(configDir, "setWebLinkOpenTarget('built-in')")

    expect(JSON.parse(readFileSync(configPath, 'utf8')).webLinkOpenTarget).toBe('built-in')
    expect(runStorage(configDir, 'console.log(getWebLinkOpenTarget())')).toBe('built-in')
  })

  it('falls back to the default for an invalid stored value', () => {
    const { configDir, configPath } = setupConfigDir()
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.webLinkOpenTarget = 'unknown'
    writeFileSync(configPath, JSON.stringify(config))

    expect(runStorage(configDir, 'console.log(getWebLinkOpenTarget())')).toBe('system')
  })
})
