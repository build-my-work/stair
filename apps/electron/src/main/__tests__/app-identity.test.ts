import { describe, expect, it, mock } from 'bun:test'

import { configureAppIdentity } from '../app-identity'

describe('configureAppIdentity', () => {
  it('uses stair for both the app name and Electron userData directory', () => {
    const setName = mock(() => {})
    const setPath = mock(() => {})
    const env: Record<string, string | undefined> = {}

    const identity = configureAppIdentity({
      getPath: () => '/Users/test/Library/Application Support',
      setName,
      setPath,
    }, undefined, env)

    expect(identity).toEqual({
      appName: 'stair',
      userDataPath: '/Users/test/Library/Application Support/stair',
      configDir: '/Users/test/Library/Application Support/stair',
    })
    expect(env.CRAFT_CONFIG_DIR).toBe('/Users/test/Library/Application Support/stair')
    expect(setName).toHaveBeenCalledWith('stair')
    expect(setPath).toHaveBeenCalledWith(
      'userData',
      '/Users/test/Library/Application Support/stair',
    )
  })

  it('keeps the existing app-name override and gives it an isolated userData directory', () => {
    const setName = mock(() => {})
    const setPath = mock(() => {})
    const env = { CRAFT_CONFIG_DIR: '/tmp/explicit-config' }

    const identity = configureAppIdentity({
      getPath: () => '/tmp/app-data',
      setName,
      setPath,
    }, 'stair [2]', env)

    expect(identity).toEqual({
      appName: 'stair [2]',
      userDataPath: '/tmp/app-data/stair [2]',
      configDir: '/tmp/explicit-config',
    })
  })
})
