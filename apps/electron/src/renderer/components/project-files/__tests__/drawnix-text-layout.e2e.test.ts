import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

// Included in test:external; Linux needs DISPLAY (for example, under xvfb-run).
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY)
const require = createRequire(import.meta.url)
let directory: string | undefined
let results: Array<{
  name: string
  fontSize: number
  expectedFontSize: number
  allocatedHeight: number
  renderedHeight: number
}> = []

beforeAll(async () => {
  if (!hasDisplay) return
  directory = mkdtempSync(join(tmpdir(), 'stair-drawnix-text-test-'))
  const css = join(directory, 'styles.css')
  const renderer = join(directory, 'renderer.js')
  await Promise.all([
    esbuild.build({
      entryPoints: [fileURLToPath(new URL('../drawnix-project-file.css', import.meta.url))],
      outfile: css,
      bundle: true,
      alias: {
        '@ttsworld/drawnix/index.css': join(dirname(require.resolve('@ttsworld/drawnix')), 'index.css'),
      },
    }),
    esbuild.build({
      stdin: {
        resolveDir: import.meta.dir,
        contents: `
          import { buildText, DEFAULT_FONT_FAMILY, measureElement } from '@plait/common';
          import { ROOT_TOPIC_FONT_SIZE, TOPIC_FONT_SIZE } from '@plait/mind';
          const cases = [
            { name: 'current root', kind: 'mind', fontSize: ROOT_TOPIC_FONT_SIZE, width: 80, text: 'English mixed words 中文 root node' },
            { name: 'legacy root', kind: 'mindmap', fontSize: ROOT_TOPIC_FONT_SIZE, width: 80, text: 'English mixed words 中文 root node' },
            { name: 'punctuation child', kind: 'mind_child', fontSize: TOPIC_FONT_SIZE, width: 28, text: '你（好）' },
            { name: 'punctuation temporary', kind: 'mind-temporary', fontSize: TOPIC_FONT_SIZE, width: 60, text: '测试：中文，标点。'.repeat(2) },
          ];
          window.drawnixLayoutResults = document.fonts.ready.then(() => cases.map(test => {
            const allocation = measureElement(null, buildText(test.text), {
              fontSize: test.fontSize, fontFamily: DEFAULT_FONT_FAMILY,
            }, test.width);
            const host = document.createElement('div');
            host.className = 'stair-drawnix-host';
            host.innerHTML = '<svg class="plait-board-container" style="width:800px;height:600px"><g><g><g class="text"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml" class="slate-editable-container plait-text-container" style="white-space:pre-wrap;overflow-wrap:break-word"><div data-slate-node="element"></div></div></foreignObject></g></g></g></svg>';
            host.querySelector('svg > g').setAttribute('plait-' + test.kind, 'true');
            host.querySelector('svg > g > g').classList.add(test.kind === 'mind' || test.kind === 'mindmap' ? 'root' : 'branch');
            const foreignObject = host.querySelector('foreignObject');
            foreignObject.setAttribute('width', String(test.width));
            foreignObject.setAttribute('height', String(allocation.height));
            const text = host.querySelector('[data-slate-node="element"]');
            text.textContent = test.text;
            document.body.append(host);
            const content = host.querySelector('.plait-text-container');
            return {
              name: test.name,
              fontSize: parseFloat(getComputedStyle(content).fontSize),
              expectedFontSize: test.fontSize,
              allocatedHeight: allocation.height,
              renderedHeight: content.getBoundingClientRect().height,
            };
          }));
        `,
      },
      outfile: renderer, bundle: true, platform: 'browser', format: 'iife',
    }),
  ])
  const html = join(directory, 'index.html')
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><body style="font-size:16px;line-height:24px"><script src="renderer.js"></script>')
  const fixture = join(directory, 'main.cjs')
  writeFileSync(fixture, `
    const { app, BrowserWindow } = require('electron');
    const { writeFileSync } = require('node:fs');
    const [profile, html, output] = process.argv.slice(2);
    app.setPath('userData', profile);
    app.disableHardwareAcceleration();
    app.whenReady().then(async () => {
      app.dock?.hide();
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
      await window.loadFile(html);
      const result = await window.webContents.executeJavaScript('window.drawnixLayoutResults');
      writeFileSync(output, JSON.stringify(result));
      app.exit(0);
    }).catch(error => { console.error(error); app.exit(1); });
  `)
  const output = join(directory, 'results.json')
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn({
    cmd: [require('electron'), fixture, join(directory, 'profile'), html, output],
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
    killSignal: 'SIGKILL',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Electron fixture exited ${code}: ${stdout}\n${stderr}`)
  results = JSON.parse(readFileSync(output, 'utf8'))
}, 30_000)

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

describe('Drawnix text layout in Chromium', () => {
  it.skipIf(!hasDisplay)('fits long text in both current and legacy root nodes', () => {
    const roots = results.filter(result => result.name.endsWith('root'))
    expect(roots).toHaveLength(2)
    for (const result of roots) {
      expect(result.fontSize).toBe(result.expectedFontSize)
      expect(result.renderedHeight, result.name).toBeGreaterThan(0)
      expect(result.renderedHeight, result.name).toBeLessThanOrEqual(result.allocatedHeight)
    }
  })

  it.skipIf(!hasDisplay)('fits Chinese punctuation in narrow child and temporary nodes', () => {
    const nodes = results.filter(result => result.name.startsWith('punctuation '))
    expect(nodes).toHaveLength(2)
    for (const result of nodes) {
      expect(result.fontSize).toBe(result.expectedFontSize)
      expect(result.renderedHeight, result.name).toBeGreaterThan(0)
      expect(result.renderedHeight, result.name).toBeLessThanOrEqual(result.allocatedHeight)
    }
  })
})
