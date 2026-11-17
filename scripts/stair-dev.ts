import { spawn, type Subprocess } from 'bun'
import { join } from 'node:path'
import { createStairDevelopmentEnvironment } from './stair-profile'

const repoRoot = join(import.meta.dir, '..')

// 文档站（apps/docs）随开发版一起启动，Stair 帮助菜单通过 STAIR_DOCS_URL 打开它。
// 端口已有服务（例如单独跑了 docs:dev）时直接复用，不重复启动。
const DOCS_PORT = '5176'
const docsUrl = `http://localhost:${DOCS_PORT}`

async function isServing(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

let docs: Subprocess | undefined
if (await isServing(docsUrl)) {
  console.log(`📚 Reusing docs site at ${docsUrl}`)
} else {
  console.log(`📚 Starting docs site at ${docsUrl}`)
  docs = spawn({
    cmd: [process.execPath, 'x', 'astro', 'dev', '--port', DOCS_PORT],
    cwd: join(repoRoot, 'apps/docs'),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'inherit',
  })
}

const child = spawn({
  cmd: [process.execPath, 'run', 'scripts/electron-dev.ts', ...process.argv.slice(2)],
  cwd: repoRoot,
  env: { ...createStairDevelopmentEnvironment(process.env, repoRoot), STAIR_DOCS_URL: docsUrl },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

const stopDocs = () => docs?.kill()
process.on('SIGINT', stopDocs)
process.on('SIGTERM', stopDocs)

const code = await child.exited
stopDocs()
process.exit(code)
