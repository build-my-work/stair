/**
 * Stair packaging hook.
 *
 * The upstream hook installs Craft's macOS 26 Assets.car. Stair currently uses
 * its independent ICNS asset, so remove CFBundleIconName and let macOS use the
 * standard bundle icon instead.
 */

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
    // The key is optional. The ICNS fallback remains valid when it is absent.
  }
}
