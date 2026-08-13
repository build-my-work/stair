import { describe, expect, it, mock } from 'bun:test'

const updaterHandlers = new Map<string, (...args: any[]) => void>()
const quitAndInstall = mock(() => {})
const autoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  logger: null as unknown,
  downloadedUpdateHelper: {
    cacheDir: '/tmp/stair-update-test',
    versionInfo: { version: '1.2.3' },
  },
  on: (event: string, handler: (...args: any[]) => void) => {
    updaterHandlers.set(event, handler)
    return autoUpdater
  },
  checkForUpdates: async () => null,
  quitAndInstall,
}

mock.module('electron-updater', () => ({ autoUpdater }))
mock.module('electron', () => ({
  app: {
    getName: () => 'Stair',
    getPath: () => '/tmp',
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}))
mock.module('../logger', () => ({
  mainLog: { info: () => {}, warn: () => {}, error: () => {} },
  autoUpdateLog: { info: () => {}, warn: () => {}, error: () => {} },
}))
mock.module('@craft-agent/shared/version', () => ({ getAppVersion: () => '1.0.0' }))
mock.module('@craft-agent/shared/config', () => ({
  getDismissedUpdateVersion: () => null,
  clearDismissedUpdateVersion: () => {},
}))
mock.module('@craft-agent/shared/utils/files', () => ({ readJsonFileSync: () => null }))

const {
  getUpdateInfo,
  installUpdate,
  isUpdating,
  setBeforeUpdateInstallHook,
} = await import('../auto-update')

describe('自动更新安装前的文档 flush', () => {
  it('flush 失败时中止 quitAndInstall 并恢复可重试状态', async () => {
    updaterHandlers.get('update-available')?.({ version: '1.2.3' })
    expect(getUpdateInfo().downloadState).toBe('ready')
    setBeforeUpdateInstallHook(async () => {
      throw new Error('PROJECT_FILE_CHANGED: changed on disk')
    })

    await expect(installUpdate()).rejects.toThrow('PROJECT_FILE_CHANGED')

    expect(quitAndInstall).not.toHaveBeenCalled()
    expect(isUpdating()).toBe(false)
    expect(getUpdateInfo().downloadState).toBe('ready')
  })

  it('flush 成功后才交给 electron-updater 退出安装', async () => {
    const order: string[] = []
    quitAndInstall.mockImplementation(() => { order.push('quit-and-install') })
    setBeforeUpdateInstallHook(async () => { order.push('flush') })

    await installUpdate()

    expect(order).toEqual(['flush', 'quit-and-install'])
    expect(isUpdating()).toBe(true)
  })
})
