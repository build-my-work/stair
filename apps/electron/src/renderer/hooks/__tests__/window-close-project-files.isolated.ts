import { beforeEach, describe, expect, it, mock } from 'bun:test'

let closeRequested: ((request: { source: string }) => void) | undefined
let projectFilesFlushRequested: ((requestId: string) => void) | undefined
let resolveFlush: (() => void) | undefined
let flushError: Error | null = null
const order: string[] = []
const flushCompletions: Array<{ requestId: string; error?: string }> = []
const actualReactModule = await import('react')
const actualJotaiModule = await import('jotai')
const actualWorkbenchStateModule = await import('../../workbench/workbench-state')
const actualProjectFileRegistryModule = await import(
  '../../components/project-files/project-file-document-registry'
)

mock.module('react', () => ({
  ...actualReactModule,
  useEffect: (effect: () => void | (() => void)) => { effect() },
}))
mock.module('jotai', () => ({
  ...actualJotaiModule,
  useAtomValue: (atom: unknown) => atom === actualWorkbenchStateModule.workbenchAtom
    ? { activeProjectId: null }
    : atom === actualWorkbenchStateModule.workbenchPanelsAtom
      ? []
      : null,
  useSetAtom: () => async () => true,
}))
mock.module('@/context/ModalContext', () => ({
  useModalRegistry: () => ({ hasOpenModals: () => false, closeTopModal: () => {} }),
}))
mock.module('@/context/DismissibleLayerContext', () => ({
  useDismissibleLayerRegistry: () => ({ hasOpenLayers: () => false, closeTop: () => {} }),
}))
mock.module('@/components/project-files/project-file-document-registry', () => ({
  ...actualProjectFileRegistryModule,
  flushOpenProjectFiles: () => {
    order.push('flush')
    if (flushError) return Promise.reject(flushError)
    return new Promise<void>(resolve => { resolveFlush = resolve })
  },
}))

Object.assign(globalThis, {
  window: {
    electronAPI: {
      onProjectFilesFlushRequested: (callback: typeof projectFilesFlushRequested) => {
        projectFilesFlushRequested = callback
        return () => {}
      },
      completeProjectFilesFlush: async (requestId: string, error?: string) => {
        flushCompletions.push({ requestId, ...(error ? { error } : {}) })
      },
      onCloseRequested: (callback: typeof closeRequested) => {
        closeRequested = callback
        return () => {}
      },
      cancelCloseWindow: async () => { order.push('cancel-fallback') },
      confirmCloseWindow: async () => { order.push('confirm-close') },
      debugLog: () => {},
    },
  },
})

const { useWindowCloseHandler } = await import('../useWindowCloseHandler')

describe('窗口关闭前的 Project File flush', () => {
  beforeEach(() => {
    closeRequested = undefined
    projectFilesFlushRequested = undefined
    resolveFlush = undefined
    flushError = null
    order.length = 0
    flushCompletions.length = 0
  })

  it('先取消主进程 fallback，再等待 flush，最后确认关闭', async () => {
    useWindowCloseHandler()
    closeRequested?.({ source: 'window-button' })
    await Promise.resolve()

    expect(order).toEqual(['cancel-fallback', 'flush'])
    resolveFlush?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['cancel-fallback', 'flush', 'confirm-close'])
  })

  it('flush 失败时保持窗口打开且不确认关闭', async () => {
    flushError = new Error('save failed')
    useWindowCloseHandler()
    closeRequested?.({ source: 'window-button' })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['cancel-fallback', 'flush', 'cancel-fallback'])
  })

  it('窗口关闭等待未完成的草稿保存，文件保存完成也不能提前关闭', async () => {
    let resolveDraft: (() => void) | undefined
    const draftFlush = new Promise<void>(resolve => { resolveDraft = resolve })
    useWindowCloseHandler(false, () => draftFlush)
    closeRequested?.({ source: 'window-button' })
    await Promise.resolve()
    resolveFlush?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).not.toContain('confirm-close')

    resolveDraft?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toContain('confirm-close')
  })

  it('正常退出的 flush 请求等待草稿保存后才确认成功', async () => {
    let resolveDraft: (() => void) | undefined
    const draftFlush = new Promise<void>(resolve => { resolveDraft = resolve })
    useWindowCloseHandler(false, () => draftFlush)
    projectFilesFlushRequested?.('quit-request')
    resolveFlush?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(flushCompletions).toEqual([])

    resolveDraft?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(flushCompletions).toEqual([{ requestId: 'quit-request' }])
  })

  it('草稿保存失败使正常退出的 flush 请求返回错误', async () => {
    useWindowCloseHandler(false, async () => { throw new Error('draft disk full') })
    projectFilesFlushRequested?.('quit-failed')
    resolveFlush?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(flushCompletions).toEqual([{ requestId: 'quit-failed', error: 'draft disk full' }])
  })

  it('草稿保存失败时不确认原生窗口关闭', async () => {
    useWindowCloseHandler(false, async () => { throw new Error('draft disk full') })
    closeRequested?.({ source: 'window-button' })
    await Promise.resolve()
    resolveFlush?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).not.toContain('confirm-close')
    expect(order.filter(entry => entry === 'cancel-fallback')).toHaveLength(2)
  })
})
