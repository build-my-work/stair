import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { SessionMeta } from '@/atoms/sessions'
import {
  findEmptySessionsLeavingWorkbench,
  sessionDraftHasContent,
} from '../session-auto-cleanup'

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    messageCount: 0,
    ...overrides,
  }
}

describe('Workbench 空 Session 自动清理', () => {
  it('同时识别文本草稿和附件草稿', () => {
    expect(sessionDraftHasContent(null)).toBe(false)
    expect(sessionDraftHasContent({ text: '' })).toBe(false)
    expect(sessionDraftHasContent({ text: '未保存内容' })).toBe(true)
    expect(sessionDraftHasContent({
      text: '',
      attachments: [{ path: '/tmp/image.png', name: 'image.png' }],
    })).toBe(true)
  })

  it('只删除离开最后一个可见 Panel 的无名、无消息、无草稿且非 processing Session', () => {
    const metas = new Map([
      ['empty', meta('empty')],
      ['named', meta('named', { name: '保留' })],
      ['messaged', meta('messaged', { messageCount: 1 })],
      ['drafted', meta('drafted')],
      ['processing', meta('processing', { isProcessing: true })],
    ])

    expect(findEmptySessionsLeavingWorkbench(
      new Set(metas.keys()),
      new Set(),
      metas,
      sessionId => sessionId === 'drafted',
      'workspace-a',
    )).toEqual(['empty'])
  })

  it('关闭一个 Panel 后仍在其他 Panel 可见时不删除 Session', () => {
    const metas = new Map([['shared', meta('shared')]])

    expect(findEmptySessionsLeavingWorkbench(
      new Set(['shared']),
      new Set(['shared']),
      metas,
      () => false,
      'workspace-a',
    )).toEqual([])
  })

  it('元数据缺失或已有最终消息时保留 Session', () => {
    const metas = new Map([
      ['answered', meta('answered', { lastFinalMessageId: 'message-1' })],
    ])

    expect(findEmptySessionsLeavingWorkbench(
      new Set(['missing', 'answered']),
      new Set(),
      metas,
      () => false,
      'workspace-a',
    )).toEqual([])
  })

  it('切换 Workspace 时不删除上一个 Workspace 的空 Session', () => {
    const metas = new Map([['old', meta('old', { workspaceId: 'workspace-a' })]])

    expect(findEmptySessionsLeavingWorkbench(
      new Set(['old']),
      new Set(),
      metas,
      () => false,
      'workspace-b',
    )).toEqual([])
  })

  it('删除前复核持久草稿和当前可见性，并清除待执行的草稿写入', () => {
    const appSource = readFileSync(
      new URL('../../App.tsx', import.meta.url),
      'utf8',
    )

    expect(appSource).toContain(
      'const persistedDraft = await window.electronAPI.getDraft(sessionId)',
    )
    expect(appSource).toContain('sessionDraftHasContent(persistedDraft)')
    expect(appSource).toMatch(
      /handleAutoDeleteEmptySession[\s\S]*?findEmptySessionsLeavingWorkbench\(/,
    )
    expect(appSource).toMatch(
      /handleDeleteSession[\s\S]*?draftSaveTimeoutRef\.current\.get\(sessionId\)[\s\S]*?clearTimeout/,
    )
  })
})
