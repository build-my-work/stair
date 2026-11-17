import { atom } from 'jotai'

export interface NotionViewLayout {
  bounds: { x: number; y: number; width: number; height: number }
  clip: { x: number; y: number; width: number; height: number }
  borderRadius: string
  visible: boolean
}
export const notionViewLayoutsAtom = atom<Record<string, NotionViewLayout>>({})

const guests = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void }>()
export function notionGuestReady(projectId: string) {
  let ready = guests.get(projectId)
  if (!ready) {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    void promise.catch(() => {})
    ready = { promise, resolve, reject }
    guests.set(projectId, ready)
  }
  return ready
}
export function removeNotionGuest(projectId: string) {
  guests.get(projectId)?.reject(new Error('NOTION_PANEL_CLOSED'))
  guests.delete(projectId)
}
