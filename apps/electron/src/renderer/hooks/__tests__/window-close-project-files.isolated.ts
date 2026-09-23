import { beforeEach, describe, expect, it, mock } from 'bun:test'

let closeRequested: ((request: { source: string }) => void) | undefined
let resolveFlush: (() => void) | undefined
let flushError: Error | null = null
const order: string[] = []
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
      onProjectFilesFlushRequested: () => () => {},
      completeProjectFilesFlush: async () => {},
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
    resolveFlush = undefined
    flushError = null
    order.length = 0
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
})
