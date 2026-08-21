import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const chatDisplaySource = readFileSync(
  new URL('../../components/app-shell/ChatDisplay.tsx', import.meta.url),
  'utf8',
)
const chatPageSource = readFileSync(new URL('../../pages/ChatPage.tsx', import.meta.url), 'utf8')

describe('Renderer 草稿失败恢复接线', () => {
  it('hydration 合并后通知已挂载的 ChatPage 重新读取 refs-only 草稿', () => {
    expect(appSource).toContain('mergeHydratedSessionDrafts(')
    expect(appSource).toContain('for (const sessionId of hydratedSessionIds)')
    expect(appSource).toContain("new CustomEvent('stair:draft-references-changed'")
    expect(chatPageSource).toContain("addEventListener('stair:draft-references-changed'")
  })

  it('引用校验失败时回滚对应 optimistic user message', () => {
    expect(appSource).toContain('rollbackRejectedOptimisticUserMessage(')
  })

  it('显式 Stop 使用当前 user message 的 references 做原子恢复', () => {
    expect(chatDisplaySource).toContain('restoreSessionDraftContent(')
    expect(chatDisplaySource).toContain('lastUserMsg.references ?? []')
  })

  it('只有持久化 restored draft 成功后才确认删除 queued bubbles', () => {
    expect(appSource).toContain('await window.electronAPI.setDraft(sessionId, restoredDraft)')
    expect(appSource).toContain('await window.electronAPI.acknowledgeQueuedInputRestore(')
  })
})
