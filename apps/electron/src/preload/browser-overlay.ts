/**
 * Sandboxed preload for the app-owned native browser overlay.
 *
 * The overlay sends only trusted button clicks to main and exposes no page API.
 */

import { ipcRenderer } from 'electron'
import { BROWSER_OVERLAY_ASK_CHANNEL } from '../shared/browser-selection'

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('click', (event) => {
    if (!event.isTrusted) return
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLElement>('[data-browser-selection-target]')
    const askTarget = button?.dataset.browserSelectionTarget
    if (askTarget !== 'main' && askTarget !== 'sideChat') return
    event.preventDefault()
    event.stopPropagation()
    ipcRenderer.send(
      BROWSER_OVERLAY_ASK_CHANNEL,
      askTarget,
    )
  }, true)
})
