import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'craft-agent-drafts-'))
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getSessionDraft, setSessionDraft, setSessionDraftContent, addSessionDraftReferenceAtomic, reconcileSessionDraftReferences, restoreSessionDraftAtomic, deleteSessionDraft, purgeSessionDraft, getAllSessionDrafts, getSessionDraftHydrationState } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
  }

  return run.stdout.toString().trim()
}

describe('session draft storage', () => {
  it('returns null for an unknown session', () => {
    const configDir = makeConfigDir()
    const output = runEval(configDir, "console.log(JSON.stringify(getSessionDraft('missing')))")
    expect(output).toBe('null')
  })

  it('round-trips a text-only draft', () => {
    const configDir = makeConfigDir()
    runEval(configDir, "setSessionDraft('s1', { text: 'hello world' })")
    const output = runEval(configDir, "console.log(JSON.stringify(getSessionDraft('s1')))")
    expect(JSON.parse(output)).toEqual({ text: 'hello world' })
  })

  it('round-trips a draft with attachment refs', () => {
    const configDir = makeConfigDir()
    runEval(configDir,
      "setSessionDraft('s1', { text: 'caption', attachments: [{ path: '/tmp/a.png', name: 'a.png' }, { path: '/tmp/b.pdf', name: 'Report.pdf' }] })"
    )
    const output = runEval(configDir, "console.log(JSON.stringify(getSessionDraft('s1')))")
    expect(JSON.parse(output)).toEqual({
      text: 'caption',
      attachments: [
        { path: '/tmp/a.png', name: 'a.png' },
        { path: '/tmp/b.pdf', name: 'Report.pdf' },
      ],
    })
  })

  it('round-trips an attachments-only draft (empty text)', () => {
    const configDir = makeConfigDir()
    runEval(configDir, "setSessionDraft('s1', { text: '', attachments: [{ path: '/tmp/a.png', name: 'a.png' }] })")
    const output = runEval(configDir, "console.log(JSON.stringify(getSessionDraft('s1')))")
    expect(JSON.parse(output)).toEqual({
      text: '',
      attachments: [{ path: '/tmp/a.png', name: 'a.png' }],
    })
  })

  it('round-trips a references-only draft', () => {
    const configDir = makeConfigDir()
    const reference = {
      version: 1,
      kind: 'chat-message',
      projectId: 'project-a',
      sessionId: 'source-session',
      messageId: 'source-message',
      role: 'assistant',
      quote: 'selected',
      locator: {
        type: 'text-quote',
        exact: 'selected',
        start: 0,
        end: 8,
      },
    }
    runEval(configDir, `setSessionDraft('s1', ${JSON.stringify({ text: '', references: [reference] })})`)
    const output = runEval(configDir, "console.log(JSON.stringify(getSessionDraft('s1')))" )
    expect(JSON.parse(output)).toEqual({ text: '', references: [reference] })
  })

  it('drops a draft containing an invalid structured reference', () => {
    const configDir = makeConfigDir()
    const draftsPath = join(configDir, 'drafts.json')
    writeFileSync(draftsPath, JSON.stringify({
      drafts: {
        s1: {
          text: 'unsafe',
          references: [{
            version: 1,
            kind: 'project-file',
            projectId: 'project-a',
            relativePath: '../outside.md',
          }],
        },
      },
      updatedAt: 0,
    }), 'utf-8')
    const output = runEval(configDir, "console.log(JSON.stringify(getAllSessionDrafts()))")
    expect(JSON.parse(output)).toEqual({})
  })

  it('拒绝把非法引用写入磁盘，避免下次启动连正文一起静默丢失', () => {
    const configDir = makeConfigDir()
    const output = runEval(configDir, `
      try {
        setSessionDraft('s1', {
          text: 'keep this text',
          references: [{ version: 1, kind: 'project-file', projectId: 'project-a', relativePath: '../outside.md' }],
        });
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
    `)
    expect(output).toBe('Invalid session draft')
    expect(runEval(configDir, "console.log(JSON.stringify(getSessionDraft('s1')))"))
      .toBe('null')
  })

  it('removes the entry when draft is fully empty', () => {
    const configDir = makeConfigDir()
    runEval(configDir, "setSessionDraft('s1', { text: 'typed' })")
    runEval(configDir, "setSessionDraft('s1', { text: '' })")
    const output = runEval(configDir, "console.log(JSON.stringify(getSessionDraft('s1')))")
    expect(output).toBe('null')
  })

  it('strips extra FileAttachment fields when persisting path-only attachments', () => {
    const configDir = makeConfigDir()
    // Pass a FileAttachment-shaped object (includes base64/size/etc.); persistence
    // should reduce it to just path + name when no `content` subfield is present.
    runEval(configDir,
      "setSessionDraft('s1', { text: '', attachments: [{ path: '/tmp/a.png', name: 'a.png', base64: 'AAAA', size: 4, type: 'image', mimeType: 'image/png' }] })"
    )
    const draftsPath = join(configDir, 'drafts.json')
    const raw = JSON.parse(readFileSync(draftsPath, 'utf-8'))
    expect(raw.drafts.s1.attachments).toEqual([{ path: '/tmp/a.png', name: 'a.png' }])
  })

  it('round-trips a draft with a content-backed attachment (paste / web-drag path)', () => {
    const configDir = makeConfigDir()
    runEval(configDir,
      "setSessionDraft('s1', { text: 'note', attachments: [{ path: 'pasted-image-1.png', name: 'pasted-image-1.png', content: { type: 'image', mimeType: 'image/png', size: 4, base64: 'AAAA', thumbnailBase64: 'BBBB' } }] })"
    )
    const output = runEval(configDir, "console.log(JSON.stringify(getSessionDraft('s1')))")
    expect(JSON.parse(output)).toEqual({
      text: 'note',
      attachments: [{
        path: 'pasted-image-1.png',
        name: 'pasted-image-1.png',
        content: { type: 'image', mimeType: 'image/png', size: 4, base64: 'AAAA', thumbnailBase64: 'BBBB' },
      }],
    })
  })

  it('round-trips a text-content attachment without base64', () => {
    const configDir = makeConfigDir()
    runEval(configDir,
      "setSessionDraft('s1', { text: '', attachments: [{ path: 'pasted.txt', name: 'pasted.txt', content: { type: 'text', mimeType: 'text/plain', size: 5, text: 'hello' } }] })"
    )
    const output = runEval(configDir, "console.log(JSON.stringify(getSessionDraft('s1')))")
    expect(JSON.parse(output)).toEqual({
      text: '',
      attachments: [{
        path: 'pasted.txt',
        name: 'pasted.txt',
        content: { type: 'text', mimeType: 'text/plain', size: 5, text: 'hello' },
      }],
    })
  })

  it('rejects on load: ref with malformed content (wrong type field)', () => {
    const configDir = makeConfigDir()
    const draftsPath = join(configDir, 'drafts.json')
    writeFileSync(draftsPath, JSON.stringify({
      drafts: {
        s1: {
          text: '',
          attachments: [{ path: 'x.png', name: 'x.png', content: { type: 'bogus', mimeType: 'image/png', size: 1 } }],
        },
      },
      updatedAt: 0,
    }), 'utf-8')
    const output = runEval(configDir, "console.log(JSON.stringify(getAllSessionDrafts()))")
    expect(JSON.parse(output)).toEqual({})
  })

  it('rejects on load: 0.8.11-shape ref (synthetic filename path, no content)', () => {
    const configDir = makeConfigDir()
    const draftsPath = join(configDir, 'drafts.json')
    writeFileSync(draftsPath, JSON.stringify({
      drafts: {
        s1: {
          text: 'note',
          attachments: [{ path: 'image.png', name: 'image.png' }],
        },
      },
      updatedAt: 0,
    }), 'utf-8')
    const output = runEval(configDir, "console.log(JSON.stringify(getAllSessionDrafts()))")
    // Entire draft is dropped (attachment validator fails → ref fails → draft fails)
    expect(JSON.parse(output)).toEqual({})
  })

  it('discards legacy string-shaped drafts on load', () => {
    const configDir = makeConfigDir()
    // Simulate a pre-upgrade drafts.json where values are strings.
    const draftsPath = join(configDir, 'drafts.json')
    writeFileSync(draftsPath, JSON.stringify({
      drafts: {
        old1: 'unmigrated text',
        old2: 'another one',
      },
      updatedAt: 0,
    }), 'utf-8')
    const output = runEval(configDir, "console.log(JSON.stringify(getAllSessionDrafts()))")
    expect(JSON.parse(output)).toEqual({})
  })

  it('keeps valid SessionDraft entries and drops invalid siblings on load', () => {
    const configDir = makeConfigDir()
    const draftsPath = join(configDir, 'drafts.json')
    writeFileSync(draftsPath, JSON.stringify({
      drafts: {
        valid: { text: 'stay' },
        legacy: 'drop',
        mangled: { text: 42 },
      },
      updatedAt: 0,
    }), 'utf-8')
    const output = runEval(configDir, "console.log(JSON.stringify(getAllSessionDrafts()))")
    expect(JSON.parse(output)).toEqual({ valid: { text: 'stay' } })
  })

  it('deleteSessionDraft removes the entry', () => {
    const configDir = makeConfigDir()
    runEval(configDir, "setSessionDraft('s1', { text: 'hi' })")
    runEval(configDir, "deleteSessionDraft('s1')")
    const output = runEval(configDir, "console.log(JSON.stringify(getSessionDraft('s1')))")
    expect(output).toBe('null')
  })

  it('updates text and attachments without overwriting a concurrently added reference', () => {
    const configDir = makeConfigDir()
    const reference = {
      version: 1,
      kind: 'web-selection',
      projectId: 'project-a',
      url: 'https://example.com',
      title: 'Example',
      quote: 'selected',
      locator: { type: 'web-text-quote', exact: 'selected' },
    }
    const output = runEval(configDir, `
      addSessionDraftReferenceAtomic('s1', 'project-a', ${JSON.stringify(reference)});
      setSessionDraftContent('s1', { text: 'typed later', attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }] });
      console.log(JSON.stringify(getSessionDraft('s1')));
    `)
    expect(JSON.parse(output)).toEqual({
      text: 'typed later',
      attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }],
      references: [reference],
    })
  })

  it('three-way reference updates preserve a concurrent Browser reference', () => {
    const configDir = makeConfigDir()
    const original = {
      version: 1,
      kind: 'web-selection',
      projectId: 'project-a',
      url: 'https://example.com/original',
      title: 'Original',
      quote: 'original',
      locator: { type: 'web-text-quote', exact: 'original' },
    }
    const concurrent = {
      ...original,
      url: 'https://example.com/concurrent',
      title: 'Concurrent',
      quote: 'concurrent',
      locator: { type: 'web-text-quote', exact: 'concurrent' },
    }
    const output = runEval(configDir, `
      setSessionDraft('s1', ${JSON.stringify({ text: 'keep', references: [original] })});
      addSessionDraftReferenceAtomic('s1', 'project-a', ${JSON.stringify(concurrent)});
      reconcileSessionDraftReferences('s1', 'project-a', ${JSON.stringify([original])}, []);
      console.log(JSON.stringify(getSessionDraft('s1')));
    `)
    expect(JSON.parse(output)).toEqual({ text: 'keep', references: [concurrent] })
  })

  it('applies a Browser reference request exactly once across draft deletion and replay', () => {
    const configDir = makeConfigDir()
    const reference = {
      version: 1,
      kind: 'web-selection',
      projectId: 'project-a',
      url: 'https://example.com/once',
      title: 'Once',
      quote: 'selected once',
      locator: { type: 'web-text-quote', exact: 'selected once' },
    }
    const output = runEval(configDir, `
      const first = addSessionDraftReferenceAtomic(
        's1',
        'project-a',
        ${JSON.stringify(reference)},
        'browser-request-1',
      );
      deleteSessionDraft('s1');
      const replay = addSessionDraftReferenceAtomic(
        's1',
        'project-a',
        ${JSON.stringify(reference)},
        'browser-request-1',
      );
      console.log(JSON.stringify({ first, replay, stored: getSessionDraft('s1') }));
    `)
    expect(JSON.parse(output)).toEqual({
      first: { text: '', references: [reference] },
      replay: { text: '' },
      stored: null,
    })
  })

  it('forgets Browser request receipts when the owning Chat is permanently deleted', () => {
    const configDir = makeConfigDir()
    const reference = {
      version: 1,
      kind: 'web-selection',
      projectId: 'project-a',
      url: 'https://example.com/deleted-chat',
      title: 'Deleted Chat',
      quote: 'selection',
      locator: { type: 'web-text-quote', exact: 'selection' },
    }
    const output = runEval(configDir, `
      addSessionDraftReferenceAtomic(
        's1',
        'project-a',
        ${JSON.stringify(reference)},
        'browser-request-deleted-chat',
      );
      purgeSessionDraft('s1');
      const recreated = addSessionDraftReferenceAtomic(
        's1',
        'project-a',
        ${JSON.stringify(reference)},
        'browser-request-deleted-chat',
      );
      console.log(JSON.stringify(recreated));
    `)
    expect(JSON.parse(output)).toEqual({ text: '', references: [reference] })
  })

  it('refuses to merge a Browser reference into a draft from another Project', () => {
    const configDir = makeConfigDir()
    const reference = {
      version: 1,
      kind: 'web-selection',
      projectId: 'project-a',
      url: 'https://example.com',
      title: 'Example',
      quote: 'selected',
      locator: { type: 'web-text-quote', exact: 'selected' },
    }
    const output = runEval(configDir, `
      setSessionDraft('s1', ${JSON.stringify({ text: '', references: [reference] })});
      console.log(JSON.stringify(addSessionDraftReferenceAtomic(
        's1',
        'project-b',
        ${JSON.stringify({ ...reference, projectId: 'project-b' })},
      )));
    `)
    expect(output).toBe('null')
  })

  it('restores queued input exactly once for the same restore id', () => {
    const configDir = makeConfigDir()
    const reference = {
      version: 1,
      kind: 'web-selection',
      projectId: 'project-a',
      url: 'https://example.com',
      title: 'Example',
      quote: 'selected',
      locator: { type: 'web-text-quote', exact: 'selected' },
    }
    const restored = {
      text: 'queued text',
      attachments: [{ path: '/tmp/queued.txt', name: 'queued.txt' }],
      references: [reference],
    }
    const output = runEval(configDir, `
      setSessionDraft('s1', { text: 'typed first' });
      const first = restoreSessionDraftAtomic('s1', 'project-a', 'restore-1', ${JSON.stringify(restored)});
      const replay = restoreSessionDraftAtomic('s1', 'project-a', 'restore-1', ${JSON.stringify(restored)});
      console.log(JSON.stringify({ first, replay, draft: getSessionDraft('s1') }));
    `)
    expect(JSON.parse(output)).toEqual({
      first: {
        applied: true,
        committed: true,
        localApplied: false,
        revision: 2,
        draft: {
          text: 'typed first\n\nqueued text',
          attachments: restored.attachments,
          references: [reference],
        },
      },
      replay: {
        applied: false,
        committed: true,
        localApplied: false,
        revision: 2,
        draft: {
          text: 'typed first\n\nqueued text',
          attachments: restored.attachments,
          references: [reference],
        },
      },
      draft: {
        text: 'typed first\n\nqueued text',
        attachments: restored.attachments,
        references: [reference],
      },
    })
  })

  it('hydrates restore ids with their authoritative drafts', () => {
    const configDir = makeConfigDir()
    const output = runEval(configDir, `
      restoreSessionDraftAtomic('s1', 'project-a', 'restore-1', { text: 'queued' });
      console.log(JSON.stringify(getSessionDraftHydrationState()));
    `)
    expect(JSON.parse(output)).toEqual({
      drafts: { s1: { text: 'queued' } },
      revisions: { s1: 1 },
      appliedRestoreIds: { s1: ['restore-1'] },
    })
  })
})
