import { join } from 'node:path'
import { CRAFT_PRODUCT_NAME } from '@craft-agent/shared/stair-branding'

export interface DesktopProductProfile {
  appName: string
  configDir: string | undefined
  deepLinkScheme: string
  iconPath: string | undefined
  userDataDir: string | undefined
}

export function resolveDesktopProductProfile(
  env: Readonly<Record<string, string | undefined>>,
): DesktopProductProfile {
  const appName = env.CRAFT_APP_NAME?.trim() || CRAFT_PRODUCT_NAME
  const configDir = env.CRAFT_CONFIG_DIR?.trim() || undefined

  return {
    appName,
    configDir,
    deepLinkScheme: env.CRAFT_DEEPLINK_SCHEME?.trim() || 'craftagents',
    iconPath: env.CRAFT_APP_ICON?.trim() || undefined,
    userDataDir: configDir ? join(configDir, 'electron') : undefined,
  }
}
