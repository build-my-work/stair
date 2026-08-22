import { spawn } from 'bun'
import { join } from 'node:path'
import {
  copyPiAgentServer,
  copyRipgrep,
  copySDK,
  copySessionServer,
  downloadBun,
  verifyMcpServersExist,
  verifySDKCopy,
  type Arch,
  type BuildConfig,
  type Platform,
} from './build/common'
import { createStairEnvironment } from './stair-profile'

const repoRoot = join(import.meta.dir, '..')
const electronDir = join(repoRoot, 'apps/electron')
const env = createStairEnvironment(process.env, repoRoot)
const platform = process.platform
const hasX64 = process.argv.includes('--x64')
const hasArm64 = process.argv.includes('--arm64')
if (hasX64 && hasArm64) {
  throw new Error('Stair packages one architecture at a time; choose --x64 or --arm64')
}
const hasExplicitArch = hasX64 || hasArm64
let arch = process.arch
if (hasX64) arch = 'x64'
else if (hasArm64) arch = 'arm64'

if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
  throw new Error(`Unsupported Stair build target: ${platform}-${arch}`)
}
const archFlag = `--${arch}`

const buildConfig: BuildConfig = {
  platform: platform as Platform,
  arch: arch as Arch,
  upload: false,
  uploadLatest: false,
  uploadScript: false,
  rootDir: repoRoot,
  electronDir,
}

const build = spawn({
  cmd: [process.execPath, 'run', 'electron:build'],
  cwd: repoRoot,
  env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
const buildExitCode = await build.exited
if (buildExitCode !== 0) process.exit(buildExitCode)

await downloadBun(buildConfig)
copySessionServer(buildConfig)
copyPiAgentServer(buildConfig)
verifyMcpServersExist(buildConfig)
copySDK(buildConfig)
verifySDKCopy(buildConfig)
copyRipgrep(buildConfig)

const electronBuilder = join(
  repoRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
)
const packageProcess = spawn({
  cmd: [
    electronBuilder,
    '--config',
    'electron-builder.stair.yml',
    ...process.argv.slice(2),
    ...(hasExplicitArch ? [] : [archFlag]),
  ],
  cwd: electronDir,
  env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await packageProcess.exited)
