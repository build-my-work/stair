'use strict'

const { homedir } = require('node:os')
const { join } = require('node:path')

process.env.CRAFT_APP_NAME = 'Stair'
process.env.CRAFT_CONFIG_DIR = process.env.CRAFT_CONFIG_DIR?.trim() || join(homedir(), '.stair')
process.env.CRAFT_DEEPLINK_SCHEME = 'stair'
process.env.CRAFT_APP_ICON = join(
  __dirname,
  'dist', 'resources', 'stair', 'icon.png',
)
process.env.CRAFT_DISABLE_AUTO_UPDATE = '1'

require('./dist/main.cjs')
