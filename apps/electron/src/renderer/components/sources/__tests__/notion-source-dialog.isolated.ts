import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createRequire } from 'node:module'
import React, { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const domino = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createWindow(html: string): Window & typeof globalThis
}
const source = { id: 'notion-test', slug: 'notion', name: 'Notion', type: 'api' as const, provider: 'notion', enabled: true }
const passthrough = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children)
let root: Root | null = null

beforeAll(() => {
  const browser = domino.createWindow('<!doctype html><html><body></body></html>')
  Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Node: browser.Node, Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  mock.module('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
    Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  }))
  mock.module('@/context/ModalContext', () => ({ useRegisterModal() {} }))
  mock.module('@/components/ui/dialog', () => ({
    Dialog: passthrough, DialogContent: passthrough, DialogDescription: passthrough,
    DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough,
  }))
  mock.module('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => React.createElement('input', { ...props, onInput: onChange }) }))
  mock.module('@/components/ui/label', () => ({ Label: passthrough }))
  mock.module('@/components/ui/button', () => ({ Button: ({ variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => React.createElement('button', props) }))
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

async function open(connect: (workspaceId: string, token: string) => Promise<typeof source>) {
  Object.assign(window, { electronAPI: { connectNotionSource: connect } })
  const { NotionSourceDialog } = await import('../NotionSourceDialog')
  const connected = mock(() => {})
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(React.createElement(NotionSourceDialog, { workspaceId: 'workspace-test', onClose() {}, onConnected: connected })))
  return connected
}

async function submit() {
  await act(async () => {
    const input = document.querySelector('input')!
    input.value = '  fixture-token  '
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

describe('Notion token form', () => {
  it('asks only for a masked token, prevents repeated submits, and clears it after connecting', async () => {
    let finish!: (value: typeof source) => void
    const pending = new Promise<typeof source>(resolve => { finish = resolve })
    const connect = mock(() => pending)
    const connected = await open(connect)
    expect(document.querySelectorAll('input')).toHaveLength(1)
    expect(document.querySelector('input')!.type).toBe('password')
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    await submit()
    expect(connect).toHaveBeenCalledWith('workspace-test', 'fixture-token')
    expect(document.querySelector('input')!.disabled).toBe(true)
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connected).not.toHaveBeenCalled()
    await act(async () => { finish(source) })
    expect(connected).toHaveBeenCalledWith(source)
    expect(document.querySelector('input')!.value).toBe('')
  })

  it('shows a localized error rather than credential or response details and permits retry', async () => {
    const connected = await open(async () => { throw new Error('NOTION_AUTH_FAILED: fixture-private-response') })
    await submit()
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('notion.authFailed')
    expect(document.body.textContent).not.toContain('fixture-private-response')
    expect(document.querySelector('input')!.disabled).toBe(false)
    expect(connected).not.toHaveBeenCalled()
  })

  it('does not navigate to the old workspace Source if the dialog unmounts during connection', async () => {
    let finish!: (value: typeof source) => void
    const connected = await open(() => new Promise(resolve => { finish = resolve }))
    await submit()
    await act(async () => root!.unmount())
    root = null
    await act(async () => { finish(source) })
    expect(connected).not.toHaveBeenCalled()
  })
})
