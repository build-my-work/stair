import { useEffect } from 'react'
import { handleDrawnixBoardCapability } from './drawnix-board-registry'

export function DrawnixBoardCapabilityBridge() {
  useEffect(() => {
    window.electronAPI.setDrawnixBoardCapabilityHandler(
      handleDrawnixBoardCapability,
    )
    return () => {
      window.electronAPI.setDrawnixBoardCapabilityHandler(null)
    }
  }, [])

  return null
}
