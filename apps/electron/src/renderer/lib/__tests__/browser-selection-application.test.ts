import { describe, expect, it, mock } from 'bun:test'
import type { SessionDraft } from '@craft-agent/shared/config'

import { addSessionDraftReference } from '../reference-draft'
import {
  deriveBrowserProjectNoteRequestId,
  handleBrowserSelectionApplicationRequest,
} from '../browser-selection-application'

describe('Browser selection application', () => {
  const source = {
    url: 'https://example.com/article',
    title: 'Article',
    quote: 'selected text',
    locator: { type: 'web-text-quote' as const, exact: 'selected text' },
  }

  it('derives a stable Project Note receipt ID across renderer reloads and target changes', async () => {
    const first = await deriveBrowserProjectNoteRequestId(
      'browser-selection-id',
      'project-a\0notes/first.md\0web-reference',
    )
    const afterReload = await deriveBrowserProjectNoteRequestId(
      'browser-selection-id',
      'project-a\0notes/first.md\0web-reference',
    )
    const otherTarget = await deriveBrowserProjectNoteRequestId(
      'browser-selection-id',
      'project-a\0notes/second.md\0web-reference',
    )

    expect(afterReload).toBe(first)
    expect(otherTarget).not.toBe(first)
    expect(first.length).toBeLessThanOrEqual(256)
  })

  it('adds the selected web reference to the target Chat draft', async () => {
    const drafts = new Map<string, SessionDraft>()

    await expect(handleBrowserSelectionApplicationRequest({
      v: 1,
      action: 'add-selection-to-chat',
      requestId: 'request-chat',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      sessionId: 'chat-a',
      source,
    }, {
      addDraftReference(sessionId, reference, requestId) {
        expect(requestId).toBe('request-chat')
        const next = addSessionDraftReference(
          drafts.get(sessionId),
          'project-a',
          reference,
        )
        if (!next) return false
        drafts.set(sessionId, next)
        return true
      },
    })).resolves.toEqual({ ok: true })

    expect(drafts.get('chat-a')?.references).toEqual([{
      version: 1,
      kind: 'web-selection',
      projectId: 'project-a',
      ...source,
    }])
  })

  it('adds the selected web reference to a Project Note without a Chat target', async () => {
    const addSelectionNote = mock(async () => 'notes/research.md')

    await expect(handleBrowserSelectionApplicationRequest({
      v: 1,
      action: 'add-selection-note',
      requestId: 'request-note-current',
      mode: 'current',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      sessionId: null,
      source,
    }, {
      addDraftReference: () => false,
      addSelectionNote,
    })).resolves.toEqual({
      ok: true,
      noteTargetPath: 'notes/research.md',
    })

    expect(addSelectionNote).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'web-selection',
        projectId: 'project-a',
        quote: 'selected text',
      }),
      null,
      'current',
      'request-note-current',
    )
  })

  it('opens the shared Note picker when the Browser asks to choose a target', async () => {
    const addSelectionNote = mock(async () => 'notes/second.md')

    await expect(handleBrowserSelectionApplicationRequest({
      v: 1,
      action: 'add-selection-note',
      requestId: 'request-note-choose',
      mode: 'choose-target',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      sessionId: 'chat-a',
      source,
    }, {
      addDraftReference: () => false,
      addSelectionNote,
    })).resolves.toEqual({
      ok: true,
      noteTargetPath: 'notes/second.md',
    })

    expect(addSelectionNote).toHaveBeenCalledWith(
      expect.anything(),
      'chat-a',
      'choose-target',
      'request-note-choose',
    )
  })

  it('reports a cancelled Note picker without treating it as an error', async () => {
    await expect(handleBrowserSelectionApplicationRequest({
      v: 1,
      action: 'add-selection-note',
      requestId: 'request-note-cancel',
      mode: 'choose-target',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      sessionId: 'chat-a',
      source,
    }, {
      addDraftReference: () => false,
      addSelectionNote: async () => null,
    })).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('preserves a real Note write failure instead of reporting cancellation', async () => {
    await expect(handleBrowserSelectionApplicationRequest({
      v: 1,
      action: 'add-selection-note',
      requestId: 'request-note-error',
      mode: 'current',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      sessionId: 'chat-a',
      source,
    }, {
      addDraftReference: () => false,
      addSelectionNote: async () => {
        throw new Error('Project note append failed')
      },
    })).rejects.toThrow('Project note append failed')
  })

  it('creates a Chat in the Browser Project and opens it with the selected reference', async () => {
    const drafts = new Map<string, SessionDraft>()
    const opened: string[] = []

    await expect(handleBrowserSelectionApplicationRequest({
      v: 1,
      action: 'create-chat-from-selection',
      requestId: 'request-new-chat',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      source,
    }, {
      async createChat(workspaceId, projectId, requestId) {
        expect([workspaceId, projectId, requestId]).toEqual([
          'workspace-a',
          'project-a',
          'request-new-chat',
        ])
        return { id: 'chat-new', projectId, title: 'New Chat' }
      },
      addDraftReference(sessionId, reference, requestId) {
        expect(requestId).toBe('request-new-chat')
        const next = addSessionDraftReference(
          drafts.get(sessionId),
          'project-a',
          reference,
        )
        if (!next) return false
        drafts.set(sessionId, next)
        return true
      },
      openChat(sessionId) {
        opened.push(sessionId)
      },
    })).resolves.toEqual({
      ok: true,
      sessionId: 'chat-new',
      targetTitle: 'New Chat',
    })

    expect(drafts.get('chat-new')?.references?.[0]).toMatchObject({
      kind: 'web-selection',
      projectId: 'project-a',
      quote: 'selected text',
    })
    expect(opened).toEqual(['chat-new'])
  })

  it('does not delete an idempotently-created Chat when a later step fails', async () => {
    const opened: string[] = []

    await expect(handleBrowserSelectionApplicationRequest({
      v: 1,
      action: 'create-chat-from-selection',
      requestId: 'request-orphan-chat',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      source,
    }, {
      async createChat() {
        return { id: 'chat-orphan', projectId: 'project-a', title: 'New Chat' }
      },
      addDraftReference() {
        return false
      },
      openChat(sessionId) {
        opened.push(sessionId)
      },
    })).rejects.toThrow('Could not add this reference to the new Chat')

    expect(opened).toEqual([])
  })
})
