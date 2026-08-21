import { describe, expect, it } from 'bun:test'

import type { Reference } from '@craft-agent/core'
import {
  addSessionDraftReference,
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
