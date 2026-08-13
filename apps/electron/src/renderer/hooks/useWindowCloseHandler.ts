import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useModalRegistry } from '@/context/ModalContext'
import { useDismissibleLayerRegistry } from '@/context/DismissibleLayerContext'
import {
  focusedWorkbenchPanelIdAtom,
  workbenchAtom,
  workbenchPanelsAtom,
} from '@/workbench/workbench-state'
import { closeWorkbenchPanelAtom } from '@/workbench/workbench-commands'
import { flushOpenProjectFiles } from '@/components/project-files/project-file-document-registry'
import type { WindowCloseRequest } from '../../shared/types'

/**
 * Hook to handle window close requests with source-aware behavior.
 *
 * - `window-button` closes the window directly.
 * - `keyboard-shortcut` (Cmd/Ctrl+W) uses layered dismissal:
 *   1. Close top modal
 *   2. Else close focused panel
 *   3. Else close window
 * - `unknown` follows layered dismissal as a safe fallback.
 *
 * The main process starts a fallback timeout on each close request.
 * cancelCloseWindow() clears it (window stays open).
 * confirmCloseWindow() clears it and destroys the window.
 *
 * This hook should be called once at the app root level.
 */
export function useWindowCloseHandler(isSessionWorkbenchVisible = false) {
  const { hasOpenLayers, closeTop } = useDismissibleLayerRegistry()
  const { hasOpenModals, closeTopModal } = useModalRegistry()
  const workbench = useAtomValue(workbenchAtom)
  const panels = useAtomValue(workbenchPanelsAtom)
  const focusedPanelId = useAtomValue(focusedWorkbenchPanelIdAtom)
  const closePanel = useSetAtom(closeWorkbenchPanelAtom)

  useEffect(() => window.electronAPI.onProjectFilesFlushRequested((requestId) => {
    void flushOpenProjectFiles()
      .then(() => window.electronAPI.completeProjectFilesFlush(requestId))
      .catch(error => window.electronAPI.completeProjectFilesFlush(
        requestId,
        error instanceof Error ? error.message : String(error),
      ))
  }), [])

  useEffect(() => {
    const cleanup = window.electronAPI.onCloseRequested((request: WindowCloseRequest) => {
      if (request.source !== 'window-button') {
        if (hasOpenLayers()) {
          closeTop()
          window.electronAPI.cancelCloseWindow()
          return
        }

        // Backward-compatible fallback for legacy modals not yet migrated.
        if (hasOpenModals()) {
          closeTopModal()
          window.electronAPI.cancelCloseWindow()
          return
        }

        // Close the focused panel (or last if no focus tracked)
        const target = focusedPanelId
          ? panels.find(panel => panel.id === focusedPanelId)
          : panels[panels.length - 1]
        if (isSessionWorkbenchVisible && target && workbench.activeProjectId) {
          window.electronAPI.cancelCloseWindow()
          void closePanel({ projectId: workbench.activeProjectId, panelId: target.id })
            .then(closed => {
              if (!closed) {
                window.electronAPI.debugLog(
                  '[Project Files] Panel close vetoed because save failed.',
                )
              }
            })
          return
        }
      }

      // The renderer has accepted responsibility for the close. Clear main's
      // 3-second IPC fallback before a potentially slow Project File flush.
      void window.electronAPI.cancelCloseWindow()
        .then(() => flushOpenProjectFiles())
        .then(() => window.electronAPI.confirmCloseWindow())
        .catch(error => {
          window.electronAPI.debugLog(
            '[Project Files] Window close vetoed because save failed:',
            error instanceof Error ? error.message : String(error),
          )
          window.electronAPI.cancelCloseWindow()
        })
    })

    return cleanup
  }, [hasOpenLayers, closeTop, hasOpenModals, closeTopModal, panels, focusedPanelId, closePanel, workbench.activeProjectId, isSessionWorkbenchVisible])
}
