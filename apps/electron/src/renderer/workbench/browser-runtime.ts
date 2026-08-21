import { atom } from 'jotai'

export interface BrowserRuntimeOperations {
  create(input: { projectId: string; url?: string }): Promise<string>
  destroy(runtimeId: string): Promise<void>
  park(runtimeIds: string[]): Promise<void>
}

export const browserRuntimeOperationsAtom = atom<BrowserRuntimeOperations>({
  async create({ url }) {
    const runtimeId = await window.electronAPI.browserPane.create({
      show: false,
    })
    try {
      if (url) await window.electronAPI.browserPane.navigate(runtimeId, url)
      return runtimeId
    } catch (error) {
      await window.electronAPI.browserPane.destroy(runtimeId).catch(() => undefined)
      throw error
    }
  },
  destroy: runtimeId => window.electronAPI.browserPane.destroy(runtimeId),
  park: runtimeIds => window.electronAPI.browserPane.park(runtimeIds),
})
