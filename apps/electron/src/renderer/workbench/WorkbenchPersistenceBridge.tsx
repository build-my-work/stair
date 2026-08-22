import { useEffect } from 'react'
import { useAtomValue } from 'jotai'
import {
  workbenchAtom,
  workbenchPersistenceReadyAtom,
} from './workbench-state'
import {
  scheduleWorkbenchLayoutPersistence,
  serializeWorkbenchLayouts,
} from './workbench-persistence'

export function WorkbenchPersistenceBridge(): null {
  const workbench = useAtomValue(workbenchAtom)
  const isReady = useAtomValue(workbenchPersistenceReadyAtom)

  useEffect(() => {
    if (!isReady || !workbench.workspaceId) return
    scheduleWorkbenchLayoutPersistence(serializeWorkbenchLayouts(workbench))
  }, [isReady, workbench])

  return null
}
