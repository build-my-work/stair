import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { coerceInputText } from '../../../../lib/input-text'

const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf8')
function between(from: string, to: string) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`Input test boundary changed: ${from}`)
  return source.slice(start, end)
}
const submitted = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  const { React, input, attachments, referencesValue, followUpItems, disabled, disableSend,
    skills, sources, optimisticSourceSlugs, onSourcesChange, setOptimisticSourceSlugs,
    onSubmit, setInput, setAttachments, syncTimeoutRef, onInputChange, onAttachmentsChange,
    onReferencesChange, prevInputValueRef, richInputRef, liveInputRef, inputRef,
    parseMentions, requestAnimationFrame, onWorkingDirectoryChange, homeDir } = context;
  ${between('  const submitMessage = React.useCallback(', '  // Listen for craft:submit-input')}
  return submitMessage;
`)
const approval = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  const { React, window, sessionId, permissionMode, previousPermissionMode,
    onPermissionModeChange, onSubmit, clearInputDraft, referencesValue, attachments,
    onAttachmentsChange, onReferencesChange, setAttachments, richInputRef, liveInputRef,
    coerceInputText, buildPlanApprovalMessage, planExecutionMode } = context;
  ${between('  // Listen for craft:approve-plan events', '  // Live completion and reload recovery')}
`)
const flush = new Bun.Transpiler({ loader: 'tsx' }).transformSync(`
  const { React, sessionId, syncTimeoutRef, richInputRef, liveInputRef,
    changeInputRef, prevInputValueRef, window, coerceInputText } = context;
  ${between("  // Synchronize the input's 300ms debounce", '  // Recovery can confirm')}
`)

function setup(accepted: boolean) {
  const changes: unknown[] = []
  const submissions: unknown[][] = []
  const handlers = new Map<string, (event: any) => void>()
  const attachment = { name: 'paste.txt', path: 'paste.txt', text: 'FULL_PAYLOAD' }
  const quote = { quote: 'REFERENCE' }
  const context: any = {
    React: { useCallback: (fn: unknown) => fn, useEffect: (fn: () => unknown) => fn() },
    window: { addEventListener: (name: string, fn: (event: any) => void) => handlers.set(name, fn), removeEventListener() {} },
    sessionId: 'session-a', input: 'FAST_INPUT', attachments: [attachment], referencesValue: [quote],
    followUpItems: [], disabled: false, disableSend: false, skills: [], sources: [], optimisticSourceSlugs: [],
    onSubmit: (...args: unknown[]) => { submissions.push(args); return accepted },
    setInput: (value: string) => changes.push(['input', value]),
    setAttachments: (value: unknown) => changes.push(['attachments', value]),
    onInputChange: (value: string) => changes.push(['text', value]),
    onAttachmentsChange: (value: unknown) => changes.push(['saved-attachments', value]),
    onReferencesChange: (value: unknown) => changes.push(['references', value]),
    prevInputValueRef: { current: 'OLD_DEBOUNCED' }, syncTimeoutRef: { current: null },
    richInputRef: { current: { value: 'FAST_INPUT', setValue(value: string) { this.value = value }, focus() {} } },
    liveInputRef: { current: 'FAST_INPUT' }, inputRef: { current: 'FAST_INPUT' },
    parseMentions: () => ({ skills: [], sources: [] }), requestAnimationFrame: (fn: () => void) => fn(),
    clearInputDraft: () => changes.push(['clear']), permissionMode: 'safe', previousPermissionMode: 'ask',
    onPermissionModeChange: (value: string) => changes.push(['permission', value]),
    coerceInputText, buildPlanApprovalMessage: ({ draftInput }: { draftInput: string }) => `ACCEPT ${draftInput}`,
    planExecutionMode: () => 'ask',
  }
  context.changeInputRef = { current: context.onInputChange }
  return { context, changes, submissions, handlers, attachment, quote }
}

describe('composer durable admission boundary', () => {
  it('keeps body, attachments and references when synchronous admission refuses the send', () => {
    const f = setup(false)
    const submit = new Function('context', submitted)(f.context)
    expect(submit()).toBe(false)
    expect(f.changes).toEqual([])
    expect(f.context.richInputRef.current.value).toBe('FAST_INPUT')
    expect(f.submissions[0]).toEqual(['FAST_INPUT', [f.attachment], undefined, [f.quote], { consumeDraft: true }])
  })

  it('clears imperative and React state only after durable admission succeeds', () => {
    const f = setup(true)
    const submit = new Function('context', submitted)(f.context)
    expect(submit()).toBe(true)
    expect(f.context.richInputRef.current.value).toBe('')
    expect(f.context.liveInputRef.current).toBe('')
    expect(f.context.inputRef.current).toBe('')
    expect(f.changes).toContainEqual(['saved-attachments', []])
    expect(f.changes).toContainEqual(['references', []])
  })

  it('normal plan acceptance captures full live input without consuming it on journal failure', () => {
    const f = setup(false)
    new Function('context', approval)(f.context)
    f.handlers.get('craft:approve-plan')!({ detail: { sessionId: 'session-a', approvedPlanMessageId: 'submitted-plan' } })
    expect(f.submissions[0]).toEqual(['ACCEPT FAST_INPUT', [f.attachment], undefined, [f.quote], { consumeDraft: true, approvedPlanMessageId: 'submitted-plan' }])
    expect(f.changes).toEqual([])
  })

  it('plan acceptance excluding the draft keeps its text, attachments and quotes', () => {
    const f = setup(true)
    new Function('context', approval)(f.context)
    f.handlers.get('craft:approve-plan')!({ detail: { sessionId: 'session-a', includeDraftInput: false } })
    expect(f.submissions[0]).toEqual(['ACCEPT ', undefined, undefined, [], { consumeDraft: false }])
    expect(f.changes).toEqual([['permission', 'ask']])
  })

  it('normal approval captures the plan and full payload before clearing every draft component', () => {
    const f = setup(true)
    new Function('context', approval)(f.context)
    f.handlers.get('craft:approve-plan')!({ detail: { sessionId: 'session-a', approvedPlanMessageId: 'submitted-plan' } })
    expect(f.submissions).toEqual([['ACCEPT FAST_INPUT', [f.attachment], undefined, [f.quote], {
      consumeDraft: true, approvedPlanMessageId: 'submitted-plan',
    }]])
    expect(f.changes).toEqual([['clear'], ['attachments', []], ['saved-attachments', []], ['references', []], ['permission', 'ask']])
  })

  it('flushes dirty text before hydration but does not mark an untouched empty composer dirty', () => {
    const f = setup(true)
    new Function('context', flush)(f.context)
    f.handlers.get('craft:flush-input')!({ detail: { sessionId: 'session-a' } })
    expect(f.changes).toEqual([['text', 'FAST_INPUT']])
    f.changes.length = 0
    f.context.richInputRef.current.value = ''
    f.context.prevInputValueRef.current = ''
    f.handlers.get('craft:flush-input')!({ detail: { sessionId: 'session-a' } })
    expect(f.changes).toEqual([])
  })
})
