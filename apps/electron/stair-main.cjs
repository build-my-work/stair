'use strict'

process.env.CRAFT_APP_NAME ||= 'Stair'
process.env.CRAFT_DISABLE_AUTO_UPDATE ||= '1'

require('./dist/main.cjs')
