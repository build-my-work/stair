import { spawn } from 'bun'
import { join } from 'node:path'
import { createStairEnvironment } from './stair-profile'

const repoRoot = join(import.meta.dir, '..')
const child = spawn({
  cmd: [process.execPath, 'run', 'scripts/electron-dev.ts', ...process.argv.slice(2)],
  cwd: repoRoot,
  env: createStairEnvironment(process.env, repoRoot),
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await child.exited)
