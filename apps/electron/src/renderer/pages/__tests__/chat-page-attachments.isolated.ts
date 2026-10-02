import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Same production-hook extraction seam used by the repository's Stop regression.
// This exercises React effect ordering with controllable attachment read promises.
// It does not stand in for Electron end-to-end acceptance.
const repo = new URL('../../../../../..', import.meta.url).pathname
const require = createRequire(`${repo}/apps/electron/package.json`)
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const domino = require('@mixmark-io/domino')
const page = readFileSync(`${repo}/apps/electron/src/renderer/pages/ChatPage.tsx`, 'utf8')
const start = page.indexOf('  const [attachmentsValue, setAttachmentsValue]')
const end = page.indexOf('  const [referencesValue, setReferencesValue]', start)
if (start < 0 || end < 0) throw new Error('Production hook boundaries changed')
const source = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  return function useAttachmentDraft(context) {
    const { sessionId, hydrateDraftAttachments, onAttachmentsChange } = context;
    ${page.slice(start, end)}
    return { attachmentsValue, handleAttachmentsChange };
  }
`)
const useAttachmentDraft = new Function('React', source)(React)
let root: any
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  root = undefined
})

function setup(context: any) {
  const w = domino.createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Node: w.Node, IS_REACT_ACT_ENVIRONMENT: true })
  let state: any
  function Harness({ context }: any) { state = useAttachmentDraft(context); return null }
  root = createRoot(w.document.getElementById('root'))
  const render = async (next: any) => { await act(async () => root.render(React.createElement(Harness, { context: next }))) }
  return { render, get state() { return state }, w }
}

const file = (name: string) => ({ name, type: 'text', mimeType: 'text/plain', path: `/fixture/${name}`, size: 1, text: 'x' })

test('I01/I08: delayed initial attachment read cannot overwrite a later local attachment edit', async () => {
  let finish!: (value: any) => void
  const pending = new Promise(resolve => { finish = resolve })
  const context = { sessionId: 'session-a', hydrateDraftAttachments: () => pending, onAttachmentsChange() {} }
  const h = setup(context)
  await h.render(context)
  const fresh = file('new-local.txt')
  await act(async () => h.state.handleAttachmentsChange([fresh]))
  expect(h.state.attachmentsValue).toEqual([fresh])
  await act(async () => { finish([file('old-disk.txt')]); await pending })
  expect(h.state.attachmentsValue).toEqual([fresh])
})

test('I06/I08: a pending restoration event cannot replace a later edit in the same session', async () => {
  let finish!: (value: any) => void
  let reads = 0
  const pending = new Promise(resolve => { finish = resolve })
  const context = { sessionId: 'session-a', hydrateDraftAttachments: () => ++reads === 1 ? Promise.resolve([]) : pending, onAttachmentsChange() {} }
  const h = setup(context)
  await h.render(context)
  await act(async () => {
    const event = h.w.document.createEvent('Event')
    event.initEvent('stair:draft-attachments-changed', false, false)
    Object.defineProperty(event, 'detail', { value: { sessionId: 'session-a' } })
    h.w.dispatchEvent(event)
  })
  expect(reads).toBe(2)
  const fresh = file('newer-editor.txt')
  await act(async () => h.state.handleAttachmentsChange([fresh]))
  await act(async () => { finish([file('old-recovery.txt')]); await pending })
  expect(h.state.attachmentsValue).toEqual([fresh])
})
