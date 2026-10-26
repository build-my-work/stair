import * as React from 'react'
import { ModalProvider } from '@/context/ModalContext'
import { NavigationProvider } from '@/contexts/NavigationContext'
import type { Session } from '../../shared/types'

/**
 * App contexts that production components read unconditionally (modal registry, navigation), so a preview
 * renders instead of throwing "must be used within …". Navigation stays inert: no workspace and not ready,
 * so a preview never restores routes, rewrites the playground URL or auto-selects a session. Demos that
 * need live navigation (the mobile WebUI demos) nest their own providers, which take precedence.
 */
export function PlaygroundPreviewProviders({ children }: { children: React.ReactNode }) {
  const onCreateSession = React.useCallback(async (): Promise<Session> => {
    throw new Error('[Playground] Creating sessions is not available in previews')
  }, [])

  return (
    <ModalProvider>
      <NavigationProvider
        workspaceId={null}
        defaultProjectId={null}
        workspaceSlug={null}
        onCreateSession={onCreateSession}
        isReady={false}
        isSessionsReady={false}
      >
        {children}
      </NavigationProvider>
    </ModalProvider>
  )
}
