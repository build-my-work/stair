const path = require('node:path')
const { execFileSync } = require('node:child_process')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const productFilename = context.packager.appInfo.productFilename
  const infoPlist = path.join(
    context.appOutDir,
    `${productFilename}.app`,
    'Contents',
    'Info.plist',
  )

  try {
    execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Delete :CFBundleIconName', infoPlist],
      { stdio: 'ignore' },
    )
  } catch {
    // The independent ICNS remains valid when CFBundleIconName is absent.
  }
}
