'use strict'

const { homedir } = require('node:os')
const { join } = require('node:path')

const iconExtension = process.platform === 'win32'
  ? 'ico'
  : process.platform === 'darwin'
    ? 'icns'
    : 'png'

process.env.CRAFT_APP_NAME ||= 'Stair'
process.env.CRAFT_CONFIG_DIR ||= join(homedir(), '.stair')
process.env.CRAFT_DEEPLINK_SCHEME ||= 'stair'
process.env.CRAFT_APP_ICON ||= join(
  __dirname,
  'dist', 'resources', 'stair', `icon.${iconExtension}`,
)
process.env.CRAFT_DISABLE_AUTO_UPDATE ||= '1'

require('./dist/main.cjs')
