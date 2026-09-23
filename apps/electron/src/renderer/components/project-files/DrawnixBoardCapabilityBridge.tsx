import { useEffect } from 'react'
import { useStore } from 'jotai'
import { handleDrawnixBoardCapability } from './drawnix-board-registry'
import { createDrawnixMindmap } from './drawnix-mindmap-create'
import { openProjectFilePreviewAtom } from '@/workbench/workbench-commands'
import { workbenchAtom } from '@/workbench/workbench-state'

export function DrawnixBoardCapabilityBridge() {
  const store = useStore()

  useEffect(() => {
    window.electronAPI.setDrawnixBoardCapabilityHandler(async request => {
      if (request.action !== 'create') return handleDrawnixBoardCapability(request)
      return createDrawnixMindmap(request, {
        api: window.electronAPI,
        activeProjectId: () => store.get(workbenchAtom).activeProjectId,
        openProjectFile: input => store.set(openProjectFilePreviewAtom, input),
      })
    })
    return () => window.electronAPI.setDrawnixBoardCapabilityHandler(null)
  }, [store])

  return null
}
