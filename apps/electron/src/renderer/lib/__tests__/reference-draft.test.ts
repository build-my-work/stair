import { describe, expect, it } from 'bun:test'

import type { Reference } from '@craft-agent/core'
import {
  addSessionDraftReference,
  applyQueuedInputRestore,
  mergeAuthoritativeSessionDraftReferences,
  mergeHydratedSessionDrafts,
  removeSessionDraftReference,
  restoreSessionDraftContent,
  setSessionDraftAttachments,
  setSessionDraftReferences,
  setSessionDraftText,
} from '../reference-draft'

const reference: Reference = {
  version: 1,
  kind: 'chat-message',
  projectId: 'project-a',
  sessionId: 'session-source',
  messageId: 'message-source',
  role: 'assistant',
  quote: '引用',
  locator: {
    type: 'text-quote',
    exact: '引用',
    start: 0,
    end: 2,
  },
}

describe('引用草稿更新', () => {
  it('修改文本或附件时保留已有引用', () => {
    const draft = { text: '', references: [reference] }

    expect(setSessionDraftText(draft, '问题')).toEqual({
      text: '问题',
      references: [reference],
    })
    expect(setSessionDraftAttachments(draft, [{ path: '/tmp/a.txt', name: 'a.txt' }]))
      .toEqual({
        text: '',
        attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }],
        references: [reference],
      })
  })

  it('只向同 Project 草稿追加引用并去重', () => {
    const first = addSessionDraftReference({ text: '' }, 'project-a', reference)
    expect(first?.references).toEqual([reference])
    expect(addSessionDraftReference(first, 'project-a', reference)?.references)
      .toEqual([reference])
    expect(addSessionDraftReference(first, 'project-b', reference)).toBeNull()
  })

  it('移除最后一个引用后删除空草稿，但保留文本草稿', () => {
    expect(removeSessionDraftReference({ text: '', references: [reference] }, reference))
      .toBeNull()
    expect(removeSessionDraftReference({ text: '问题', references: [reference] }, reference))
      .toEqual({ text: '问题' })
  })

  it('批量替换引用时仍执行 Project 边界并保留其他草稿内容', () => {
    expect(setSessionDraftReferences({ text: '问题' }, 'project-a', [reference]))
      .toEqual({ text: '问题', references: [reference] })
    expect(setSessionDraftReferences({ text: '问题', references: [reference] }, 'project-a', []))
      .toEqual({ text: '问题' })
    expect(setSessionDraftReferences({ text: '问题' }, 'project-b', [reference]))
      .toBeNull()
  })

  it('服务端权威快照合并时同时保留本地新增和本地删除意图', () => {
    const remote = { ...reference, messageId: 'message-remote' }
    const local = { ...reference, messageId: 'message-local' }

    expect(mergeAuthoritativeSessionDraftReferences(
      { text: '问题', references: [local] },
      'project-a',
      [reference],
      [reference, remote],
    )).toEqual({
      ok: true,
      draft: {
        text: '问题',
        references: [remote, local],
      },
    })
  })

  it('服务端新增引用会进入本地，但已确认后被用户删除的引用不会复活', () => {
    const added = { ...reference, messageId: 'message-added' }

    expect(mergeAuthoritativeSessionDraftReferences(
      { text: '', references: [reference] },
      'project-a',
      [reference],
      [reference, added],
    )).toEqual({
      ok: true,
      draft: { text: '', references: [reference, added] },
    })

    expect(mergeAuthoritativeSessionDraftReferences(
      { text: '', references: [reference] },
      'project-a',
      [reference, added],
      [reference, added],
    )).toEqual({
      ok: true,
      draft: { text: '', references: [reference] },
    })
  })

  it('发送清空旧草稿时仍保留并发完成的 Browser 新引用', () => {
    const browserReference = { ...reference, messageId: 'browser-selection' }

    expect(mergeAuthoritativeSessionDraftReferences(
      null,
      'project-a',
      [reference],
      [reference, browserReference],
    )).toEqual({
      ok: true,
      draft: {
        text: '',
        references: [browserReference],
      },
    })
  })

  it('权威快照与本地引用合并超限时显式失败而不是伪装成空草稿', () => {
    const confirmed = Array.from({ length: 31 }, (_, index): Reference => ({
      ...reference,
      messageId: `confirmed-${index}`,
    }))
    const remote = { ...reference, messageId: 'remote' }
    const local = { ...reference, messageId: 'local' }

    expect(mergeAuthoritativeSessionDraftReferences(
      { text: '', references: [...confirmed, local] },
      'project-a',
      confirmed,
      [...confirmed, remote],
    )).toEqual({ ok: false, reason: 'reference-boundary' })
  })

  it('批量恢复先去重再执行数量上限，重复引用不会造成误拒绝', () => {
    expect(setSessionDraftReferences(
      { text: '问题' },
      'project-a',
      Array.from({ length: 33 }, () => reference),
    )).toEqual({ text: '问题', references: [reference] })
  })

  it('引用发送失败时合并恢复刚发送内容，不覆盖用户随后输入的草稿', () => {
    expect(restoreSessionDraftContent(
      { text: '随后输入', attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }] },
      'project-a',
      '发送失败',
      [reference],
    )).toEqual({
      ok: true,
      draft: {
        text: '随后输入\n\n发送失败',
        attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }],
        references: [reference],
      },
    })
    expect(restoreSessionDraftContent(
      { text: '随后输入' },
      undefined,
      '发送失败',
      [reference],
    )).toEqual({
      ok: false,
      draft: { text: '随后输入' },
      reason: 'reference-boundary',
    })
  })

  it('恢复引用超过草稿上限时原子失败，不静默保留部分恢复结果', () => {
    const fullReferences = Array.from({ length: 32 }, (_, index): Reference => ({
      ...reference,
      messageId: `message-${index}`,
    }))
    const existing = { text: '随后输入', references: fullReferences }

    expect(restoreSessionDraftContent(
      existing,
      'project-a',
      '排队消息',
      [{ ...reference, messageId: 'queued-message' }],
    )).toEqual({
      ok: false,
      draft: existing,
      reason: 'reference-boundary',
    })
  })

  it('Stop 恢复当前 in-flight 文本时同时合并其结构化引用', () => {
    expect(restoreSessionDraftContent(
      { text: '正在编辑' },
      'project-a',
      '刚刚发送',
      [reference],
    )).toEqual({
      ok: true,
      draft: {
        text: '正在编辑\n\n刚刚发送',
        references: [reference],
      },
    })
  })

  it('Stop 恢复 queued 附件时追加到用户随后选择的附件', () => {
    expect(restoreSessionDraftContent(
      {
        text: '正在编辑',
        attachments: [{ path: '/tmp/new.txt', name: 'new.txt' }],
      },
      'project-a',
      '排队消息',
      [],
      [{ path: '/tmp/queued.txt', name: 'queued.txt' }],
    )).toEqual({
      ok: true,
      draft: {
        text: '正在编辑\n\n排队消息',
        attachments: [
          { path: '/tmp/new.txt', name: 'new.txt' },
          { path: '/tmp/queued.txt', name: 'queued.txt' },
        ],
      },
    })
  })

  it('refs-only 恢复不会给 hydration 期间的新文本追加空白行', () => {
    expect(restoreSessionDraftContent(
      { text: 'hydration 期间输入' },
      'project-a',
      '',
      [reference],
    )).toEqual({
      ok: true,
      draft: {
        text: 'hydration 期间输入',
        references: [reference],
      },
    })
  })

  it('重启 hydration 已包含 restore id 时不会再次追加 queued input', () => {
    const hydrated = {
      text: '原草稿\n\n排队消息',
      attachments: [{ path: '/tmp/queued.txt', name: 'queued.txt' }],
      references: [reference],
    }
    expect(applyQueuedInputRestore(
      hydrated,
      hydrated,
      hydrated,
      'project-a',
    )).toEqual({ ok: true, draft: hydrated })
  })

  it('hydration 前的新输入会与已原子恢复的权威草稿合并而不是覆盖它', () => {
    const authoritative = {
      text: '排队消息',
      attachments: [{ path: '/tmp/queued.txt', name: 'queued.txt' }],
      references: [reference],
    }
    expect(applyQueuedInputRestore(
      {
        text: 'hydration 前输入',
        attachments: [{ path: '/tmp/new.txt', name: 'new.txt' }],
      },
      null,
      authoritative,
      'project-a',
    )).toEqual({
      ok: true,
      draft: {
        text: '排队消息\n\nhydration 前输入',
        attachments: [
          { path: '/tmp/queued.txt', name: 'queued.txt' },
          { path: '/tmp/new.txt', name: 'new.txt' },
        ],
        references: [reference],
      },
    })
  })

  it('另一个尚未应用 restore id 的窗口会合并 queued input', () => {
    expect(applyQueuedInputRestore(
      { text: '原草稿' },
      { text: '原草稿' },
      { text: '原草稿\n\n排队消息', references: [reference] },
      'project-a',
    )).toEqual({
      ok: true,
      draft: {
        text: '原草稿\n\n排队消息',
        references: [reference],
      },
    })
  })

  it('本地和权威草稿追加同一段文本时只保留一份', () => {
    expect(applyQueuedInputRestore(
      { text: '原草稿\n\n同一段' },
      { text: '原草稿' },
      { text: '原草稿\n\n同一段' },
      'project-a',
    )).toEqual({
      ok: true,
      draft: { text: '原草稿\n\n同一段' },
    })
  })

  it('以服务端权威草稿为基线并保留当前窗口尚未落盘的输入', () => {
    expect(applyQueuedInputRestore(
      {
        text: '窗口 A 尚未落盘',
        attachments: [{ path: '/tmp/window-a.txt', name: 'window-a.txt' }],
      },
      null,
      {
        text: '窗口 B 已落盘\n\n排队消息',
        attachments: [{ path: '/tmp/queued.txt', name: 'queued.txt' }],
        references: [reference],
      },
      'project-a',
    )).toEqual({
      ok: true,
      draft: {
        text: '窗口 B 已落盘\n\n排队消息\n\n窗口 A 尚未落盘',
        attachments: [
          { path: '/tmp/queued.txt', name: 'queued.txt' },
          { path: '/tmp/window-a.txt', name: 'window-a.txt' },
        ],
        references: [reference],
      },
    })
  })

  it('保留 queued input，但不会复活恢复期间被本窗口删除的草稿内容', () => {
    const removedReference = {
      ...reference,
      quote: 'removed',
      locator: {
        type: 'text-quote' as const,
        exact: 'removed',
        start: 0,
        end: 7,
      },
    }
    const queuedReference = {
      ...reference,
      messageId: 'message-queued',
      quote: 'queued',
      locator: {
        type: 'text-quote' as const,
        exact: 'queued',
        start: 0,
        end: 6,
      },
    }
    const confirmedBefore = {
      text: '准备删除的文字',
      attachments: [{ path: '/tmp/removed.txt', name: 'removed.txt' }],
      references: [removedReference],
    }

    expect(applyQueuedInputRestore(
      { text: '' },
      confirmedBefore,
      {
        text: '准备删除的文字\n\n排队消息',
        attachments: [
          { path: '/tmp/removed.txt', name: 'removed.txt' },
          { path: '/tmp/queued.txt', name: 'queued.txt' },
        ],
        references: [removedReference, queuedReference],
      },
      'project-a',
    )).toEqual({
      ok: true,
      draft: {
        text: '排队消息',
        attachments: [{ path: '/tmp/queued.txt', name: 'queued.txt' }],
        references: [queuedReference],
      },
    })
  })

  it('异步 hydration 只补入未修改的草稿，并返回需要通知的 Session', () => {
    const current = new Map([
      ['typed-during-hydration', { text: '新输入' }],
    ])
    const persisted = {
      'refs-only': { text: '', references: [reference] },
      'typed-during-hydration': { text: '旧输入', references: [reference] },
      'cleared-during-hydration': { text: '', references: [reference] },
    }

    const result = mergeHydratedSessionDrafts(
      current,
      persisted,
      new Set(['cleared-during-hydration']),
    )

    expect(result.drafts.get('refs-only')).toEqual(persisted['refs-only'])
    expect(result.drafts.get('typed-during-hydration')).toEqual({ text: '新输入' })
    expect(result.drafts.has('cleared-during-hydration')).toBe(false)
    expect(result.hydratedSessionIds).toEqual(['refs-only'])
  })

  it('拒绝服务端必然会因体积超限而拒收的引用草稿', () => {
    const oversized = {
      ...reference,
      kind: 'project-file' as const,
      relativePath: 'books/book.epub',
      sourceFingerprint: `sha256:${'a'.repeat(64)}` as const,
      fileName: 'book.epub',
      tocPath: Array.from({ length: 20 }, (_, index) => ({
        key: `chapter-${index}`,
        title: '章'.repeat(1_000),
        orderPath: [index],
      })),
      locator: {
        type: 'epub-cfi' as const,
        cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:2)',
      },
    }

    expect(addSessionDraftReference({ text: '' }, 'project-a', oversized)).toBeNull()
    expect(setSessionDraftReferences({ text: '问题' }, 'project-a', [oversized]))
      .toBeNull()
  })
})
