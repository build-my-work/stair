import { app } from 'electron'

import { configureAppIdentity } from './app-identity'
import { loadShellEnv } from './shell-env'

loadShellEnv()
configureAppIdentity(app, process.env.CRAFT_APP_NAME || undefined)

void import('./index').catch((error) => {
  console.error('Failed to start stair:', error)
  app.quit()
})
