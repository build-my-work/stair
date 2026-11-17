import { useEffect } from 'react'
import { useStore } from 'jotai'
import { workbenchAtom } from '@/workbench/workbench-state'
import { openNotionPageAtom } from './notion-workbench'

export function NotionCapabilityBridge() {
  const store = useStore()
  useEffect(() => {
    if (!window.electronAPI.setNotionCapabilityHandler) return
    window.electronAPI.setNotionCapabilityHandler(async request => {
      const workbench = store.get(workbenchAtom)
      if (workbench.workspaceId !== request.workspaceId) throw new Error('NOTION_WORKSPACE_MISMATCH')
      const panel = workbench.layoutsByProject[request.projectId]?.auxiliary.find(item => item.kind === 'notion-page')
      const canOpen = Boolean(panel) || workbench.activeProjectId === request.projectId
      if (request.action === 'open') {
        if (!canOpen) throw new Error('NOTION_PROJECT_NOT_OPEN: Open this Project in Stair first.')
        await store.set(openNotionPageAtom, { projectId: request.projectId, pageId: request.pageId, agent: true })
      }
      const current = panel || request.action === 'open'
        ? await window.electronAPI.notionView({ action: 'current', projectId: request.projectId }) : null
      const valid = current && typeof current === 'object' && !current.error
      return { hasPanel: Boolean(panel) || request.action === 'open', canOpen, pageId: valid ? current.pageId : null, revision: valid ? current.revision : null }
    })
    const off = window.electronAPI.onNotionViewChanged((projectId, state) => {
      if (!state.pageId) return
      const current = store.get(workbenchAtom)
      const layout = current.layoutsByProject[projectId]
      if (!layout || !layout.auxiliary.some(panel => panel.kind === 'notion-page' && panel.pageId !== state.pageId)) return
      store.set(workbenchAtom, { ...current, layoutsByProject: { ...current.layoutsByProject, [projectId]: {
        ...layout, auxiliary: layout.auxiliary.map(panel => panel.kind === 'notion-page' ? { ...panel, pageId: state.pageId! } : panel),
      } } })
    })
    return () => { window.electronAPI.setNotionCapabilityHandler(null); off() }
  }, [store])
  return null
}
