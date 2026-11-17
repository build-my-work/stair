import * as React from "react"

/** Keep transcript scrolling inside its panel rather than moving the Workbench. */
export function scrollChatToBottom(viewport: HTMLElement | null, behavior: ScrollBehavior): void {
  if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior })
}

/**
 * Scrolls the transcript viewport to the bottom on mount, before browser paint.
 * Uses useLayoutEffect to ensure scroll happens before content is visible.
 */
export function ScrollOnMount({
  viewportRef,
  onScroll,
  skip = false
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
  skip?: boolean
}) {
  React.useLayoutEffect(() => {
    if (skip) return
    scrollChatToBottom(viewportRef.current, 'instant')
    onScroll?.()
  }, [skip])
  return null
}
