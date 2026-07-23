import { join } from 'node:path'

export const DEFAULT_APP_NAME = 'stair'

interface AppIdentityTarget {
  getPath: (name: 'appData') => string
  setName: (name: string) => void
  setPath: (name: 'userData', path: string) => void
}

export function configureAppIdentity(
  app: AppIdentityTarget,
  appName = DEFAULT_APP_NAME,
  env: Record<string, string | undefined> = process.env,
): { appName: string; userDataPath: string; configDir: string } {
  const userDataPath = join(app.getPath('appData'), appName)
  const configDir = env.CRAFT_CONFIG_DIR || userDataPath
  env.CRAFT_CONFIG_DIR = configDir
  app.setName(appName)
  app.setPath('userData', userDataPath)
  return { appName, userDataPath, configDir }
}
