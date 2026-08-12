import { homedir } from 'node:os'
import { join } from 'node:path'

export const STAIR_DEFAULT_VITE_PORT = '5193'

export function createStairEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
  repoRoot = join(import.meta.dir, '..'),
  homeDir = homedir(),
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )

  return {
    ...inherited,
    CRAFT_APP_NAME: 'Stair',
    VITE_APP_NAME: 'Stair',
    CRAFT_CONFIG_DIR: source.CRAFT_CONFIG_DIR?.trim() || join(homeDir, '.stair'),
    CRAFT_VITE_PORT: source.CRAFT_VITE_PORT?.trim() || STAIR_DEFAULT_VITE_PORT,
    CRAFT_DEEPLINK_SCHEME: 'stair',
    CRAFT_APP_ICON: join(repoRoot, 'apps/electron/resources/stair/icon.png'),
    CRAFT_DISABLE_AUTO_UPDATE: '1',
    CRAFT_INSTANCE_NUMBER: '',
  }
}
