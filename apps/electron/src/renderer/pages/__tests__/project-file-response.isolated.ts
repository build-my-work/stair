import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const repo = new URL('../../../../../..', import.meta.url).pathname
const require = createRequire(`${repo}/apps/electron/package.json`)
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const domino = require('@mixmark-io/domino')
const page = readFileSync(`${repo}/apps/electron/src/renderer/pages/ProjectFilePage.tsx`, 'utf8')
const loadStart = page.indexOf('  useEffect(() => {\n    let cancelled = false')
const loadEnd = page.indexOf('  useEffect(() => {\n    if (!response || !canEdit)', loadStart)
const fingerprintStart = page.indexOf('  const loadedSourceFingerprint =')
const fingerprintEnd = page.indexOf('  const handleEdit =', fingerprintStart)
if ([loadStart, loadEnd, fingerprintStart, fingerprintEnd].some(i => i < 0)) throw new Error('Production hook boundaries changed')
const stateStart = page.indexOf('  const [loadedText, setResponse]');
const stateEnd = page.indexOf('  const [editorContent, setEditorContent]', stateStart);
const source = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  return function useReader(context) {
    const { projectId, relativePath, openIntent, openIntentRevision, toast, t } = context;
    const { useState, useEffect } = React;
    ${page.slice(stateStart, stateEnd)}
    const [, setEditorContent] = useState('');
    const [, setDocumentState] = useState(null);
    const [, setIsEditing] = useState(false);
    const [, setError] = useState(null);
    const [, setIsLoading] = useState(false);
    const CLEAN_STATE = { status: 'clean', error: null };
    const canRead = true, kind = 'text', reloadRevision = 0;
    ${page.slice(loadStart, loadEnd)}
    ${page.slice(fingerprintStart, fingerprintEnd)}
    return response;
  }
`)
const useReader = new Function('React', source)(React)
let root: any
afterEach(async () => { if (root) await act(async () => root.unmount()); root = undefined })

test('R04: switching unchanged source A to unchanged source B must not report fingerprint failure', async () => {
  const w = domino.createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Node: w.Node, IS_REACT_ACT_ENVIRONMENT: true })
  w.electronAPI = { readProjectTextFile: async ({ projectId, relativePath }: any) => ({
    text: `${relativePath} quote`, sourceFingerprint: `fp:${relativePath}`,
    metadata: { projectId, relativePath, byteLength: 12, mimeType: 'text/plain' },
  }) }
  const errors: string[] = []
  let response: any
  function Harness({ context }: any) { response = useReader(context); return null }
  root = createRoot(w.document.getElementById('root'))
  const context = (path: string, revision: number) => ({ projectId: 'project-a', relativePath: path,
    openIntent: { expectedFingerprint: `fp:${path}` }, openIntentRevision: revision,
    toast: { error: (message: string) => errors.push(message) }, t: (key: string) => key })
  await act(async () => root.render(React.createElement(Harness, { context: context('a.txt', 1) })))
  expect(response.sourceFingerprint).toBe('fp:a.txt')
  expect(errors).toEqual([])
  await act(async () => root.render(React.createElement(Harness, { context: context('b.txt', 2) })))
  expect(response.sourceFingerprint).toBe('fp:b.txt')
  expect(errors).toEqual([])
})
