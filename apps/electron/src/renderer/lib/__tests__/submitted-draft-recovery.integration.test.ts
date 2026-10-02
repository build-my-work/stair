import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Reference } from '@craft-agent/core'
import type { DraftContentMutation } from '@craft-agent/shared/config'
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
    await current.flushPendingDrafts('workspace-a')
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

  for (const restart of [false, true]) {
    test.each(['committed', 'not-committed', 'remote-before-commit', 'remote-after-commit', 'remote-without-commit'] as const)(
      `an ambiguous predecessor %s is consumed once with renderer restart=${restart}`,
      async (outcome) => {
        const id = `pending-predecessor-${outcome}-${restart}`
        const input = { text: 'SUBMITTED B', attachments: [{ path: '/new.txt', name: 'new.txt' }], references: [reference('B')] }
        const remote = { text: 'OTHER WINDOW C', attachments: [{ path: '/remote.txt', name: 'remote.txt' }], references: [reference('C')] }
        const hasRemote = outcome.startsWith('remote-')
        config.setSessionDraft(id, { text: 'ORIGINAL A', references: input.references })
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let attempts = 0
        const original = coordinator({ setDraftContent: async (sessionId, content, mutation) => {
          attempts += 1
          if (attempts !== 1) return config.setSessionDraftContent(sessionId, content, mutation)
          entered.resolve()
          await release.promise
          if (outcome === 'committed' || outcome === 'remote-after-commit') config.setSessionDraftContent(sessionId, content, mutation)
          if (hasRemote) {
            config.setSessionDraftContent(sessionId, remote, {
              id: `other-${id}`, clientId: 'other-window', sequence: 1,
              baseRevision: config.getSessionDraftHydrationState().revisions?.[sessionId] ?? 0,
              base: config.getSessionDraft(sessionId) ?? { text: '' },
            })
            config.reconcileSessionDraftReferences(sessionId, 'project-a', input.references, remote.references)
          }
          if (outcome === 'remote-before-commit') config.setSessionDraftContent(sessionId, content, mutation)
          throw new Error('Content write outcome unknown')
        } })
        original.updateText(id, input.text)
        original.updateAttachments(id, input.attachments)
        const flushing = original.flushContent(id).catch(error => error)
        await entered.promise
        const captured = JSON.parse(JSON.stringify(original.captureSubmittedDraft(id)))
        const immutableCapture = JSON.stringify(captured)
        original.updateText(id, '')
        original.updateAttachments(id, [])
        original.replaceReferences(id, [])
        release.resolve()
        expect(await flushing).toBeInstanceOf(Error)
        const current = restart ? coordinator() : original
        if (restart) original.dispose()
        await current.consumeSubmittedDraft('workspace-a', id, id, captured)
        expect({ text: current.getText(id), attachments: current.getAttachmentRefs(id), references: current.getReferences(id) })
          .toEqual(hasRemote ? remote : { text: '', attachments: [], references: [] })
        expect(config.getSessionDraft(id)?.text ?? '').toBe(hasRemote ? remote.text : '')
        expect(config.getSessionDraft(id)?.attachments ?? []).toEqual(hasRemote ? remote.attachments : [])
        await current.consumeSubmittedDraft('workspace-a', id, id, captured)
        expect(current.getText(id)).toBe(hasRemote ? remote.text : '')
        expect(JSON.stringify(captured)).toBe(immutableCapture)
        await current.restoreInput('workspace-a', id, 'project-a', {
          type: 'restore_input', ...input, queuedRestoreId: `input-${id}`, messageIds: ['queued-message'],
        })
        const expected = {
          text: hasRemote ? `${remote.text}\n\n${input.text}` : input.text,
          attachments: hasRemote ? [...remote.attachments, ...input.attachments] : input.attachments,
          references: hasRemote ? [...remote.references, ...input.references] : input.references,
        }
        expect(current.getDraft(id)).toMatchObject(expected)
        expect(config.getSessionDraft(id)).toMatchObject(expected)
        const reopened = coordinator()
        await reopened.consumeSubmittedDraft('workspace-a', id, id, captured)
        await reopened.restoreInput('workspace-a', id, 'project-a', { type: 'restore_input', ...input, queuedRestoreId: `input-${id}` })
        expect(reopened.getDraft(id)).toMatchObject(expected)
        expect(attempts).toBe(1)
      },
    )
  }

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

  test('a lost consumption reply preserves edits before its immutable retry and restores the input only once', async () => {
    const id = 'lost-consumption-reply'
    const input = { text: 'SUBMITTED B', attachments: [{ path: '/sent.txt', name: 'sent.txt' }] }
    const later = { text: 'ORIGINAL A', attachments: [{ path: '/later.txt', name: 'later.txt' }] }
    config.setSessionDraft(id, { text: 'ORIGINAL A' })
    const writeStarted = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()
    const consumeStarted = Promise.withResolvers<void>()
    const releaseConsume = Promise.withResolvers<void>()
    let lostReply = true
    const current = coordinator({
      setDraftContent: async (sessionId, content, mutation) => {
        writeStarted.resolve()
        await releaseWrite.promise
        config.setSessionDraftContent(sessionId, content, mutation)
        throw new Error('Content reply lost')
      },
      restoreDraftInput: async (sessionId, request) => {
        const result = config.restoreSessionDraftAtomic(sessionId, 'project-a', request.restoreId, request.draft, request.local)
        if (lostReply) {
          lostReply = false
          consumeStarted.resolve()
          await releaseConsume.promise
          throw new Error('Consumption reply lost')
        }
        return result
      },
    })
    current.updateText(id, input.text)
    current.updateAttachments(id, input.attachments)
    const writing = current.flushContent(id).catch(error => error)
    await writeStarted.promise
    const captured = current.captureSubmittedDraft(id)
    const immutableCapture = JSON.stringify(captured)
    current.updateText(id, '')
    current.updateAttachments(id, [])
    releaseWrite.resolve()
    await writing
    const consumption = current.consumeSubmittedDraft('workspace-a', id, id, captured).catch(error => error)
    await consumeStarted.promise
    current.updateText(id, later.text)
    current.updateAttachments(id, later.attachments)
    releaseConsume.resolve()
    expect(await consumption).toBeInstanceOf(Error)
    await current.consumeSubmittedDraft('workspace-a', id, id, captured)
    expect(current.getDraft(id)).toMatchObject(later)
    expect(JSON.stringify(captured)).toBe(immutableCapture)
    await current.restoreInput('workspace-a', id, 'project-a', { type: 'restore_input', ...input, queuedRestoreId: `input-${id}` })
    expect(current.getDraft(id)).toMatchObject({ text: `${later.text}\n\n${input.text}`, attachments: [...later.attachments, ...input.attachments] })
    expect(config.getSessionDraft(id)?.text).toBe(current.getText(id))
  })

  test.each([true, false])('identical text and attachments rewritten by another content writer keep their new ownership (identity=%s)', (identity) => {
    const id = `same-bytes-new-owner-${identity}`
    config.setSessionDraft(id, { text: 'A' })
    const pendingWrite = {
      content: { text: 'B', attachments: [{ path: '/new.txt', name: 'new.txt' }] },
      mutation: { id: `write-${id}`, clientId: 'writer', sequence: 1, baseRevision: config.getSessionDraftHydrationState().revisions?.[id] ?? 0, base: { text: 'A' } },
    }
    config.setSessionDraftContent(id, pendingWrite.content, pendingWrite.mutation)
    config.setSessionDraftContent(id, pendingWrite.content, {
      id: `other-${id}`, ...(identity ? { clientId: 'other-writer', sequence: 1 } : {}),
      baseRevision: config.getSessionDraftHydrationState().revisions?.[id] ?? 0, base: pendingWrite.content,
    })
    const consumed = config.restoreSessionDraftAtomic(id, 'project-a', `consume-${id}`, { text: '' }, {
      content: { text: '' }, mutation: { ...pendingWrite.mutation, id: `consume-${id}`, sequence: 2, pendingWrite },
    })
    expect(consumed.draft).toMatchObject(pendingWrite.content)
    expect(config.getSessionDraft(id)).toMatchObject(pendingWrite.content)
  })

  test('a predecessor receipt survives reference writes, omits inline attachment bytes, and is settled only once', () => {
    const id = 'causal-content-checkpoint'
    config.setSessionDraft(id, { text: 'A' })
    const inline = 'UNIQUE-INLINE-PAYLOAD-'.repeat(1000)
    const pendingWrite = {
      content: { text: 'B', attachments: [{ path: 'paste.txt', name: 'paste.txt', content: { type: 'text' as const, mimeType: 'text/plain', size: inline.length, text: inline } }] },
      mutation: { id: `write-${id}`, clientId: 'writer', sequence: 1, baseRevision: config.getSessionDraftHydrationState().revisions?.[id] ?? 0, base: { text: 'A' } },
    }
    config.setSessionDraftContent(id, pendingWrite.content, pendingWrite.mutation)
    config.reconcileSessionDraftReferences(id, 'project-a', [], [reference('C')])
    const raw = JSON.parse(readFileSync(join(process.env.CRAFT_CONFIG_DIR!, 'drafts.json'), 'utf8'))
    expect(raw.lastContentMutationIds[id]).toBe(pendingWrite.mutation.id)
    expect(JSON.stringify(raw.contentWriters[id])).not.toContain('UNIQUE-INLINE-PAYLOAD')
    expect(raw.contentWriters[id].writer.contentWrite.pending.removedAttachmentHashes).toHaveLength(1)
    const local = { content: { text: '' }, mutation: { ...pendingWrite.mutation, id: `first-${id}`, sequence: 2, pendingWrite } }
    config.restoreSessionDraftAtomic(id, 'project-a', `consume-first-${id}`, { text: '' }, local)
    expect(config.getSessionDraft(id)).toEqual({ text: '', references: [reference('C')] })
    config.restoreSessionDraftAtomic(id, 'project-a', `input-${id}`, pendingWrite.content)
    config.restoreSessionDraftAtomic(id, 'project-a', `consume-second-${id}`, { text: '' }, {
      ...local, mutation: { ...local.mutation, id: `second-${id}`, sequence: 3 },
    })
    expect(config.getSessionDraft(id)).toMatchObject(pendingWrite.content)
    expect(config.getSessionDraft(id)?.references).toEqual([reference('C')])
  })

  test('invalid or changed predecessor proofs cannot modify the durable draft', () => {
    const id = 'invalid-pending-proof'
    config.setSessionDraft(id, { text: 'A' })
    const pendingWrite = {
      content: { text: 'B' },
      mutation: { id: `write-${id}`, clientId: 'writer', sequence: 1, baseRevision: config.getSessionDraftHydrationState().revisions?.[id] ?? 0, base: { text: 'A' } },
    }
    config.setSessionDraftContent(id, pendingWrite.content, pendingWrite.mutation)
    const mutation: DraftContentMutation = { ...pendingWrite.mutation, id: `consume-${id}`, sequence: 2, pendingWrite }
    const file = join(process.env.CRAFT_CONFIG_DIR!, 'drafts.json')
    const before = readFileSync(file, 'utf8')
    const invalid = [
      { ...mutation, pendingWrite: { ...pendingWrite, content: { text: 'DIFFERENT' } } },
      { ...mutation, pendingWrite: { ...pendingWrite, mutation: { ...pendingWrite.mutation, clientId: 'other-writer' } } },
      { ...mutation, pendingWrite: { ...pendingWrite, mutation: { ...pendingWrite.mutation, sequence: 2 } } },
      { ...mutation, pendingWrite: { ...pendingWrite, mutation: { ...pendingWrite.mutation, pendingWrite } } },
      { ...mutation, pendingWrite: { ...pendingWrite, mutation: { ...pendingWrite.mutation, references: { baseReferences: [], nextReferences: [] } } } },
    ]
    for (const invalidMutation of invalid) {
      expect(() => config.restoreSessionDraftAtomic(id, 'project-a', `consume-${id}`, { text: '' }, { content: { text: '' }, mutation: invalidMutation })).toThrow()
      expect(readFileSync(file, 'utf8')).toBe(before)
    }
    expect(() => config.setSessionDraftContent(id, { text: '' }, mutation)).toThrow('Invalid pending draft content write')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
}
