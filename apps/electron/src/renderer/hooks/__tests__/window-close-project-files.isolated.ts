import { describe, expect, it, mock } from 'bun:test'

let closeRequested: ((request: { source: string }) => void) | undefined
let resolveFlush: (() => void) | undefined
const order: string[] = []

mock.module('react', () => ({
  useEffect: (effect: () => void | (() => void)) => { effect() },
}))
mock.module('jotai', () => ({
  useAtomValue: (atom: symbol) => atom.description === 'workbench'
    ? { activeProjectId: null }
    : atom.description === 'panels'
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
mock.module('@/workbench/workbench-state', () => ({
  workbenchAtom: Symbol('workbench'),
  workbenchPanelsAtom: Symbol('panels'),
  focusedWorkbenchPanelIdAtom: Symbol('focus'),
}))
mock.module('@/workbench/workbench-commands', () => ({
  closeWorkbenchPanelAtom: Symbol('close-panel'),
}))
mock.module('@/components/project-files/project-file-document-registry', () => ({
  flushOpenProjectFiles: () => {
    order.push('flush')
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
  it('先取消主进程 fallback，再等待 flush，最后确认关闭', async () => {
    useWindowCloseHandler()
    closeRequested?.({ source: 'window-button' })
    await Promise.resolve()

    expect(order).toEqual(['cancel-fallback', 'flush'])
    resolveFlush?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['cancel-fallback', 'flush', 'confirm-close'])
  })
})
