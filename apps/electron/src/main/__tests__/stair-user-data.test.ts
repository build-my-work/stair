import { describe, expect, it } from 'bun:test'
import { resolveDesktopProductProfile } from '../product-profile'

describe('桌面产品配置', () => {
  it('默认 Craft 入口保持现有身份和默认数据目录', () => {
    expect(resolveDesktopProductProfile({})).toEqual({
      appName: 'Craft Agents',
      configDir: undefined,
      deepLinkScheme: 'craftagents',
      iconPath: undefined,
      userDataDir: undefined,
    })
  })

  it('Stair 使用独立配置、Electron userData、图标和深链协议', () => {
    expect(
      resolveDesktopProductProfile({
        CRAFT_APP_NAME: 'Stair',
        CRAFT_CONFIG_DIR: '/Users/test/.stair',
        CRAFT_DEEPLINK_SCHEME: 'stair',
        CRAFT_APP_ICON: '/repo/apps/electron/resources/stair/icon.png',
      }),
    ).toEqual({
      appName: 'Stair',
      configDir: '/Users/test/.stair',
      deepLinkScheme: 'stair',
      iconPath: '/repo/apps/electron/resources/stair/icon.png',
      userDataDir: '/Users/test/.stair/electron',
    })
  })

  it('多实例 Craft 也按显式配置目录隔离 Electron userData', () => {
    expect(
      resolveDesktopProductProfile({
        CRAFT_APP_NAME: 'Craft Agents [2]',
        CRAFT_CONFIG_DIR: '/tmp/.craft-agent-2',
        CRAFT_DEEPLINK_SCHEME: 'craftagents2',
      }).userDataDir,
    ).toBe('/tmp/.craft-agent-2/electron')
  })
})
