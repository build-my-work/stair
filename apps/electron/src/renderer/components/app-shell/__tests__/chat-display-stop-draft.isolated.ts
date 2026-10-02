import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { coerceInputText } from '../../../lib/input-text'
import { restoreSessionDraftContent } from '../../../lib/reference-draft'
import type { Reference } from '@craft-agent/core'

// Regression for the CHAT-04 stop-draft defect: with a queued message pending,
// an explicit Stop must leave the draft to the backend restore_input (the
// already-sent prompt would otherwise be duplicated on the next send). Already accepted input is edited through an explicit bubble action, not Stop. The real ChatDisplay handleStop decision is exercised here — no
// copy of the decision and no backend draft-merge re-test live in this file.
const shell = readFileSync(new URL('../ChatDisplay.tsx', import.meta.url), 'utf8')
const start = shell.indexOf('  const handleStop = (silent = false) => {')
const end = shell.indexOf('  // Per-frame scroll compensation during input height animation', start)
if ([start, end].some(index => index < 0)) {
  throw new Error('ChatDisplay handleStop boundaries changed')
}
const source = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  return function useStop(context) {
    const { session, inputValue, referencesValue, onInputChange, onReferencesChange, toast, t, appShellContext = {} } = context;
    ${shell.slice(start, end)}
    return { stop: handleStop };
  }
`)

type SessionMessage = {
  role: 'user' | 'assistant' | 'info'
  content: string
  isQueued?: boolean
  references?: Reference[]
}
type StopContext = {
  appShellContext?: { pendingInputSessionIds?: ReadonlySet<string>; onCancelPendingInput?: (sessionId: string) => Promise<void> }
  session: { id: string; projectId: string; isProcessing: boolean; messages: SessionMessage[] }
  inputValue: string
  referencesValue: Reference[]
  onInputChange(text: string): void
  onReferencesChange(references: Reference[]): void
  toast: { error(message: string): void }
  t(key: string): string
}
type Harness = {
  stop(silent?: boolean): void
  cancels: { sessionId: string; silent: boolean }[]
  inputChanges: string[]
  referenceChanges: Reference[][]
  errors: string[]
}

const domino = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createWindow(html: string): Window & typeof globalThis
}
let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  const w = globalThis.window as { electronAPI?: unknown } | undefined
  if (w) delete w.electronAPI
})

function userMessage(content: string, overrides: Partial<SessionMessage> = {}): SessionMessage {
  return { role: 'user', content, ...overrides }
}

function projectReference(quote: string, projectId = 'project-a'): Reference {
  return {
    version: 1, kind: 'project-file', projectId, relativePath: 'book.md',
    sourceFingerprint: 'sha256:book', fileName: 'book.md', quote,
    locator: { type: 'text-quote', exact: quote, start: 0, end: quote.length },
  } as Reference
}

function setup(context: StopContext): Harness {
  const browserWindow = domino.createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    window: browserWindow, document: browserWindow.document,
    navigator: browserWindow.navigator, HTMLElement: browserWindow.HTMLElement,
    Node: browserWindow.Node, IS_REACT_ACT_ENVIRONMENT: true,
  })
  const harness: Harness = { stop: () => {}, cancels: [], inputChanges: [], referenceChanges: [], errors: [] }
  Object.assign(browserWindow, { electronAPI: {
    cancelProcessing: async (sessionId: string, silent: boolean) => {
      harness.cancels.push({ sessionId, silent })
    },
  } })
  const useStop = new Function('React', 'coerceInputText', 'restoreSessionDraftContent', source)(
    React, coerceInputText, restoreSessionDraftContent,
  ) as (context: StopContext) => { stop(silent?: boolean): void }
  function Harness() {
    const actions = useStop(context)
    harness.stop = actions.stop
    return null
  }
  root = createRoot(browserWindow.document.getElementById('root')!)
  act(() => root!.render(React.createElement(Harness)))
  return harness
}

const processingSession = (messages: SessionMessage[]) => ({
  id: 'session-1', projectId: 'project-a', isProcessing: true, messages,
})

describe('ChatDisplay Stop draft decision (CHAT-04)', () => {
  it('can stop a pending submission before the host starts processing', async () => {
    const pendingCancels: string[] = []
    const harness = setup({
      session: { ...processingSession([]), isProcessing: false },
      inputValue: 'newer edit', referencesValue: [],
      onInputChange: () => { throw new Error('Stop must not clear newer input') },
      onReferencesChange: () => { throw new Error('Stop must not clear newer references') },
      toast: { error() {} }, t: key => key,
      appShellContext: {
        pendingInputSessionIds: new Set(['session-1']),
        onCancelPendingInput: async sessionId => { pendingCancels.push(sessionId) },
      },
    })
    harness.stop()
    expect(pendingCancels).toEqual(['session-1'])
    expect(harness.cancels).toEqual([{ sessionId: 'session-1', silent: false }])
  })

  it('leaves the draft untouched when stopping with a queued message pending', () => {
    const harness = setup({
      session: processingSession([
        userMessage('A-prompt already sent'),
        userMessage('B-queued', { isQueued: true }),
      ]),
      inputValue: '',
      referencesValue: [],
      onInputChange: text => harness.inputChanges.push(text),
      onReferencesChange: refs => harness.referenceChanges.push(refs),
      toast: { error: message => harness.errors.push(message) },
      t: key => key,
    })
    harness.stop()
    expect(harness.inputChanges).toEqual([])
    expect(harness.referenceChanges).toEqual([])
    expect(harness.errors).toEqual([])
    expect(harness.cancels).toEqual([{ sessionId: 'session-1', silent: false }])
  })

  it('does not re-add the sent prompt on a silent redirect stop either', () => {
    const harness = setup({
      session: processingSession([
        userMessage('A-prompt already sent'),
        userMessage('B-queued', { isQueued: true }),
      ]),
      inputValue: '',
      referencesValue: [],
      onInputChange: text => harness.inputChanges.push(text),
      onReferencesChange: refs => harness.referenceChanges.push(refs),
      toast: { error: message => harness.errors.push(message) },
      t: key => key,
    })
    harness.stop(true)
    expect(harness.inputChanges).toEqual([])
    expect(harness.cancels).toEqual([{ sessionId: 'session-1', silent: true }])
  })

  it('leaves delivered input in history when stopping without a queue', () => {
    const reference = projectReference('selected quote')
    const harness = setup({
      session: processingSession([
        userMessage('A-prompt already sent', { references: [reference] }),
      ]),
      inputValue: '',
      referencesValue: [],
      onInputChange: text => harness.inputChanges.push(text),
      onReferencesChange: refs => harness.referenceChanges.push(refs),
      toast: { error: message => harness.errors.push(message) },
      t: key => key,
    })
    harness.stop()
    expect(harness.inputChanges).toEqual([])
    expect(harness.referenceChanges).toEqual([])
    expect(harness.cancels).toEqual([{ sessionId: 'session-1', silent: false }])
  })

  it('does not contaminate a newer draft with an already delivered prompt', () => {
    const harness = setup({
      session: processingSession([userMessage('A-prompt already sent')]),
      inputValue: 'unsent draft text',
      referencesValue: [],
      onInputChange: text => harness.inputChanges.push(text),
      onReferencesChange: refs => harness.referenceChanges.push(refs),
      toast: { error: message => harness.errors.push(message) },
      t: key => key,
    })
    harness.stop()
    expect(harness.inputChanges).toEqual([])
  })

  it('skips the queued prompt and only restores the sent one when queued messages exist behind the scenes', () => {
    // A queued assistant-side message must not flip the decision: what matters
    // is a queued USER message (the pending restore), not any isQueued flag.
    const harness = setup({
      session: processingSession([
        userMessage('A-prompt already sent'),
        userMessage('B-queued', { isQueued: true }),
        userMessage('C-queued-too', { isQueued: true }),
      ]),
      inputValue: '',
      referencesValue: [],
      onInputChange: text => harness.inputChanges.push(text),
      onReferencesChange: refs => harness.referenceChanges.push(refs),
      toast: { error: message => harness.errors.push(message) },
      t: key => key,
    })
    harness.stop()
    expect(harness.inputChanges).toEqual([])
    expect(harness.cancels).toEqual([{ sessionId: 'session-1', silent: false }])
  })

  it('does nothing when the session is not processing', () => {
    const harness = setup({
      session: { id: 'session-1', projectId: 'project-a', isProcessing: false, messages: [userMessage('A-prompt')] },
      inputValue: '',
      referencesValue: [],
      onInputChange: text => harness.inputChanges.push(text),
      onReferencesChange: refs => harness.referenceChanges.push(refs),
      toast: { error: message => harness.errors.push(message) },
      t: key => key,
    })
    harness.stop()
    expect(harness.inputChanges).toEqual([])
    expect(harness.cancels).toEqual([])
  })

  it('still cancels processing when the sent prompt has nothing to restore', () => {
    const harness = setup({
      session: processingSession([userMessage('', { references: [] })]),
      inputValue: '',
      referencesValue: [],
      onInputChange: text => harness.inputChanges.push(text),
      onReferencesChange: refs => harness.referenceChanges.push(refs),
      toast: { error: message => harness.errors.push(message) },
      t: key => key,
    })
    // empty content and no references → nothing restorable → no draft write,
    // but cancel still goes through.
    harness.stop()
    expect(harness.inputChanges).toEqual([])
    expect(harness.referenceChanges).toEqual([])
    expect(harness.cancels).toEqual([{ sessionId: 'session-1', silent: false }])
  })
})
