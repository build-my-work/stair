const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync, statSync } = require('node:fs')
const { Arch } = require('builder-util')

function verifyPackagedRuntimeDependencies(
  resourcesPath,
  platform = process.platform,
  arch = process.arch,
) {
  const appRoot = path.join(resourcesPath, 'app')
  const appModules = path.join(appRoot, 'node_modules')
  const claudePackage = path.join(
    appModules,
    '@anthropic-ai',
    'claude-agent-sdk',
    'package.json',
  )
  const claudeSdk = path.join(
    appModules,
    '@anthropic-ai',
    'claude-agent-sdk',
    'sdk.mjs',
  )
  const claudeBinary = path.join(
    appModules,
    '@anthropic-ai',
    'claude-agent-sdk-binary',
    platform === 'win32' ? 'claude.exe' : 'claude',
  )
  const claudeBinaryPackage = path.join(
    appModules,
    '@anthropic-ai',
    'claude-agent-sdk-binary',
    'package.json',
  )
  const ripgrepBinary = path.join(
    appModules,
    '@vscode',
    'ripgrep',
    'bin',
    platform === 'win32' ? 'rg.exe' : 'rg',
  )
  const runtimeIcon = path.join(
    appRoot,
    'dist',
    'resources',
    'stair',
    'icon.png',
  )
  const sessionServer = path.join(
    appRoot,
    'resources',
    'session-mcp-server',
    'index.js',
  )
  const piServerRoot = path.join(appRoot, 'resources', 'pi-agent-server')
  const piServer = path.join(piServerRoot, 'index.js')
  const koffiPackage = path.join(piServerRoot, 'node_modules', 'koffi', 'package.json')
  const koffiBinary = path.join(
    piServerRoot,
    'node_modules',
    'koffi',
    'build',
    'koffi',
    `${platform}_${arch}`,
    'koffi.node',
  )
  const bunBinary = path.join(
    platform === 'win32' ? resourcesPath : appRoot,
    'vendor',
    'bun',
    platform === 'win32' ? 'bun.exe' : 'bun',
  )

  for (const filePath of [
    claudePackage,
    claudeSdk,
    claudeBinaryPackage,
    claudeBinary,
    ripgrepBinary,
    runtimeIcon,
  ]) {
    if (!existsSync(filePath)) {
      throw new Error(`Missing packaged runtime dependency: ${filePath}`)
    }
  }

  const ripgrepHeader = readFileSync(ripgrepBinary)
  let ripgrepArch
  if (platform === 'darwin' && ripgrepHeader.readUInt32LE(0) === 0xfeedfacf) {
    const cpuType = ripgrepHeader.readUInt32LE(4)
    if (cpuType === 0x0100000c) ripgrepArch = 'arm64'
    else if (cpuType === 0x01000007) ripgrepArch = 'x64'
  } else if (platform === 'win32' && ripgrepHeader.subarray(0, 2).toString() === 'MZ') {
    const peOffset = ripgrepHeader.readUInt32LE(0x3c)
    const machine = ripgrepHeader.readUInt16LE(peOffset + 4)
    if (machine === 0xaa64) ripgrepArch = 'arm64'
    else if (machine === 0x8664) ripgrepArch = 'x64'
  } else if (platform === 'linux' && ripgrepHeader.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = ripgrepHeader.readUInt16LE(18)
    if (machine === 183) ripgrepArch = 'arm64'
    else if (machine === 62) ripgrepArch = 'x64'
  }
  if (ripgrepArch !== arch) {
    throw new Error(
      `Packaged ripgrep binary does not match ${platform}-${arch}: ${ripgrepBinary}`,
    )
  }

  const binaryMetadata = JSON.parse(readFileSync(claudeBinaryPackage, 'utf8'))
  if (!binaryMetadata.os?.includes(platform) || !binaryMetadata.cpu?.includes(arch)) {
    throw new Error(
      `Packaged Claude binary does not match ${platform}-${arch}: ${claudeBinaryPackage}`,
    )
  }

  if (statSync(claudeBinary).size < 50_000_000) {
    throw new Error(`Packaged Claude binary is too small: ${claudeBinary}`)
  }

  for (const filePath of [
    sessionServer,
    piServer,
    koffiPackage,
    koffiBinary,
    bunBinary,
  ]) {
    if (!existsSync(filePath)) {
      throw new Error(`Missing packaged runtime dependency: ${filePath}`)
    }
  }
}

module.exports = async function afterPack(context) {
  const productFilename = context.packager.appInfo.productFilename
  const arch = Arch[context.arch]
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported Stair package architecture: ${context.arch}`)
  }
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(
      context.appOutDir,
      `${productFilename}.app`,
      'Contents',
      'Resources',
    )
    : path.join(context.appOutDir, 'resources')

  verifyPackagedRuntimeDependencies(resourcesPath, context.electronPlatformName, arch)

  if (context.electronPlatformName !== 'darwin') return

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
      { encoding: 'utf8' },
    )
  } catch (error) {
    const details = `${error.stderr ?? ''}${error.stdout ?? ''}`
    if (!details.includes('Does Not Exist')) throw error
  }
}

module.exports.verifyPackagedRuntimeDependencies = verifyPackagedRuntimeDependencies
