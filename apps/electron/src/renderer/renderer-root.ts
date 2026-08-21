import type { Root } from 'react-dom/client'

export interface RendererHotData {
  reactRoot?: Root
}

export function resolveRendererRoot(
  rootElement: HTMLElement,
  hotData: RendererHotData | undefined,
  createRoot: (container: HTMLElement) => Root,
): { reactRoot: Root; shouldRender: boolean } {
  const existingRoot = hotData?.reactRoot
  const reactRoot = existingRoot ?? createRoot(rootElement)
  if (hotData) hotData.reactRoot = reactRoot
  return { reactRoot, shouldRender: existingRoot === undefined }
}
