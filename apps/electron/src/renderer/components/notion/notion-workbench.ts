import { notionGuestReady } from './notion-view-state'
import { atom } from 'jotai'
import { workbenchAtom, createEmptyProjectWorkbench, workbenchPanelRevealRevisionAtom } from '@/workbench/workbench-state'
import { getDefaultWorkbenchPanelRatio } from '@/workbench/panel-sizing'
import { workbenchPanelLayoutWidthAtom } from '@/workbench/workbench-state'

export const openNotionPageAtom = atom(null, async (get, set, input: { projectId: string; pageId: string; agent?: boolean }) => {
  if (typeof window.electronAPI.notionView !== 'function') throw new Error('NOTION_DESKTOP_REQUIRED: Open this Project in Stair Desktop.')
  const current = get(workbenchAtom)
  const layout = current.layoutsByProject[input.projectId] ?? createEmptyProjectWorkbench()
  const existing = layout.auxiliary.find(panel => panel.kind === 'notion-page')
  if (!existing && current.activeProjectId !== input.projectId) throw new Error('NOTION_PROJECT_NOT_OPEN: Open this Project in Stair first.')
  const panel = existing ?? {
    id: `notion-${crypto.randomUUID()}`, kind: 'notion-page' as const, projectId: input.projectId, pageId: input.pageId,
    widthRatio: getDefaultWorkbenchPanelRatio(get(workbenchPanelLayoutWidthAtom), 'notion-page'),
  }
  if (!existing) {
    set(workbenchAtom, { ...current, layoutsByProject: { ...current.layoutsByProject, [input.projectId]: {
      ...layout, auxiliary: [...layout.auxiliary, panel], focusedPanelId: panel.id,
    } } })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([notionGuestReady(input.projectId).promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('NOTION_PANEL_NOT_READY: Close and reopen the panel.')), 15000)
    })])
  } finally { if (timer) clearTimeout(timer) }
  const result = await window.electronAPI.notionView({ action: 'open', ...input })
  const latest = get(workbenchAtom)
  const latestLayout = latest.layoutsByProject[input.projectId]
  if (latest.workspaceId === current.workspaceId && latestLayout) {
    set(workbenchAtom, { ...latest, layoutsByProject: { ...latest.layoutsByProject, [input.projectId]: {
      ...latestLayout,
      auxiliary: latestLayout.auxiliary.map(item => item.id === panel.id && item.kind === 'notion-page' ? { ...item, pageId: input.pageId } : item),
      focusedPanelId: latest.activeProjectId === input.projectId ? panel.id : latestLayout.focusedPanelId,
    } } })
    if (latest.activeProjectId === input.projectId) set(workbenchPanelRevealRevisionAtom, get(workbenchPanelRevealRevisionAtom) + 1)
  }
  return result
})
