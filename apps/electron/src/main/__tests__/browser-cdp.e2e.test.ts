import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY)

it.skipIf(!hasDisplay)('B01 / BROWSER-02: verifies real page effects in one hidden Electron view', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stair-browser-cdp-test-'))
  try {
    const fixture = join(directory, 'fixture.cjs')
    await esbuild.build({
      entryPoints: [new URL('./browser-cdp-runtime.fixture.ts', import.meta.url).pathname],
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      plugins: [{
        name: 'fixture-logger',
        setup(build) {
          build.onResolve({ filter: /^\.\/logger$/ }, () => ({ path: 'logger', namespace: 'fixture' }))
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export const mainLog = { info() {}, warn() {}, error() {} }',
          }))
        },
      }],
    })
    const reactFixture = join(directory, 'react.cjs')
    await esbuild.build({
      stdin: {
        contents: `import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          function App() {
            const [value, setValue] = useState('Old React value');
            const [result, setResult] = useState('');
            return React.createElement('div', null,
              React.createElement('input', { value, 'aria-label': 'Controlled input', onChange: event => setValue(event.currentTarget.value) }),
              React.createElement('button', { onClick: () => setResult(value) }, 'Commit'),
              React.createElement('output', null, result));
          }
          flushSync(() => createRoot(document.querySelector('#root')).render(React.createElement(App)));`,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      },
      outfile: reactFixture, bundle: true, platform: 'browser', format: 'iife',
    })
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = Bun.spawn({
      cmd: [createRequire(import.meta.url)('electron'), fixture, join(directory, 'profile'), reactFixture],
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Electron fixture exited ${code}: ${stdout}\n${stderr}`)
    const line = stdout.split('\n').find(value => value.startsWith('BROWSER_RUNTIME_RESULT='))
    if (!line) throw new Error(`Electron fixture returned no results: ${stdout}\n${stderr}`)
    const { redirectedFocus, ...results } = JSON.parse(line.slice('BROWSER_RUNTIME_RESULT='.length))
    expect(results).toEqual({
      background: { value: 'B01-HIDDEN', result: 'B01-HIDDEN' },
      react: { value: 'React 中文', result: 'React 中文' },
      contenteditable: 'New 中文\nvalue',
      emptyContenteditable: '',
      readonly: { rejected: true, value: 'Keep me' },
      maxlength: { rejected: true, value: 'Old' },
      number: '42',
      invalidNumber: { rejected: true, value: '42' },
      textarea: 'New 中文\nvalue',
      emptyTextarea: '',
      crlfTextarea: 'Windows\ntext',
      cancelledInput: { rejected: true, value: '' },
      disabledFieldset: { rejected: true, value: 'Keep me' },
      privacy: ['password', 'autocomplete', 'masked'].map(mode => ({
        mode, isPassword: true, value: 'fixture-secret', other: '', focus: 'other',
        outputHasSecret: false, storedHasSecret: false, storedWasRedacted: true,
      })),
      drag: { down: true, up: true, x: 110 },
    })
    expect(redirectedFocus.other).toBe('')
    expect(redirectedFocus.value).toBe(redirectedFocus.rejected ? 'Keep me' : 'Wrong target')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
