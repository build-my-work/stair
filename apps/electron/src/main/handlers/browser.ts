import {
  RPC_CHANNELS,
  type BrowserPaneCreateOptions,
  type BrowserEmptyStateLaunchPayload,
  type BrowserSelectionActionPayload,
  type BrowserSurfaceState,
} from '../../shared/types'
import type { WebSelectionReferenceV1 } from '@craft-agent/core/types'
import type { BrowserScreenshotOptions } from '../browser-pane-manager'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'

type BrowserHostTarget =
  | { to: 'client'; clientId: string }
  | { to: 'all' }

function getBrowserHostTarget(
  deps: HandlerDeps,
  hostWebContentsId: number,
): BrowserHostTarget {
  const clientId = deps.windowManager?.getClientIdForWindow(hostWebContentsId)
  return clientId ? { to: 'client', clientId } : { to: 'all' }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.browserPane.CREATE,
  RPC_CHANNELS.browserPane.DESTROY,
  RPC_CHANNELS.browserPane.LIST,
  RPC_CHANNELS.browserPane.NAVIGATE,
  RPC_CHANNELS.browserPane.GO_BACK,
  RPC_CHANNELS.browserPane.GO_FORWARD,
  RPC_CHANNELS.browserPane.RELOAD,
  RPC_CHANNELS.browserPane.STOP,
  RPC_CHANNELS.browserPane.FOCUS,
  RPC_CHANNELS.browserPane.ATTACH_SURFACE,
  RPC_CHANNELS.browserPane.UPDATE_SURFACE,
  RPC_CHANNELS.browserPane.DETACH_SURFACE,
  RPC_CHANNELS.browserPane.REVEAL_SELECTION,
  RPC_CHANNELS.browserPane.LAUNCH,
  RPC_CHANNELS.browserPane.SNAPSHOT,
  RPC_CHANNELS.browserPane.CLICK,
  RPC_CHANNELS.browserPane.FILL,
  RPC_CHANNELS.browserPane.SELECT,
  RPC_CHANNELS.browserPane.SCREENSHOT,
  RPC_CHANNELS.browserPane.EVALUATE,
  RPC_CHANNELS.browserPane.SCROLL,
] as const

export function registerBrowserHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { browserPaneManager, platform } = deps
  if (!browserPaneManager) return

  server.handle(RPC_CHANNELS.browserPane.CREATE, (ctx, input?: string | BrowserPaneCreateOptions) => {
    // Stamp the window with the requester's workspace so manual UI-opened
    // tabs stay scoped to the workspace where the user clicked. If
    // ctx.workspaceId is null (no workspace context — e.g. CLI / agent
    // harness), the window stays globally visible (legacy behavior).
    const workspaceId = ctx.workspaceId ?? null

    if (typeof input === 'string') {
      return browserPaneManager.createInstance(input, { workspaceId })
    }

    if (input?.bindToSessionId) {
      return browserPaneManager.createForSession(input.bindToSessionId, {
        show: input.show ?? false,
        workspaceId,
      })
    }

    return browserPaneManager.createInstance(input?.id, { show: input?.show, workspaceId })
  })

  server.handle(RPC_CHANNELS.browserPane.DESTROY, (_ctx, id: string) => {
    browserPaneManager.destroyInstance(id)
  })

  server.handle(RPC_CHANNELS.browserPane.LIST, () => {
    // Return all instances. Workspace isolation is enforced renderer-side
    // (filterInstancesForWorkspace), which knows BOTH the local workspace id
    // and the remote-mirror workspace id for the active workspace. A server-
    // side filter on ctx.workspaceId would miss remote-stamped tabs because
    // ctx.workspaceId is always the local id (set by updateClientWorkspace).
    return browserPaneManager.listInstances()
  })

  server.handle(RPC_CHANNELS.browserPane.NAVIGATE, async (_ctx, id: string, url: string) => {
    try {
      return await browserPaneManager.navigate(id, url)
    } catch (err) {
      platform.logger.error(`[browser-pane] navigate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.GO_BACK, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.goBack(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goBack failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.GO_FORWARD, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.goForward(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goForward failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.RELOAD, (_ctx, id: string) => {
    browserPaneManager.reload(id)
  })

  server.handle(RPC_CHANNELS.browserPane.STOP, (_ctx, id: string) => {
    browserPaneManager.stop(id)
  })

  server.handle(RPC_CHANNELS.browserPane.FOCUS, (_ctx, id: string) => {
    browserPaneManager.focus(id)
  })

  server.handle(
    RPC_CHANNELS.browserPane.ATTACH_SURFACE,
    (ctx, id: string, state: BrowserSurfaceState) => {
      if (!ctx.webContentsId) throw new Error('Browser surface requires a local renderer')
      return browserPaneManager.attachSurface(id, ctx.webContentsId, state)
    },
  )

  server.handle(
    RPC_CHANNELS.browserPane.UPDATE_SURFACE,
    (ctx, id: string, leaseId: string, state: BrowserSurfaceState) => {
      if (!ctx.webContentsId) throw new Error('Browser surface requires a local renderer')
      browserPaneManager.updateSurface(id, ctx.webContentsId, leaseId, state)
    },
  )

  server.handle(
    RPC_CHANNELS.browserPane.DETACH_SURFACE,
    (ctx, id: string, leaseId: string) => {
      if (!ctx.webContentsId) return
      browserPaneManager.detachSurface(id, ctx.webContentsId, leaseId)
    },
  )

  server.handle(
    RPC_CHANNELS.browserPane.REVEAL_SELECTION,
    (ctx, reference: WebSelectionReferenceV1) => (
      browserPaneManager.revealSelection(reference, {
        workspaceId: ctx.workspaceId,
      })
    ),
  )

  server.handle(RPC_CHANNELS.browserPane.LAUNCH, async (ctx, payload: BrowserEmptyStateLaunchPayload) => {
    try {
      return await browserPaneManager.handleEmptyStateLaunchFromRenderer(ctx.webContentsId!, payload)
    } catch (err) {
      platform.logger.error('[browser-pane] empty-state launch IPC failed:', err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SNAPSHOT, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.getAccessibilitySnapshot(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] snapshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.CLICK, async (_ctx, id: string, ref: string) => {
    try {
      return await browserPaneManager.clickElement(id, ref)
    } catch (err) {
      platform.logger.error(`[browser-pane] click failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.FILL, async (_ctx, id: string, ref: string, value: string) => {
    try {
      return await browserPaneManager.fillElement(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] fill failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SELECT, async (_ctx, id: string, ref: string, value: string) => {
    try {
      return await browserPaneManager.selectOption(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] select failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SCREENSHOT, async (_ctx, id: string, options?: BrowserScreenshotOptions) => {
    try {
      const result = await browserPaneManager.screenshot(id, options)
      return {
        base64: result.imageBuffer.toString('base64'),
        imageFormat: result.imageFormat,
        metadata: result.metadata,
      }
    } catch (err) {
      platform.logger.error(`[browser-pane] screenshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.EVALUATE, async (_ctx, id: string, expression: string) => {
    try {
      return await browserPaneManager.evaluate(id, expression)
    } catch (err) {
      platform.logger.error(`[browser-pane] evaluate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SCROLL, async (_ctx, id: string, direction: string, amount?: number) => {
    const validDirections = ['up', 'down', 'left', 'right']
    if (!validDirections.includes(direction)) {
      throw new Error(`Invalid scroll direction: ${direction}`)
    }
    try {
      return await browserPaneManager.scroll(id, direction as 'up' | 'down' | 'left' | 'right', amount)
    } catch (err) {
      platform.logger.error(`[browser-pane] scroll failed for ${id}:`, err)
      throw err
    }
  })

  // Forward browser events to all locally-connected renderers. Workspace
  // isolation is enforced renderer-side (filterInstancesForWorkspace), which
  // handles both the local workspace id and the remote-mirror workspace id.
  //
  // We can't route STATE_CHANGED to `{ to: 'workspace', workspaceId }` here
  // because the broadcast routing uses the client's transport-level workspaceId
  // (the local Craft Agents window's id, set by `updateClientWorkspace`),
  // while remote-bridged instances are stamped with the remote server's
  // workspaceId. The two never match, so a workspace-targeted broadcast would
  // silently fail to reach the renderer. Broadcast to all + filter in the
  // renderer is the contract that actually works in both local-only and
  // remote-mirror deployments.
  browserPaneManager.onStateChange((info) => {
    pushTyped(server, RPC_CHANNELS.browserPane.STATE_CHANGED, { to: 'all' }, info)
  })

  browserPaneManager.onRemoved((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.REMOVED, { to: 'all' }, id)
  })

  browserPaneManager.onInteracted((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.INTERACTED, { to: 'all' }, id)
  })

  browserPaneManager.onPresentRequest((request, hostWebContentsId) => {
    pushTyped(
      server,
      RPC_CHANNELS.browserPane.PRESENT_REQUESTED,
      getBrowserHostTarget(deps, hostWebContentsId),
      request,
    )
  })

  browserPaneManager.onClosePanelRequest((browserId, hostWebContentsId) => {
    pushTyped(
      server,
      RPC_CHANNELS.browserPane.CLOSE_PANEL_REQUESTED,
      getBrowserHostTarget(deps, hostWebContentsId),
      browserId,
    )
  })

  browserPaneManager.onSelectionAction((
    payload: BrowserSelectionActionPayload,
    hostWebContentsId: number,
  ) => {
    pushTyped(
      server,
      RPC_CHANNELS.browserPane.SELECTION_ACTION,
      getBrowserHostTarget(deps, hostWebContentsId),
      payload,
    )
  })
}
