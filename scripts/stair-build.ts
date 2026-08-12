import { spawn } from 'bun'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { createStairEnvironment } from './stair-profile'

const repoRoot = join(import.meta.dir, '..')
const electronDir = join(repoRoot, 'apps/electron')
const env = createStairEnvironment(process.env, repoRoot)

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

cpSync(
  join(electronDir, 'resources/stair/icon.png'),
  join(electronDir, 'dist/resources/icon.png'),
)

const electronBuilder = join(
  repoRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
)
const packageProcess = spawn({
  cmd: [electronBuilder, '--config', 'electron-builder.stair.yml', ...process.argv.slice(2)],
  cwd: electronDir,
  env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await packageProcess.exited)
