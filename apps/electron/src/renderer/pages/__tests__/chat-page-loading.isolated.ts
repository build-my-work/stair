import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import React, { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore, useAtomValue } from 'jotai'
import type { ChatDisplay } from '../../components/app-shell/ChatDisplay'
import type { FileAttachment, Session } from '../../../shared/types'
import type { Reference } from '@craft-agent/core'
import { loadedSessionsAtom, sessionAtomFamily, sessionMetaMapAtom } from '../../atoms/sessions'

// Render the actual ChatPage with its actual session-loading atoms. Only the
// unrelated shell and transcript rendering are replaced; admission is real.
const rendererPath = (path: string) => new URL(`../../${path}`, import.meta.url).pathname
const domino = createRequire(import.meta.url)('@mixmark-io/domino') as {
  createWindow(html: string): Window & typeof globalThis
}
const sessionId = 'loading-chat'
const text = 'Keep this whole draft until this Chat can accept it.'
const attachments: FileAttachment[] = [{ type: 'text', name: 'draft.txt', path: '/fixture/draft.txt', mimeType: 'text/plain', text: 'UNIQUE-ATTACHMENT', size: 17 }]
const references: Reference[] = [{ version: 1, kind: 'web-selection', projectId: 'project-a', url: 'https://example.test/fixture', title: 'Fixture', quote: 'UNIQUE-QUOTE', locator: { type: 'web-text-quote', exact: 'UNIQUE-QUOTE' } }]
const sent: unknown[][] = []
let displayed: ComponentProps<typeof ChatDisplay> | undefined
let root: Root | undefined
let finishLoad: ((session: Session) => void) | undefined

const context = {
  activeWorkspaceId: 'workspace-a', llmConnections: [], workspaceDefaultLlmConnection: null,
  workspaces: [], enabledSources: [], skills: [], labels: [], enabledModes: [], sessionStatuses: [],
  getDraft: () => text, getDraftReferences: () => references,
  hydrateDraftAttachments: async () => attachments,
  onInputChange() {}, onAttachmentsChange() {}, onReferencesChange: () => true,
  onSetActiveViewingSession() {}, onRespondToPermission() {}, onRespondToCredential() {},
  onSendMessage: (...args: unknown[]) => { sent.push(args); return true },
}

beforeAll(() => {
  mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
  mock.module('sonner', () => ({ toast: { error() {}, success() {} } }))
  mock.module(rendererPath('context/AppShellContext.tsx'), () => ({
    useAppShellContext: () => context,
    useSession: (id: string) => useAtomValue(sessionAtomFamily(id)),
    usePendingPermission: () => undefined, usePendingCredential: () => undefined,
    useSessionOptionsFor: () => ({ options: { permissionMode: 'ask', thinkingLevel: 'medium' }, setOption() {}, setPermissionMode() {} }),
  }))
  mock.module(rendererPath('components/app-shell/ChatDisplay.tsx'), () => ({
    ChatDisplay: (props: ComponentProps<typeof ChatDisplay>) => { displayed = props; return null },
  }))
  mock.module(rendererPath('components/app-shell/PanelHeader.tsx'), () => ({ PanelHeader: () => null }))
  mock.module(rendererPath('components/app-shell/SessionMenu.tsx'), () => ({ SessionMenu: () => null }))
  mock.module(rendererPath('components/app-shell/CompactSessionMenu.tsx'), () => ({ CompactSessionMenu: () => null }))
  mock.module(rendererPath('components/app-shell/SessionInfoPopover.tsx'), () => ({ SessionInfoPopover: () => null }))
  mock.module(rendererPath('components/ui/rename-dialog.tsx'), () => ({ RenameDialog: () => null }))
  mock.module(rendererPath('components/ui/PanelHeaderCenterButton.tsx'), () => ({ PanelHeaderCenterButton: () => null }))
  const Passthrough = ({ children }: { children?: React.ReactNode }) => children
  mock.module(rendererPath('components/ui/dropdown-menu.tsx'), () => ({ DropdownMenu: Passthrough, DropdownMenuTrigger: Passthrough }))
  mock.module(rendererPath('components/ui/styled-dropdown.tsx'), () => ({ StyledDropdownMenuContent: () => null, StyledDropdownMenuItem: () => null, StyledDropdownMenuSeparator: () => null }))
  mock.module(rendererPath('lib/navigate.ts'), () => ({ navigate() {}, routes: { view: { allSessions: () => '', board: () => '' } } }))
  mock.module(rendererPath('lib/perf.ts'), () => ({ rendererPerf: { markSessionSwitch() {} } }))
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  displayed = undefined
  finishLoad = undefined
  sent.length = 0
})

test('an unloaded Chat rejects admission without consuming its rich draft, then sends after loading', async () => {
  const browserWindow = domino.createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  const pending = new Promise<Session>(resolve => { finishLoad = resolve })
  Object.assign(globalThis, { window: browserWindow, document: browserWindow.document, navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement, Node: browserWindow.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {} })
  Object.assign(window, { electronAPI: { getSessionMessages: () => pending,
    getWindowFocusState: async () => true, onWindowFocusChange: () => () => {} } })
  const store = createStore()
  const loaded: Session = { id: sessionId, workspaceId: 'workspace-a', workspaceName: 'Workspace', projectId: 'project-a',
    lastMessageAt: 0, messages: [], messageCount: 0, isProcessing: false }
  store.set(sessionMetaMapAtom, new Map([[sessionId, { ...loaded }]]))
  store.set(loadedSessionsAtom, new Set([sessionId]))
  const { default: ChatPage } = await import('../ChatPage')
  root = createRoot(document.getElementById('root')!)
  await act(async () => root!.render(React.createElement(Provider, { store }, React.createElement(ChatPage, { sessionId }))))

  expect(displayed!.onSendMessage(text, attachments, undefined, references)).toBe(false)
  expect(displayed!.disableSend).toBe(true)
  expect(displayed!.inputValue).toBe(text)
  expect(displayed!.attachmentsValue).toEqual(attachments)
  expect(displayed!.referencesValue).toEqual(references)
  expect(sent).toEqual([])

  await act(async () => { finishLoad!(loaded); await pending })
  expect(store.get(sessionAtomFamily(sessionId))).toEqual(loaded)
  expect(displayed!.disableSend).not.toBe(true)
  expect(displayed!.onSendMessage(text, attachments, undefined, references)).toBe(true)
  expect(sent).toEqual([[sessionId, text, attachments, undefined, undefined, references, undefined]])
})
