import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Reference } from '@craft-agent/core'
import type { SessionDraftPersistence } from '../session-draft-coordinator'

if (process.env.STAIR_SUBMITTED_DRAFT_CHILD !== '1') {
  test('submitted drafts recover through the real durable store after renderer restart', () => {
    const profile = mkdtempSync(join(tmpdir(), 'stair-submitted-draft-'))
    try {
      copyFileSync(join(import.meta.dir, '../../../../../../apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
      const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, CRAFT_CONFIG_DIR: profile, STAIR_SUBMITTED_DRAFT_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe',
      })
      if (run.exitCode !== 0) throw new Error(run.stdout.toString() + run.stderr.toString())
      expect(run.exitCode).toBe(0)
    } finally { rmSync(profile, { recursive: true, force: true }) }
  }, 30_000)
} else {
  if (!process.env.CRAFT_CONFIG_DIR?.includes('stair-submitted-draft-')) throw new Error('Disposable profile required')
  const config = await import('@craft-agent/shared/config')
  const { SessionDraftCoordinator } = await import('../session-draft-coordinator')
  const coordinators: InstanceType<typeof SessionDraftCoordinator>[] = []
  afterAll(() => coordinators.forEach(coordinator => coordinator.dispose()))
  const reference = (quote: string): Reference => ({ version: 1, kind: 'web-selection', projectId: 'project-a', url: 'https://example.test', title: 'source', quote, locator: { type: 'web-text-quote', exact: quote } })
  function coordinator(overrides: Partial<SessionDraftPersistence> = {}, beforeHydrate?: (value: InstanceType<typeof SessionDraftCoordinator>) => void) {
    const result = new SessionDraftCoordinator({
      getProjectId: () => 'project-a', debounceMs: 60_000,
      persistence: {
        setDraftContent: async (id, content, mutation) => config.setSessionDraftContent(id, content, mutation),
        updateDraftReferences: async (id, update) => config.reconcileSessionDraftReferences(id, 'project-a', update.baseReferences, update.nextReferences),
        addDraftReference: async (id, ref) => config.addSessionDraftReferenceAtomic(id, 'project-a', ref),
        restoreDraftInput: async (id, request) => config.restoreSessionDraftAtomic(id, 'project-a', request.restoreId, request.draft, request.local, request.planExecutionId),
        acknowledgeQueuedInputRestore: async () => {},
        ...overrides,
      },
    })
    coordinators.push(result)
    beforeHydrate?.(result)
    const hydration = result.beginHydration('workspace-a')
    result.hydrate(hydration, config.getSessionDraftHydrationState())
    return result
  }

  test('crash between journal stage and draft clear does not duplicate persisted text or attachments', async () => {
    const id = 'crash-before-clear'
    const input = { text: 'ORIGINAL', references: [reference('quote')], attachments: [{ path: 'paste.txt', name: 'paste.txt', content: { type: 'text' as const, mimeType: 'text/plain', size: 7, text: 'PAYLOAD' } }] }
    config.setSessionDraft(id, input)
    const original = coordinator()
    const captured = JSON.parse(JSON.stringify(original.captureSubmittedDraft(id)))
    original.dispose()
    const restarted = coordinator()
    await restarted.consumeSubmittedDraft('workspace-a', id, 'request-a', captured)
    await restarted.restoreInput('workspace-a', id, 'project-a', { type: 'restore_input', ...input, queuedRestoreId: 'rejected-request-a' })
    expect(config.getSessionDraft(id)?.text).toBe('ORIGINAL')
    expect(config.getSessionDraft(id)?.attachments).toEqual(input.attachments)
    const reopened = coordinator()
    await reopened.consumeSubmittedDraft('workspace-a', id, 'request-a', captured)
    await reopened.restoreInput('workspace-a', id, 'project-a', { type: 'restore_input', ...input, queuedRestoreId: 'rejected-request-a' })
    expect(config.getSessionDraft(id)?.text).toBe('ORIGINAL')
    expect(config.getSessionDraft(id)?.attachments).toEqual(input.attachments)
  })

  test('consuming a staged input preserves text and references edited during its host write', async () => {
    const id = 'new-edit-during-consume'
    config.setSessionDraft(id, { text: 'SENT', references: [reference('sent')] })
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    const current = coordinator({ restoreDraftInput: async (sessionId, request) => {
      started(); await hold
      return config.restoreSessionDraftAtomic(sessionId, 'project-a', request.restoreId, request.draft, request.local)
    } })
    const captured = current.captureSubmittedDraft(id)
    current.updateText(id, '')
    current.replaceReferences(id, [])
    const consumption = current.consumeSubmittedDraft('workspace-a', id, 'request-b', captured)
    await entered
    current.updateText(id, 'NEWER')
    current.replaceReferences(id, [reference('newer')])
    release()
    await consumption
    expect(current.getText(id)).toBe('NEWER')
    expect(current.getReferences(id)).toEqual([reference('newer')])
    await current.flushContent(id)
    expect(config.getSessionDraft(id)?.text).toBe('NEWER')
  })

  test('typing a new full draft while the send waits for its lock survives consumption', async () => {
    const id = 'new-edit-before-consume'
    config.setSessionDraft(id, { text: 'OLD', references: [reference('old')], attachments: [{ path: '/old.txt', name: 'old.txt' }] })
    const current = coordinator()
    const captured = current.captureSubmittedDraft(id)
    current.updateText(id, '')
    current.updateAttachments(id, [])
    current.replaceReferences(id, [])
    current.updateText(id, 'NEW UNSENT')
    current.updateAttachments(id, [{ path: '/new.txt', name: 'new.txt' }])
    current.replaceReferences(id, [reference('newer')])
    await current.consumeSubmittedDraft('workspace-a', id, 'delayed-request', captured)
    expect(current.getDraft(id)).toMatchObject({
      text: 'NEW UNSENT', references: [reference('newer')], attachments: [{ path: '/new.txt', name: 'new.txt' }],
    })
  })

  test('a newer draft that already persisted is neither consumed nor duplicated', async () => {
    const id = 'new-edit-persisted-before-consume'
    config.setSessionDraft(id, { text: 'OLD' })
    const current = coordinator()
    const captured = current.captureSubmittedDraft(id)
    current.updateText(id, '')
    current.updateText(id, 'NEW SAVED')
    await current.flushContent(id)
    await current.consumeSubmittedDraft('workspace-a', id, 'later-request', captured)
    expect(current.getText(id)).toBe('NEW SAVED')
    expect(config.getSessionDraft(id)?.text).toBe('NEW SAVED')
  })

  test('typing before initial hydration preserves unseen disk attachments and references through persistence', async () => {
    const id = 'dirty-hydration-fields'
    const attachment = { path: '/persisted.txt', name: 'persisted.txt' }
    config.setSessionDraft(id, { text: 'DISK', references: [reference('disk')], attachments: [attachment] })
    const current = coordinator({}, value => {
      value.updateText(id, 'LOCAL')
      value.replaceReferences(id, [reference('local')])
    })
    expect(current.getText(id)).toBe('LOCAL')
    expect(current.getAttachmentRefs(id)).toEqual([attachment])
    expect(current.getReferences(id)).toEqual([reference('disk'), reference('local')])
    await current.flushForWorkspaceSwitch('workspace-a')
    expect(config.getSessionDraft(id)?.text).toBe('DISK\n\nLOCAL')
    expect(config.getSessionDraft(id)?.attachments).toEqual([attachment])
    expect(config.getSessionDraft(id)?.references).toEqual([reference('disk'), reference('local')])
    expect(current.getText(id)).toBe('DISK\n\nLOCAL')
  })

  test('Edit followed by immediate replacement and send consumes the persisted base before Stop restores the new input', async () => {
    const id = 'edit-replace-immediate-stop'
    const original = {
      text: 'R03 ORIGINAL BODY A', references: [reference('text'), reference('pdf'), reference('epub')],
      attachments: [{ path: 'paste.txt', name: 'paste.txt', content: { type: 'text' as const, mimeType: 'text/plain', size: 7, text: 'PAYLOAD' } }],
    }
    const current = coordinator()
    await current.restoreInput('workspace-a', id, 'project-a', { type: 'restore_input', ...original })
    const queued = { ...original, text: 'I04 NEW BODY B' }
    // captureSubmittedDraft flushes this live replacement before the 300 ms
    // composer debounce. The Edit reference write has already advanced the
    // host revision independently of its earlier content acknowledgement.
    current.updateText(id, queued.text)
    const captured = current.captureSubmittedDraft(id, queued)
    current.updateText(id, '')
    current.updateAttachments(id, [])
    current.replaceReferences(id, [])
    await current.consumeSubmittedDraft('workspace-a', id, 'edit-replace-request', captured)
    const afterSend = current.getDraft(id)
    const afterSendOnDisk = config.getSessionDraft(id)
    // Reconciliation replays exactly the same consumption identity, as it
    // does after an ambiguous send/ACK. It must not revive the Edit snapshot.
    await current.consumeSubmittedDraft('workspace-a', id, 'edit-replace-request', captured)
    await current.restoreInput('workspace-a', id, 'project-a', {
      type: 'restore_input', ...queued, queuedRestoreId: 'input-edit-replace-request', messageIds: ['queued-message'],
    })
    expect({ afterSend: afterSend?.text ?? '', afterSendOnDisk: afterSendOnDisk?.text ?? '', afterStop: current.getText(id) })
      .toEqual({ afterSend: '', afterSendOnDisk: '', afterStop: queued.text })
    expect(current.getReferences(id)).toEqual(queued.references)
    expect(current.getAttachmentRefs(id)).toEqual(queued.attachments)
    expect(config.getSessionDraft(id)).toMatchObject(queued)
  })

  test('consuming a replacement preserves unrelated text written by another window', async () => {
    const id = 'replacement-with-remote-draft'
    config.setSessionDraft(id, { text: 'ORIGINAL A' })
    const current = coordinator()
    current.updateText(id, 'SUBMITTED B')
    const captured = current.captureSubmittedDraft(id)
    current.updateText(id, '')
    config.setSessionDraftContent(id, { text: 'OTHER WINDOW C' })
    await current.consumeSubmittedDraft('workspace-a', id, 'remote-replacement-request', captured)
    expect(current.getText(id)).toBe('OTHER WINDOW C')
    await current.restoreInput('workspace-a', id, 'project-a', { type: 'restore_input', text: 'SUBMITTED B', queuedRestoreId: 'input-remote-replacement-request' })
    expect(current.getText(id)).toBe('OTHER WINDOW C\n\nSUBMITTED B')
  })

  test('all staged slots retire before either identical rejected input is restored', async () => {
    const id = 'same-text-queue'
    config.setSessionDraft(id, { text: 'SAME' })
    const current = coordinator()
    const first = current.captureSubmittedDraft(id)
    current.updateText(id, '')
    current.updateText(id, 'SAME')
    const second = current.captureSubmittedDraft(id)
    current.updateText(id, '')
    await current.consumeSubmittedDraft('workspace-a', id, 'same-a', first)
    await current.consumeSubmittedDraft('workspace-a', id, 'same-b', second)
    await current.restoreInput('workspace-a', id, 'project-a', { type: 'restore_input', text: 'SAME', queuedRestoreId: 'rejected-same-a' })
    await current.consumeSubmittedDraft('workspace-a', id, 'same-b', second)
    expect(current.getText(id)).toBe('SAME')
    await current.restoreInput('workspace-a', id, 'project-a', { type: 'restore_input', text: 'SAME', queuedRestoreId: 'rejected-same-b' })
    expect(config.getSessionDraft(id)?.text).toBe('SAME\n\nSAME')
  })
}
