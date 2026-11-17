import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)('clips the native page without resizing it; park preserves edits', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'stair-notion-e2e-'))
  try {
    const fixture = join(folder, 'fixture.cjs')
    const compiled = Bun.spawnSync([createRequire(import.meta.url).resolve('esbuild/bin/esbuild'), new URL('./notion-view-runtime.fixture.ts', import.meta.url).pathname, `--outfile=${fixture}`, '--bundle', '--platform=node', '--format=cjs', '--external:electron'])
    if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString())
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = Bun.spawn([createRequire(import.meta.url)('electron'), fixture, join(folder, 'profile')], { env, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(`${code}\n${stdout}\n${stderr}`).toContain('NOTION_NATIVE_RESULT=')
    if (code !== 0) throw new Error(stdout + stderr)
    expect(code).toBe(0)
  } finally { rmSync(folder, { recursive: true, force: true }) }
}, 40_000)

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)('mounts the production guest pool and opens a page from an initially empty workbench', async () => {
  const { writeFileSync } = await import('node:fs')
  const folder = mkdtempSync(join(tmpdir(), 'stair-notion-pool-'))
  try {
    const entry = join(folder, 'main.cjs')
    const renderer = join(folder, 'renderer.js')
    const preload = join(folder, 'preload.cjs')
    const esbuild = createRequire(import.meta.url).resolve('esbuild/bin/esbuild')
    for (const [input, output, platform] of [
      [new URL('./notion-pool-runtime.fixture.ts', import.meta.url).pathname, entry, 'node'],
      [new URL('./notion-pool-renderer.fixture.tsx', import.meta.url).pathname, renderer, 'browser'],
    ]) {
      const compiled = Bun.spawnSync([esbuild!, input!, `--outfile=${output}`, '--bundle', `--platform=${platform}`, '--external:electron', '--tsconfig=apps/electron/tsconfig.json',
        ...(platform === 'browser' ? [`--alias:@/context/ThemeContext=${new URL('./notion-theme-context.fixture.tsx', import.meta.url).pathname}`] : []),
      ])
      if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString())
    }
    writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',{getRuntimeEnvironment:()=> 'electron',notionView:r=>ipcRenderer.invoke('__notion:view',r)});contextBridge.exposeInMainWorld('reportNotionTest',v=>ipcRenderer.send('__notion:testReport',v));`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = Bun.spawn([createRequire(import.meta.url)('electron'), entry, join(folder, 'profile'), renderer, preload], { env, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(stdout + stderr)
    expect(stdout).toContain('NOTION_POOL_RESULT=')
    expect(stdout).toContain('11111111-1111-1111-1111-111111111111')
  } finally { rmSync(folder, { recursive: true, force: true }) }
}, 30_000)
