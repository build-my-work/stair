/**
 * Sandboxed preload for the app-owned native browser overlay.
 */

import { ipcRenderer } from 'electron'
import {
  BROWSER_OVERLAY_ACTION_CHANNEL,
  isBrowserSelectionAction,
} from '../shared/browser-selection'

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('click', (event) => {
    if (!event.isTrusted) return
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLElement>(
      '[data-browser-selection-action]',
    )
    const action = button?.dataset.browserSelectionAction
    if (!isBrowserSelectionAction(action)) return
    event.preventDefault()
    event.stopPropagation()
    ipcRenderer.send(BROWSER_OVERLAY_ACTION_CHANNEL, action)
  }, true)
})
