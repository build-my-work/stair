import * as React from 'react'
import { useSetAtom } from 'jotai'

import ChatPage from '@/pages/ChatPage'
import { setEmbeddedSessionVisibilityAtom } from '@/atoms/panel-stack'

export interface EmbeddedSideChatProps {
  sessionId: string
  /** Only the active tab reports this session as visible/read. */
  active?: boolean
}

/** Chat surface for a persistent side-chat session inside RightWorkspace. */
export function EmbeddedSideChat({ sessionId, active = true }: EmbeddedSideChatProps) {
  const setVisible = useSetAtom(setEmbeddedSessionVisibilityAtom)

  React.useEffect(() => {
    if (!active) return
    setVisible({ sessionId, visible: true })
    return () => setVisible({ sessionId, visible: false })
  }, [active, sessionId, setVisible])

  return <ChatPage sessionId={sessionId} embedded active={active} />
}
