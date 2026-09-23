import {
  CLIENT_BROWSER_APPLICATION_INVOKE,
  requestClientBrowserApplicationInvoke,
  type BrowserApplicationProjectContext,
  type RpcServer,
} from '@craft-agent/server-core/transport'
import type { BrowserApplicationService } from './browser-pane-manager'
import type { WindowManager } from './window-manager'

interface BrowserApplicationWorkspace {
  id: string
}

interface BrowserApplicationRouterOptions {
  server: RpcServer
  windowManager?: WindowManager
  resolveWorkspace: (workspaceId: string) => BrowserApplicationWorkspace | null
}

interface BrowserProjectTarget {
  workspaceId: string
  projectId: string
  targetSessionId?: string | null
  preferredClientId?: string | null
}

export interface BrowserApplicationRouter {
  service: BrowserApplicationService
  validateProjectTarget(target: BrowserProjectTarget): Promise<void>
}

const CLIENT_WAIT_MS = 5_000
const PREFERRED_CLIENT_GRACE_MS = 75
const CLIENT_RETRY_MS = 50

function waitForResult<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

export function createBrowserApplicationRouter({
  server,
  windowManager,
  resolveWorkspace,
}: BrowserApplicationRouterOptions): BrowserApplicationRouter {
  const requireWorkspace = (workspaceId: string): BrowserApplicationWorkspace => {
    const workspace = resolveWorkspace(workspaceId)
    if (!workspace) throw new Error('Browser Workspace is unavailable')
    return workspace
  }

  const findCapabilityClient = (workspaceId: string, preferredClientId?: string | null) => {
    if (
      preferredClientId
      && server.hasClientCapability(preferredClientId, CLIENT_BROWSER_APPLICATION_INVOKE)
    ) {
      return preferredClientId
    }

    const window = windowManager?.getWindowByWorkspace(workspaceId)
    if (window && !window.isDestroyed()) {
      const clientId = windowManager?.getClientIdForWindow(window.webContents.id)
      if (
        clientId
        && server.hasClientCapability(clientId, CLIENT_BROWSER_APPLICATION_INVOKE)
      ) {
        return clientId
      }
    }

    return server.findClientsWithCapability(
      CLIENT_BROWSER_APPLICATION_INVOKE,
      { workspaceId },
    )[0]
  }

  const requireCapabilityClient = async (
    workspaceId: string,
    preferredClientId?: string | null,
  ): Promise<string> => {
    const connectedClientId = findCapabilityClient(workspaceId, preferredClientId)
    if (connectedClientId) return connectedClientId

    const window = windowManager?.focusOrCreateWindow(workspaceId)
    if (!window) throw new Error('Remote Browser Project data is unavailable')

    const deadline = Date.now() + CLIENT_WAIT_MS
    do {
      const clientId = windowManager?.getClientIdForWindow(window.webContents.id)
      if (
        clientId
        && server.hasClientCapability(clientId, CLIENT_BROWSER_APPLICATION_INVOKE)
      ) {
        return clientId
      }
      await new Promise(resolve => setTimeout(resolve, CLIENT_RETRY_MS))
    } while (Date.now() < deadline)

    throw new Error('Remote Browser Project data is unavailable')
  }

  const firstResponsiveClient = async <T>(
    workspaceId: string,
    preferredClientId: string | null | undefined,
    request: (clientId: string) => Promise<T>,
    unavailableMessage: string,
  ): Promise<{ clientId: string; value: T }> => {
    const deadline = Date.now() + CLIENT_WAIT_MS
    const requestsByClient = new Map<string, Promise<{ clientId: string; value: T }>>()
    do {
      const clientIds: string[] = []
      if (
        preferredClientId
        && server.hasClientCapability(preferredClientId, CLIENT_BROWSER_APPLICATION_INVOKE)
      ) {
        clientIds.push(preferredClientId)
      }
      for (const clientId of server.findClientsWithCapability(
        CLIENT_BROWSER_APPLICATION_INVOKE,
        { workspaceId },
      )) {
        if (!clientIds.includes(clientId)) clientIds.push(clientId)
      }
      const fallbackClientId = findCapabilityClient(workspaceId)
      if (fallbackClientId && !clientIds.includes(fallbackClientId)) {
        clientIds.unshift(fallbackClientId)
      }
      if (clientIds.length === 0) {
        clientIds.push(await requireCapabilityClient(workspaceId))
      }

      const requests = clientIds.map(clientId => {
        let pending = requestsByClient.get(clientId)
        if (!pending) {
          pending = request(clientId).then(value => ({ clientId, value }))
          requestsByClient.set(clientId, pending)
          void pending.finally(() => {
            if (requestsByClient.get(clientId) === pending) {
              requestsByClient.delete(clientId)
            }
          }).catch(() => {})
        }
        return pending
      })
      const preferredIndex = preferredClientId
        ? clientIds.indexOf(preferredClientId)
        : -1
      if (preferredIndex >= 0) {
        const preferred = await waitForResult(
          requests[preferredIndex],
          PREFERRED_CLIENT_GRACE_MS,
        )
        if (preferred) return preferred
      }
      const resolved = await waitForResult(
        Promise.any(requests),
        Math.max(0, deadline - Date.now()),
      )
      if (resolved) return resolved
      await new Promise(resolve => setTimeout(resolve, CLIENT_RETRY_MS))
    } while (Date.now() < deadline)

    throw new Error(unavailableMessage)
  }

  const resolveOriginClientId = (
    workspaceId: string,
    originWebContentsId?: number | null,
  ): string | undefined => {
    if (originWebContentsId == null) return undefined
    if (windowManager?.getWorkspaceForWindow(originWebContentsId) !== workspaceId) {
      return undefined
    }
    return windowManager?.getClientIdForWindow(originWebContentsId)
  }

  const requireApplicationClient = async (
    workspaceId: string,
    preferredClientId?: string | null,
  ): Promise<string> => {
    const { clientId } = await firstResponsiveClient(
      workspaceId,
      preferredClientId,
      async candidateClientId => {
        const response = await requestClientBrowserApplicationInvoke(
          server,
          candidateClientId,
          {
            v: 1,
            action: 'get-application-readiness',
            workspaceId,
          },
        )
        if (!('applicationReady' in response) || !response.applicationReady) {
          throw new Error('Browser application handler is not ready')
        }
        return true
      },
      'Browser application handler is unavailable',
    )
    return clientId
  }

  const getProjectContext = async (
    workspaceId: string,
    projectId: string,
    preferredClientId?: string | null,
    includeOwnerSessionId?: string,
  ): Promise<{
    clientId: string
    context: BrowserApplicationProjectContext
  }> => {
    const { clientId, value } = await firstResponsiveClient(
      workspaceId,
      preferredClientId,
      async candidateClientId => {
        const response = await requestClientBrowserApplicationInvoke(
          server,
          candidateClientId,
          {
            v: 1,
            action: 'get-project-context',
            workspaceId,
            projectId,
            ...(includeOwnerSessionId ? { includeOwnerSessionId } : {}),
          },
        )
        if (!('projectExists' in response)) {
          throw new Error('Remote Browser Project data returned an invalid response')
        }
        return response
      },
      'Remote Browser Project data is unavailable',
    )
    return { clientId, context: value }
  }

  const validateProjectTarget = async ({
    workspaceId,
    projectId,
    targetSessionId,
    preferredClientId,
  }: BrowserProjectTarget): Promise<void> => {
    const workspace = requireWorkspace(workspaceId)
    const { context } = await getProjectContext(
      workspace.id,
      projectId,
      preferredClientId,
    )
    if (!context.projectExists) throw new Error('Browser Project is unavailable')
    if (
      targetSessionId
      && !context.chatTargets.some(target => target.id === targetSessionId)
    ) {
      throw new Error('Target Chat is not available in this Project')
    }
  }

  const service: BrowserApplicationService = {
    listProjectTargets: async ({ workspaceId, originWebContentsId }) => {
      const workspace = requireWorkspace(workspaceId)
      const { value } = await firstResponsiveClient(
        workspace.id,
        resolveOriginClientId(workspace.id, originWebContentsId),
        async clientId => {
          const response = await requestClientBrowserApplicationInvoke(
            server,
            clientId,
            {
              v: 1,
              action: 'list-project-targets',
              workspaceId: workspace.id,
            },
          )
          if (!('projectTargets' in response)) {
            throw new Error('Remote Browser Project list returned an invalid response')
          }
          return response.projectTargets
        },
        'Remote Browser Project list is unavailable',
      )
      return value
    },
    listChatTargets: async ({ workspaceId, projectId, originWebContentsId, includeOwnerSessionId }) => {
      const workspace = requireWorkspace(workspaceId)
      const { context } = await getProjectContext(
        workspace.id,
        projectId,
        resolveOriginClientId(workspace.id, originWebContentsId),
        includeOwnerSessionId,
      )
      if (!context.projectExists) throw new Error('Browser Project is unavailable')
      return context.chatTargets
    },
    openChat: async ({ workspaceId, projectId, sessionId, originWebContentsId }) => {
      const workspace = requireWorkspace(workspaceId)
      const originClientId = resolveOriginClientId(workspace.id, originWebContentsId)
      const { clientId, context } = await getProjectContext(
        workspace.id,
        projectId,
        originClientId,
      )
      if (!context.chatTargets.some(target => target.id === sessionId)) {
        throw new Error('Target Chat is not available in this Project')
      }

      const readyClientId = await requireApplicationClient(workspace.id, clientId)
      await requestClientBrowserApplicationInvoke(
        server,
        readyClientId,
        {
          v: 1,
          action: 'open-chat',
          workspaceId: workspace.id,
          projectId,
          sessionId,
        },
      )
      windowManager?.focusWindowForClient(readyClientId)
    },
    applySelection: async input => {
      const workspace = requireWorkspace(input.workspaceId)
      const originClientId = resolveOriginClientId(
        workspace.id,
        input.originWebContentsId,
      )
      if (input.action === 'new-chat') {
        const clientId = await requireApplicationClient(workspace.id, originClientId)
        const response = await requestClientBrowserApplicationInvoke(
          server,
          clientId,
          {
            v: 1,
            action: 'create-chat-from-selection',
            requestId: input.requestId,
            workspaceId: workspace.id,
            projectId: input.projectId,
            source: input.source,
          },
        )
        if (
          !('sessionId' in response)
          || typeof response.sessionId !== 'string'
          || !('targetTitle' in response)
          || typeof response.targetTitle !== 'string'
        ) {
          throw new Error('Browser New Chat returned an invalid response')
        }
        return {
          sessionId: response.sessionId,
          targetTitle: response.targetTitle,
          noteTargetPath: null,
        }
      }
      if (input.action === 'add-note' || input.action === 'choose-note-target') {
        const clientId = await requireApplicationClient(workspace.id, originClientId)
        windowManager?.focusWindowForClient(clientId)
        const response = await requestClientBrowserApplicationInvoke(
          server,
          clientId,
          {
            v: 1,
            action: 'add-selection-note',
            requestId: input.requestId,
            mode: input.action === 'choose-note-target' ? 'choose-target' : 'current',
            workspaceId: workspace.id,
            projectId: input.projectId,
            sessionId: input.sessionId,
            source: input.source,
          },
        )
        if (!('ok' in response)) {
          throw new Error('Browser Add Note returned an invalid response')
        }
        if (!response.ok) return { cancelled: true }
        if (
          !('noteTargetPath' in response)
          || typeof response.noteTargetPath !== 'string'
          || !('sessionId' in response)
          || (response.sessionId !== null && typeof response.sessionId !== 'string')
        ) {
          throw new Error('Browser Add Note returned an invalid Note target')
        }
        if (response.sessionId !== null && response.sessionId !== input.sessionId) {
          throw new Error('Browser Add Note returned an invalid target Chat')
        }
        return {
          sessionId: response.sessionId,
          targetTitle: null,
          noteTargetPath: response.noteTargetPath,
        }
      }

      const { clientId: contextClientId, context } = await getProjectContext(
        workspace.id,
        input.projectId,
        originClientId,
      )

      if (input.action === 'add-chat') {
        if (!input.sessionId) throw new Error('Browser window has no target Chat')
        const target = context.chatTargets.find(candidate => candidate.id === input.sessionId)
        if (!target) throw new Error('Target Chat is not available in this Project')
        await requestClientBrowserApplicationInvoke(
          server,
          await requireApplicationClient(workspace.id, contextClientId),
          {
            v: 1,
            action: 'add-selection-to-chat',
            requestId: input.requestId,
            workspaceId: workspace.id,
            projectId: input.projectId,
            sessionId: input.sessionId,
            source: input.source,
          },
        )
        return {
          sessionId: target.id,
          targetTitle: target.title,
          noteTargetPath: target.noteTargetPath,
        }
      }
      throw new Error('Unsupported Browser selection action')
    },
  }

  return { service, validateProjectTarget }
}
